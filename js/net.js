/* net.js - WebRTC Peer-to-Peer Online Multiplayer Manager (PeerJS).
 *
 * Supports:
 *   1. Host Room (generates a 4-character Room Code + shareable ?room=CODE invite link)
 *   2. Join Room (connects to a 4-character Room Code)
 *   3. Quick Match (auto-pairs waiting players via a deterministic public lobby pool)
 *
 * Host is Fighter 0 (Red Corner, left); Guest is Fighter 1 (Blue Corner, right).
 * Both players use their standard Player 1 controls (keyboard or mobile touch pad).
 * Edge-triggered inputs (jab, hook, uppercut, dodge, combo, get-up presses) from the Guest
 * are latched on arrival so no quick tap is ever lost between 60Hz simulation steps.
 */
(function (g) {
  'use strict';

  var ROOM_PREFIX = 'ironfists-v1-room-';
  var QUICK_PREFIX = 'ironfists-v1-quick-';
  var QUICK_SLOTS = 4;
  var CODE_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

  var peer = null;
  var conn = null;
  var role = null;           // 'host' | 'guest' | null
  var roomCode = '';
  var connected = false;
  var pingMs = 0;
  var lastGuestTs = 0;
  var lastPingSent = 0;

  // Latched remote input state (for Host consuming Guest's inputs at 60Hz)
  var remoteHold = { left: false, right: false, block: false };
  var remoteEdge = { jab: false, hook: false, uppercut: false, dodge: false, combo: false };
  var remotePresses = 0;

  // Callbacks wired by main.js
  var handlers = {
    onStatus: null,          // function(statusObj)
    onConnected: null,       // function(info)
    onDisconnected: null,    // function(reason)
    onRemoteSelect: null,    // function(slot, boxerId)
    onRemoteReady: null,     // function(readyBool)
    onMatchStart: null,      // function(payload)
    onStateSnapshot: null,   // function(state, events)
    onSkipRest: null,        // function()
    onRematchRequest: null   // function()
  };

  var peerScriptLoading = false;
  var peerScriptCallbacks = [];

  function ensurePeerJS(cb) {
    if (g.Peer) { cb(true); return; }
    peerScriptCallbacks.push(cb);
    if (peerScriptLoading) return;
    peerScriptLoading = true;

    function tryLoad(url, fallbackUrl) {
      var s = document.createElement('script');
      s.src = url;
      s.async = true;
      s.onload = function () {
        peerScriptLoading = false;
        var list = peerScriptCallbacks.slice();
        peerScriptCallbacks = [];
        for (var i = 0; i < list.length; i++) list[i](!!g.Peer);
      };
      s.onerror = function () {
        if (fallbackUrl) {
          tryLoad(fallbackUrl, null);
        } else {
          peerScriptLoading = false;
          var list = peerScriptCallbacks.slice();
          peerScriptCallbacks = [];
          for (var i = 0; i < list.length; i++) list[i](false);
        }
      };
      document.head.appendChild(s);
    }

    tryLoad(
      'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
      'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'
    );
  }

  function peerConfig() {
    return {
      debug: 0,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' }
        ]
      }
    };
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

  function disconnect(silent) {
    var wasConnected = connected;
    connected = false;
    resetRemoteInput();
    if (conn) {
      try { conn.close(); } catch (_) {}
      conn = null;
    }
    if (peer) {
      try { peer.destroy(); } catch (_) {}
      peer = null;
    }
    role = null;
    roomCode = '';
    pingMs = 0;
    if (!silent && wasConnected && handlers.onDisconnected) {
      handlers.onDisconnected('Connection closed');
    }
  }

  function wireConnection(c) {
    conn = c;
    c.on('open', function () {
      connected = true;
      resetRemoteInput();
      // If Host was occupying a public Quick Match lobby slot, disconnect from broker
      // so the slot ID is immediately freed for the next pair of players while keeping P2P open.
      if (role === 'host' && roomCode === 'QUICK' && peer && !peer.disconnected) {
        try { peer.disconnect(); } catch (_) {}
      }
      notifyStatus('connected', 'Opponent connected!');
      if (handlers.onConnected) {
        handlers.onConnected({ role: role, roomCode: roomCode });
      }
    });

    c.on('data', function (msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.t) {
        case 'inp':
          // Guest input arriving at Host: update hold states and latch edge triggers
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
          // Host simulation state + events arriving at Guest
          if (msg.ack && msg.ack > 0) {
            var rtt = Date.now() - msg.ack;
            if (rtt >= 0 && rtt < 5000) {
              pingMs = pingMs === 0 ? rtt : Math.round(pingMs * 0.8 + rtt * 0.2);
            }
            send({ t: 'pong', ping: pingMs });
          }
          if (handlers.onStateSnapshot && msg.s) {
            handlers.onStateSnapshot(msg.s, msg.ev || []);
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
    });

    c.on('close', function () {
      var wasConn = connected;
      disconnect(true);
      notifyStatus('disconnected', 'Opponent disconnected.');
      if (wasConn && handlers.onDisconnected) {
        handlers.onDisconnected('Opponent disconnected.');
      }
    });

    c.on('error', function () {
      var wasConn = connected;
      disconnect(true);
      notifyStatus('error', 'Connection error.');
      if (wasConn && handlers.onDisconnected) {
        handlers.onDisconnected('Connection lost.');
      }
    });
  }

  function hostRoom(customCode) {
    disconnect(true);
    role = 'host';
    roomCode = (customCode || randomCode(4)).toUpperCase().replace(/[^A-Z0-9]/g, '');
    notifyStatus('connecting', 'Creating room ' + roomCode + '...');

    ensurePeerJS(function (ok) {
      if (!ok) {
        notifyStatus('error', 'Could not load WebRTC networking library. Check internet connection.');
        return;
      }
      var peerId = ROOM_PREFIX + roomCode;
      var p = new g.Peer(peerId, peerConfig());
      peer = p;

      p.on('open', function () {
        notifyStatus('waiting', 'Waiting for opponent to join room ' + roomCode + '...');
      });

      p.on('connection', function (c) {
        if (conn && connected) {
          c.on('open', function () { c.close(); });
          return;
        }
        wireConnection(c);
      });

      p.on('error', function (err) {
        if (err && err.type === 'unavailable-id') {
          // Room code collision: try a fresh code
          hostRoom(randomCode(4));
          return;
        }
        notifyStatus('error', 'Network error: ' + (err && err.type ? err.type : 'failed'));
      });
    });
  }

  function joinRoom(code) {
    var clean = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean || clean.length < 3) {
      notifyStatus('error', 'Enter a valid 4-character Room Code.');
      return;
    }
    disconnect(true);
    role = 'guest';
    roomCode = clean;
    notifyStatus('connecting', 'Joining room ' + roomCode + '...');

    ensurePeerJS(function (ok) {
      if (!ok) {
        notifyStatus('error', 'Could not load WebRTC networking library. Check internet connection.');
        return;
      }
      var p = new g.Peer(peerConfig());
      peer = p;

      p.on('open', function () {
        var c = p.connect(ROOM_PREFIX + roomCode, { reliable: true });
        wireConnection(c);
      });

      p.on('error', function (err) {
        if (err && err.type === 'peer-unavailable') {
          notifyStatus('error', 'Room "' + roomCode + '" not found. Check the code and try again.');
        } else {
          notifyStatus('error', 'Could not connect: ' + (err && err.type ? err.type : 'error'));
        }
      });
    });
  }

  function quickMatch() {
    disconnect(true);
    roomCode = 'QUICK';
    notifyStatus('connecting', 'Searching for an online opponent...');

    ensurePeerJS(function (ok) {
      if (!ok) {
        notifyStatus('error', 'Could not load WebRTC networking library. Check internet connection.');
        return;
      }
      tryQuickSlot(0);
    });
  }

  function tryQuickSlot(slotIdx) {
    if (slotIdx >= QUICK_SLOTS) slotIdx = 0;
    var slotId = QUICK_PREFIX + slotIdx;
    role = 'host';
    var p = new g.Peer(slotId, peerConfig());
    peer = p;

    p.on('open', function () {
      notifyStatus('waiting', 'In matchmaking queue... Waiting for opponent...');
    });

    p.on('connection', function (c) {
      if (conn && connected) {
        c.on('open', function () { c.close(); });
        return;
      }
      wireConnection(c);
    });

    p.on('error', function (err) {
      if (err && err.type === 'unavailable-id') {
        // Someone is already waiting in this slot! Connect to them as Guest!
        try { p.destroy(); } catch (_) {}
        role = 'guest';
        notifyStatus('connecting', 'Opponent found! Connecting...');
        var guestPeer = new g.Peer(peerConfig());
        peer = guestPeer;
        var settled = false;
        var fallbackTimer = setTimeout(function () {
          if (!settled && !connected) {
            settled = true;
            try { guestPeer.destroy(); } catch (_) {}
            tryQuickSlot((slotIdx + 1) % QUICK_SLOTS);
          }
        }, 4500);

        guestPeer.on('open', function () {
          var c = guestPeer.connect(slotId, { reliable: true });
          c.on('open', function () {
            settled = true;
            clearTimeout(fallbackTimer);
          });
          wireConnection(c);
        });

        guestPeer.on('error', function () {
          if (!settled && !connected) {
            settled = true;
            clearTimeout(fallbackTimer);
            try { guestPeer.destroy(); } catch (_) {}
            tryQuickSlot((slotIdx + 1) % QUICK_SLOTS);
          }
        });
      } else {
        notifyStatus('error', 'Matchmaking error: ' + (err && err.type ? err.type : 'failed'));
      }
    });
  }

  function send(obj) {
    if (conn && connected) {
      try { conn.send(obj); } catch (_) {}
    }
  }

  function sendGuestInput(inp) {
    if (!connected || role !== 'guest') return;
    var now = Date.now();
    var includeTs = (now - lastPingSent >= 250) ? now : 0;
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

  function sendHostState(state, events) {
    if (!connected || role !== 'host') return;
    var ack = lastGuestTs;
    lastGuestTs = 0;
    send({
      t: 'st',
      s: state,
      ev: events || [],
      ack: ack
    });
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
    isConnected: function () { return connected; },
    getRole: function () { return role; },
    getRoomCode: function () { return roomCode; },
    getPing: function () { return pingMs; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
