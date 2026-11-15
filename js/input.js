/* input.js - strict keyboard + multitouch input manager.
 *
 * Contract:
 * - Uses e.code exclusively (layout/Shift/CapsLock independent).
 * - Continuous hold actions: left, right, block (active ONLY while key/touch is held).
 * - Edge-triggered actions: jab, hook, uppercut, dodge, combo (fire ONLY once per keydown edge;
 *   holding the key or OS key-repeat never repeats the action).
 * - Get-up presses: `presses` is an integer count of valid fresh keydown/pointerdown events
 *   for that player since the last step (e.repeat and holding a key add 0).
 * - Clears all held/pulsed state on keyup, window blur, visibilitychange, pause, and state changes.
 * - Never shares or mutates input objects between Player 1, Player 2, and CPU.
 */
(function (g) {
  'use strict';

  var HOLD_ACTIONS = { left: true, right: true, block: true };
  var EDGE_ACTIONS = { jab: true, hook: true, uppercut: true, dodge: true, combo: true };

  var P1_MAP = {
    KeyA: 'left', KeyD: 'right',
    KeyJ: 'jab', KeyZ: 'jab',
    KeyK: 'hook', KeyX: 'hook',
    KeyL: 'uppercut', KeyC: 'uppercut',
    KeyS: 'block', ShiftLeft: 'block',
    KeyW: 'dodge', Space: 'dodge', KeyV: 'dodge',
    KeyE: 'combo'
  };

  // Extra convenience bindings for Player 1 when in 1-player (VS CPU) mode
  var P1_SOLO_EXTRA = {
    ArrowLeft: 'left', ArrowRight: 'right',
    ArrowDown: 'block', ArrowUp: 'dodge'
  };

  var P2_MAP = {
    ArrowLeft: 'left', ArrowRight: 'right',
    Numpad1: 'jab', Digit1: 'jab', Comma: 'jab',
    Numpad2: 'hook', Digit2: 'hook', Period: 'hook',
    Numpad3: 'uppercut', Digit3: 'uppercut', Slash: 'uppercut',
    ArrowDown: 'block', Numpad0: 'block', ShiftRight: 'block',
    ArrowUp: 'dodge', Numpad4: 'dodge', Enter: 'dodge', Semicolon: 'dodge',
    KeyI: 'combo'
  };

  var down = {};
  var pulse1 = { jab: false, hook: false, uppercut: false, dodge: false, combo: false };
  var pulse2 = { jab: false, hook: false, uppercut: false, dodge: false, combo: false };
  var pressCount1 = 0;
  var pressCount2 = 0;
  var touchPointers = {}; // action -> { pid: true }
  var touchPulse = { jab: false, hook: false, uppercut: false, dodge: false, combo: false };
  var touchPressCount1 = 0;
  var touchButtons = [];
  var twoPlayer = false;
  var onPauseKey = null;
  var onDebugKey = null;

  var lastSampledP1 = { left: false, right: false, jab: false, hook: false, uppercut: false, block: false, dodge: false, combo: false, presses: 0 };
  var lastSampledP2 = { left: false, right: false, jab: false, hook: false, uppercut: false, block: false, dodge: false, combo: false, presses: 0 };

  function isGameKey(code) {
    return !!(P1_MAP[code] || P2_MAP[code] || P1_SOLO_EXTRA[code]);
  }

  function resolveP1Action(code) {
    return P1_MAP[code] || (!twoPlayer ? P1_SOLO_EXTRA[code] : null) || null;
  }

  function resolveP2Action(code) {
    return twoPlayer ? (P2_MAP[code] || null) : null;
  }

  function handleKeyDown(e) {
    var code = e.code;
    if (!code) return;

    if (code === 'Backquote' || code === 'F3') {
      e.preventDefault();
      if (!e.repeat && typeof onDebugKey === 'function') onDebugKey();
      return;
    }

    if (code === 'Escape' || code === 'KeyP') {
      e.preventDefault();
      if (!e.repeat && typeof onPauseKey === 'function') onPauseKey();
      return;
    }

    if (isGameKey(code)) {
      var tag = e.target && e.target.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
        e.preventDefault();
      }
      if (document.activeElement && document.activeElement.tagName === 'BUTTON') {
        document.activeElement.blur();
      }
    }

    if (g.GameAudio) g.GameAudio.resume();

    // Ignore OS key auto-repeat and already-held keys so holding never re-triggers punches/dodges/combos or get-up presses
    if (e.repeat || down[code]) return;
    down[code] = true;

    var a1 = resolveP1Action(code);
    if (a1) {
      pressCount1++;
      if (EDGE_ACTIONS[a1]) pulse1[a1] = true;
    }
    var a2 = resolveP2Action(code);
    if (a2) {
      pressCount2++;
      if (EDGE_ACTIONS[a2]) pulse2[a2] = true;
    }
  }

  function handleKeyUp(e) {
    var code = e.code;
    if (!code) return;
    delete down[code];
  }

  function clearAll() {
    down = {};
    pulse1 = { jab: false, hook: false, uppercut: false, dodge: false, combo: false };
    pulse2 = { jab: false, hook: false, uppercut: false, dodge: false, combo: false };
    pressCount1 = 0;
    pressCount2 = 0;
    touchPointers = {};
    touchPulse = { jab: false, hook: false, uppercut: false, dodge: false, combo: false };
    touchPressCount1 = 0;
    for (var i = 0; i < touchButtons.length; i++) {
      touchButtons[i].classList.remove('active');
    }
    lastSampledP1 = { left: false, right: false, jab: false, hook: false, uppercut: false, block: false, dodge: false, combo: false, presses: 0 };
    lastSampledP2 = { left: false, right: false, jab: false, hook: false, uppercut: false, block: false, dodge: false, combo: false, presses: 0 };
  }

  function isTouchActionHeld(act) {
    var bag = touchPointers[act];
    if (!bag) return false;
    for (var k in bag) {
      if (Object.prototype.hasOwnProperty.call(bag, k)) return true;
    }
    return false;
  }

  function samplePlayer(isP1) {
    var out = { left: false, right: false, jab: false, hook: false, uppercut: false, block: false, dodge: false, combo: false, presses: 0 };
    var code, act;

    // 1. Continuous hold actions (left, right, block) from currently held keys
    for (code in down) {
      if (!down[code]) continue;
      act = isP1 ? resolveP1Action(code) : resolveP2Action(code);
      if (act && HOLD_ACTIONS[act]) {
        out[act] = true;
      }
    }

    // 2. Touch hold actions for Player 1
    if (isP1) {
      for (act in HOLD_ACTIONS) {
        if (isTouchActionHeld(act)) out[act] = true;
      }
    }

    // 3. Edge-triggered actions (jab, hook, uppercut, dodge, combo) fire ONLY on a keydown/pointerdown pulse
    var pulse = isP1 ? pulse1 : pulse2;
    for (act in EDGE_ACTIONS) {
      if (pulse[act]) {
        out[act] = true;
        pulse[act] = false;
      }
      if (isP1 && touchPulse[act]) {
        out[act] = true;
        touchPulse[act] = false;
      }
    }

    // 4. Fresh press count for the knockdown Get-Up Meter
    if (isP1) {
      out.presses = pressCount1 + touchPressCount1;
      pressCount1 = 0;
      touchPressCount1 = 0;
      lastSampledP1 = Object.assign({}, out);
    } else {
      out.presses = pressCount2;
      pressCount2 = 0;
      lastSampledP2 = Object.assign({}, out);
    }
    return out;
  }

  function bindTouchControls(container) {
    if (!container) return;
    var btns = container.querySelectorAll('[data-action]');
    touchButtons = Array.prototype.slice.call(btns);
    touchButtons.forEach(function (btn) {
      var act = btn.getAttribute('data-action');
      if (!touchPointers[act]) touchPointers[act] = {};

      function press(e) {
        e.preventDefault();
        if (g.GameAudio) g.GameAudio.resume();
        var pid = e.pointerId !== undefined ? e.pointerId : 'mouse';
        if (btn.setPointerCapture && e.pointerId !== undefined) {
          try { btn.setPointerCapture(e.pointerId); } catch (_) {}
        }
        if (!touchPointers[act]) touchPointers[act] = {};
        var wasHeld = isTouchActionHeld(act);
        if (!touchPointers[act][pid]) {
          touchPressCount1++;
        }
        touchPointers[act][pid] = true;
        if (EDGE_ACTIONS[act] && !wasHeld) {
          touchPulse[act] = true;
        }
        btn.classList.add('active');
        if (document.activeElement && document.activeElement.tagName === 'BUTTON') {
          document.activeElement.blur();
        }
      }

      function release(e) {
        e.preventDefault();
        var pid = e.pointerId !== undefined ? e.pointerId : 'mouse';
        if (touchPointers[act]) {
          delete touchPointers[act][pid];
        }
        if (!isTouchActionHeld(act)) {
          btn.classList.remove('active');
        }
      }

      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('lostpointercapture', release);
      btn.addEventListener('pointerleave', function (e) {
        if (!btn.hasPointerCapture || (e.pointerId !== undefined && !btn.hasPointerCapture(e.pointerId))) {
          release(e);
        }
      });
      btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    });
  }

  function getDebugState() {
    var p1Keys = [], p2Keys = [], k;
    for (k in down) {
      if (!down[k]) continue;
      if (resolveP1Action(k)) p1Keys.push(k);
      if (resolveP2Action(k)) p2Keys.push(k);
    }
    for (k in HOLD_ACTIONS) {
      if (isTouchActionHeld(k)) p1Keys.push('Touch:' + k);
    }
    for (k in EDGE_ACTIONS) {
      if (isTouchActionHeld(k)) p1Keys.push('Touch:' + k);
    }
    return {
      p1Keys: p1Keys,
      p2Keys: p2Keys,
      lastP1: Object.assign({}, lastSampledP1),
      lastP2: Object.assign({}, lastSampledP2)
    };
  }

  window.addEventListener('keydown', handleKeyDown, { passive: false });
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', clearAll);
  window.addEventListener('pagehide', clearAll);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearAll();
  });

  g.Input = {
    setTwoPlayer: function (v) { twoPlayer = !!v; clearAll(); },
    setPauseHandler: function (fn) { onPauseKey = fn; },
    setDebugHandler: function (fn) { onDebugKey = fn; },
    bindTouch: bindTouchControls,
    reset: clearAll,
    sampleP1: function () { return samplePlayer(true); },
    sampleP2: function () { return samplePlayer(false); },
    getDebugState: getDebugState
  };
})(typeof window !== 'undefined' ? window : globalThis);
