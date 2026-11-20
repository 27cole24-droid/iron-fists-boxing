/* main.js - UI screens, renderer switching, fixed-timestep accumulator loop, debug overlay, and self-test. */
(function (g) {
  'use strict';
  var C = g.Config, Boxers = g.Boxers, Sim = g.Sim, AI = g.AI, Input = g.Input, Audio = g.GameAudio, Net = g.Net;

  var DIFF_KEY = 'ironFistsDifficulty';
  var PROFILE_KEY = 'ironFistsEloProfile_v1';
  var LB_KEY = 'ironFistsTop3Leaderboard_v1';

  function loadDifficulty() {
    try {
      var v = window.localStorage.getItem(DIFF_KEY);
      if (v === 'easy' || v === 'normal' || v === 'hard') return v;
    } catch (_) {}
    return 'easy';
  }
  function saveDifficulty(v) { try { window.localStorage.setItem(DIFF_KEY, v); } catch (_) {} }

  function loadProfile() {
    try {
      var raw = window.localStorage.getItem(PROFILE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        if (p && p.id && typeof p.elo === 'number') return p;
      }
    } catch (_) {}
    var def = {
      id: 'p_' + Math.random().toString(36).slice(2, 9),
      name: 'BOXER-' + Math.floor(100 + Math.random() * 900),
      elo: 1000,
      wins: 0
    };
    saveProfile(def);
    return def;
  }

  function saveProfile(p) {
    try { window.localStorage.setItem(PROFILE_KEY, JSON.stringify(p)); } catch (_) {}
  }

  var DEFAULT_TOP3 = [
    { id: 'seed_1', name: 'IRON CHAMP', elo: 1050, wins: 2 },
    { id: 'seed_2', name: 'CONTENDER', elo: 1025, wins: 1 },
    { id: 'seed_3', name: 'ROOKIE KING', elo: 1000, wins: 0 }
  ];

  function loadLeaderboard() {
    try {
      var raw = window.localStorage.getItem(LB_KEY);
      if (raw) {
        var arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return arr.slice(0, 3);
      }
    } catch (_) {}
    return DEFAULT_TOP3.slice();
  }

  function saveLeaderboard(arr) {
    try { window.localStorage.setItem(LB_KEY, JSON.stringify(arr.slice(0, 3))); } catch (_) {}
  }

  var app = {
    screen: 'title',          // 'title' | 'select' | 'fight'
    vsMode: 'cpu',            // 'cpu' | '2p' | 'online'
    difficulty: loadDifficulty(), // 'easy' (default) | 'normal' (Medium) | 'hard' -- remembered in localStorage
    renderMode: '2d',         // '2d' | '3d'
    selected: ['viper', 'hammer'],
    paused: false,
    debugOpen: false,
    resultShown: false,
    seedCounter: 101,

    renderer: null,
    simState: null,
    prevSimState: null,
    ai0: null,
    ai1: null,
    lastStepInputs: [
      { left: false, right: false, jab: false, hook: false, uppercut: false, block: false, dodge: false, combo: false, presses: 0 },
      { left: false, right: false, jab: false, hook: false, uppercut: false, block: false, dodge: false, combo: false, presses: 0 }
    ],
    comboGrades: [],
    priorKOs: [0, 0],
    onlineEventsQueue: [],
    guestReady: false,
    profile: loadProfile(),
    leaderboard: loadLeaderboard(),
    accumulator: 0,
    lastFrameTime: 0,
    bannerTimer: 0,
    lastRoundCard: null
  };

  function $(id) { return document.getElementById(id); }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function mergeAndRenderLeaderboard(incomingList, shouldPublish) {
    var byId = {};
    var pool = DEFAULT_TOP3.concat(app.leaderboard || []).concat(incomingList || []);
    if (app.profile && app.profile.id) {
      pool.push({
        id: app.profile.id,
        name: app.profile.name,
        elo: app.profile.elo,
        wins: app.profile.wins || 0
      });
    }
    for (var i = 0; i < pool.length; i++) {
      var item = pool[i];
      if (!item || !item.id || typeof item.elo !== 'number') continue;
      var prev = byId[item.id];
      if (!prev || item.elo > prev.elo || (item.elo === prev.elo && item.id === app.profile.id)) {
        byId[item.id] = {
          id: String(item.id).slice(0, 24),
          name: String(item.name || 'BOXER').toUpperCase().slice(0, 14),
          elo: Math.round(item.elo),
          wins: item.wins | 0
        };
      }
    }
    var list = Object.keys(byId).map(function (k) { return byId[k]; });
    list.sort(function (a, b) {
      if (b.elo !== a.elo) return b.elo - a.elo;
      return (b.wins || 0) - (a.wins || 0);
    });
    app.leaderboard = list.slice(0, 3);
    saveLeaderboard(app.leaderboard);
    renderLeaderboardUI();
    if (shouldPublish && Net && Net.publishLeaderboard) {
      Net.publishLeaderboard(app.leaderboard);
    }
  }

  function renderLeaderboardUI() {
    var p = app.profile;
    var badge1 = $('player-elo-badge');
    if (badge1) badge1.textContent = 'ELO: ' + p.elo;
    var badge2 = $('net-your-elo');
    if (badge2) badge2.textContent = 'YOUR ELO: ' + p.elo;
    var nameInp = $('inp-player-name');
    if (nameInp && document.activeElement !== nameInp) {
      nameInp.value = p.name;
    }

    var medals = ['🥇 #1', '🥈 #2', '🥉 #3'];
    var titleList = $('lb-title-list');
    if (titleList) {
      titleList.innerHTML = app.leaderboard.slice(0, 3).map(function (entry, idx) {
        var isMe = entry.id === p.id;
        return '<div class="lb-row rank-' + (idx + 1) + '">' +
          '<div class="lb-row-top">' +
            '<span class="lb-rank">' + medals[idx] + '</span>' +
            '<span class="lb-score">' + entry.elo + ' ELO</span>' +
          '</div>' +
          '<div class="lb-name">' + escapeHtml(entry.name) + (isMe ? ' (YOU)' : '') + '</div>' +
        '</div>';
      }).join('');
    }

    var onlineList = $('lb-online-list');
    if (onlineList) {
      onlineList.innerHTML = app.leaderboard.slice(0, 3).map(function (entry, idx) {
        return '<span class="lb-inline-pill">' + medals[idx] + ' ' + escapeHtml(entry.name) +
          '<strong>' + entry.elo + '</strong></span>';
      }).join('');
    }
  }
  function copyInput(inp) {
    inp = inp || {};
    var out = {
      left: !!inp.left, right: !!inp.right,
      jab: !!inp.jab, hook: !!inp.hook, uppercut: !!inp.uppercut,
      block: !!inp.block, dodge: !!inp.dodge, combo: !!inp.combo,
      presses: (typeof inp.presses === 'number' && inp.presses > 0) ? (inp.presses | 0) : 0
    };
    if (inp.cpuDiff) out.cpuDiff = inp.cpuDiff;
    return out;
  }

  // ------------------------------------------------------------------ Renderer registry & hot-swap
  function getRendererRegistry() {
    var reg = { '2d': g.Renderer2D };
    if (g.Renderer3D) reg['3d'] = g.Renderer3D;
    return reg;
  }

  function switchRenderer(mode) {
    var reg = getRendererRegistry();
    if (!reg[mode]) return;
    var stage = $('stage');
    if (app.renderer) {
      app.renderer.destroy();
      app.renderer = null;
    }
    app.renderMode = mode;
    app.renderer = reg[mode].create();
    app.renderer.init(stage);
    $('btn-mode-2d').classList.toggle('active', mode === '2d');
    $('btn-mode-3d').classList.toggle('active', mode === '3d');
    if (app.simState) {
      app.renderer.render(app.simState, [], 1, app.prevSimState || app.simState);
    }
  }

  function sync3DButtonAvailability() {
    var btn3d = $('btn-mode-3d');
    if (g.Renderer3D) {
      btn3d.disabled = false;
      btn3d.innerHTML = '3D RING';
    } else {
      btn3d.disabled = true;
      btn3d.innerHTML = '3D <span class="soon-tag">Coming Soon</span>';
    }
  }

  // ------------------------------------------------------------------ Screen transitions
  function showScreen(name) {
    Input.reset();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    app.screen = name;
    document.body.classList.toggle('in-fight', name === 'fight');
    if (app.renderer) app.renderer.resize();
    $('screen-title').classList.toggle('active', name === 'title');
    $('screen-select').classList.toggle('active', name === 'select');
    $('screen-hud').classList.toggle('active', name === 'fight');
    hideModals();
    if (name === 'title') {
      app.priorKOs = [0, 0];
      startAttractFight();
    } else if (name === 'select') {
      app.priorKOs = [0, 0];
      renderSelectScreen();
    }
  }

  function hideModals() {
    $('modal-pause').classList.remove('show');
    $('modal-how').classList.remove('show');
    $('modal-result').classList.remove('show');
    app.paused = false;
  }

  // ------------------------------------------------------------------ Attract demo fight behind Title
  function startAttractFight() {
    var b0 = Boxers.list[0].id, b1 = Boxers.list[1].id;
    app.simState = Sim.create({ boxers: [b0, b1], seed: 777 });
    app.prevSimState = app.simState;
    app.ai0 = AI.create({ index: 0, boxerId: b0, difficulty: 'normal', seed: 11 });
    app.ai1 = AI.create({ index: 1, boxerId: b1, difficulty: 'normal', seed: 22 });
    app.accumulator = 0;
  }

  // ------------------------------------------------------------------ Boxer Select Screen
  var STAT_LABELS = [
    ['speed', 'Speed'],
    ['power', 'Power'],
    ['stamina', 'Stamina'],
    ['chin', 'Chin'],
    ['reach', 'Reach']
  ];

  function buildRosterStrip(slot) {
    var wrap = $(slot === 0 ? 'p1-roster' : 'p2-roster');
    wrap.innerHTML = '';
    var netConn = app.vsMode === 'online' && Net && Net.isConnected();
    var netRole = netConn ? Net.getRole() : null;
    var slotLocked = netConn && ((netRole === 'host' && slot === 1) || (netRole === 'guest' && slot === 0));

    Boxers.list.forEach(function (b) {
      var btn = document.createElement('button');
      btn.className = 'roster-card' +
        (app.selected[slot] === b.id ? ' selected' : '') +
        (slotLocked ? ' locked' : '');
      btn.innerHTML =
        '<div class="rc-dot" style="background:' + b.look.glove + ';border-color:' + b.look.trunks + '"></div>' +
        '<div class="rc-name">' + b.nick.replace('The ', '') + '</div>' +
        '<div class="rc-style">' + b.style.split(' ').slice(-1)[0] + '</div>';
      btn.addEventListener('click', function () {
        if (slotLocked) return;
        if (Audio) Audio.resume();
        app.selected[slot] = b.id;
        if (netConn) {
          Net.send({ t: 'sel', slot: slot, boxer: b.id });
        }
        renderSelectScreen();
        btn.blur();
      });
      wrap.appendChild(btn);
    });
  }

  function fillFighterPanel(slot) {
    var prefix = slot === 0 ? 'p1' : 'p2';
    var b = Boxers.byId(app.selected[slot]);
    $(prefix + '-flag').style.background = b.country.css;
    $(prefix + '-country').textContent = b.country.name;
    $(prefix + '-style').textContent = b.style;
    $(prefix + '-name').textContent = b.name;
    $(prefix + '-nick').textContent = '"' + b.nick + '"';
    $(prefix + '-bio').textContent = b.bio;

    var statsEl = $(prefix + '-stats');
    statsEl.innerHTML = STAT_LABELS.map(function (pair) {
      var val = b.stats[pair[0]] || 5;
      return '<div class="stat-row">' +
        '<span class="lbl">' + pair[1] + '</span>' +
        '<div class="stat-track"><div class="stat-fill" style="width:' + (val * 10) + '%"></div></div>' +
        '<span>' + val + '</span>' +
      '</div>';
    }).join('');
  }

  function renderSelectScreen() {
    var isOnline = app.vsMode === 'online';
    var netConn = isOnline && Net && Net.isConnected();
    var netRole = netConn ? Net.getRole() : null;

    var p1Tag = $('p1-corner-tag');
    if (p1Tag) {
      p1Tag.textContent = isOnline
        ? (netConn ? (netRole === 'host' ? 'RED CORNER • YOU (HOST)' : 'RED CORNER • HOST') : 'RED CORNER • HOST (P1)')
        : 'RED CORNER • P1';
    }
    $('p2-corner-tag').textContent = isOnline
      ? (netConn ? (netRole === 'guest' ? 'BLUE CORNER • YOU (GUEST)' : 'BLUE CORNER • OPPONENT') : 'BLUE CORNER • GUEST (P2)')
      : (app.vsMode === '2p' ? 'BLUE CORNER • P2' : 'BLUE CORNER • CPU');

    $('seg-diff').style.display = app.vsMode === 'cpu' ? 'inline-flex' : 'none';
    var onlinePanel = $('online-panel');
    if (onlinePanel) onlinePanel.style.display = isOnline ? 'flex' : 'none';

    var startBtn = $('btn-start-fight');
    if (startBtn) {
      if (isOnline) {
        if (!netConn) {
          startBtn.textContent = 'CONNECT ONLINE ABOVE FIRST';
          startBtn.disabled = true;
          startBtn.style.opacity = '0.5';
        } else if (netRole === 'guest') {
          startBtn.textContent = app.guestReady ? '✓ READY! WAITING FOR HOST...' : 'TAP WHEN READY 🔔';
          startBtn.disabled = false;
          startBtn.style.opacity = app.guestReady ? '0.8' : '1';
        } else {
          startBtn.textContent = (app.guestReady ? 'OPPONENT READY — START FIGHT 🔔' : 'START ONLINE FIGHT 🔔');
          startBtn.disabled = false;
          startBtn.style.opacity = '1';
        }
      } else {
        startBtn.textContent = 'START FIGHT 🔔';
        startBtn.disabled = false;
        startBtn.style.opacity = '1';
      }
    }

    buildRosterStrip(0);
    buildRosterStrip(1);
    fillFighterPanel(0);
    fillFighterPanel(1);
  }

  // ------------------------------------------------------------------ Start / Manage Real Fight
  function startMatch(onlinePayload) {
    if (app.vsMode === 'online') {
      if (!Net || !Net.isConnected()) return;
      if (Net.getRole() === 'guest' && (!onlinePayload || !onlinePayload.fromHost)) {
        app.guestReady = !app.guestReady;
        Net.send({ t: 'ready', ready: app.guestReady });
        renderSelectScreen();
        return;
      }
    }

    if (Audio) Audio.resume();
    Input.setTwoPlayer(app.vsMode === '2p');
    Input.reset();

    if (onlinePayload && onlinePayload.fromHost) {
      app.selected = onlinePayload.boxers || app.selected;
      app.seedCounter = onlinePayload.seed || 138;
      app.priorKOs = onlinePayload.priorKOs || [0, 0];
    } else {
      app.seedCounter = (app.seedCounter + 37) | 0;
      if (app.vsMode === 'online' && Net && Net.isConnected() && Net.getRole() === 'host') {
        Net.send({
          t: 'start',
          fromHost: true,
          boxers: app.selected,
          seed: app.seedCounter,
          priorKOs: app.priorKOs
        });
      }
    }

    var b0 = app.selected[0], b1 = app.selected[1];
    app.simState = Sim.create({ boxers: [b0, b1], seed: app.seedCounter, priorKOs: app.priorKOs, vsCpu: app.vsMode === 'cpu', difficulty: app.difficulty });
    app.prevSimState = app.simState;
    app.ai0 = null;
    app.ai1 = app.vsMode === 'cpu'
      ? AI.create({ index: 1, boxerId: b1, difficulty: app.difficulty, seed: app.seedCounter + 99 })
      : null;
    app.lastStepInputs = [copyInput({}), copyInput({})];
    app.comboGrades = [];
    app.onlineEventsQueue = [];
    app.guestReady = false;
    app.accumulator = 0;
    app.paused = false;
    app.resultShown = false;
    app.lastRoundCard = null;

    var B0 = Boxers.byId(b0), B1 = Boxers.byId(b1);
    $('hud-flag-0').style.background = B0.country.css;
    $('hud-flag-1').style.background = B1.country.css;
    if (app.vsMode === 'online' && Net && Net.isConnected()) {
      var isHost = Net.getRole() === 'host';
      $('hud-name-0').textContent = B0.name + (isHost ? ' (YOU)' : ' (HOST)');
      $('hud-name-1').textContent = B1.name + (isHost ? ' (OPPONENT)' : ' (YOU)');
    } else {
      $('hud-name-0').textContent = B0.name + ' (P1)';
      $('hud-name-1').textContent = B1.name + (app.vsMode === '2p' ? ' (P2)' : ' (CPU)');
    }

    $('hud-controls-hint').innerHTML = app.vsMode === '2p'
      ? '<strong>P1:</strong> A/D Move · J Jab · K Hook · L Uppercut · S Block · W/Space Dodge · <strong>E Combo</strong> &nbsp;|&nbsp; <strong>P2:</strong> ←/→ Move · 1/, Jab · 2/. Hook · 3// Upper · ↓/0 Block · ↑/Enter Dodge · <strong>I Combo</strong>'
      : '<strong>Move:</strong> A/D or ←/→ &nbsp;•&nbsp; <strong>Jab:</strong> J &nbsp;•&nbsp; <strong>Hook:</strong> K &nbsp;•&nbsp; <strong>Uppercut:</strong> L &nbsp;•&nbsp; <strong>Block:</strong> S &nbsp;•&nbsp; <strong>Dodge:</strong> W/Space &nbsp;•&nbsp; <strong>Signature Combo:</strong> E';

    showScreen('fight');
    showBanner('ROUND 1 — FIGHT!', 1.4);
    if (Audio && app.simState.events.length) Audio.handle(app.simState.events);
    updateHUD(app.simState);
  }

  function showBanner(text, seconds) {
    var el = $('hud-banner');
    el.textContent = text;
    el.classList.add('show');
    app.bannerTimer = seconds || 1.3;
  }

  function handleFightEvents(events) {
    if (!events || !events.length) return;
    if (Audio) Audio.handle(events);
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.type === 'round_start') {
        Input.reset();
        showBanner('ROUND ' + e.round, 1.4);
      } else if (e.type === 'fight_start') {
        showBanner('FIGHT!', 1.0);
      } else if (e.type === 'combo_start') {
        app.comboGrades = [];
        showBanner('COMBO! — ' + e.name.toUpperCase(), 1.15);
      } else if (e.type === 'combo_too_far') {
        showBanner('TOO FAR!', 0.65);
      } else if (e.type === 'combo_hit') {
        app.comboGrades[e.hitIndex] = e.grade;
      } else if (e.type === 'combo_end') {
        if (e.instantKO) {
          showBanner('GREEN COMBO — KNOCKOUT!', 2.6);
        } else if (e.greenCount === e.totalHits && !e.broken) {
          showBanner('PERFECT COMBO! ' + e.greenCount + '/' + e.totalHits + ' GREEN!', 1.3);
        }
      } else if (e.type === 'knockdown') {
        Input.reset();
        if (!e.instantKO) showBanner('KNOCKDOWN #' + e.kdTot + '!', 1.4);
      } else if (e.type === 'get_up_success') {
        Input.reset();
        showBanner('BEAT THE COUNT!', 1.1);
      } else if (e.type === 'round_end') {
        Input.reset();
        app.lastRoundCard = e.card;
        showBanner('END OF ROUND ' + e.round, 1.6);
      } else if (e.type === 'ko') {
        Input.reset();
        if (typeof e.loser === 'number' && app.screen === 'fight') {
          app.priorKOs[e.loser] = (app.priorKOs[e.loser] || 0) + 1;
        }
        showBanner('KNOCKOUT!', 2.6);
      } else if (e.type === 'decision') {
        Input.reset();
        showBanner('DECISION!', 2.2);
      }
    }
  }

  function updateHUD(s) {
    var isOnline = app.vsMode === 'online' && Net && Net.isConnected();
    var localIdx = (isOnline && Net.getRole() === 'guest') ? 1 : 0;

    for (var i = 0; i < 2; i++) {
      var f = s.fighters[i];
      var hpPct = Math.max(0, Math.min(100, (f.hp / f.maxHp) * 100));
      var stPct = Math.max(0, Math.min(100, (f.st / f.maxSt) * 100));
      var momPct = Math.max(0, Math.min(100, (f.momentum / C.MOMENTUM.max) * 100));
      var momReady = f.momentum >= C.MOMENTUM.max;

      var hpEl = $('hud-hp-' + i);
      hpEl.style.width = hpPct.toFixed(1) + '%';
      $('hud-hp-trail-' + i).style.width = hpPct.toFixed(1) + '%';
      hpEl.classList.toggle('warn', hpPct <= 50 && hpPct > 25);
      hpEl.classList.toggle('danger', hpPct <= 25);

      var stEl = $('hud-st-' + i);
      stEl.style.width = stPct.toFixed(1) + '%';
      stEl.classList.toggle('low', stPct < 28 || f.gassedT > 0);

      // Combo meter + READY prompt
      var momShell = $('hud-mom-shell-' + i);
      var momEl = $('hud-mom-' + i);
      var momLbl = $('hud-mom-lbl-' + i);
      var momReadyPill = $('hud-mom-ready-' + i);
      if (momEl) momEl.style.width = momPct.toFixed(1) + '%';
      if (momShell) momShell.classList.toggle('ready', momReady);
      if (momLbl) {
        var sigName = Boxers.byId(f.bid).signatureCombo ? Boxers.byId(f.bid).signatureCombo.name.toUpperCase() : 'COMBO';
        momLbl.textContent = momReady ? ('COMBO READY — ' + sigName) : ('COMBO ' + Math.floor(momPct) + '%');
      }
      if (momReadyPill) {
        var showReady = momReady && !s.comboState && !s.count && s.phase === 'fight';
        momReadyPill.classList.toggle('show', showReady);
        if (isOnline) {
          momReadyPill.textContent = (i === localIdx) ? '⚡ COMBO READY! PRESS [E]' : '⚡ OPPONENT COMBO READY!';
        } else if (i === 0) {
          momReadyPill.textContent = '⚡ COMBO READY! PRESS [E]';
        } else {
          momReadyPill.textContent = app.vsMode === '2p' ? '⚡ COMBO READY! PRESS [I]' : '⚡ CPU COMBO READY!';
        }
      }

      // Knockdown & Prior KO count badge with skull/impact indicator
      var kdBadge = $('hud-kd-' + i);
      if (kdBadge) {
        var tot = f.kdTot + (f.priorKOs || 0);
        var skulls = tot === 0 ? '' : (tot >= 3 ? '💀×' + tot + ' ' : '💥×' + tot + ' ');
        var koSuffix = f.priorKOs > 0 ? (' • KO: ' + f.priorKOs) : '';
        kdBadge.textContent = skulls + 'KD: ' + f.kdTot + koSuffix;
        kdBadge.className = 'kd-badge' +
          (tot >= 3 ? ' kd-danger' : (tot === 2 ? ' kd-orange' : (tot === 1 ? ' kd-warn' : '')));
      }

      var comboEl = $('hud-combo-' + i);
      if (f.comboN >= 2 && f.comboT > 0) {
        comboEl.textContent = f.comboN + ' HIT COMBO!';
        comboEl.classList.add('show');
      } else {
        comboEl.classList.remove('show');
      }
    }

    // Mobile touch combo button: appears when the local player's combo meter is READY (or during their active combo)
    var touchComboBtn = $('btn-touch-combo');
    if (touchComboBtn) {
      var showTouchCombo = s.phase === 'fight' && !s.count &&
        ((s.fighters[localIdx].momentum >= C.MOMENTUM.max && !s.comboState) ||
         (s.comboState && s.comboState.attacker === localIdx));
      touchComboBtn.style.display = showTouchCombo ? 'flex' : 'none';
    }

    // NBA 2K-style Signature Combo Timing Meter HUD overlay
    var cmBox = $('hud-combo-meter');
    if (cmBox) {
      if (s.comboState) {
        var cs = s.comboState;
        cmBox.classList.add('show');
        $('cm-sig-name').textContent = cs.name.toUpperCase();
        $('cm-hit-info').textContent = 'HIT ' + (cs.hitIndex + 1) + ' / ' + cs.totalHits + ' — ' + cs.hitLabel + ' (' + cs.punchType.toUpperCase() + ')';

        var pipsEl = $('cm-pips');
        if (pipsEl) {
          var pipsHtml = '';
          for (var p = 0; p < cs.totalHits; p++) {
            var g = app.comboGrades[p];
            var cls = 'cm-pip' + (g ? (' ' + g) : (p === cs.hitIndex ? ' active' : ''));
            pipsHtml += '<div class="' + cls + '"></div>';
          }
          pipsEl.innerHTML = pipsHtml;
        }

        var goodLo = Math.max(0, Math.min(1, cs.greenCenter - cs.goodHalf));
        var goodHi = Math.max(0, Math.min(1, cs.greenCenter + cs.goodHalf));
        var greenLo = Math.max(0, Math.min(1, cs.greenCenter - cs.greenHalf));
        var greenHi = Math.max(0, Math.min(1, cs.greenCenter + cs.greenHalf));
        $('cm-zone-good').style.left = (goodLo * 100).toFixed(1) + '%';
        $('cm-zone-good').style.width = ((goodHi - goodLo) * 100).toFixed(1) + '%';
        $('cm-zone-green').style.left = (greenLo * 100).toFixed(1) + '%';
        $('cm-zone-green').style.width = ((greenHi - greenLo) * 100).toFixed(1) + '%';

        var curPos = cs.locked && cs.lockPos !== null ? cs.lockPos : cs.cursor;
        $('cm-cursor').style.left = (Math.max(0, Math.min(1, curPos)) * 100).toFixed(1) + '%';

        var gradeEl = $('cm-grade');
        if (cs.locked && cs.grade) {
          gradeEl.textContent = cs.gradeText;
          gradeEl.className = 'cm-grade ' + cs.grade;
        } else {
          gradeEl.textContent = 'RELEASE IN THE GREEN ZONE!';
          gradeEl.className = 'cm-grade';
        }

        var promptEl = $('cm-prompt');
        if (isOnline) {
          promptEl.textContent = (cs.attacker === localIdx)
            ? 'PRESS [J / K / L / E] WHEN THE NEEDLE HITS GREEN!'
            : 'OPPONENT EXECUTING SIGNATURE COMBO...';
        } else {
          var isHumanAtk = (cs.attacker === 0) || (cs.attacker === 1 && app.vsMode === '2p');
          var atkKey = cs.attacker === 0 ? 'J / K / L / E' : '1 / 2 / 3 / I';
          promptEl.textContent = isHumanAtk
            ? ('PRESS [' + atkKey + '] WHEN THE NEEDLE HITS GREEN!')
            : 'CPU EXECUTING SIGNATURE COMBO...';
        }
      } else {
        cmBox.classList.remove('show');
      }
    }

    $('hud-round').textContent = 'ROUND ' + s.round + ' / ' + C.ROUNDS;
    var sec = Math.max(0, Math.ceil(s.clock / C.FPS));
    var m = Math.floor(sec / 60), r = sec % 60;
    $('hud-clock').textContent = m + ':' + (r < 10 ? '0' + r : r);

    // Knockdown 10-Count & Get-Up Meter overlay
    var countBox = $('hud-count');
    if (s.count) {
      var downed = s.fighters[s.count.who];
      var lvl = s.count.level || 0;
      var tier = Math.min(3, lvl);
      var pct = Math.max(0, Math.min(100, Math.round((downed.getup / C.KNOCKDOWN.meterMax) * 100)));

      countBox.classList.add('show');
      $('count-who').textContent = Boxers.byId(downed.bid).name.toUpperCase() + ' — KNOCKDOWN #' + downed.kdTot;

      var priorKoStr = downed.priorKOs > 0 ? (' + ' + downed.priorKOs + ' PRIOR KO' + (downed.priorKOs > 1 ? 'S' : '')) : '';
      var diffLabels = [
        'STANDARD (1ST KD' + priorKoStr + ')',
        'TOUGH (KD #' + downed.kdTot + priorKoStr + ')',
        'SEVERE (KD #' + downed.kdTot + priorKoStr + ')',
        'CRITICAL (KD #' + downed.kdTot + priorKoStr + ')'
      ];
      var diffColors = ['#4ade80', '#facc15', '#fb923c', '#f87171'];
      var diffEl = $('count-diff');
      if (diffEl) {
        diffEl.textContent = 'GET-UP DIFFICULTY: ' + diffLabels[tier];
        diffEl.style.color = diffColors[tier];
      }

      $('count-num').textContent = Math.max(1, s.count.n);
      var pctEl = $('rise-pct');
      if (pctEl) pctEl.textContent = pct + '%';

      var fillEl = $('rise-fill');
      fillEl.style.width = pct + '%';
      fillEl.className = 'rise-fill lvl-' + tier;

      var trackEl = $('rise-track');
      if (trackEl) {
        trackEl.className = 'rise-track' + (tier >= 1 ? ' shake-' + tier : '');
      }

      if (isOnline) {
        $('count-hint').textContent = (s.count.who === localIdx)
          ? 'MASH ANY KEY! (OR TAP FAST!)'
          : 'OPPONENT TRYING TO BEAT THE COUNT...';
      } else {
        var humanDown = (s.count.who === 0) || (s.count.who === 1 && app.vsMode === '2p');
        $('count-hint').textContent = humanDown ? 'MASH ANY KEY! (OR TAP FAST!)' : 'CPU TRYING TO BEAT THE COUNT...';
      }
    } else {
      countBox.classList.remove('show');
    }

    var restBox = $('hud-rest');
    if (s.phase === 'rest') {
      restBox.classList.add('show');
      $('rest-title').textContent = 'CORNER REST — AFTER ROUND ' + s.round;
      var card = app.lastRoundCard || [10, 10];
      var b0 = Boxers.byId(s.boxers[0]).nick, b1 = Boxers.byId(s.boxers[1]).nick;
      $('rest-card').textContent = 'Unofficial Round Score: ' + b0 + ' ' + card[0] + ' — ' + card[1] + ' ' + b1;
      var rem = Math.max(0, Math.ceil((C.REST_SECONDS * C.FPS - s.phaseT) / C.FPS));
      $('rest-clock').textContent = 'Next Round in ' + rem + 's';
    } else {
      restBox.classList.remove('show');
    }

    if (s.phase === 'finished' && !app.resultShown && s.phaseT >= 75) {
      app.resultShown = true;
      showResultModal(s);
    }
  }

  function showResultModal(s) {
    var res = s.result;
    var wBoxer = Boxers.byId(s.boxers[res.winner]);
    var corner;
    var eloCallout = $('res-elo-callout');
    if (app.vsMode === 'online' && Net && Net.isConnected()) {
      var localIdx = Net.getRole() === 'guest' ? 1 : 0;
      var wonOnline = (res.winner === localIdx);
      corner = wonOnline ? 'You Won!' : 'Online Opponent';
      if (wonOnline) {
        var eloGain = res.method === 'KO' ? 30 : 25;
        app.profile.elo = (app.profile.elo || 1000) + eloGain;
        app.profile.wins = (app.profile.wins || 0) + 1;
        saveProfile(app.profile);
        mergeAndRenderLeaderboard(null, true);
        if (eloCallout) {
          eloCallout.style.display = 'inline-block';
          eloCallout.textContent = '🏆 ONLINE WIN! +' + eloGain + ' ELO → ' + app.profile.elo + ' ELO';
        }
      } else {
        if (eloCallout) {
          eloCallout.style.display = 'inline-block';
          eloCallout.textContent = 'ONLINE ELO: ' + app.profile.elo + ' (+0 ELO)';
        }
      }
    } else {
      corner = res.winner === 0 ? 'Player 1' : (app.vsMode === '2p' ? 'Player 2' : 'CPU');
      if (eloCallout) eloCallout.style.display = 'none';
    }
    $('res-headline').textContent = wBoxer.name.toUpperCase() + ' WINS!';
    var m = Math.floor(res.time / 60), r = res.time % 60;
    var timeStr = m + ':' + (r < 10 ? '0' + r : r);
    $('res-sub').textContent = res.method === 'Decision'
      ? (res.detail + ' (' + corner + ')')
      : ('Winner by ' + res.method + ' (10-Count) in Round ' + res.round + ' (' + timeStr + ') • ' + corner);

    var B0 = Boxers.byId(s.boxers[0]), B1 = Boxers.byId(s.boxers[1]);
    var cardsWrap = $('res-cards-wrap');
    if (res.cards && res.cards.length) {
      var names = ['Judge A. Morales', 'Judge B. Lindqvist', 'Judge C. Takahashi'];
      cardsWrap.innerHTML = '<table class="score-table"><thead><tr><th>Judge</th><th>' + B0.name + '</th><th>' + B1.name + '</th></tr></thead><tbody>' +
        res.cards.map(function (c, idx) {
          return '<tr><td>' + names[idx] + '</td><td><strong>' + c.total[0] + '</strong></td><td><strong>' + c.total[1] + '</strong></td></tr>';
        }).join('') + '</tbody></table>';
    } else {
      cardsWrap.innerHTML = '';
    }

    var f0 = s.fighters[0], f1 = s.fighters[1];
    var acc0 = f0.thrownN ? Math.round((f0.landedN / f0.thrownN) * 100) : 0;
    var acc1 = f1.thrownN ? Math.round((f1.landedN / f1.thrownN) * 100) : 0;
    $('res-stats-table').innerHTML =
      '<thead><tr><th>' + B0.name + '</th><th>Match Stat</th><th>' + B1.name + '</th></tr></thead>' +
      '<tbody>' +
        '<tr><td>' + Math.round(f0.dmg) + '</td><td>Total Damage Dealt</td><td>' + Math.round(f1.dmg) + '</td></tr>' +
        '<tr><td>' + f0.landedN + ' / ' + f0.thrownN + ' (' + acc0 + '%)</td><td>Clean Punches Landed</td><td>' + f1.landedN + ' / ' + f1.thrownN + ' (' + acc1 + '%)</td></tr>' +
        '<tr><td>' + f1.kdTot + '</td><td>Knockdowns Scored</td><td>' + f0.kdTot + '</td></tr>' +
      '</tbody>';

    if ($('btn-rematch')) $('btn-rematch').textContent = 'REMATCH 🔔';
    $('modal-result').classList.add('show');
  }

  // ------------------------------------------------------------------ Debug Overlay (` or F3)
  function toggleDebugOverlay() {
    app.debugOpen = !app.debugOpen;
    var el = $('debug-overlay');
    if (el) el.classList.toggle('show', app.debugOpen);
    if (app.debugOpen && app.simState) renderDebugOverlay();
  }

  function formatInputFlags(inp) {
    var keys = ['left', 'right', 'jab', 'hook', 'uppercut', 'block', 'dodge', 'combo'];
    var flags = keys.map(function (k) {
      return '<span class="' + (inp[k] ? 'dbg-on' : 'dbg-off') + '">' + k + ':' + (inp[k] ? '1' : '0') + '</span>';
    }).join(' ');
    return flags + ' <span class="' + (inp.presses ? 'dbg-on' : 'dbg-off') + '">presses:' + (inp.presses || 0) + '</span>';
  }

  function renderDebugOverlay() {
    var el = $('debug-overlay');
    if (!el || !app.debugOpen || !app.simState) return;
    var s = app.simState;
    var dbgIn = Input.getDebugState();
    var src0 = app.screen === 'title' ? 'CPU' : 'human';
    var src1 = (app.screen !== 'title' && app.vsMode === '2p') ? 'human' : 'CPU';

    function colHTML(idx, src, rawKeys, stepInp) {
      var f = s.fighters[idx];
      var bufStr = f.buffer ? (f.buffer + ' (' + f.bufT + 'f)') : 'none';
      var momStr = f.momentum.toFixed(1) + '/' + C.MOMENTUM.max + (f.momentum >= C.MOMENTUM.max ? ' [READY]' : '');
      return '<div class="dbg-col">' +
        '<div class="dbg-title">FIGHTER ' + (idx + 1) + ' (' + f.bid.toUpperCase() + ') — Source: ' + src + '</div>' +
        '<div>Raw Held Keys: <strong>' + (rawKeys.length ? rawKeys.join(', ') : 'none') + '</strong></div>' +
        '<div>Step Input: ' + formatInputFlags(stepInp) + '</div>' +
        '<div>Action: <strong>' + f.action + '</strong> | Frame: ' + f.t + '/' + f.dur + ' | Prog: ' + f.prog.toFixed(2) + '</div>' +
        '<div>Pos X: ' + f.x.toFixed(3) + 'm | HP: ' + f.hp.toFixed(1) + ' | Stamina: ' + f.st.toFixed(1) + '/' + f.maxSt + '</div>' +
        '<div>Combo Meter: <strong>' + momStr + '</strong> | KD Tot: ' + f.kdTot + ' (Lvl ' + f.kdLevel + ') | Buf: <strong>' + bufStr + '</strong></div>' +
      '</div>';
    }

    var csInfo = s.comboState
      ? (' | Combo: ' + s.comboState.name + ' (Hit ' + (s.comboState.hitIndex + 1) + '/' + s.comboState.totalHits + ', cursor=' + s.comboState.cursor.toFixed(2) + ')')
      : '';

    el.innerHTML =
      '<div><strong>DEBUG OVERLAY</strong> (Toggle: <span class="kbd">`</span> or <span class="kbd">F3</span>) — Tick: ' + s.tick + ' | Phase: ' + s.phase + ' | Hitstop: ' + s.hitstop + csInfo + '</div>' +
      '<div class="dbg-grid">' +
        colHTML(0, src0, src0 === 'human' ? dbgIn.p1Keys : ['(CPU AI)'], app.lastStepInputs[0]) +
        colHTML(1, src1, src1 === 'human' ? dbgIn.p2Keys : ['(CPU AI)'], app.lastStepInputs[1]) +
      '</div>';
  }

  // ------------------------------------------------------------------ Main Loop (Fixed 60Hz Sim + Interpolated Render)
  function tickFrame(now) {
    requestAnimationFrame(tickFrame);
    if (!app.lastFrameTime) app.lastFrameTime = now;
    var realDt = Math.min(0.1, (now - app.lastFrameTime) / 1000);
    app.lastFrameTime = now;

    if (app.screen === 'select') {
      var t = now / 1000;
      g.BoxerArt.drawPreview($('preview-p1'), Boxers.byId(app.selected[0]), t, 1);
      g.BoxerArt.drawPreview($('preview-p2'), Boxers.byId(app.selected[1]), t + 1.2, -1);
    }

    var pingBadge = $('net-ping-badge');
    if (pingBadge) {
      if (app.vsMode === 'online' && Net && Net.isConnected()) {
        pingBadge.style.display = 'inline-block';
        var pingVal = Net.getPing();
        pingBadge.textContent = '🟢 ONLINE' + (pingVal > 0 ? (' • ' + pingVal + 'ms') : '');
      } else {
        pingBadge.style.display = 'none';
      }
    }

    if (!app.simState || !app.renderer) return;

    if (app.bannerTimer > 0 && !app.paused) {
      app.bannerTimer -= realDt;
      if (app.bannerTimer <= 0) $('hud-banner').classList.remove('show');
    }

    var frameEvents = [];
    var isOnlineFight = (app.screen === 'fight' && app.vsMode === 'online' && Net && Net.isConnected());
    var isOnlineGuest = isOnlineFight && Net.getRole() === 'guest';

    if (!app.paused) {
      var scale = app.simState.timeScale || 1;
      app.accumulator += realDt * scale;
      var steps = 0;
      while (app.accumulator >= C.DT && steps < C.MAX_STEPS_PER_FRAME) {
        if (isOnlineGuest) {
          // Online Guest: sample local Player 1 controls, send to Host, AND predict locally for 0-frame input response
          var gInp = copyInput(Input.sampleP1());
          var hInp = app.lastStepInputs[0] || copyInput({});
          app.lastStepInputs[1] = gInp;
          Net.sendGuestInput(gInp);
          app.prevSimState = app.simState;
          app.simState = Sim.step(app.simState, hInp, gInp);
        } else {
          app.prevSimState = app.simState;
          var in0, in1;
          if (app.screen === 'title') {
            in0 = copyInput(app.ai0.think(app.simState));
            in1 = copyInput(app.ai1.think(app.simState));
          } else if (isOnlineFight && Net.getRole() === 'host') {
            in0 = copyInput(Input.sampleP1());
            in1 = copyInput(Net.consumeRemoteInput());
          } else {
            // Sample human input ONCE per simulation step; never share objects between P1 and P2/CPU
            in0 = copyInput(Input.sampleP1());
            in1 = app.vsMode === '2p'
              ? copyInput(Input.sampleP2())
              : copyInput(app.ai1.think(app.simState));
          }
          app.lastStepInputs = [in0, in1];
          app.simState = Sim.step(app.simState, in0, in1);
          if (app.screen === 'fight' && app.simState.events.length) {
            for (var i = 0; i < app.simState.events.length; i++) frameEvents.push(app.simState.events[i]);
          }
          if (isOnlineFight && Net.getRole() === 'host') {
            Net.sendHostState(app.simState, app.simState.events, in0);
          }
          if (app.screen === 'title' && app.simState.phase === 'finished' && app.simState.phaseT > 120) {
            startAttractFight();
            break;
          }
        }
        app.accumulator -= C.DT;
        steps++;
      }
      if (steps >= C.MAX_STEPS_PER_FRAME) app.accumulator = 0;
    }

    if (isOnlineGuest && app.onlineEventsQueue.length) {
      for (var eq = 0; eq < app.onlineEventsQueue.length; eq++) {
        frameEvents.push(app.onlineEventsQueue[eq]);
      }
      app.onlineEventsQueue = [];
    }

    if (app.screen === 'fight') {
      handleFightEvents(frameEvents);
      updateHUD(app.simState);
    }

    if (app.debugOpen) {
      renderDebugOverlay();
    }

    var alpha = app.paused ? 1 : Math.max(0, Math.min(1, app.accumulator / C.DT));
    app.renderer.render(app.simState, frameEvents, alpha, app.prevSimState);
  }

  // ------------------------------------------------------------------ Automated Self-Test (?selftest=1)
  function triggerKnockdownForTest(boxer0, boxer1, targetKdNumber, seed) {
    var s = Sim.create({ boxers: [boxer0 || 'showtime', boxer1 || 'hammer'], seed: seed || 300 });
    // Position fighter 1 close to fighter 0 and set fighter 0 HP low so an uppercut/hook knocks fighter 0 down
    s.fighters[0].x = -0.35;
    s.fighters[1].x = 0.35;
    s.fighters[0].hp = 1;
    s.fighters[0].kd = targetKdNumber - 1;
    s.fighters[0].kdTot = targetKdNumber - 1;
    s.fighters[0].kdLevel = targetKdNumber - 1;
    // Step with fighter 1 throwing a jab to trigger knockdown on fighter 0
    for (var i = 0; i < 30 && !s.count; i++) {
      s = Sim.step(s, {}, { jab: i === 0, presses: i === 0 ? 1 : 0 });
    }
    return s;
  }

  function runSelfTest() {
    var results = [];
    function check(name, pass, detail) {
      results.push({ name: name, pass: !!pass, detail: detail || '' });
      console.log((pass ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' — ' + detail : ''));
    }

    // 1. Idle 5s: position never changes & no punch thrown
    (function () {
      var s = Sim.create({ boxers: ['viper', 'hammer'], seed: 100 });
      var x0 = s.fighters[0].x;
      var moved = false, punched = false, nonIdle = false;
      for (var i = 0; i < 300; i++) {
        s = Sim.step(s, {}, {});
        if (s.fighters[0].x !== x0) moved = true;
        if (s.fighters[0].thrownN > 0) punched = true;
        if (s.fighters[0].action !== 'idle') nonIdle = true;
      }
      check(
        '1. No input for 5s: position never changes & no punch thrown',
        !moved && !punched && !nonIdle,
        'x0=' + x0 + ' -> ' + s.fighters[0].x + ', thrown=' + s.fighters[0].thrownN
      );
    })();

    // 2. Holding "right" moves right; releasing stops within 1 step
    (function () {
      var s = Sim.create({ boxers: ['viper', 'hammer'], seed: 101 });
      var startX = s.fighters[0].x;
      var movedEveryStep = true;
      for (var i = 0; i < 15; i++) {
        var prevX = s.fighters[0].x;
        s = Sim.step(s, { right: true }, {});
        if (!(s.fighters[0].x > prevX && s.fighters[0].action === 'walk')) movedEveryStep = false;
      }
      var xAtRelease = s.fighters[0].x;
      var sAfter1 = Sim.step(s, { right: false }, {});
      var sAfter2 = Sim.step(sAfter1, { right: false }, {});
      var stoppedIn1Step = (sAfter1.fighters[0].x === xAtRelease) &&
                           (sAfter1.fighters[0].action === 'idle') &&
                           (sAfter2.fighters[0].x === xAtRelease);
      check(
        '2. Holding "right" moves right; releasing stops within 1 step',
        movedEveryStep && s.fighters[0].x > startX && stoppedIn1Step,
        'heldX=' + xAtRelease.toFixed(3) + ', releaseStepX=' + sAfter1.fighters[0].x.toFixed(3)
      );
    })();

    // 3. Single jab press throws 1 jab; holding jab does not repeat
    (function () {
      var s = Sim.create({ boxers: ['viper', 'hammer'], seed: 102 });
      for (var i = 0; i < 120; i++) s = Sim.step(s, { jab: true }, {});
      Input.reset();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', repeat: false }));
      var s2 = Sim.create({ boxers: ['viper', 'hammer'], seed: 102 });
      for (var j = 0; j < 120; j++) {
        if (j === 5 || j === 20) window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', repeat: true }));
        s2 = Sim.step(s2, Input.sampleP1(), {});
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' }));
      Input.reset();
      check(
        '3. Single jab press throws 1 jab; holding jab does not repeat',
        s.fighters[0].thrownN === 1 && s2.fighters[0].thrownN === 1 && s2.fighters[0].action === 'idle',
        'simHeld=' + s.fighters[0].thrownN + ', inputHeld=' + s2.fighters[0].thrownN
      );
    })();

    // 4. Block is only active while held
    (function () {
      var s = Sim.create({ boxers: ['viper', 'hammer'], seed: 103 });
      s = Sim.step(s, { block: true }, {});
      var activeWhileHeld = (s.fighters[0].action === 'block');
      s = Sim.step(s, { block: false }, {});
      var stoppedOnRelease = (s.fighters[0].action === 'idle');
      check('4. Block is only active while held', activeWhileHeld && stoppedOnRelease, 'released=' + s.fighters[0].action);
    })();

    // 5. In VS CPU mode, CPU input never changes Player 1 state
    (function () {
      Input.setTwoPlayer(false);
      Input.reset();
      var s = Sim.create({ boxers: ['viper', 'hammer'], seed: 104 });
      var ai = AI.create({ index: 1, boxerId: 'hammer', difficulty: 'hard', seed: 55 });
      var p1StartX = s.fighters[0].x, p1Changed = false;
      for (var i = 0; i < 180; i++) {
        var in0 = Input.sampleP1();
        var in1 = ai.think(s);
        if (Math.abs(s.fighters[1].x - s.fighters[0].x) < 1.35) {
          in1 = { left: true, right: false, jab: false, hook: false, uppercut: false, block: true, dodge: false };
        }
        s = Sim.step(s, in0, in1);
        if (s.fighters[0].x !== p1StartX || s.fighters[0].action !== 'idle' || s.fighters[0].thrownN !== 0) p1Changed = true;
      }
      check('5. In VS CPU mode, CPU input never changes Player 1 state', !p1Changed, 'p1.x=' + s.fighters[0].x);
    })();

    // 6. Window blur & pause clear all held inputs
    (function () {
      Input.reset();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyS' }));
      window.dispatchEvent(new Event('blur'));
      var afterBlur = Input.sampleP1();
      var blurOk = Input.getDebugState().p1Keys.length === 0 && !afterBlur.right && !afterBlur.block;
      startMatch();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD' }));
      togglePause();
      var afterPause = Input.sampleP1();
      var pauseOk = Input.getDebugState().p1Keys.length === 0 && !afterPause.right;
      togglePause();
      check('6. Window blur & pause clear all held inputs', blurOk && pauseOk, 'blurOk=' + blurOk + ', pauseOk=' + pauseOk);
    })();

    // 7. No TKO ever triggers regardless of knockdown count (e.g. 5 knockdowns in 1 round)
    (function () {
      var s = Sim.create({ boxers: ['showtime', 'hammer'], seed: 201 });
      var tkoTriggered = false;
      for (var k = 1; k <= 5; k++) {
        s.fighters[0].x = -0.35;
        s.fighters[1].x = 0.35;
        s.fighters[0].hp = 1;
        s.fighters[0].invulnT = 0;
        for (var a = 0; a < 30 && !s.count; a++) {
          s = Sim.step(s, {}, { jab: a === 0, presses: a === 0 ? 1 : 0 });
          s.events.forEach(function (e) { if (e.type === 'tko') tkoTriggered = true; });
        }
        // Keep kdLevel at 0 in test 7 solely to verify that 5 knockdowns in a single round never triggers a TKO
        s.fighters[0].kdLevel = 0;
        if (s.count) s.count.level = 0;
        var guard = 0;
        while (s.count && s.phase === 'fight' && guard < 700) {
          s = Sim.step(s, { presses: (guard % 4 === 0) ? 1 : 0 }, {});
          s.events.forEach(function (e) { if (e.type === 'tko') tkoTriggered = true; });
          guard++;
        }
      }
      var survivedFiveInOneRound = (s.phase === 'fight' && s.result === null && s.fighters[0].kd === 5 && !tkoTriggered);
      check(
        '7. No TKO rule: 5 knockdowns in a single round never triggers TKO',
        survivedFiveInOneRound,
        'roundKDs=' + s.fighters[0].kd + ', phase=' + s.phase + ', tko=' + tkoTriggered
      );
    })();

    // 8. A downed boxer with no presses always gets KO'd at the 10-count
    (function () {
      var s = triggerKnockdownForTest('showtime', 'hammer', 1, 202);
      var countTicks = 0, koEmitted = false;
      for (var i = 0; i < 700 && s.phase !== 'finished'; i++) {
        s = Sim.step(s, { presses: 0 }, {});
        s.events.forEach(function (e) {
          if (e.type === 'count_tick') countTicks = e.count;
          if (e.type === 'ko') koEmitted = true;
        });
      }
      var ok = (s.phase === 'finished' && s.result && s.result.method === 'KO' && countTicks === 10 && koEmitted);
      check(
        '8. Downed boxer with 0 presses is KO\'d at count 10',
        ok,
        'method=' + (s.result && s.result.method) + ', count=' + countTicks + ', koEvent=' + koEmitted
      );
    })();

    // 9. Balanced Get-Up Meter: 7.5 presses/sec rises on 1st KD, but fails after prior knockdowns/KOs
    (function () {
      // 1st knockdown (no prior KOs): 7.5 presses/sec (1 press every 8 frames) gets up
      var s1 = triggerKnockdownForTest('showtime', 'hammer', 1, 203);
      var gotUp1 = false;
      for (var i = 0; i < 650 && s1.count && s1.phase === 'fight'; i++) {
        var press = (i % 8 === 0) ? 1 : 0; // 7.5 presses per second
        s1 = Sim.step(s1, { presses: press }, {});
        s1.events.forEach(function (e) { if (e.type === 'get_up_success') gotUp1 = true; });
      }
      // 3rd knockdown (or 1st KD with 2 prior KOs): same 7.5 presses/sec fails as KO
      var sPriorKO = Sim.create({ boxers: ['showtime', 'hammer'], seed: 204, priorKOs: [2, 0] });
      sPriorKO.fighters[0].x = -0.35;
      sPriorKO.fighters[1].x = 0.35;
      sPriorKO.fighters[0].hp = 1;
      for (var a = 0; a < 30 && !sPriorKO.count; a++) {
        sPriorKO = Sim.step(sPriorKO, {}, { jab: a === 0, presses: a === 0 ? 1 : 0 });
      }
      var gotUpAfterPriorKOs = false;
      for (var j = 0; j < 650 && sPriorKO.phase === 'fight'; j++) {
        var press2 = (j % 8 === 0) ? 1 : 0; // same 7.5 presses/sec
        sPriorKO = Sim.step(sPriorKO, { presses: press2 }, {});
        sPriorKO.events.forEach(function (e) { if (e.type === 'get_up_success') gotUpAfterPriorKOs = true; });
      }
      var failedAsKO = (!gotUpAfterPriorKOs && sPriorKO.phase === 'finished' && sPriorKO.result && sPriorKO.result.method === 'KO');
      check(
        '9. Get-Up Meter: 7.5/s rises on 1st KD, fails (KO) with prior knockdowns/KOs',
        gotUp1 && failedAsKO,
        '1stKD_gotUp=' + gotUp1 + ', withPriorKOs_gotUp=' + gotUpAfterPriorKOs + ' (result=' + (sPriorKO.result && sPriorKO.result.method) + ')'
      );
    })();

    // 10. Holding a key during knockdown does nothing; other player's keys never affect downed boxer's meter
    (function () {
      Input.setTwoPlayer(true);
      Input.reset();
      var s = triggerKnockdownForTest('showtime', 'hammer', 1, 205);
      // Skip initial hitstop frames
      while (s.hitstop > 0) s = Sim.step(s, Input.sampleP1(), Input.sampleP2());

      // P1 holds KeyJ down continuously (with repeat events) while P2 rapidly mashes P2 keys
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', repeat: false }));
      // Consume the single initial press before testing continuous holding + P2 mashing
      Input.sampleP1();
      s.fighters[0].getup = 0;

      var maxMeterWhileHoldingAndP2Mashing = 0;
      for (var i = 0; i < 60; i++) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyJ', repeat: true }));
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Numpad1', repeat: false }));
        s = Sim.step(s, Input.sampleP1(), Input.sampleP2());
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Numpad1' }));
        if (s.fighters[0].getup > maxMeterWhileHoldingAndP2Mashing) {
          maxMeterWhileHoldingAndP2Mashing = s.fighters[0].getup;
        }
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyJ' }));
      Input.setTwoPlayer(false);
      Input.reset();
      check(
        '10. Holding a key adds 0; other player\'s keys never affect meter',
        maxMeterWhileHoldingAndP2Mashing === 0,
        'maxP1Meter=' + maxMeterWhileHoldingAndP2Mashing
      );
    })();

    // 11. Determinism: identical seed + inputs -> identical state
    (function () {
      function runSim(seed) {
        var s = Sim.create({ boxers: ['showtime', 'shadow'], seed: seed });
        var a0 = AI.create({ index: 0, boxerId: 'showtime', difficulty: 'normal', seed: seed + 1 });
        var a1 = AI.create({ index: 1, boxerId: 'shadow', difficulty: 'hard', seed: seed + 2 });
        for (var i = 0; i < 400; i++) {
          s = Sim.step(s, a0.think(s), a1.think(s));
        }
        return JSON.stringify(s);
      }
      var rA = runSim(999), rB = runSim(999);
      check('11. Determinism: identical seed + inputs -> identical state', rA === rB, 'len=' + rA.length);
    })();

    // 12. Harder Combo Meter growth & drain rules (~22-30 clean punches to fill; idle/whiff/hit drain; reduced between rounds)
    (function () {
      var s = Sim.create({ boxers: ['viper', 'hammer'], seed: 301 });
      s.fighters[0].x = -0.35;
      s.fighters[1].x = 0.35;
      s.fighters[1].hp = 9999; // keep opponent standing while measuring punches to fill Combo Meter
      var punchesToReady = 0;
      for (var p = 0; p < 35 && s.fighters[0].momentum < C.MOMENTUM.max; p++) {
        var pType = (p % 3 === 0) ? 'jab' : ((p % 3 === 1) ? 'hook' : 'uppercut');
        var inp = {}; inp[pType] = true;
        s = Sim.step(s, inp, {});
        punchesToReady++;
        // step until fighter 0 returns to idle and opponent recovers
        for (var w = 0; w < 45; w++) {
          s.fighters[0].x = -0.35;
          s.fighters[1].x = 0.35;
          s.fighters[0].st = s.fighters[0].maxSt;
          s = Sim.step(s, {}, {});
        }
      }
      var fillInTargetBand = (s.fighters[0].momentum === 100 && punchesToReady >= 22 && punchesToReady <= 30);

      // Test idle drain after grace period when combo meter < 100
      s.fighters[0].momentum = 50;
      s.fighters[0].idleNoHitT = 0;
      for (var id = 0; id < 260; id++) s = Sim.step(s, {}, {});
      var drainedAfterIdle = s.fighters[0].momentum < 50;

      // Test between-rounds reduction (35% kept)
      s.fighters[0].momentum = 80;
      s.fighters[0].idleNoHitT = 0;
      s.clock = 1;
      s = Sim.step(s, {}, {}); // triggers endRound -> phase 'roundend'
      while (s.phase === 'roundend' || s.phase === 'rest') {
        s = Sim.step(s, {}, {});
      }
      var reducedBetweenRounds = Math.abs(s.fighters[0].momentum - 80 * C.MOMENTUM.betweenRoundsKeep) < 0.01;

      check(
        '12. Harder Combo Meter fills in ~22-30 clean punches, drains when idle, reduces between rounds',
        fillInTargetBand && drainedAfterIdle && reducedBetweenRounds,
        'punches=' + punchesToReady + ', afterIdle=' + drainedAfterIdle + ', afterRest=' + s.fighters[0].momentum.toFixed(1)
      );
    })();

    // 13. Activating combo out of range shows TOO FAR and does NOT waste combo meter
    (function () {
      var s = Sim.create({ boxers: ['viper', 'hammer'], seed: 302 });
      s.fighters[0].momentum = 100;
      s.fighters[0].x = -1.6;
      s.fighters[1].x = 1.6;
      s = Sim.step(s, { combo: true }, {});
      var tooFarEmitted = s.events.some(function (e) { return e.type === 'combo_too_far'; });
      var preserved = (s.fighters[0].momentum === 100 && s.comboState === null);
      check(
        '13. Pressing Combo out of range emits combo_too_far and preserves 100% Combo Meter',
        tooFarEmitted && preserved,
        'tooFar=' + tooFarEmitted + ', comboMeter=' + s.fighters[0].momentum + ', comboState=' + !!s.comboState
      );
    })();

    // 14. Activating combo in range starts Signature Combo, resets Combo Meter to 0, and locks defender Combo Meter
    (function () {
      var s = Sim.create({ boxers: ['viper', 'hammer'], seed: 303 });
      s.fighters[0].momentum = 100;
      s.fighters[1].momentum = 44;
      s.fighters[0].x = -0.4;
      s.fighters[1].x = 0.4;
      s = Sim.step(s, { combo: true }, {});
      var started = !!(s.comboState && s.comboState.attacker === 0 && s.comboState.name === 'Viper Fang Flurry');
      var resetToZero = (s.fighters[0].momentum === 0);
      check(
        '14. Pressing Combo in range starts Signature Combo & resets Combo Meter to 0',
        started && resetToZero && s.fighters[1].momentum === 44,
        'started=' + started + ', atkCombo=' + s.fighters[0].momentum + ', defCombo=' + s.fighters[1].momentum
      );
    })();

    // 15. NBA 2K Green Timing Meter: Greening the Combo triggers an INSTANT KO; Miss zone breaks combo early
    (function () {
      // A: Greening Hammer's 3-hit "Siberian Anvil Crush" triggers an immediate KO even from full HP
      var sG = Sim.create({ boxers: ['hammer', 'viper'], seed: 304 });
      sG.fighters[0].momentum = 100;
      sG.fighters[0].x = -0.35;
      sG.fighters[1].x = 0.35;
      sG.fighters[1].hp = 100;
      sG = Sim.step(sG, { combo: true }, {});
      var greenHits = 0;
      for (var i = 0; i < 400 && sG.comboState; i++) {
        var cs = sG.comboState;
        var pressNow = (cs.stage === 'meter' && Math.abs(cs.cursor - cs.greenCenter) <= cs.greenHalf * 0.4);
        sG = Sim.step(sG, { jab: pressNow }, {});
        sG.events.forEach(function (e) { if (e.type === 'combo_hit' && e.grade === 'green') greenHits++; });
      }
      var greenComboInstantKO = (greenHits === 3 && sG.phase === 'finished' && sG.result && sG.result.method === 'KO' && sG.result.winner === 0);

      // B: Early Red/Miss press on hit 1 breaks combo immediately
      var sM = Sim.create({ boxers: ['hammer', 'viper'], seed: 305 });
      sM.fighters[0].momentum = 100;
      sM.fighters[0].x = -0.35;
      sM.fighters[1].x = 0.35;
      sM = Sim.step(sM, { combo: true }, {});
      var missHits = 0, totalComboHits = 0, brokenFlag = false;
      for (var j = 0; j < 300 && sM.comboState; j++) {
        var csM = sM.comboState;
        var pressEarly = (csM.stage === 'meter' && csM.cursor >= 0.12 && csM.cursor <= 0.20);
        sM = Sim.step(sM, { jab: pressEarly }, {});
        sM.events.forEach(function (e) {
          if (e.type === 'combo_hit') {
            totalComboHits++;
            if (e.grade === 'miss') missHits++;
          }
          if (e.type === 'combo_end' && e.broken) brokenFlag = true;
        });
      }
      var missBrokeEarly = (missHits === 1 && totalComboHits === 1 && brokenFlag);

      check(
        '15. Greening the Combo triggers an INSTANT KO; Miss zone breaks combo early',
        greenComboInstantKO && missBrokeEarly,
        'greenHits=' + greenHits + ' (result=' + (sG.result && sG.result.method) + '), missTotalHits=' + totalComboHits + ' (broken=' + brokenFlag + ')'
      );
    })();

    // 16. Combo key contract: KeyE (P1) and KeyI (P2) only fire on keydown edge for their own player
    (function () {
      Input.setTwoPlayer(true);
      Input.reset();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', repeat: false }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyI', repeat: false }));
      var p1First = Input.sampleP1(), p2First = Input.sampleP2();
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', repeat: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyI', repeat: true }));
      var p1Held = Input.sampleP1(), p2Held = Input.sampleP2();
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyI' }));
      Input.setTwoPlayer(false);
      Input.reset();
      var ok = (p1First.combo === true && p2First.combo === true && p1Held.combo === false && p2Held.combo === false);
      check(
        '16. KeyE (P1) and KeyI (P2) trigger combo on keydown edge only (never while held)',
        ok,
        'p1Edge=' + p1First.combo + '/held=' + p1Held.combo + ', p2Edge=' + p2First.combo + '/held=' + p2Held.combo
      );
    })();

    // 17. CPU difficulty: reaction delay, block rate and combo frequency are lowest on Easy
    (function () {
      var DD = AI.DIFFICULTIES;
      var cfgOk = DD.easy.react >= 18 && DD.easy.react > DD.normal.react && DD.normal.react > DD.hard.react &&
        DD.easy.blockP < DD.normal.blockP && DD.normal.blockP < DD.hard.blockP &&
        DD.easy.sigChance < DD.normal.sigChance && DD.normal.sigChance < DD.hard.sigChance;
      function measure(diff) {
        var s = Sim.create({ boxers: ['viper', 'hammer'], seed: 77, vsCpu: true, difficulty: diff });
        var ai = AI.create({ index: 1, boxerId: 'hammer', difficulty: diff, seed: 31 });
        var blockTicks = 0, ticks = 0, combos = 0;
        for (var i = 0; i < 3600 && s.phase === 'fight'; i++) {
          s.fighters[0].hp = 100; s.fighters[0].st = s.fighters[0].maxSt; s.fighters[1].hp = 100;
          if (!s.comboState && s.fighters[1].momentum < 100) s.fighters[1].momentum = 100;
          if (!s.comboState && Math.abs(s.fighters[0].x - s.fighters[1].x) > 1.0) s.fighters[0].x = s.fighters[1].x - 1.0;
          var in1 = ai.think(s);
          if (!s.comboState) { ticks++; if (in1.block) blockTicks++; }
          s = Sim.step(s, { jab: i % 50 === 0 }, in1);
          s.events.forEach(function (e) { if (e.type === 'combo_start' && e.who === 1) combos++; });
        }
        return { block: blockTicks / Math.max(1, ticks), combos: combos };
      }
      var mE = measure('easy'), mN = measure('normal'), mH = measure('hard');
      var measured = mE.block < mN.block && mE.block < mH.block && mE.combos < mN.combos && mE.combos <= mH.combos;
      check(
        '17. CPU Easy: slower reactions, lower block rate and fewer combos than Medium/Hard',
        cfgOk && measured,
        'react ' + DD.easy.react + '/' + DD.normal.react + '/' + DD.hard.react +
        ', block% ' + (mE.block * 100).toFixed(0) + '/' + (mN.block * 100).toFixed(0) + '/' + (mH.block * 100).toFixed(0) +
        ', combos ' + mE.combos + '/' + mN.combos + '/' + mH.combos
      );
    })();

    // 18. Human damage multipliers apply only in VS CPU mode; Local 2 Player has none
    (function () {
      function jabLoss(opts, attackerIdx) {
        var o = { boxers: ['viper', 'hammer'], seed: 905 };
        for (var k in opts) o[k] = opts[k];
        var s = Sim.create(o);
        s.fighters[0].x = -0.35; s.fighters[1].x = 0.35;
        for (var i = 0; i < 40; i++) {
          var a = { jab: i === 0 };
          s = Sim.step(s, attackerIdx === 0 ? a : {}, attackerIdx === 1 ? a : {});
        }
        return 100 - s.fighters[1 - attackerIdx].hp;
      }
      var base0 = jabLoss({}, 0), base1 = jabLoss({}, 1);
      var twoP0 = jabLoss({ vsCpu: false }, 0), twoP1 = jabLoss({ vsCpu: false }, 1);
      var e0 = jabLoss({ vsCpu: true, difficulty: 'easy' }, 0), e1 = jabLoss({ vsCpu: true, difficulty: 'easy' }, 1);
      var m0 = jabLoss({ vsCpu: true, difficulty: 'normal' }, 0), m1 = jabLoss({ vsCpu: true, difficulty: 'normal' }, 1);
      var h0 = jabLoss({ vsCpu: true, difficulty: 'hard' }, 0);
      var s2p = Sim.create({ boxers: ['viper', 'hammer'], seed: 1, vsCpu: false });
      var ok = base0 > 0 && base1 > 0 && twoP0 === base0 && twoP1 === base1 &&
        s2p.fighters[0].assist === null && s2p.fighters[1].assist === null &&
        Math.abs(e0 / base0 - C.ASSIST.easy.dmgDealt) < 0.02 && Math.abs(e1 / base1 - C.ASSIST.easy.dmgTaken) < 0.02 &&
        Math.abs(m0 / base0 - C.ASSIST.normal.dmgDealt) < 0.02 && Math.abs(m1 / base1 - C.ASSIST.normal.dmgTaken) < 0.02 &&
        Math.abs(h0 / base0 - 1) < 0.001;
      check(
        '18. Human damage x1.25/x0.7 (Easy), x1.1/x0.85 (Medium), x1.0 (Hard) only in VS CPU; Local 2P unchanged',
        ok,
        'dealt easy ' + (e0 / base0).toFixed(2) + ', taken easy ' + (e1 / base1).toFixed(2) + ', dealt med ' + (m0 / base0).toFixed(2) +
        ', taken med ' + (m1 / base1).toFixed(2) + ', 2P ' + (twoP0 === base0 && twoP1 === base1)
      );
    })();

    // 19. Human assists beyond damage (VS CPU only): stamina regen, momentum, green zone, get-up
    (function () {
      var sc = Sim.create({ boxers: ['viper', 'hammer'], seed: 40, vsCpu: true, difficulty: 'easy' });
      var s2 = Sim.create({ boxers: ['viper', 'hammer'], seed: 40 });
      sc.fighters[0].st = 10; s2.fighters[0].st = 10;
      sc.fighters[1].st = 10; s2.fighters[1].st = 10;
      for (var i = 0; i < 60; i++) { sc = Sim.step(sc, {}, {}); s2 = Sim.step(s2, {}, {}); }
      var regenHuman = (sc.fighters[0].st - 10) / (s2.fighters[0].st - 10);
      var regenCpuSame = Math.abs((sc.fighters[1].st - 10) - (s2.fighters[1].st - 10)) < 1e-9;
      var pc = Sim.kdParams(2, 5, C.ASSIST.easy), pn = Sim.kdParams(2, 5);
      var getupEasier = pc.drainPerSec < pn.drainPerSec * 0.8 && pc.pressGain > pn.pressGain;
      // green zone: human zone bigger and cursor slower than the same combo in 2P
      function comboMeter(opts) {
        var s = Sim.create(Object.assign({ boxers: ['hammer', 'viper'], seed: 304 }, opts));
        s.fighters[0].momentum = 100; s.fighters[0].x = -0.35; s.fighters[1].x = 0.35;
        s = Sim.step(s, { combo: true }, {});
        for (var j = 0; j < 80 && !(s.comboState && s.comboState.stage === 'meter'); j++) s = Sim.step(s, {}, {});
        return s.comboState;
      }
      var cmA = comboMeter({ vsCpu: true, difficulty: 'easy' }), cmB = comboMeter({});
      var greenBigger = cmA.greenHalf > cmB.greenHalf * 1.25 && cmA.stageDur > cmB.stageDur * 1.15;
      // momentum gain
      function momAfterHit(opts) {
        var s = Sim.create(Object.assign({ boxers: ['viper', 'hammer'], seed: 905 }, opts));
        s.fighters[0].x = -0.35; s.fighters[1].x = 0.35;
        for (var k = 0; k < 40; k++) s = Sim.step(s, { jab: k === 0 }, {});
        return s.fighters[0].momentum;
      }
      var momRatio = momAfterHit({ vsCpu: true, difficulty: 'easy' }) / Math.max(0.001, momAfterHit({}));
      check(
        '19. VS CPU Easy human assists: faster stamina regen, more momentum, bigger green zone, easier get-up',
        regenHuman > 1.2 && regenHuman < 1.3 && regenCpuSame && getupEasier && greenBigger && momRatio > 1.25 && momRatio < 1.35,
        'regen x' + regenHuman.toFixed(2) + ', momentum x' + momRatio.toFixed(2) + ', green x' + (cmA.greenHalf / cmB.greenHalf).toFixed(2) +
        ', cursor x' + (cmA.stageDur / cmB.stageDur).toFixed(2)
      );
    })();

    // 20. Determinism + fights always resolve in VS CPU mode (bot "human" vs seeded CPU), plus win-rate report
    (function () {
      function botFight(seed, cpuDiff, botDiff) {
        var s = Sim.create({ boxers: ['viper', 'hammer'], seed: seed, vsCpu: true, difficulty: cpuDiff });
        var bot = AI.create({ index: 0, boxerId: 'viper', difficulty: botDiff, seed: seed + 5 });
        var cpu = AI.create({ index: 1, boxerId: 'hammer', difficulty: cpuDiff, seed: seed + 9 });
        for (var i = 0; i < 20000 && s.phase !== 'finished'; i++) {
          var b = bot.think(s); delete b.cpuDiff;   // the bot plays as a HUMAN (no CPU get-up flag)
          if (s.count && s.count.who === 0) b.presses = (i % 6 === 0) ? 1 : 0;
          s = Sim.step(s, b, cpu.think(s));
        }
        return s;
      }
      var a = JSON.stringify(botFight(11, 'easy', 'normal')), b2 = JSON.stringify(botFight(11, 'easy', 'normal'));
      var wins = { easy: 0, normal: 0, hard: 0 }, resolved = true, total = 5, ko = 0;
      ['easy', 'normal', 'hard'].forEach(function (d) {
        for (var k = 0; k < total; k++) {
          var f = botFight(200 + k * 17, d, 'normal');
          if (f.phase !== 'finished' || !f.result) resolved = false;
          else { if (f.result.winner === 0) wins[d]++; if (f.result.method === 'KO') ko++; }
        }
      });
      check(
        '20. Same seed gives identical results; every VS CPU fight resolves (KO or decision)',
        a === b2 && resolved,
        'avg-player bot wins vs CPU Easy/Medium/Hard: ' + wins.easy + '/' + total + ', ' + wins.normal + '/' + total + ', ' + wins.hard + '/' + total + ' (KO finishes: ' + ko + ')'
      );
    })();
    var allPass = results.every(function (r) { return r.pass; });
    console.log('SELF-TEST SUMMARY: ' + (allPass ? 'ALL ' + results.length + ' PASSED' : 'FAILURES DETECTED'));
    showScreen('title');
    if (window.location && window.location.search && window.location.search.indexOf('screen=select') >= 0) showScreen('select');

    var panel = $('selftest-panel');
    if (panel) {
      panel.classList.add('show');
      panel.innerHTML =
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
          '<strong style="color:#ffe27a;font-size:14px;">AUTOMATED SELF-TEST RESULTS (' + (allPass ? 'ALL ' + results.length + ' PASSED' : 'FAILED') + ')</strong>' +
          '<button id="btn-close-selftest" class="icon-btn" style="padding:2px 8px;font-size:11px;">✕</button>' +
        '</div>' +
        results.map(function (r) {
          return '<div><span class="' + (r.pass ? 'st-pass' : 'st-fail') + '">' + (r.pass ? '✔ PASS' : '✘ FAIL') + '</span> ' +
            r.name + ' <span style="color:#94a3b8;">(' + r.detail + ')</span></div>';
        }).join('');
      var closeBtn = $('btn-close-selftest');
      if (closeBtn) closeBtn.addEventListener('click', function () { panel.classList.remove('show'); });
    }
    return { allPass: allPass, results: results };
  }

  // ------------------------------------------------------------------ UI Wiring
  function togglePause() {
    if (app.screen !== 'fight' || !app.simState || app.simState.phase === 'finished') return;
    Input.reset();
    app.paused = !app.paused;
    $('modal-pause').classList.toggle('show', app.paused);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  function initUI() {
    // Touch device detection -> enables the on-screen touch pad and mobile layout
    var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)');
    function applyTouchClass() {
      var isTouch = (coarse && coarse.matches) || (navigator.maxTouchPoints > 0 && window.innerWidth < 1100);
      document.body.classList.toggle('is-touch', !!isTouch);
      if (app.renderer) app.renderer.resize();
    }
    applyTouchClass();
    if (coarse && coarse.addEventListener) coarse.addEventListener('change', applyTouchClass);
    window.addEventListener('orientationchange', function () {
      Input.reset();
      setTimeout(function () { if (app.renderer) app.renderer.resize(); }, 250);
    });
    var fsBtn = $('btn-fullscreen');
    if (fsBtn) {
      fsBtn.addEventListener('click', function () {
        var el = document.documentElement;
        if (document.fullscreenElement) {
          if (document.exitFullscreen) document.exitFullscreen();
        } else if (el.requestFullscreen) {
          el.requestFullscreen().then(function () {
            if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {});
          }).catch(function () {});
        } else {
          fsBtn.style.display = 'none';
        }
      });
    }

    sync3DButtonAvailability();
    switchRenderer('2d');
    window.addEventListener('resize', function () {
      if (app.renderer) app.renderer.resize();
    });

    Input.bindTouch($('touch-controls'));
    Input.setPauseHandler(togglePause);
    Input.setDebugHandler(toggleDebugOverlay);

    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('button') : null;
      if (btn && btn.blur) btn.blur();
    });

    $('btn-mode-2d').addEventListener('click', function () { switchRenderer('2d'); });
    $('btn-mode-3d').addEventListener('click', function () {
      if (g.Renderer3D) switchRenderer('3d');
    });

    $('btn-sound').addEventListener('click', function () {
      Audio.init();
      var next = !Audio.isMuted();
      Audio.setMuted(next);
      $('btn-sound').textContent = next ? '🔇 MUTE' : '🔊 SFX';
    });

    $('btn-enter').addEventListener('click', function () {
      Audio.init();
      showScreen('select');
    });
    $('btn-how').addEventListener('click', function () {
      $('modal-how').classList.add('show');
    });
    $('btn-how-close').addEventListener('click', function () {
      $('modal-how').classList.remove('show');
    });

    Array.prototype.forEach.call($('seg-vs').querySelectorAll('button'), function (btn) {
      btn.addEventListener('click', function () {
        var nextMode = btn.getAttribute('data-vs');
        if (app.vsMode === 'online' && nextMode !== 'online' && Net && Net.isConnected()) {
          Net.disconnect(true);
        }
        app.vsMode = nextMode;
        Array.prototype.forEach.call($('seg-vs').querySelectorAll('button'), function (b) {
          b.classList.toggle('active', b === btn);
        });
        renderSelectScreen();
      });
    });

    // Online Matchmaking UI & Net handlers
    function updateOnlineStatusUI(st) {
      var dot = $('net-status-dot');
      var txt = $('net-status-text');
      var codeBox = $('net-code-box');
      var codeVal = $('net-code-val');
      var leaveBtn = $('btn-net-leave');
      var actRow = $('online-actions-row');
      if (dot) {
        dot.className = 'net-dot' +
          (st.connected ? ' connected' : (st.state === 'waiting' || st.state === 'connecting' ? ' waiting' : (st.state === 'error' ? ' error' : '')));
      }
      if (txt && st.message) txt.textContent = st.message;
      var showCode = st.roomCode && st.roomCode !== 'QUICK' && (st.state === 'waiting' || st.connected);
      if (codeBox) codeBox.style.display = showCode ? 'inline-flex' : 'none';
      if (codeVal && showCode) codeVal.textContent = st.roomCode;
      var activeSession = st.connected || st.state === 'waiting' || st.state === 'connecting';
      if (leaveBtn) leaveBtn.style.display = activeSession ? 'inline-block' : 'none';
      if (actRow) actRow.style.display = st.connected ? 'none' : 'flex';
      renderSelectScreen();
    }

    if (Net) {
      Net.setHandlers({
        onStatus: updateOnlineStatusUI,
        onConnected: function (info) {
          app.guestReady = false;
          var mySlot = info.role === 'host' ? 0 : 1;
          Net.send({ t: 'sel', slot: mySlot, boxer: app.selected[mySlot] });
          var msg = info.role === 'host'
            ? 'Opponent connected! Pick your fighter and click START ONLINE FIGHT.'
            : 'Connected to Host! Pick your fighter (Blue Corner) and tap READY.';
          updateOnlineStatusUI({ state: 'connected', connected: true, role: info.role, roomCode: info.roomCode, message: msg });
        },
        onDisconnected: function (reason) {
          app.guestReady = false;
          updateOnlineStatusUI({ state: 'disconnected', connected: false, roomCode: '', message: reason || 'Disconnected.' });
          if (app.screen === 'fight' && app.vsMode === 'online') {
            showScreen('select');
          }
        },
        onRemoteSelect: function (slot, boxerId) {
          if ((slot === 0 || slot === 1) && Boxers.byId(boxerId)) {
            app.selected[slot] = boxerId;
            if (app.screen === 'select') renderSelectScreen();
          }
        },
        onRemoteReady: function (rdy) {
          app.guestReady = !!rdy;
          if (app.screen === 'select') renderSelectScreen();
        },
        onMatchStart: function (payload) {
          hideModals();
          startMatch(payload);
        },
        onStateSnapshot: function (remoteState, remoteEvents, hostInp) {
          if (app.screen !== 'fight' || app.vsMode !== 'online' || !app.simState) return;
          // Re-attach static derived fighter stats (`p`) stripped from network packets
          remoteState.fighters[0].p = app.simState.fighters[0].p;
          remoteState.fighters[1].p = app.simState.fighters[1].p;
          remoteState.fighters[0].assist = null;
          remoteState.fighters[1].assist = null;
          remoteState.events = [];
          if (hostInp) {
            app.lastStepInputs[0] = copyInput({ left: hostInp.l, right: hostInp.r, block: hostInp.b });
          }
          app.prevSimState = app.simState;
          app.simState = remoteState;
          if (remoteEvents && remoteEvents.length) {
            for (var i = 0; i < remoteEvents.length; i++) {
              app.onlineEventsQueue.push(remoteEvents[i]);
            }
          }
        },
        onSkipRest: function () {
          doSkipRest(true);
        },
        onRematchRequest: function () {
          if (Net.getRole() === 'host') {
            hideModals();
            startMatch();
          }
        },
        onLeaderboard: function (remoteTop3) {
          mergeAndRenderLeaderboard(remoteTop3, false);
        }
      });

      var nameInp = $('inp-player-name');
      if (nameInp) {
        nameInp.value = app.profile.name;
        var commitName = function () {
          var clean = String(nameInp.value || '').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 14);
          if (!clean) clean = app.profile.name;
          nameInp.value = clean;
          if (clean !== app.profile.name) {
            app.profile.name = clean;
            saveProfile(app.profile);
            var inTop3 = app.leaderboard.some(function (e) { return e.id === app.profile.id; });
            mergeAndRenderLeaderboard(null, inTop3);
          }
        };
        nameInp.addEventListener('change', commitName);
        nameInp.addEventListener('blur', commitName);
        nameInp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            nameInp.blur();
          }
        });
      }

      mergeAndRenderLeaderboard(null, false);
      if (Net.syncLeaderboard) Net.syncLeaderboard();

      var btnQuick = $('btn-net-quick');
      if (btnQuick) btnQuick.addEventListener('click', function () {
        if (Audio) Audio.resume();
        Net.quickMatch();
      });
      var btnHost = $('btn-net-host');
      if (btnHost) btnHost.addEventListener('click', function () {
        if (Audio) Audio.resume();
        Net.hostRoom();
      });
      var btnJoin = $('btn-net-join');
      var inpCode = $('inp-net-code');
      if (btnJoin && inpCode) {
        btnJoin.addEventListener('click', function () {
          if (Audio) Audio.resume();
          Net.joinRoom(inpCode.value);
        });
        inpCode.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            Net.joinRoom(inpCode.value);
          }
        });
      }
      var btnCopyCode = $('btn-net-copy-code');
      if (btnCopyCode) btnCopyCode.addEventListener('click', function () {
        var code = Net.getRoomCode();
        if (code && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code);
          btnCopyCode.textContent = '✓ COPIED';
          setTimeout(function () { btnCopyCode.textContent = '📋 CODE'; }, 1500);
        }
      });
      var btnCopyLink = $('btn-net-copy-link');
      if (btnCopyLink) btnCopyLink.addEventListener('click', function () {
        var code = Net.getRoomCode();
        if (!code) return;
        var base = window.location.origin && window.location.origin !== 'null'
          ? (window.location.origin + window.location.pathname)
          : 'https://ironfistboxing.club/';
        var url = base + '?room=' + encodeURIComponent(code);
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url);
          btnCopyLink.textContent = '✓ LINK COPIED';
          setTimeout(function () { btnCopyLink.textContent = '🔗 INVITE LINK'; }, 1500);
        }
      });
      var btnLeave = $('btn-net-leave');
      if (btnLeave) btnLeave.addEventListener('click', function () {
        Net.disconnect(true);
        updateOnlineStatusUI({ state: 'idle', connected: false, roomCode: '', message: 'Disconnected. Choose Quick Match, Host Room, or Join Room.' });
      });
    }

    Array.prototype.forEach.call($('seg-diff').querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.getAttribute('data-diff') === app.difficulty);
    });
    Array.prototype.forEach.call($('seg-diff').querySelectorAll('button'), function (btn) {
      btn.addEventListener('click', function () {
        app.difficulty = btn.getAttribute('data-diff');
        saveDifficulty(app.difficulty);
        Array.prototype.forEach.call($('seg-diff').querySelectorAll('button'), function (b) {
          b.classList.toggle('active', b === btn);
        });
      });
    });

    $('btn-random').addEventListener('click', function () {
      var list = Boxers.list;
      if (app.vsMode === 'online' && Net && Net.isConnected()) {
        var mySlot = Net.getRole() === 'host' ? 0 : 1;
        var pick = list[Math.floor(Math.random() * list.length)].id;
        app.selected[mySlot] = pick;
        Net.send({ t: 'sel', slot: mySlot, boxer: pick });
      } else {
        var i0 = Math.floor(Math.random() * list.length);
        var i1 = (i0 + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
        app.selected = [list[i0].id, list[i1].id];
      }
      renderSelectScreen();
    });

    $('btn-select-back').addEventListener('click', function () { showScreen('title'); });
    $('btn-start-fight').addEventListener('click', function () { startMatch(); });

    $('btn-pause').addEventListener('click', togglePause);
    $('btn-resume').addEventListener('click', togglePause);
    $('btn-restart').addEventListener('click', function () {
      if (app.vsMode === 'online' && Net && Net.isConnected() && Net.getRole() === 'guest') {
        Net.send({ t: 'rematch' });
        hideModals();
        return;
      }
      hideModals();
      startMatch();
    });
    $('btn-pause-select').addEventListener('click', function () { showScreen('select'); });
    $('btn-pause-title').addEventListener('click', function () { showScreen('title'); });

    function doSkipRest(fromRemote) {
      if (!app.simState || app.simState.phase !== 'rest') return;
      if (app.vsMode === 'online' && Net && Net.isConnected()) {
        if (!fromRemote) Net.send({ t: 'skip_rest' });
        if (Net.getRole() === 'guest') return;
      }
      Input.reset();
      var guard = 0;
      while (app.simState.phase === 'rest' && guard < C.REST_SECONDS * C.FPS + 5) {
        app.prevSimState = app.simState;
        app.simState = Sim.step(app.simState, {}, {});
        if (app.simState.events.length) handleFightEvents(app.simState.events);
        guard++;
      }
      if (app.vsMode === 'online' && Net && Net.isConnected() && Net.getRole() === 'host') {
        Net.sendHostState(app.simState, app.simState.events);
      }
      updateHUD(app.simState);
    }

    $('btn-skip-rest').addEventListener('click', function () { doSkipRest(false); });

    $('btn-rematch').addEventListener('click', function () {
      if (app.vsMode === 'online' && Net && Net.isConnected() && Net.getRole() === 'guest') {
        Net.send({ t: 'rematch' });
        $('btn-rematch').textContent = 'WAITING FOR HOST...';
        return;
      }
      hideModals();
      startMatch();
    });
    $('btn-res-select').addEventListener('click', function () { showScreen('select'); });
    $('btn-res-title').addEventListener('click', function () { showScreen('title'); });

    showScreen('title');
    if (window.location && window.location.search) {
      var qs = window.location.search;
      if (qs.indexOf('screen=select') >= 0) showScreen('select');
      var roomMatch = qs.match(/[?&]room=([A-Za-z0-9]+)/);
      if (roomMatch && roomMatch[1] && Net) {
        var joinCode = roomMatch[1].toUpperCase();
        app.vsMode = 'online';
        Array.prototype.forEach.call($('seg-vs').querySelectorAll('button'), function (b) {
          b.classList.toggle('active', b.getAttribute('data-vs') === 'online');
        });
        showScreen('select');
        if ($('inp-net-code')) $('inp-net-code').value = joinCode;
        Net.joinRoom(joinCode);
      }
      if (qs.indexOf('selftest=1') >= 0) {
        runSelfTest();
      }
    }
    requestAnimationFrame(tickFrame);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUI);
  } else {
    initUI();
  }

  g.App = {
    switchRenderer: switchRenderer,
    sync3DButtonAvailability: sync3DButtonAvailability,
    toggleDebugOverlay: toggleDebugOverlay,
    runSelfTest: runSelfTest,
    getState: function () { return app; }
  };
})(typeof window !== 'undefined' ? window : globalThis);


