/* audio.js - Web Audio sound effects, all synthesized (no asset files). Reacts to sim EVENTS only. */
(function (g) {
  'use strict';
  var ctx = null, master = null, noiseBuf = null, crowdGain = null, muted = false;

  function init() {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
    var AC = g.AudioContext || g.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain(); master.gain.value = muted ? 0 : 0.8; master.connect(ctx.destination);
    var len = ctx.sampleRate * 1.5, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    noiseBuf = buf;
    startCrowd();
  }

  function startCrowd() {
    var src = ctx.createBufferSource(); src.buffer = noiseBuf; src.loop = true;
    var bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 650; bp.Q.value = 0.5;
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400;
    crowdGain = ctx.createGain(); crowdGain.gain.value = 0.0;
    src.connect(bp); bp.connect(lp); lp.connect(crowdGain); crowdGain.connect(master);
    src.start();
  }

  function crowd(level, dur) {
    if (!ctx || !crowdGain) return;
    var t = ctx.currentTime;
    crowdGain.gain.cancelScheduledValues(t);
    crowdGain.gain.setValueAtTime(crowdGain.gain.value, t);
    crowdGain.gain.linearRampToValueAtTime(level, t + 0.12);
    crowdGain.gain.linearRampToValueAtTime(0.035, t + dur);
  }

  function noise(t0, dur, type, f0, f1, q, vol) {
    var src = ctx.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 0.8 + Math.random() * 0.4;
    var f = ctx.createBiquadFilter(); f.type = type; f.Q.value = q;
    f.frequency.setValueAtTime(f0, t0); f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    var g1 = ctx.createGain(); g1.gain.setValueAtTime(0.0001, t0); g1.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(0.02, dur * 0.3)); g1.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f); f.connect(g1); g1.connect(master);
    src.start(t0, Math.random() * 0.5, dur + 0.05);
  }
  function tone(t0, dur, f0, f1, type, vol) {
    var o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    var g1 = ctx.createGain(); g1.gain.setValueAtTime(vol, t0); g1.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g1); g1.connect(master); o.start(t0); o.stop(t0 + dur + 0.05);
  }

  function whoosh(type) {
    var t = ctx.currentTime, d = type === 'uppercut' ? 0.28 : (type === 'hook' ? 0.22 : 0.14);
    noise(t, d, 'bandpass', type === 'jab' ? 1800 : 1100, type === 'jab' ? 500 : 300, 1.2, type === 'jab' ? 0.16 : 0.24);
  }
  function hit(dmg, heavy, counter) {
    var t = ctx.currentTime, v = Math.min(1, 0.45 + dmg / 18);
    tone(t, 0.16, heavy ? 130 : 180, 50, 'sine', 0.8 * v);
    noise(t, 0.12, 'lowpass', 2600, 300, 0.7, 0.9 * v);
    noise(t, 0.05, 'highpass', 2500, 4000, 0.7, 0.35 * v);
    if (heavy) { tone(t, 0.35, 70, 35, 'sine', 0.8); noise(t + 0.02, 0.3, 'lowpass', 900, 120, 0.7, 0.5); }
    if (counter) tone(t + 0.02, 0.1, 900, 400, 'triangle', 0.15);
  }
  function block() {
    var t = ctx.currentTime;
    tone(t, 0.09, 220, 120, 'triangle', 0.35);
    noise(t, 0.08, 'bandpass', 1400, 500, 1.4, 0.4);
  }
  function dodge() { noise(ctx.currentTime, 0.2, 'bandpass', 700, 2200, 2, 0.14); }
  function bell(times) {
    var t0 = ctx.currentTime, i, k, parts = [[523, 0.5], [1120, 0.3], [1650, 0.18], [2310, 0.1], [3050, 0.06]];
    for (i = 0; i < times; i++) {
      var t = t0 + i * (times > 3 ? 0.17 : 0.55);
      for (k = 0; k < parts.length; k++) {
        var o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = parts[k][0] * (1 + (k % 2 ? 0.003 : -0.002));
        var gn = ctx.createGain(); gn.gain.setValueAtTime(0.0001, t); gn.gain.exponentialRampToValueAtTime(parts[k][1] * 0.45, t + 0.004); gn.gain.exponentialRampToValueAtTime(0.0001, t + 1.8 / (1 + k * 0.5));
        o.connect(gn); gn.connect(master); o.start(t); o.stop(t + 2);
      }
    }
  }
  function thud() { var t = ctx.currentTime; tone(t, 0.45, 90, 28, 'sine', 1.0); noise(t, 0.4, 'lowpass', 600, 80, 0.7, 0.8); }
  function countTick(n) {
    var t = ctx.currentTime;
    var f = 380 + n * 48;
    tone(t, 0.16, f, f * 0.96, 'triangle', 0.22);
    if (n >= 8) tone(t, 0.16, f * 1.5, f * 1.45, 'sine', 0.14);
  }
  function pressTick(meter) {
    var t = ctx.currentTime;
    var f = 520 + (meter || 0) * 5.2;
    tone(t, 0.045, f, f * 1.12, 'sine', 0.11);
  }
  function riseSuccess() {
    var t = ctx.currentTime;
    tone(t, 0.18, 440, 660, 'triangle', 0.22);
    tone(t + 0.07, 0.24, 660, 880, 'triangle', 0.25);
  }
  function momentumReady() {
    var t = ctx.currentTime;
    tone(t, 0.14, 523.25, 659.25, 'triangle', 0.22);
    tone(t + 0.08, 0.22, 659.25, 1046.5, 'sine', 0.26);
  }
  function comboTooFar() {
    var t = ctx.currentTime;
    tone(t, 0.12, 160, 110, 'sawtooth', 0.16);
  }
  function perfectBlock() {
    var t = ctx.currentTime;
    tone(t, 0.11, 980, 1420, 'triangle', 0.25);
    noise(t, 0.07, 'bandpass', 2200, 1200, 2.0, 0.3);
  }
  function comboStart() {
    var t = ctx.currentTime;
    tone(t, 0.28, 220, 440, 'sawtooth', 0.24);
    tone(t + 0.05, 0.32, 330, 660, 'triangle', 0.26);
    noise(t, 0.25, 'bandpass', 800, 2400, 1.5, 0.25);
  }
  function comboMeterSweep() {
    var t = ctx.currentTime;
    tone(t, 0.35, 320, 620, 'sine', 0.09);
  }
  function comboHitGrade(grade, finisher) {
    var t = ctx.currentTime;
    if (grade === 'green') {
      tone(t, 0.16, 880, 1320, 'sine', 0.28);
      tone(t + 0.05, 0.22, 1320, 1760, 'triangle', 0.25);
      if (finisher) tone(t, 0.4, 110, 40, 'sine', 0.85);
    } else if (grade === 'good') {
      tone(t, 0.14, 587, 784, 'triangle', 0.2);
    } else {
      tone(t, 0.18, 190, 95, 'sawtooth', 0.22);
    }
  }

  function handle(events) {
    if (!ctx || muted || !events) return;
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      switch (e.type) {
        case 'punch_thrown': whoosh(e.punch || 'jab'); break;
        case 'punch_landed': hit(e.dmg, e.heavy, e.counter); crowd(e.heavy ? 0.22 : 0.1, e.heavy ? 1.8 : 0.9); break;
        case 'blocked': block(); break;
        case 'perfect_block': perfectBlock(); break;
        case 'dodged': dodge(); break;
        case 'guard_break': hit(8, true, false); crowd(0.18, 1.2); break;
        case 'momentum_ready': momentumReady(); crowd(0.18, 1.2); break;
        case 'combo_too_far': comboTooFar(); break;
        case 'combo_start': comboStart(); crowd(0.36, 2.4); break;
        case 'combo_meter_start': comboMeterSweep(); break;
        case 'combo_hit': comboHitGrade(e.grade, e.finisher); if (e.grade === 'green') crowd(0.32, 1.8); break;
        case 'combo_end': if (!e.broken) crowd(0.38, 2.5); break;
        case 'knockdown': thud(); crowd(0.35, 3.0); break;
        case 'count_tick': countTick(e.count || e.n || 1); crowd(0.12 + (e.count || 1) * 0.02, 0.8); break;
        case 'get_up_press': pressTick(e.meter); break;
        case 'get_up_success': riseSuccess(); crowd(0.32, 2.2); break;
        case 'bell': bell(e.kind === 'start' ? 1 : (e.kind === 'ko' ? 10 : 3)); if (e.kind === 'start') crowd(0.2, 2.0); break;
        case 'ko': crowd(0.5, 5.0); break;
        case 'decision': crowd(0.35, 3.5); break;
        case 'combo': crowd(0.2, 1.2); break;
      }
    }
  }

  g.GameAudio = {
    init: init,
    handle: handle,
    setMuted: function (m) { muted = m; if (master) master.gain.value = m ? 0 : 0.8; },
    isMuted: function () { return muted; },
    resume: init
  };
})(typeof window !== 'undefined' ? window : globalThis);
