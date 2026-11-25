/* net.js - School-Firewall-Proof Multi-Transport Online Multiplayer Manager.
 *
 * Uses 4 layered transports in parallel (deduplicated by sender sequence number) so
 * Online Mode works everywhere — home Wi-Fi, 4G/5G cellular, AND strict school Wi-Fi:
 *   1. Port-443 MQTT-over-WSS (public.cloud.shiftr.io:443) + backup MQTT brokers
 *      (broker.emqx.io:8084, test.mosquitto.org:8081) with automatic reconnect.
 *   2. Same-Origin HTTPS Port-443 SSE + POST Relay (/api/relay on ironfistboxing.club)
 *      via Netlify Edge Functions — impossible for school firewalls to block because
 *      it uses the exact same domain and port 443 as the game itself.
 *   3. Automatic Direct WebRTC RTCDataChannel upgrade (with Google STUN + OpenRelay
 *      port-443 TCP/TLS TURN) for ultra-low-latency, zero-rate-limit 30Hz gameplay
 *      once two players meet via any signaling channel.
 *   4. BroadcastChannel for instant local multi-tab testing.
 *
 * Supports:
 *   - Host Room (4-character Room Code + ?room=CODE invite link)
 *   - Join Room (if two friends both click Join with the same code, one auto-hosts!)
 *   - Quick Match (live heartbeat lobby that pairs any two searching players in <1s)
 *   - Global Top 3 Elo Leaderboard sync
 */
(function (g) {
  'use strict';

  var BROKERS = [
    { url: 'wss://public.cloud.shiftr.io:443', user: 'public', pass: 'public' },
    { url: 'wss://broker.emqx.io:8084/mqtt' },
    { url: 'wss://test.mosquitto.org:8081/mqtt' }
  ];
  var ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80' },
    {
      urls: [
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp'
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject'
    }
  ];

  var TOPIC_LOBBY = 'ironfists/v3/lobby';
  var TOPIC_ROOM_PREFIX = 'ironfists/v3/room/';
  var TOPIC_LEADERBOARD = 'ironfists/v3/leaderboard/top3';
  var CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  var myId = 'if_' + Math.random().toString(36).slice(2, 10) + '_' + (Date.now() % 100000);
  var peerId = null;
  var role = null;           // 'host' | 'guest' | null
  var roomCode = '';
  var mode = 'idle';         // 'idle' | 'quick' | 'room'
  var connected = false;
  var seekTs = 0;
  var pingMs = 0;
  var lastGuestTs = 0;
  var lastPingSent = 0;
  var lastRxTime = 0;

  var txSeq = 0;
  var seenSeq = {};          // senderId -> highest seq processed
  var clients = [];
  var bc = null;
  var activeTopic = null;
  var heartbeatTimer = null;
  var stepSendCount = 0;
  var pendingLeaderboardJson = null;

  // Same-Origin HTTPS Port-443 SSE + POST relay state (works behind strict school firewalls)
  var canUseSameOriginRelay = (typeof g.location !== 'undefined' &&
    (g.location.protocol === 'https:' || g.location.protocol === 'http:') &&
    g.location.hostname !== 'localhost' && g.location.hostname !== '127.0.0.1');
  var sseSource = null;
  var sseTopic = null;
  var sseReady = false;
  var lastHttpDataTx = 0;
  var lastHttpKeepaliveTx = 0;

  // Direct WebRTC DataChannel upgrade state
  var rtcPc = null;
  var rtcDc = null;
  var rtcReady = false;
  var rtcPendingIce = [];
  var rtcStarted = false;

  // Latched remote input state (for Host consuming Guest's inputs at 60Hz)
  var remoteHold = { left: false, right: false, block: false };
  var remoteEdge = { jab: false, hook: false, uppercut: false, dodge: false, combo: false };
  var remotePresses = 0;

  var handlers = {
    onStatus: null,
    onConnected: null,
    onDisconnected: null,
    onRemoteSelect: null,
    onRemoteReady: null,
    onMatchStart: null,
    onStateSnapshot: null,
    onSkipRest: null,
    onRematchRequest: null,
    onLeaderboard: null
  };

  // ------------------------------------------------------------------ Minimal MQTT v3.1.1 over WebSocket
  function strToUtf8(str) {
    if (g.TextEncoder) return new g.TextEncoder().encode(str);
    var utf8 = unescape(encodeURIComponent(str));
    var arr = new Uint8Array(utf8.length);
    for (var i = 0; i < utf8.length; i++) arr[i] = utf8.charCodeAt(i);
    return arr;
  }

  function utf8ToStr(bytes) {
    if (g.TextDecoder) return new g.TextDecoder().decode(bytes);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
  }

  function encVarLen(len) {
    var out = [];
    do {
      var b = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) b |= 128;
      out.push(b);
    } while (len > 0);
    return out;
  }

  function encMqttStr(str) {
    var b = strToUtf8(str);
    var out = new Uint8Array(2 + b.length);
    out[0] = (b.length >> 8) & 255;
    out[1] = b.length & 255;
    out.set(b, 2);
    return out;
  }

  function createMqttSocket(cfg) {
    var url = cfg.url;
    var user = cfg.user || '';
    var pass = cfg.pass || '';
    var ws = null;
    var isReady = false;
    var closed = false;
    var buf = new Uint8Array(0);
    var subId = 1;
    var pingInterval = null;
    var reconnectTimer = null;
    var currentTopic = null;

    var client = {
      url: url,
      ready: function () { return isReady; },
      subscribe: function (topic, keepCurrent) {
        if (!keepCurrent) currentTopic = topic;
        if (!isReady || !ws) return;
        var tb = strToUtf8(topic);
        var rem = 2 + 2 + tb.length + 1;
        var vh = encVarLen(rem);
        var pkt = new Uint8Array(1 + vh.length + rem);
        pkt[0] = 0x82;
        pkt.set(vh, 1);
        var o = 1 + vh.length;
        var pid = (subId++) & 0xffff;
        pkt[o] = (pid >> 8) & 255;
        pkt[o + 1] = pid & 255;
        pkt[o + 2] = (tb.length >> 8) & 255;
        pkt[o + 3] = tb.length & 255;
        pkt.set(tb, o + 4);
        pkt[o + 4 + tb.length] = 0;
        try { ws.send(pkt); } catch (_) {}
      },
      publish: function (topic, jsonStr, retain) {
        if (!isReady || !ws) return;
        var tb = strToUtf8(topic);
        var mb = strToUtf8(jsonStr);
        var rem = 2 + tb.length + mb.length;
        var vh = encVarLen(rem);
        var pkt = new Uint8Array(1 + vh.length + rem);
        pkt[0] = retain ? 0x31 : 0x30;
        pkt.set(vh, 1);
        var o = 1 + vh.length;
        pkt[o] = (tb.length >> 8) & 255;
        pkt[o + 1] = tb.length & 255;
        pkt.set(tb, o + 2);
        pkt.set(mb, o + 2 + tb.length);
        try { ws.send(pkt); } catch (_) {}
      },
      close: function () {
        closed = true;
        isReady = false;
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        if (ws) {
          try { ws.close(); } catch (_) {}
          ws = null;
        }
      }
    };

    function scheduleReconnect() {
      if (closed || reconnectTimer) return;
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        if (!closed) connectWs();
      }, 4000);
    }

    function connectWs() {
      if (closed) return;
      buf = new Uint8Array(0);
      try {
        ws = new g.WebSocket(url, 'mqtt');
        ws.binaryType = 'arraybuffer';
      } catch (_) {
        scheduleReconnect();
        return;
      }

      ws.onopen = function () {
        if (closed) return;
        var cidPart = encMqttStr(myId + '_' + Math.floor(Math.random() * 999));
        var hasAuth = !!(user && pass);
        var userPart = hasAuth ? encMqttStr(user) : new Uint8Array(0);
        var passPart = hasAuth ? encMqttStr(pass) : new Uint8Array(0);
        var flags = hasAuth ? 0xC2 : 0x02;
        var vh = [0, 4, 77, 81, 84, 84, 4, flags, 0, 45];
        var rem = vh.length + cidPart.length + userPart.length + passPart.length;
        var vl = encVarLen(rem);
        var pkt = new Uint8Array(1 + vl.length + rem);
        pkt[0] = 0x10;
        pkt.set(vl, 1);
        var o = 1 + vl.length;
        pkt.set(vh, o); o += vh.length;
        pkt.set(cidPart, o); o += cidPart.length;
        if (hasAuth) {
          pkt.set(userPart, o); o += userPart.length;
          pkt.set(passPart, o);
        }
        try { ws.send(pkt); } catch (_) {}
      };

      ws.onmessage = function (ev) {
        if (closed || !ev.data) return;
        var incoming = new Uint8Array(ev.data);
        var merged = new Uint8Array(buf.length + incoming.length);
        merged.set(buf, 0);
        merged.set(incoming, buf.length);
        buf = merged;

        while (buf.length >= 2) {
          var type = buf[0] >> 4;
          var mult = 1, rem = 0, idx = 1, b;
          do {
            if (idx >= buf.length) return;
            b = buf[idx++];
            rem += (b & 127) * mult;
            mult *= 128;
          } while ((b & 128) !== 0);
          if (buf.length < idx + rem) return;
          var payload = buf.subarray(idx, idx + rem);
          buf = buf.subarray(idx + rem);

          if (type === 2) {
            isReady = true;
            client.subscribe(TOPIC_LEADERBOARD, true);
            if (currentTopic) client.subscribe(currentTopic);
            if (pendingLeaderboardJson) client.publish(TOPIC_LEADERBOARD, pendingLeaderboardJson, true);
            onAnyTransportReady();
            if (pingInterval) clearInterval(pingInterval);
            pingInterval = setInterval(function () {
              if (isReady && ws) {
                try { ws.send(new Uint8Array([0xc0, 0x00])); } catch (_) {}
              }
            }, 20000);
          } else if (type === 3) {
            var tlen = (payload[0] << 8) | payload[1];
            var topicStr = utf8ToStr(payload.subarray(2, 2 + tlen));
            var msgStr = utf8ToStr(payload.subarray(2 + tlen));
            handleRawPacket(topicStr, msgStr);
          }
        }
      };

      ws.onerror = function () {};
      ws.onclose = function () {
        isReady = false;
        if (pingInterval) { clearInterval(pingInterval); pingInterval = null; }
        scheduleReconnect();
      };
    }

    connectWs();
    return client;
  }

  // ------------------------------------------------------------------ Same-Origin HTTPS Port-443 Relay (/api/relay)
  function topicToRelayKey(topic) {
    return String(topic || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  }

  function closeSseRelay() {
    if (sseSource) {
      try { sseSource.close(); } catch (_) {}
      sseSource = null;
    }
    sseTopic = null;
    sseReady = false;
  }

  function openSseRelay(topic) {
    if (!canUseSameOriginRelay || typeof g.EventSource !== 'function') return;
    if (sseSource && sseTopic === topic) return;
    closeSseRelay();
    sseTopic = topic;
    try {
      var url = '/api/relay?topic=' + encodeURIComponent(topicToRelayKey(topic));
      sseSource = new g.EventSource(url);
      sseSource.addEventListener('open', function () {
        sseReady = true;
        onAnyTransportReady();
      });
      sseSource.onmessage = function (ev) {
        if (!ev || !ev.data) return;
        try {
          var env = JSON.parse(ev.data);
          if (env && env.event === 'message' && env.message) {
            handleRawPacket(topic, env.message);
          }
        } catch (_) {}
      };
      sseSource.onerror = function () {
        // EventSource auto-reconnects natively
      };
    } catch (_) {
      sseReady = false;
    }
  }

  function postSseRelay(topic, jsonStr) {
    if (!canUseSameOriginRelay || typeof g.fetch !== 'function') return;
    try {
      g.fetch('/api/relay?topic=' + encodeURIComponent(topicToRelayKey(topic)), {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: jsonStr,
        keepalive: false
      }).catch(function () {});
    } catch (_) {}
  }

  // ------------------------------------------------------------------ Direct WebRTC DataChannel Upgrade
  function closeWebRTC() {
    rtcReady = false;
    rtcStarted = false;
    rtcPendingIce = [];
    if (rtcDc) {
      try { rtcDc.close(); } catch (_) {}
      rtcDc = null;
    }
    if (rtcPc) {
      try { rtcPc.close(); } catch (_) {}
      rtcPc = null;
    }
  }

  function wireDataChannel(dc) {
    rtcDc = dc;
    dc.onopen = function () {
      rtcReady = true;
    };
    dc.onclose = function () {
      rtcReady = false;
    };
    dc.onerror = function () {
      rtcReady = false;
    };
    dc.onmessage = function (ev) {
      if (ev && typeof ev.data === 'string' && activeTopic) {
        handleRawPacket(activeTopic, ev.data);
      }
    };
  }

  function createPeerConn() {
    var RTC = g.RTCPeerConnection || g.webkitRTCPeerConnection;
    if (!RTC) return null;
    try {
      var pc = new RTC({ iceServers: ICE_SERVERS });
      pc.onicecandidate = function (ev) {
        if (ev && ev.candidate && connected && activeTopic && peerId) {
          publishSignaling(activeTopic, {
            t: 'rtc_ice',
            to: peerId,
            cand: ev.candidate.toJSON ? ev.candidate.toJSON() : {
              candidate: ev.candidate.candidate,
              sdpMid: ev.candidate.sdpMid,
              sdpMLineIndex: ev.candidate.sdpMLineIndex
            }
          });
        }
      };
      pc.ondatachannel = function (ev) {
        if (ev && ev.channel) wireDataChannel(ev.channel);
      };
      pc.onconnectionstatechange = function () {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          rtcReady = false;
        }
      };
      return pc;
    } catch (_) {
      return null;
    }
  }

  function startWebRTC() {
    if (rtcStarted || !connected || !peerId) return;
    rtcStarted = true;
    if (role !== 'host') return; // Host initiates the offer; Guest answers on rtc_offer
    rtcPc = createPeerConn();
    if (!rtcPc) return;
    try {
      var dc = rtcPc.createDataChannel('ironfists', { ordered: false, maxRetransmits: 0 });
      wireDataChannel(dc);
      rtcPc.createOffer().then(function (offer) {
        return rtcPc.setLocalDescription(offer).then(function () {
          if (connected && activeTopic && peerId) {
            publishSignaling(activeTopic, { t: 'rtc_offer', to: peerId, sdp: offer.sdp });
          }
        });
      }).catch(function () {});
    } catch (_) {}
  }

  function handleRtcOffer(sdp) {
    if (!connected || !peerId) return;
    if (!rtcPc) rtcPc = createPeerConn();
    if (!rtcPc) return;
    try {
      rtcPc.setRemoteDescription({ type: 'offer', sdp: sdp }).then(function () {
        flushPendingIce();
        return rtcPc.createAnswer();
      }).then(function (answer) {
        return rtcPc.setLocalDescription(answer).then(function () {
          if (connected && activeTopic && peerId) {
            publishSignaling(activeTopic, { t: 'rtc_answer', to: peerId, sdp: answer.sdp });
          }
        });
      }).catch(function () {});
    } catch (_) {}
  }

  function handleRtcAnswer(sdp) {
    if (!rtcPc) return;
    try {
      rtcPc.setRemoteDescription({ type: 'answer', sdp: sdp }).then(function () {
        flushPendingIce();
      }).catch(function () {});
    } catch (_) {}
  }

  function handleRtcIce(cand) {
    if (!cand) return;
    if (rtcPc && rtcPc.remoteDescription) {
      try { rtcPc.addIceCandidate(cand).catch(function () {}); } catch (_) {}
    } else {
      rtcPendingIce.push(cand);
    }
  }

  function flushPendingIce() {
    if (!rtcPc || !rtcPc.remoteDescription) return;
    while (rtcPendingIce.length > 0) {
      var c = rtcPendingIce.shift();
      try { rtcPc.addIceCandidate(c).catch(function () {}); } catch (_) {}
    }
  }

  // ------------------------------------------------------------------ Transport Coordination
  function ensureTransports() {
    if (!bc && g.BroadcastChannel) {
      try {
        bc = new g.BroadcastChannel('ironfists_net_v3');
        bc.onmessage = function (ev) {
          if (ev && ev.data && ev.data.topic && ev.data.payload) {
            handleRawPacket(ev.data.topic, ev.data.payload);
          }
        };
      } catch (_) {}
    }
    if (clients.length === 0 && g.WebSocket) {
      for (var i = 0; i < BROKERS.length; i++) {
        clients.push(createMqttSocket(BROKERS[i]));
      }
    }
  }

  function anyMqttConnected() {
    for (var i = 0; i < clients.length; i++) {
      if (clients[i].ready()) return true;
    }
    return false;
  }

  function anyTransportConnected() {
    return rtcReady || anyMqttConnected() || sseReady;
  }

  function onAnyTransportReady() {
    if (mode === 'room' && !connected) {
      if (role === 'host') {
        notifyStatus('waiting', 'Room ' + roomCode + ' ready! Waiting for friend to join...');
      } else {
        notifyStatus('connecting', 'Searching for Room ' + roomCode + '...');
      }
      sendHandshakePulse();
    } else if (mode === 'quick' && !connected) {
      notifyStatus('waiting', 'Searching for an online opponent...');
      sendHandshakePulse();
    }
  }

  function subscribeTopic(topic) {
    activeTopic = topic;
    ensureTransports();
    for (var i = 0; i < clients.length; i++) {
      clients[i].subscribe(topic);
    }
    openSseRelay(topic);
  }

  function publishSignaling(topic, obj) {
    obj.from = myId;
    obj.seq = ++txSeq;
    var jsonStr = JSON.stringify(obj);
    if (bc) {
      try { bc.postMessage({ topic: topic, payload: jsonStr }); } catch (_) {}
    }
    for (var i = 0; i < clients.length; i++) {
      clients[i].publish(topic, jsonStr);
    }
    postSseRelay(topic, jsonStr);
  }

  function publishTopic(topic, obj) {
    obj.from = myId;
    obj.seq = ++txSeq;
    var jsonStr = JSON.stringify(obj);
    var t = obj.t;
    var isHighFreq = (t === 'inp' || t === 'st' || t === 'pong');
    var isKeepalive = (t === 'keepalive');

    if (bc) {
      try { bc.postMessage({ topic: topic, payload: jsonStr }); } catch (_) {}
    }
    if (rtcReady && rtcDc && rtcDc.readyState === 'open' && topic === activeTopic) {
      try { rtcDc.send(jsonStr); } catch (_) {}
    }
    var mqttUp = anyMqttConnected();
    if (mqttUp) {
      for (var i = 0; i < clients.length; i++) {
        clients[i].publish(topic, jsonStr);
      }
    }

    // Use Same-Origin HTTPS Port-443 Relay for:
    //  - ALL control/menu/handshake/signaling messages (instant & firewall-proof!)
    //  - Gameplay fallback ONLY if BOTH WebRTC AND MQTT are blocked by the firewall
    if (canUseSameOriginRelay) {
      if (!isHighFreq && !isKeepalive) {
        postSseRelay(topic, jsonStr);
      } else if (!rtcReady && !mqttUp) {
        var now = Date.now();
        if (isKeepalive) {
          if (now - lastHttpKeepaliveTx >= 2200) {
            lastHttpKeepaliveTx = now;
            postSseRelay(topic, jsonStr);
          }
        } else if (now - lastHttpDataTx >= 165) {
          // ~6Hz fallback rate when ultra-strict firewall blocks both WebRTC & WSS
          lastHttpDataTx = now;
          postSseRelay(topic, jsonStr);
        }
      }
    }
  }

  function randomCode(len) {
    len = len || 4;
    var out = '';
    for (var i = 0; i < len; i++) {
      out += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
    }
    return out;
  }

  function notifyStatus(state, message, extra) {
    if (handlers.onStatus) {
      handlers.onStatus(Object.assign({
        state: state,
        message: message || '',
        role: role,
        roomCode: roomCode,
        connected: connected,
        ping: pingMs
      }, extra || {}));
    }
  }

  function resetRemoteInput() {
    remoteHold.left = false;
    remoteHold.right = false;
    remoteHold.block = false;
    remoteEdge.jab = false;
    remoteEdge.hook = false;
    remoteEdge.uppercut = false;
    remoteEdge.dodge = false;
    remoteEdge.combo = false;
    remotePresses = 0;
  }

  function clearHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function startHeartbeat() {
    clearHeartbeat();
    heartbeatTimer = setInterval(function () {
      if (mode === 'idle') return;
      if (!connected) {
        sendHandshakePulse();
      } else {
        // Send keepalive & check if opponent timed out (15 seconds without any packet)
        publishTopic(activeTopic, { t: 'keepalive', to: peerId });
        if (lastRxTime > 0 && Date.now() - lastRxTime > 15000) {
          var wasConn = connected;
          disconnect(true);
          notifyStatus('disconnected', 'Opponent disconnected.');
          if (wasConn && handlers.onDisconnected) {
            handlers.onDisconnected('Opponent disconnected.');
          }
        }
      }
    }, 650);
  }

  function sendHandshakePulse() {
    if (!activeTopic || connected) return;
    if (mode === 'quick') {
      publishSignaling(TOPIC_LOBBY, { t: 'seek', ts: seekTs });
    } else if (mode === 'room') {
      publishSignaling(activeTopic, { t: 'hello', role: role, ts: seekTs, code: roomCode });
    }
  }

  function finalizeConnection(assignedRole, remotePeerId, code) {
    if (connected) return;
    role = assignedRole;
    peerId = remotePeerId;
    roomCode = code;
    mode = 'room';
    connected = true;
    lastRxTime = Date.now();
    resetRemoteInput();

    var roomTopic = TOPIC_ROOM_PREFIX + roomCode;
    if (activeTopic !== roomTopic) {
      subscribeTopic(roomTopic);
    }
    publishSignaling(roomTopic, { t: 'ack_conn', to: peerId, role: role });

    // Upgrade to direct WebRTC DataChannel in the background (works on school Wi-Fi!)
    setTimeout(startWebRTC, 150);

    notifyStatus('connected', 'Opponent connected!');
    if (handlers.onConnected) {
      handlers.onConnected({ role: role, roomCode: roomCode });
    }
  }

  function handleRawPacket(topic, msgStr) {
    if (topic === TOPIC_LEADERBOARD) {
      var lb;
      try { lb = JSON.parse(msgStr); } catch (_) { return; }
      if (lb && Array.isArray(lb.top3) && handlers.onLeaderboard) {
        handlers.onLeaderboard(lb.top3);
      }
      return;
    }
    if (mode === 'idle' || topic !== activeTopic) return;
    var msg;
    try { msg = JSON.parse(msgStr); } catch (_) { return; }
    if (!msg || !msg.from || msg.from === myId) return;

    // Deduplicate across parallel transports using sender sequence numbers
    if (typeof msg.seq === 'number') {
      var prevSeq = seenSeq[msg.from] || 0;
      if (msg.seq <= prevSeq) return;
      seenSeq[msg.from] = msg.seq;
    }

    // If already paired with a specific peer, ignore packets from anyone else
    if (connected && peerId && msg.from !== peerId) return;
    if (msg.to && msg.to !== myId) return;

    lastRxTime = Date.now();

    // 1. Quick Match lobby pairing
    if (mode === 'quick' && !connected) {
      if (msg.t === 'seek') {
        var iAmHost = (seekTs < msg.ts) || (seekTs === msg.ts && myId < msg.from);
        if (iAmHost) {
          var newCode = 'Q' + randomCode(3);
          publishSignaling(TOPIC_LOBBY, { t: 'pair', to: msg.from, code: newCode });
          finalizeConnection('host', msg.from, newCode);
        }
      } else if (msg.t === 'pair' && msg.to === myId && msg.code) {
        finalizeConnection('guest', msg.from, msg.code);
      }
      return;
    }

    // 2. Room Code pairing (works even if both friends clicked Join or both clicked Host with same code!)
    if (mode === 'room' && !connected) {
      if (msg.t === 'hello') {
        var myHost;
        if (role === 'host' && msg.role === 'guest') myHost = true;
        else if (role === 'guest' && msg.role === 'host') myHost = false;
        else myHost = (seekTs < msg.ts) || (seekTs === msg.ts && myId < msg.from);

        if (myHost) {
          publishSignaling(activeTopic, { t: 'welcome', to: msg.from, code: roomCode });
          finalizeConnection('host', msg.from, roomCode);
        } else {
          publishSignaling(activeTopic, { t: 'hello', role: 'guest', ts: seekTs, code: roomCode });
        }
      } else if (msg.t === 'welcome' && msg.to === myId) {
        finalizeConnection('guest', msg.from, roomCode);
      } else if (msg.t === 'ack_conn' && msg.to === myId) {
        var myAssignedRole = msg.role === 'host' ? 'guest' : 'host';
        finalizeConnection(myAssignedRole, msg.from, roomCode);
      }
      return;
    }

    // 3. In-session messages between connected Host and Guest
    switch (msg.t) {
      case 'ack_conn':
        break;

      case 'rtc_offer':
        if (msg.sdp) handleRtcOffer(msg.sdp);
        break;

      case 'rtc_answer':
        if (msg.sdp) handleRtcAnswer(msg.sdp);
        break;

      case 'rtc_ice':
        if (msg.cand) handleRtcIce(msg.cand);
        break;

      case 'leave':
        var wasConn = connected;
        disconnect(true);
        notifyStatus('disconnected', 'Opponent left the room.');
        if (wasConn && handlers.onDisconnected) {
          handlers.onDisconnected('Opponent left the room.');
        }
        break;

      case 'inp':
        remoteHold.left = !!msg.l;
        remoteHold.right = !!msg.r;
        remoteHold.block = !!msg.b;
        if (msg.j) remoteEdge.jab = true;
        if (msg.h) remoteEdge.hook = true;
        if (msg.u) remoteEdge.uppercut = true;
        if (msg.d) remoteEdge.dodge = true;
        if (msg.c) remoteEdge.combo = true;
        if (typeof msg.p === 'number' && msg.p > 0) {
          remotePresses += (msg.p | 0);
        }
        if (msg.ts) lastGuestTs = msg.ts;
        break;

      case 'st':
        if (msg.ack && msg.ack > 0) {
          var rtt = Date.now() - msg.ack;
          if (rtt >= 0 && rtt < 5000) {
            pingMs = pingMs === 0 ? rtt : Math.round(pingMs * 0.8 + rtt * 0.2);
          }
          send({ t: 'pong', ping: pingMs });
        }
        if (handlers.onStateSnapshot && msg.s) {
          handlers.onStateSnapshot(msg.s, msg.ev || [], msg.hi || null);
        }
        break;

      case 'pong':
        if (typeof msg.ping === 'number') pingMs = msg.ping;
        break;

      case 'sel':
        if (handlers.onRemoteSelect) handlers.onRemoteSelect(msg.slot, msg.boxer);
        break;

      case 'ready':
        if (handlers.onRemoteReady) handlers.onRemoteReady(!!msg.ready);
        break;

      case 'start':
        if (handlers.onMatchStart) handlers.onMatchStart(msg);
        break;

      case 'skip_rest':
        if (handlers.onSkipRest) handlers.onSkipRest();
        break;

      case 'rematch':
        if (handlers.onRematchRequest) handlers.onRematchRequest();
        break;
    }
  }

  function disconnect(silent) {
    if (connected && activeTopic && peerId) {
      try { publishSignaling(activeTopic, { t: 'leave', to: peerId }); } catch (_) {}
    }
    var wasConnected = connected;
    connected = false;
    mode = 'idle';
    role = null;
    peerId = null;
    roomCode = '';
    activeTopic = null;
    pingMs = 0;
    lastRxTime = 0;
    clearHeartbeat();
    closeWebRTC();
    closeSseRelay();
    resetRemoteInput();
    if (!silent && wasConnected && handlers.onDisconnected) {
      handlers.onDisconnected('Connection closed.');
    }
  }

  function hostRoom(customCode) {
    disconnect(true);
    mode = 'room';
    role = 'host';
    seekTs = Date.now();
    roomCode = (customCode || randomCode(4)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    subscribeTopic(TOPIC_ROOM_PREFIX + roomCode);
    startHeartbeat();
    if (anyTransportConnected()) {
      notifyStatus('waiting', 'Room ' + roomCode + ' ready! Share the code or invite link.');
      sendHandshakePulse();
    } else {
      notifyStatus('connecting', 'Opening Room ' + roomCode + '...');
    }
  }

  function joinRoom(code) {
    var clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean || clean.length < 2) {
      notifyStatus('error', 'Enter a Room Code first (e.g. 4 letters/numbers).');
      return;
    }
    disconnect(true);
    mode = 'room';
    role = 'guest';
    seekTs = Date.now();
    roomCode = clean;
    subscribeTopic(TOPIC_ROOM_PREFIX + roomCode);
    startHeartbeat();
    if (anyTransportConnected()) {
      notifyStatus('connecting', 'Joining Room ' + roomCode + '...');
      sendHandshakePulse();
    } else {
      notifyStatus('connecting', 'Connecting to Room ' + roomCode + '...');
    }
  }

  function quickMatch() {
    disconnect(true);
    mode = 'quick';
    role = 'host';
    roomCode = 'QUICK';
    seekTs = Date.now();
    subscribeTopic(TOPIC_LOBBY);
    startHeartbeat();
    if (anyTransportConnected()) {
      notifyStatus('waiting', 'Searching for an online opponent...');
      sendHandshakePulse();
    } else {
      notifyStatus('connecting', 'Connecting to matchmaking lobby...');
    }
  }

  function send(obj) {
    if (!connected || !activeTopic) return;
    if (peerId) obj.to = peerId;
    publishTopic(activeTopic, obj);
  }

  function sendGuestInput(inp) {
    if (!connected || role !== 'guest') return;
    var now = Date.now();
    var includeTs = (now - lastPingSent >= 300) ? now : 0;
    if (includeTs) lastPingSent = now;
    send({
      t: 'inp',
      l: !!inp.left,
      r: !!inp.right,
      b: !!inp.block,
      j: !!inp.jab,
      h: !!inp.hook,
      u: !!inp.uppercut,
      d: !!inp.dodge,
      c: !!inp.combo,
      p: inp.presses || 0,
      ts: includeTs
    });
  }

  function consumeRemoteInput() {
    var out = {
      left: remoteHold.left,
      right: remoteHold.right,
      block: remoteHold.block,
      jab: remoteEdge.jab,
      hook: remoteEdge.hook,
      uppercut: remoteEdge.uppercut,
      dodge: remoteEdge.dodge,
      combo: remoteEdge.combo,
      presses: remotePresses
    };
    remoteEdge.jab = false;
    remoteEdge.hook = false;
    remoteEdge.uppercut = false;
    remoteEdge.dodge = false;
    remoteEdge.combo = false;
    remotePresses = 0;
    return out;
  }

  function slimFighter(f) {
    var out = {}, k;
    for (k in f) {
      if (k !== 'p' && k !== 'assist') out[k] = f[k];
    }
    return out;
  }

  function sendHostState(state, events, hostInp) {
    if (!connected || role !== 'host') return;
    stepSendCount++;
    var hasEvents = events && events.length > 0;
    if (!hasEvents && !state.comboState && !state.count && (stepSendCount % 2 === 1)) return;

    var ack = lastGuestTs;
    lastGuestTs = 0;
    var slim = {
      tick: state.tick, rng: state.rng, phase: state.phase, phaseT: state.phaseT,
      round: state.round, clock: state.clock,
      fighters: [slimFighter(state.fighters[0]), slimFighter(state.fighters[1])],
      count: state.count, comboState: state.comboState,
      hitstop: state.hitstop, slowmo: state.slowmo, timeScale: state.timeScale,
      rounds: state.rounds, result: state.result, boxers: state.boxers
    };
    send({
      t: 'st',
      s: slim,
      hi: hostInp ? { l: !!hostInp.left, r: !!hostInp.right, b: !!hostInp.block } : null,
      ev: events || [],
      ack: ack
    });
  }

  function syncLeaderboard() {
    ensureTransports();
  }

  function publishLeaderboard(top3Array) {
    ensureTransports();
    var jsonStr = JSON.stringify({ top3: top3Array, ts: Date.now() });
    pendingLeaderboardJson = jsonStr;
    if (bc) {
      try { bc.postMessage({ topic: TOPIC_LEADERBOARD, payload: jsonStr }); } catch (_) {}
    }
    for (var i = 0; i < clients.length; i++) {
      clients[i].publish(TOPIC_LEADERBOARD, jsonStr, true);
    }
  }

  g.Net = {
    setHandlers: function (h) {
      for (var k in h) {
        if (handlers.hasOwnProperty(k)) handlers[k] = h[k];
      }
    },
    hostRoom: hostRoom,
    joinRoom: joinRoom,
    quickMatch: quickMatch,
    disconnect: disconnect,
    send: send,
    sendGuestInput: sendGuestInput,
    consumeRemoteInput: consumeRemoteInput,
    sendHostState: sendHostState,
    syncLeaderboard: syncLeaderboard,
    publishLeaderboard: publishLeaderboard,
    isConnected: function () { return connected; },
    getRole: function () { return role; },
    getRoomCode: function () { return roomCode; },
    getPing: function () { return pingMs; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
