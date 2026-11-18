/* sim.js - pure deterministic fight simulation.
 *
 *   Sim.create(opts)            -> initial state
 *   Sim.step(state, in1, in2)   -> NEW state (the old one is never mutated)
 *
 * No DOM, no drawing, no audio, no Math.random (seeded RNG stored in state.rng).
 * Every step the returned state carries state.events: things that happened this step.
 * Inputs: {left,right,jab,hook,uppercut,block,dodge,combo,presses} (booleans + integer presses).
 * Fighter 0 always stands on the left and faces +x, fighter 1 on the right facing -x.
 */
(function (g) {
  'use strict';
  var C = g.Config, R = g.RNG;

  var TRAIT_DEFAULTS = { jabSpeed: 1, hookPower: 1, upperPower: 1, upperCost: 1, blockEff: 1, dodgeCdMul: 1, counterMult: 1, iBonus: 0, hitstunMul: 1, comboBonus: 1 };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isPunch(a) { return a === 'jab' || a === 'hook' || a === 'uppercut'; }
  function isFree(a) { return a === 'idle' || a === 'walk' || a === 'block'; }

  function derive(b) {
    var s = b.stats, t = {}, k;
    for (k in TRAIT_DEFAULTS) t[k] = (b.traits && b.traits[k] !== undefined) ? b.traits[k] : TRAIT_DEFAULTS[k];
    return {
      id: b.id,
      moveSpeed: 0.8 + 0.04 * s.speed,
      atkTime: 1.28 - 0.055 * s.speed,       // frame multiplier (lower = faster)
      power: 0.7 + 0.065 * s.power,
      maxSt: C.STAMINA_BASE + C.STAMINA_PER_STAT * s.stamina,
      regen: C.REGEN_BASE + C.REGEN_PER_STAT * s.stamina,
      takeMul: 1.3 - 0.06 * s.chin,          // damage taken multiplier
      chin: s.chin,
      reach: 0.88 + 0.03 * s.reach,
      armScale: 0.9 + 0.02 * s.reach,
      t: t
    };
  }

  function makeFighter(idx, b, x, priorKOs, assist) {
    var p = derive(b);
    var pKOs = Math.max(0, priorKOs | 0);
    var initKdLevel = pKOs * (C.KNOCKDOWN.priorKoLevelPenalty || 1);
    return {
      idx: idx, bid: b.id, p: p, x: x, facing: idx === 0 ? 1 : -1,
      hp: C.HP_MAX, maxHp: C.HP_MAX, st: p.maxSt, maxSt: p.maxSt,
      momentum: 0, maxMomentum: C.MOMENTUM.max, idleNoHitT: 0, whiffStreak: 0,
      perfectBlockCounterT: 0, blockStunT: 0,
      action: 'idle', t: 0, dur: 0, prog: 0, dir: 0,
      ptype: null, wu: 0, ac: 0, rec: 0, hitDone: false, landed: false, whiff: false, cancelAt: 0, atkPower: 1,
      kv: 0, dodgeCd: 0, dodgeDir: -1, ifEnd: 0, counterT: 0, hitType: null,
      comboN: 0, comboT: 0, repeatN: 0, lastType: null,
      buffer: null, bufT: 0, gassedT: 0, pm: 0,
      kd: 0, kdTot: 0, kdLevel: initKdLevel, priorKOs: pKOs, getup: 0, invulnT: 0, assist: assist || null,
      dmgR: 0, cleanR: 0, dmg: 0, landedN: 0, thrownN: 0
    };
  }

  function kdParams(level, chin, assist) {
    var K = C.KNOCKDOWN;
    var lvl = clamp(level | 0, 0, K.maxLevelCap) * (assist ? assist.getupRamp : 1);
    var pressGain = Math.max(K.minPressGain, K.basePressGain * Math.pow(1 - K.pressShrinkPerKd, lvl));
    var chinMul = Math.max(0.5, 1 - ((chin || 5) - 5) * K.chinDrainFactor);
    var drainPerSec = Math.min(K.maxDrainPerSec, K.baseDrainPerSec * Math.pow(K.drainMultPerKd, lvl) * chinMul);
    if (assist) { pressGain *= assist.getupGainMul; drainPerSec *= assist.getupDrainMul; }
    return { level: lvl, pressGain: pressGain, drainPerSec: drainPerSec };
  }

  function create(opts) {
    var b0 = g.Boxers.byId(opts.boxers[0]), b1 = g.Boxers.byId(opts.boxers[1]);
    var pKOs = opts.priorKOs || [0, 0];
    // VS CPU mode: Player 1 (human) gets small assists from Config.ASSIST[difficulty]; Local 2P gets none.
    var cpuDiff = opts.vsCpu ? (C.ASSIST[opts.difficulty] ? opts.difficulty : 'easy') : null;
    var humanAssist = cpuDiff ? C.ASSIST[cpuDiff] : null;
    var s = {
      tick: 0, rng: (opts.seed | 0) || 1, phase: 'fight', phaseT: 0, round: 1,
      clock: C.ROUND_SECONDS * C.FPS,
      fighters: [makeFighter(0, b0, -C.START_X, pKOs[0], humanAssist), makeFighter(1, b1, C.START_X, pKOs[1], null)],
      count: null, comboState: null, hitstop: 0, slowmo: 0, timeScale: 1,
      cpuMode: cpuDiff ? { human: 0, diff: cpuDiff } : null,
      events: [], rounds: [], result: null, boxers: [b0.id, b1.id]
    };
    s.events.push({ type: 'round_start', round: 1 });
    s.events.push({ type: 'bell', kind: 'start', round: 1 });
    s.events.push({ type: 'fight_start', round: 1 });
    return s;
  }

  function clone(s) {
    var n = {}, k;
    for (k in s) n[k] = s[k];
    n.fighters = [Object.assign({}, s.fighters[0]), Object.assign({}, s.fighters[1])];
    n.count = s.count ? Object.assign({}, s.count) : null;
    n.comboState = s.comboState ? Object.assign({}, s.comboState) : null;
    n.events = [];
    return n;
  }

  function emit(n, type, data) {
    data = data || {};
    data.type = type;
    n.events.push(data);
  }

  function norm(i) {
    i = i || {};
    return {
      left: !!i.left, right: !!i.right,
      jab: !!i.jab, hook: !!i.hook, uppercut: !!i.uppercut,
      block: !!i.block, dodge: !!i.dodge, combo: !!i.combo,
      presses: (typeof i.presses === 'number' && i.presses > 0) ? (i.presses | 0) : undefined,
      cpuDiff: i.cpuDiff || null
    };
  }
  function mask(i) {
    return (i.left ? 1 : 0) | (i.right ? 2 : 0) | (i.jab ? 4 : 0) | (i.hook ? 8 : 0) |
           (i.uppercut ? 16 : 0) | (i.block ? 32 : 0) | (i.dodge ? 64 : 0) | (i.combo ? 128 : 0);
  }
  function fatigue(f) {
    var th = C.FATIGUE_START * f.maxSt;
    return f.st >= th ? 0 : Math.max(0, (th - f.st) / th);
  }
  function setIdle(f) {
    f.action = 'idle';
    f.t = 0;
    f.dur = 0;
    f.prog = 0;
    f.dir = 0;
    f.ptype = null;
  }

  function addMomentum(n, f, delta) {
    if (!delta) return;
    // Momentum does not grow while a boxer is knocked down, and opponent's momentum never changes during a combo
    if (n.comboState && f.idx !== n.comboState.attacker) return;
    if (delta > 0 && (n.count || f.action === 'knockdown' || f.action === 'getup')) return;
    if (delta > 0 && f.assist) delta *= f.assist.momentumMul;
    var prev = f.momentum;
    f.momentum = clamp(f.momentum + delta, 0, C.MOMENTUM.max);
    if (prev < C.MOMENTUM.max && f.momentum >= C.MOMENTUM.max) {
      emit(n, 'momentum_ready', { who: f.idx });
    }
  }

  function captureEdgeBuffer(f, inp) {
    var rise = mask(inp) & ~f.pm;
    var want = (rise & 128) ? 'combo' : (rise & 4) ? 'jab' : (rise & 8) ? 'hook' : (rise & 16) ? 'uppercut' : (rise & 64) ? 'dodge' : null;
    if (want) {
      f.buffer = want;
      f.bufT = C.BUFFER_FRAMES;
    }
  }

  // ---------------------------------------------------------------- step
  function step(s, i0, i1) {
    var n = clone(s);
    var ins = [norm(i0), norm(i1)];
    n.tick++;
    if (n.slowmo > 0) n.slowmo--;
    n.timeScale = n.slowmo > 0 ? C.SLOWMO.scale : 1;

    // During hitstop freeze, preserve any rising-edge button press, combo timing press, or knockdown mash press
    if (n.hitstop > 0) {
      n.hitstop--;
      if (n.phase === 'fight') {
        if (n.count) {
          var cw = n.count.who, cin = ins[cw], cd = n.fighters[cw];
          if (!cin.cpuDiff) {
            var p = cin.presses !== undefined ? cin.presses : ((mask(cin) & ~cd.pm) ? 1 : 0);
            if (p > 0) n.count.bufferedPresses = (n.count.bufferedPresses || 0) + p;
          }
        } else if (n.comboState) {
          var ca = n.comboState.attacker, cain = ins[ca], caf = n.fighters[ca];
          if ((mask(cain) & ~caf.pm) & (4 | 8 | 16 | 128)) {
            n.comboState.bufferedTimingPress = true;
          }
        } else {
          captureEdgeBuffer(n.fighters[0], ins[0]);
          captureEdgeBuffer(n.fighters[1], ins[1]);
        }
      }
      n.fighters[0].pm = mask(ins[0]);
      n.fighters[1].pm = mask(ins[1]);
      return n;
    }

    switch (n.phase) {
      case 'intro': stepIntro(n); break;
      case 'fight': stepFight(n, ins); break;
      case 'roundend': stepRoundEnd(n); break;
      case 'rest': stepRest(n); break;
      case 'finished': stepFinished(n); break;
    }
    n.fighters[0].pm = mask(ins[0]);
    n.fighters[1].pm = mask(ins[1]);
    return n;
  }

  function glide(f, target, speed) {
    var d = target - f.x, mv = speed * C.DT;
    if (Math.abs(d) <= mv) { f.x = target; f.dir = 0; setIfFree(f, 'idle'); return; }
    var sgn = d > 0 ? 1 : -1;
    f.x += sgn * mv;
    f.dir = sgn * f.facing;
    setIfFree(f, 'walk');
  }
  function setIfFree(f, a) {
    if (f.action === a) { f.t++; return; }
    if (isFree(f.action) || (!isPunch(f.action) && f.action !== 'knockdown' && f.action !== 'getup' && f.action !== 'victory')) { f.action = a; f.t = 0; }
  }
  function calmFighter(f) {
    if (f.action === 'knockdown' || f.action === 'getup' || f.action === 'victory') return;
    if (!isFree(f.action)) setIdle(f);
    f.kv = 0; f.buffer = null; f.bufT = 0; f.dir = 0;
  }

  function setProg(f) {
    var a = f.action;
    if (isPunch(a)) {
      var P = C.PUNCH[a], tot = P.windup + P.active + P.recovery;
      var wf = P.windup / tot, af = P.active / tot, t = f.t;
      if (t <= f.wu) f.prog = wf * (t / Math.max(1, f.wu));
      else if (t <= f.wu + f.ac) f.prog = wf + af * ((t - f.wu) / f.ac);
      else f.prog = Math.min(1, wf + af + (1 - wf - af) * ((t - f.wu - f.ac) / Math.max(1, f.dur - f.wu - f.ac)));
    } else if (a === 'block') f.prog = Math.min(1, f.t / 6);
    else if (a === 'knockdown') f.prog = Math.min(1, f.t / C.KNOCKDOWN.fall);
    else if (a === 'idle' || a === 'walk' || a === 'victory') f.prog = 0;
    else f.prog = f.dur ? Math.min(1, f.t / f.dur) : 0;
  }

  function stepIntro(n) {
    n.phase = 'fight';
    n.phaseT = 0;
    n.fighters[0].x = -C.START_X;
    n.fighters[1].x = C.START_X;
    setIdle(n.fighters[0]);
    setIdle(n.fighters[1]);
    emit(n, 'bell', { kind: 'start', round: n.round });
    emit(n, 'fight_start', { round: n.round });
  }

  function stepFight(n, ins) {
    var prevX0 = n.fighters[0].x, prevX1 = n.fighters[1].x;
    if (n.count) {
      stepCount(n, ins, prevX0, prevX1);
      setProg(n.fighters[0]);
      setProg(n.fighters[1]);
      return;
    }
    if (n.comboState) {
      stepComboMove(n, ins);
      return;
    }
    updateFighter(n, 0, ins[0]);
    if (!n.comboState) {
      updateFighter(n, 1, ins[1]);
    }
    if (!n.comboState) {
      resolveHits(n);
      separate(n, prevX0, prevX1);
      setProg(n.fighters[0]);
      setProg(n.fighters[1]);
    }
    if (n.phase === 'fight' && !n.count && !n.comboState) {
      n.clock--;
      if (n.clock <= 0) endRound(n);
    }
  }

  // ---------------------------------------------------------------- fighter update
  function updateFighter(n, i, inp) {
    var f = n.fighters[i];
    var rise = mask(inp) & ~f.pm;
    if (f.dodgeCd > 0) f.dodgeCd--;
    if (f.counterT > 0) f.counterT--;
    if (f.perfectBlockCounterT > 0) f.perfectBlockCounterT--;
    if (f.blockStunT > 0) f.blockStunT--;
    if (f.gassedT > 0) f.gassedT--;
    if (f.invulnT > 0) f.invulnT--;
    if (f.comboT > 0) { f.comboT--; if (f.comboT === 0) { f.comboN = 0; f.repeatN = 0; f.lastType = null; } }

    // Slow momentum drain after standing 4 seconds with no landed punches
    f.idleNoHitT++;
    if (f.idleNoHitT > C.MOMENTUM.idleGraceFrames && f.momentum > 0 && f.momentum < C.MOMENTUM.max) {
      addMomentum(n, f, -C.MOMENTUM.idleDrainPerSec * C.DT);
    }

    var want = (rise & 128) ? 'combo' : (rise & 4) ? 'jab' : (rise & 8) ? 'hook' : (rise & 16) ? 'uppercut' : (rise & 64) ? 'dodge' : null;
    if (want) {
      f.buffer = want;
      f.bufT = C.BUFFER_FRAMES;
    } else if (f.bufT > 0) {
      f.bufT--;
      if (f.bufT === 0) f.buffer = null;
    }

    if (f.kv !== 0) {
      f.x += -f.facing * f.kv;
      f.kv *= 0.85;
      if (Math.abs(f.kv) < 0.0004) f.kv = 0;
    }

    var a = f.action;
    if (a === 'hit' || a === 'stagger') {
      f.t++;
      if (f.t >= f.dur) {
        setIdle(f);
        freeUpdate(n, f, inp);
      }
    } else if (isPunch(a)) {
      advancePunch(n, f, inp);
    } else if (a === 'dodge') {
      f.t++;
      if (f.t <= C.DODGE.moveFrames) {
        var d = (f.dodgeDir > 0 ? C.DODGE.slipDist : C.DODGE.dist) / C.DODGE.moveFrames;
        f.x += f.facing * f.dodgeDir * d;
      }
      if (f.t >= f.dur) {
        setIdle(f);
        freeUpdate(n, f, inp);
      }
    } else if (a === 'knockdown' || a === 'getup' || a === 'victory') {
      f.t++;
    } else {
      freeUpdate(n, f, inp);
    }

    // Stamina regeneration (only when free)
    if (isFree(f.action) && f.gassedT === 0 && !n.comboState) {
      var mul = f.action === 'block' ? C.REGEN_BLOCK_MUL : (f.dir !== 0 ? C.REGEN_MOVE_MUL : 1);
      f.st = Math.min(f.maxSt, f.st + f.p.regen * mul * C.DT * (f.assist ? f.assist.regenMul : 1));
    }
  }

  function tryActivateCombo(n, f) {
    if (n.phase !== 'fight' || n.count || n.comboState) return false;
    if (f.momentum < C.MOMENTUM.max) return false;
    if (f.blockStunT > 0) return false;
    var o = n.fighters[1 - f.idx];
    if (o.action === 'knockdown' || o.action === 'getup') return false;

    var boxer = g.Boxers.byId(f.bid);
    var sig = boxer && boxer.signatureCombo;
    if (!sig || !sig.hits || !sig.hits.length) return false;

    var maxDist = (sig.range || C.MOMENTUM.activateRange) * f.p.reach;
    var dist = Math.abs(f.x - o.x);
    if (dist > maxDist) {
      // Too far: do NOT waste momentum; emit hint event
      emit(n, 'combo_too_far', { who: f.idx, x: f.x, dist: dist, maxDist: maxDist });
      return false;
    }

    startSignatureCombo(n, f, o, sig);
    return true;
  }

  function tryConsumeBuffer(n, f, inp) {
    if (!f.buffer) return false;
    var b = f.buffer;
    if (b === 'combo') {
      f.buffer = null; f.bufT = 0;
      return tryActivateCombo(n, f);
    }
    if (b === 'dodge') {
      if (f.dodgeCd > 0) return false;
      f.buffer = null; f.bufT = 0;
      if (f.st >= 2) { startDodge(n, f, inp); return true; }
      emit(n, 'gassed', { who: f.idx });
      return false;
    }
    f.buffer = null; f.bufT = 0;
    if (f.st >= C.MIN_STAMINA_TO_PUNCH) {
      startPunch(n, f, b);
      return true;
    }
    emit(n, 'gassed', { who: f.idx });
    return false;
  }

  function freeUpdate(n, f, inp) {
    if (tryConsumeBuffer(n, f, inp)) return;
    var dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    var na = inp.block ? 'block' : (dir !== 0 ? 'walk' : 'idle');
    if (na !== f.action) { f.action = na; f.t = 0; } else f.t++;
    f.dir = dir * f.facing;
    if (dir !== 0) {
      var sp = (f.dir > 0 ? C.MOVE_FWD : C.MOVE_BACK) * f.p.moveSpeed * (1 - 0.2 * fatigue(f)) * (inp.block ? C.BLOCK_MOVE_MUL : 1);
      f.x += dir * sp * C.DT;
    }
  }

  function startPunch(n, f, type) {
    var P = C.PUNCH[type], fat = fatigue(f);
    var cost = P.stamina * (type === 'uppercut' ? f.p.t.upperCost : 1);
    f.st = Math.max(0, f.st - cost);
    if (f.st <= 0) { f.gassedT = C.GASSED_DELAY; emit(n, 'gassed', { who: f.idx }); }
    var mult = f.p.atkTime * (1 + C.FATIGUE_SLOW * fat) * (type === 'jab' ? f.p.t.jabSpeed : 1);
    f.wu = Math.max(2, Math.round(P.windup * mult));
    f.ac = P.active;
    f.rec = Math.max(4, Math.round(P.recovery * mult));
    f.dur = f.wu + f.ac + f.rec;
    f.cancelAt = f.wu + f.ac + Math.ceil(f.rec * 0.45);
    var tp = type === 'hook' ? f.p.t.hookPower : (type === 'uppercut' ? f.p.t.upperPower : 1);
    f.atkPower = f.p.power * (1 - C.FATIGUE_WEAK * fat) * tp;
    f.action = type; f.ptype = type; f.t = 0; f.dir = 0;
    f.hitDone = false; f.landed = false; f.whiff = false;
    f.thrownN++;
    emit(n, 'punch_thrown', { who: f.idx, punch: type, x: f.x });
  }

  function startDodge(n, f, inp) {
    var D = C.DODGE;
    f.st = Math.max(0, f.st - D.cost);
    if (f.st <= 0) f.gassedT = C.GASSED_DELAY;
    var dir = (inp.right ? 1 : 0) - (inp.left ? 1 : 0);
    f.dodgeDir = (dir * f.facing > 0) ? 1 : -1;
    f.action = 'dodge'; f.t = 0; f.dur = D.dur; f.dir = 0;
    f.dodgeCd = Math.round(D.cooldown * f.p.t.dodgeCdMul);
    f.ifEnd = D.iEnd + f.p.t.iBonus + (f.assist ? f.assist.dodgeIFrameBonus : 0);
    emit(n, 'dodge_start', { who: f.idx, dir: f.dodgeDir });
  }

  function advancePunch(n, f, inp) {
    f.t++;
    var actEnd = f.wu + f.ac;
    if (f.t === actEnd + 1 && !f.hitDone) {
      f.whiff = true;
      f.whiffStreak++;
      if (f.whiffStreak >= 2) {
        addMomentum(n, f, -C.MOMENTUM.lossWhiff);
      }
      f.dur += Math.round(f.rec * C.WHIFF_EXTRA);
      emit(n, 'whiff', { who: f.idx, punch: f.action });
    }
    // Allow combo activation during punch recovery
    if (f.t > actEnd && f.buffer === 'combo') {
      f.buffer = null; f.bufT = 0;
      if (tryActivateCombo(n, f)) return;
    }
    if (f.landed && f.t >= f.cancelAt && f.t < f.dur) {
      if (tryConsumeBuffer(n, f, inp)) return;
      if (inp.block) { f.action = 'block'; f.t = 0; f.ptype = null; f.dir = 0; return; }
    }
    if (f.t >= f.dur) {
      setIdle(f);
      freeUpdate(n, f, inp);
    }
  }

  // ---------------------------------------------------------------- Signature Combo ("Big Moment") & Green Meter
  function startSignatureCombo(n, a, d, sig) {
    var CM = C.COMBO_MOVE;
    a.momentum = 0;
    a.idleNoHitT = 0;
    a.whiffStreak = 0;
    a.buffer = null; a.bufT = 0; a.kv = 0;
    d.buffer = null; d.bufT = 0; d.kv = 0;
    setIdle(a);
    setIdle(d);

    var mid = clamp((a.x + d.x) * 0.5, -C.RING_HALF + 0.6, C.RING_HALF - 0.6);
    var targetA = mid - a.facing * (CM.lockDist * 0.5);
    var targetD = mid + a.facing * (CM.lockDist * 0.5);

    n.comboState = {
      attacker: a.idx,
      defender: d.idx,
      boxerId: a.bid,
      name: sig.name,
      hits: sig.hits,
      hitIndex: 0,
      totalHits: sig.hits.length,
      stage: 'intro',           // 'intro' | 'meter' | 'strike' | 'outro'
      stageT: 0,
      stageDur: CM.introFrames,
      targetAX: targetA,
      targetDX: targetD,
      cursor: 0,
      greenCenter: CM.greenCenter,
      greenHalf: CM.greenHalfWidth,
      goodHalf: CM.goodHalfWidth,
      locked: false,
      lockPos: null,
      grade: null,
      gradeText: '',
      punchType: sig.hits[0].type,
      hitLabel: sig.hits[0].label,
      greenCount: 0,
      totalDamage: 0,
      bufferedTimingPress: false,
      cpuTargetPos: null
    };

    emit(n, 'combo_start', {
      who: a.idx, defender: d.idx, name: sig.name, totalHits: sig.hits.length, x: mid
    });
  }

  function beginComboHitMeter(n, cs, idx, atkInp) {
    var CM = C.COMBO_MOVE;
    var h = cs.hits[idx];
    var spd = (h.speed || 1) * Math.pow(CM.speedScalePerHit, idx);
    cs.hitIndex = idx;
    cs.stage = 'meter';
    cs.stageT = 0;
    cs.stageDur = Math.max(18, Math.round(CM.meterFramesBase / spd));
    cs.cursor = 0;
    cs.locked = false;
    cs.lockPos = null;
    cs.grade = null;
    cs.gradeText = '';
    cs.punchType = h.type;
    cs.hitLabel = h.label;
    cs.greenCenter = CM.greenCenter;
    cs.greenHalf = CM.greenHalfWidth * (h.greenMul || 1) * Math.pow(CM.greenShrinkPerHit, idx);
    cs.goodHalf = Math.max(cs.greenHalf + 0.055, CM.goodHalfWidth * Math.pow(CM.greenShrinkPerHit, idx * 0.6));
    // VS CPU assist: the human's green/good zones are larger and the cursor sweeps slower
    var atkAssist = n.fighters[cs.attacker].assist;
    if (atkAssist) {
      cs.greenHalf *= atkAssist.greenZoneMul;
      cs.goodHalf *= atkAssist.greenZoneMul;
      cs.stageDur = Math.round(cs.stageDur * atkAssist.cursorSlow);
    }
    cs.bufferedTimingPress = false;
    cs.cpuTargetPos = null;

    if (atkInp && atkInp.cpuDiff) {
      var diff = atkInp.cpuDiff;
      var pGreen = CM.cpuGreenProb[diff] !== undefined ? CM.cpuGreenProb[diff] : CM.cpuGreenProb.normal;
      var pGood = CM.cpuGoodProb[diff] !== undefined ? CM.cpuGoodProb[diff] : CM.cpuGoodProb.normal;
      var roll = R.next(n);
      if (roll < pGreen) {
        cs.cpuTargetPos = cs.greenCenter + (R.next(n) - 0.5) * 1.5 * cs.greenHalf;
      } else if (roll < pGreen + pGood) {
        var side = R.next(n) < 0.5 ? -1 : 1;
        cs.cpuTargetPos = cs.greenCenter + side * (cs.greenHalf + (0.2 + 0.7 * R.next(n)) * (cs.goodHalf - cs.greenHalf));
      } else {
        cs.cpuTargetPos = R.next(n) < 0.65 ? (0.22 + R.next(n) * 0.2) : 0.98;
      }
    }

    var a = n.fighters[cs.attacker], d = n.fighters[cs.defender];
    a.action = h.type; a.ptype = h.type; a.t = 1; a.dur = cs.stageDur; a.prog = 0.05;
    if (d.action !== 'idle') setIdle(d);

    emit(n, 'combo_meter_start', {
      who: cs.attacker, hitIndex: idx, totalHits: cs.totalHits,
      punch: h.type, label: h.label,
      greenCenter: cs.greenCenter, greenHalf: cs.greenHalf, goodHalf: cs.goodHalf
    });
  }

  function stepComboMove(n, ins) {
    var cs = n.comboState;
    var CM = C.COMBO_MOVE;
    var a = n.fighters[cs.attacker], d = n.fighters[cs.defender];
    var atkInp = ins[cs.attacker];

    // Keep fighters locked at choreographed exchange distance
    a.x += (cs.targetAX - a.x) * 0.35;
    d.x += (cs.targetDX - d.x) * 0.35;

    if (cs.stage === 'intro') {
      cs.stageT++;
      setIdle(a);
      setIdle(d);
      if (cs.stageT >= cs.stageDur) {
        beginComboHitMeter(n, cs, 0, atkInp);
      }
      return;
    }

    if (cs.stage === 'meter') {
      cs.stageT++;
      cs.cursor = Math.min(1, cs.stageT / Math.max(1, cs.stageDur));
      // Windup pose tracks cursor progress
      var h = cs.hits[cs.hitIndex];
      var P = C.PUNCH[h.type];
      var wf = P.windup / (P.windup + P.active + P.recovery);
      a.action = h.type; a.ptype = h.type;
      a.prog = wf * cs.cursor;
      if (d.action === 'hit' && d.t < d.dur) {
        d.t++;
        d.prog = d.t / Math.max(1, d.dur);
      } else {
        setIdle(d);
      }

      var rise = mask(atkInp) & ~a.pm;
      var humanPressed = !atkInp.cpuDiff && (((rise & (4 | 8 | 16 | 128)) !== 0) || cs.bufferedTimingPress);
      var cpuPressed = !!atkInp.cpuDiff && cs.cpuTargetPos !== null && cs.cursor >= cs.cpuTargetPos;
      var timedOut = cs.stageT >= cs.stageDur;

      if (humanPressed || cpuPressed || timedOut) {
        cs.bufferedTimingPress = false;
        var triggered = humanPressed || (cpuPressed && cs.cpuTargetPos < 0.96);
        var lockPos = cpuPressed ? clamp(cs.cpuTargetPos, 0, 1) : cs.cursor;
        cs.cursor = lockPos;
        cs.lockPos = lockPos;
        cs.locked = true;

        var err = Math.abs(lockPos - cs.greenCenter);
        if (triggered && err <= cs.greenHalf) {
          cs.grade = 'green';
          cs.gradeText = 'GREEN! PERFECT!';
        } else if (triggered && err <= cs.goodHalf) {
          cs.grade = 'good';
          cs.gradeText = 'GOOD TIMING';
        } else {
          cs.grade = 'miss';
          cs.gradeText = !triggered ? 'LATE / MISS!' : (lockPos < cs.greenCenter ? 'TOO EARLY!' : 'TOO LATE!');
        }
        executeComboStrike(n, cs);
      }
      return;
    }

    if (cs.stage === 'strike') {
      cs.stageT++;
      var u = cs.stageT / Math.max(1, cs.stageDur);
      var h2 = cs.hits[cs.hitIndex];
      var P2 = C.PUNCH[h2.type], tot2 = P2.windup + P2.active + P2.recovery;
      var wf2 = P2.windup / tot2, af2 = P2.active / tot2;
      a.action = h2.type; a.ptype = h2.type;
      a.prog = u < 0.45 ? (wf2 + af2 * (u / 0.45)) : (wf2 + af2 + (1 - wf2 - af2) * ((u - 0.45) / 0.55));
      if (d.action === 'hit' || d.action === 'block') {
        d.t++;
        d.prog = Math.min(1, d.t / Math.max(1, d.dur));
      }

      if (cs.stageT >= cs.stageDur) {
        // Check if defender was knocked down or instant-KO'd by this strike
        if (d.hp <= 0) {
          if (cs.greenCount === cs.totalHits) {
            a.momentum = clamp(a.momentum + CM.allGreenBonusRefund, 0, C.MOMENTUM.max);
          }
          var wasInstantKO = !!cs.instantKO;
          emit(n, 'combo_end', {
            who: cs.attacker, greenCount: cs.greenCount, totalHits: cs.totalHits,
            totalDamage: cs.totalDamage, broken: false, knockdown: true, instantKO: wasInstantKO
          });
          n.comboState = null;
          if (wasInstantKO) {
            d.hp = 0;
            d.kd++;
            d.kdTot++;
            d.kdLevel = Math.min(C.KNOCKDOWN.maxLevelCap, d.kdLevel + 1);
            d.action = 'knockdown'; d.t = 0; d.dur = C.KNOCKDOWN.fall; d.ptype = null; d.dir = 0;
            d.kv = 0.58; d.buffer = null; d.bufT = 0;
            emit(n, 'knockdown', { who: d.idx, by: a.idx, kd: d.kd, kdTot: d.kdTot, kdLevel: d.kdLevel, x: d.x, instantKO: true });
            n.hitstop = C.HITSTOP.knockdown;
            n.slowmo = C.SLOWMO.finish;
            finish(n, a.idx, 'KO');
          } else {
            knockdown(n, d, a);
          }
          return;
        }
        // Did a miss break the combo early?
        if (cs.grade === 'miss' && CM.missBreaksCombo) {
          cs.stage = 'outro';
          cs.stageT = 0;
          cs.stageDur = CM.outroFrames;
          setIdle(a);
          setIdle(d);
          return;
        }
        // Advance to next hit or finish combo
        if (cs.hitIndex + 1 < cs.totalHits) {
          beginComboHitMeter(n, cs, cs.hitIndex + 1, atkInp);
        } else {
          if (cs.greenCount === cs.totalHits) {
            a.momentum = clamp(a.momentum + CM.allGreenBonusRefund, 0, C.MOMENTUM.max);
          }
          cs.stage = 'outro';
          cs.stageT = 0;
          cs.stageDur = CM.outroFrames;
          setIdle(a);
          setIdle(d);
        }
      }
      return;
    }

    if (cs.stage === 'outro') {
      cs.stageT++;
      setIdle(a);
      setIdle(d);
      if (cs.stageT >= cs.stageDur) {
        emit(n, 'combo_end', {
          who: cs.attacker, greenCount: cs.greenCount, totalHits: cs.totalHits,
          totalDamage: cs.totalDamage, broken: cs.grade === 'miss', knockdown: false, instantKO: false
        });
        n.comboState = null;
      }
    }
  }

  function executeComboStrike(n, cs) {
    var CM = C.COMBO_MOVE;
    var a = n.fighters[cs.attacker], d = n.fighters[cs.defender];
    var h = cs.hits[cs.hitIndex];
    var P = C.PUNCH[h.type];

    cs.stage = 'strike';
    cs.stageT = 0;
    cs.stageDur = CM.strikeFrames + (h.finisher ? 6 : 0);

    var mult = cs.grade === 'green' ? CM.greenMult : (cs.grade === 'good' ? CM.goodMult : CM.missMult);
    var dmg = h.damage * a.p.power * mult * d.p.takeMul * (a.assist ? a.assist.dmgDealt : 1) * (d.assist ? d.assist.dmgTaken : 1);

    if (cs.grade === 'green') {
      cs.greenCount++;
      a.momentum = clamp(a.momentum + CM.perfectRefund, 0, C.MOMENTUM.max);
      // Greening the Combo Finisher (or all hits in the combo) triggers a guaranteed KO!
      if (CM.greenComboInstantKO && (h.finisher || cs.greenCount === cs.totalHits)) {
        dmg = Math.max(dmg, d.hp + 10);
        cs.instantKO = true;
        cs.gradeText = 'GREEN COMBO KO!';
      }
    }

    d.hp = Math.max(0, d.hp - dmg);
    a.dmgR += dmg;
    a.dmg += dmg;
    a.thrownN++;
    a.idleNoHitT = 0;
    cs.totalDamage += dmg;

    var impactX = d.x - a.facing * 0.12;
    if (cs.grade === 'miss') {
      d.action = 'block'; d.t = 4; d.dur = cs.stageDur; d.prog = 1;
      emit(n, 'blocked', { who: a.idx, target: d.idx, punch: h.type, x: impactX, y: P.hitHeight, dmg: dmg });
      n.hitstop = Math.max(n.hitstop, 2);
    } else {
      a.cleanR++;
      a.landedN++;
      d.action = 'hit'; d.t = 0; d.dur = cs.stageDur; d.hitType = h.type; d.prog = 0.2;
      var isHeavy = cs.grade === 'green' || !!h.finisher;
      emit(n, 'punch_landed', {
        who: a.idx, target: d.idx, punch: h.type, dmg: dmg, x: impactX, y: P.hitHeight,
        dir: a.facing, heavy: isHeavy, counter: false, combo: cs.hitIndex + 1,
        knockdown: d.hp <= 0, signatureHit: true, grade: cs.grade
      });
      n.hitstop = Math.max(n.hitstop, cs.grade === 'green' ? (h.finisher ? 11 : 5) : 3);
      if (h.finisher && cs.grade === 'green') {
        n.slowmo = Math.max(n.slowmo, 28);
      }
    }

    emit(n, 'combo_hit', {
      who: a.idx, target: d.idx, hitIndex: cs.hitIndex, totalHits: cs.totalHits,
      punch: h.type, label: h.label, grade: cs.grade, gradeText: cs.gradeText,
      lockPos: cs.lockPos, dmg: dmg, finisher: !!h.finisher, instantKO: !!cs.instantKO, x: impactX, y: P.hitHeight
    });
  }

  // ---------------------------------------------------------------- hits
  function snap(f) {
    var p = isPunch(f.action);
    return {
      action: f.action, x: f.x, type: f.ptype,
      active: p && f.t > f.wu && f.t <= f.wu + f.ac && !f.hitDone,
      windup: p && f.t <= f.wu,
      recovery: p && f.t > f.wu + f.ac,
      whiff: f.whiff,
      inv: (f.action === 'dodge' && f.t > C.DODGE.iStart && f.t <= f.ifEnd) || f.invulnT > 0 || f.action === 'getup' || f.action === 'knockdown',
      dodgeInv: f.action === 'dodge' && f.t > C.DODGE.iStart && f.t <= f.ifEnd,
      blocking: f.action === 'block' && f.t >= C.BLOCK.raise,
      perfectBlock: f.action === 'block' && f.t >= C.BLOCK.raise && f.t <= C.BLOCK.raise + C.BLOCK.perfectWindow + (f.assist ? f.assist.perfectBlockBonus : 0)
    };
  }

  function resolveHits(n) {
    var pre = [snap(n.fighters[0]), snap(n.fighters[1])];
    for (var i = 0; i < 2; i++) {
      if (n.phase !== 'fight' || n.count || n.comboState) break;
      var A = pre[i];
      if (!A.active) continue;
      var a = n.fighters[i], d = n.fighters[1 - i], D = pre[1 - i];
      var P = C.PUNCH[A.type];
      var dist = Math.abs(A.x - D.x);
      var range = P.range * a.p.reach + (a.assist ? a.assist.hitRangeBonus : 0);
      if (dist > range) continue;
      // VS CPU assists: human damage dealt / taken multipliers (1.0 for the CPU and in Local 2P)
      var assistMul = (a.assist ? a.assist.dmgDealt : 1) * (d.assist ? d.assist.dmgTaken : 1);
      a.hitDone = true;
      var impactX = D.x - a.facing * 0.12;

      // Post-getup invulnerability or active dodge i-frames
      if (D.inv) {
        if (D.dodgeInv) {
          d.counterT = C.MULT.dodgeCounterWindow;
          a.whiff = true;
          a.whiffStreak++;
          if (a.whiffStreak >= 2) addMomentum(n, a, -C.MOMENTUM.lossWhiff);
          a.dur += Math.round(a.rec * C.WHIFF_EXTRA);
          emit(n, 'dodged', { who: 1 - i, attacker: i, x: d.x, punch: A.type });
        }
        continue;
      }

      var rm = dist <= P.close ? 1 : 1 - (1 - P.minMul) * Math.min(1, (dist - P.close) / Math.max(0.01, range - P.close));
      var base = P.damage * a.atkPower * rm * (1 + (R.next(n) - 0.5) * 0.1) * assistMul;

      // blocked
      if (D.blocking) {
        var red = Math.min(0.95, C.BLOCK.reduce[A.type] * d.p.t.blockEff);
        var chip = base * d.p.takeMul * (1 - red);
        d.hp = Math.max(1, d.hp - chip);
        a.dmgR += chip; a.dmg += chip;
        a.whiffStreak = 0;
        addMomentum(n, a, C.MOMENTUM.gainBlocked);
        d.st -= base * C.BLOCK.drain / d.p.t.blockEff;
        d.blockStunT = 10;
        if (D.perfectBlock) {
          d.perfectBlockCounterT = C.BLOCK.perfectCounterWindow;
          emit(n, 'perfect_block', { who: 1 - i, x: d.x });
        }
        d.kv = Math.max(d.kv, P.knock * 0.35 / 6.67);
        emit(n, 'blocked', { who: i, target: 1 - i, punch: A.type, x: impactX, y: 1.4, dmg: chip, perfect: D.perfectBlock });
        n.hitstop = Math.max(n.hitstop, C.HITSTOP.block);
        if (d.st <= 0) {
          d.st = 0; d.gassedT = C.GASSED_DELAY;
          d.action = 'stagger'; d.t = 0; d.dur = C.BLOCK.guardBreakStun; d.ptype = null; d.hitType = A.type; d.dir = 0;
          emit(n, 'guard_break', { who: 1 - i, x: d.x });
        }
        continue;
      }

      // clean hit: combo bookkeeping
      var comboMul = 1, repeatMul = 1;
      if (a.comboT > 0) {
        a.comboN++;
        if (a.lastType === A.type) a.repeatN++; else a.repeatN = 0;
      } else { a.comboN = 1; a.repeatN = 0; }
      if (a.lastType && a.lastType !== A.type && a.comboT > 0) {
        comboMul = 1 + C.COMBO.perStep * a.p.t.comboBonus * Math.min(C.COMBO.maxSteps, a.comboN - 1);
      }
      if (a.repeatN > 0) repeatMul = Math.max(C.COMBO.repeatMin, Math.pow(C.COMBO.repeatDecay, a.repeatN));

      var sit = 1, counter = false, dodgeOrPerfectCounter = false;
      if (D.windup || D.active) { sit *= C.MULT.counterHit; counter = true; }
      else if (D.recovery) sit *= D.whiff ? C.MULT.whiff : C.MULT.openRecovery;
      if (a.counterT > 0) {
        sit *= C.MULT.dodgeCounter * a.p.t.counterMult;
        counter = true;
        dodgeOrPerfectCounter = true;
        a.counterT = 0;
      } else if (a.perfectBlockCounterT > 0) {
        sit *= C.MULT.counterHit * a.p.t.counterMult;
        counter = true;
        dodgeOrPerfectCounter = true;
        a.perfectBlockCounterT = 0;
      }
      if (d.st < 0.15 * d.maxSt) sit *= C.MULT.tiredTarget;

      var dmg = base * comboMul * repeatMul * sit * d.p.takeMul;
      d.hp -= dmg;
      a.dmgR += dmg; a.dmg += dmg; a.cleanR++; a.landedN++;
      a.landed = true; a.lastType = A.type; a.comboT = C.COMBO.window;
      a.idleNoHitT = 0; a.whiffStreak = 0;
      d.comboT = 0; d.comboN = 0; d.repeatN = 0; d.lastType = null;

      var heavy = dmg >= C.HEAVY_DMG || A.type === 'uppercut';
      var kdNow = false;
      if (d.hp <= 0) kdNow = true;
      else if (A.type === 'uppercut' && d.hp <= d.maxHp * C.KNOCKDOWN.uppercutHpFrac && dmg >= C.KNOCKDOWN.uppercutMinDmg &&
               R.next(n) < 0.9 - 0.05 * d.p.chin) kdNow = true;

      // Momentum gains for attacker
      var M = C.MOMENTUM;
      var mGain = A.type === 'uppercut' ? M.gainUppercut : (A.type === 'hook' ? M.gainHook : M.gainJab);
      if (a.comboN >= 2) {
        mGain += M.gainChainPerLink * Math.min(M.gainChainMaxLinks, a.comboN - 1);
      }
      if (dodgeOrPerfectCounter || counter) {
        mGain += dodgeOrPerfectCounter ? M.gainCounter : (M.gainCounter * 0.55);
      }
      if (kdNow) mGain += M.gainKnockdown;
      addMomentum(n, a, mGain);

      // Momentum losses for defender
      if (kdNow) addMomentum(n, d, -M.lossKnockdown);
      else if (heavy) addMomentum(n, d, -M.lossHeavyHit);

      emit(n, 'punch_landed', {
        who: i, target: 1 - i, punch: A.type, dmg: dmg, x: impactX, y: P.hitHeight, dir: a.facing,
        heavy: heavy || kdNow, counter: counter, combo: a.comboN, knockdown: kdNow
      });
      if (a.comboN >= 3) emit(n, 'combo', { who: i, count: a.comboN });
      n.hitstop = Math.max(n.hitstop, C.HITSTOP[A.type]);

      if (kdNow) {
        knockdown(n, d, a);
      } else {
        d.ptype = null; d.dir = 0;
        if (heavy && d.hp < d.maxHp * 0.3) {
          d.action = 'stagger'; d.t = 0; d.dur = 50;
        } else {
          d.action = 'hit'; d.t = 0; d.dur = Math.round(P.hitstun * a.p.t.hitstunMul);
        }
        d.hitType = A.type;
        d.kv = P.knock / 6.67;
        d.buffer = null; d.bufT = 0;
      }
    }
  }

  function knockdown(n, d, a) {
    d.action = 'knockdown'; d.t = 0; d.dur = 0; d.ptype = null; d.dir = 0;
    d.hp = 0;
    d.kd++;
    d.kdTot++;
    d.kdLevel++;
    d.getup = 0;
    d.kv = 0.12;
    d.buffer = null; d.bufT = 0;
    calmFighter(a);
    setIdle(a);
    var lvl = Math.max(0, d.kdLevel - 1);
    var params = kdParams(lvl, d.p.chin, d.assist);
    emit(n, 'knockdown', {
      who: d.idx, by: a.idx, n: d.kd, kdTot: d.kdTot, level: lvl,
      pressGain: params.pressGain, drainPerSec: params.drainPerSec, x: d.x
    });
    n.hitstop = Math.max(n.hitstop, C.HITSTOP.knockdown);
    n.count = {
      who: d.idx, n: 0, tick: 0, level: lvl,
      pressGain: params.pressGain, drainPerSec: params.drainPerSec,
      bufferedPresses: 0, cpuTempo: 0
    };
    n.slowmo = C.SLOWMO.knockdown;
  }

  function stepCount(n, ins, prevX0, prevX1) {
    var cn = n.count, d = n.fighters[cn.who], o = n.fighters[1 - cn.who], inp = ins[cn.who];
    var K = C.KNOCKDOWN;
    var lvl = cn.level || 0;
    var params = kdParams(lvl, d.p.chin, d.assist);

    if (d.kv !== 0) { d.x += -d.facing * d.kv; d.kv *= 0.85; if (Math.abs(d.kv) < 0.0004) d.kv = 0; }
    d.t++;

    if (d.action === 'knockdown') {
      if (cn.pressCd > 0) cn.pressCd--;
      var presses = 0;
      // Allow filling the Get-Up Meter once the boxer hits the mat (halfway through fall)
      if (d.t >= Math.floor(K.fall * 0.5)) {
        if (inp.cpuDiff) {
          if (cn.tick % 20 === 0) {
            cn.cpuTempo = (R.next(n) - 0.5) * 2 * K.cpuMashVariance;
          }
          var baseRate = (K.cpuMashBase[inp.cpuDiff] || K.cpuMashBase.normal) + (d.p.chin - 5) * K.cpuMashChinBonus;
          var rate = Math.max(1.2, baseRate + (cn.cpuTempo || 0));
          if (R.next(n) < rate * C.DT) presses = 1;
        } else {
          var rawPresses = 0;
          if (inp.presses !== undefined) {
            rawPresses = Math.max(0, inp.presses | 0);
          } else {
            rawPresses = (mask(inp) & ~d.pm) ? 1 : 0;
          }
          if (cn.bufferedPresses > 0) {
            rawPresses += cn.bufferedPresses;
            cn.bufferedPresses = 0;
          }
          // Cap to 1 press per cooldown window so palm-rolling multiple keys cannot bypass the mash difficulty
          if (rawPresses > 0 && (!cn.pressCd || cn.pressCd <= 0)) {
            presses = 1;
            cn.pressCd = K.pressCooldownFrames || 3;
          }
        }

        d.getup = Math.max(0, d.getup - params.drainPerSec * C.DT);
        if (presses > 0) {
          d.getup = Math.min(K.meterMax, d.getup + presses * params.pressGain);
          emit(n, 'get_up_press', { who: cn.who, presses: presses, meter: d.getup, level: lvl });
        }
      } else {
        cn.bufferedPresses = 0;
        d.getup = 0;
      }

      if (d.getup >= K.meterMax && d.t >= K.fall) {
        d.action = 'getup';
        d.t = 0;
        d.dur = K.getupAnim;
        d.getup = K.meterMax;
        d.invulnT = K.getupAnim + K.postGetupInvuln;

        var hpFrac = Math.max(K.restoreMin, K.restoreBase - lvl * K.restoreDecayPerKd + (d.p.chin - 5) * K.restorePerChin);
        d.hp = Math.max(d.hp, d.maxHp * hpFrac);

        var stFrac = Math.max(K.staminaMinFrac, K.staminaRestoreFrac - lvl * 0.03);
        d.st = d.maxSt * stFrac;

        emit(n, 'get_up_success', { who: cn.who, count: cn.n, kdTot: d.kdTot, level: lvl, hp: d.hp });
      } else {
        cn.tick++;
        if (cn.tick % K.countFrames === 0) {
          cn.n++;
          emit(n, 'count_tick', { who: cn.who, count: cn.n, n: cn.n });
          if (cn.n >= K.countTo) {
            finish(n, 1 - cn.who, 'KO');
            n.slowmo = C.SLOWMO.finish;
            return;
          }
        }
      }
    } else if (d.action === 'getup') {
      if (d.invulnT > 0) d.invulnT--;
      if (d.t >= d.dur) {
        setIdle(d);
        d.getup = 0;
        d.buffer = null; d.bufT = 0;
        n.count = null;
        setIdle(o);
        return;
      }
    }

    var neutralCorner = o.idx === 0 ? -C.CORNER_X : C.CORNER_X;
    if (Math.abs(neutralCorner - d.x) < 1.5) {
      neutralCorner = o.x >= d.x ? C.CORNER_X : -C.CORNER_X;
    }
    calmFighter(o);
    glide(o, clamp(neutralCorner, -C.RING_HALF, C.RING_HALF), 2.4);
    separate(n, prevX0, prevX1);
  }

  function separate(n, prevX0, prevX1) {
    var a = n.fighters[0], b = n.fighters[1], H = C.RING_HALF;
    a.x = clamp(a.x, -H, H);
    b.x = clamp(b.x, -H, H);
    var d = b.x - a.x;
    if (d < C.MIN_DIST) {
      var overlap = C.MIN_DIST - d;
      var da = prevX0 !== undefined ? Math.max(0, a.x - prevX0) : 0.5;
      var db = prevX1 !== undefined ? Math.max(0, prevX1 - b.x) : 0.5;
      var tot = da + db;
      if (tot > 0) {
        a.x -= overlap * (da / tot);
        b.x += overlap * (db / tot);
      } else {
        a.x -= overlap * 0.5;
        b.x += overlap * 0.5;
      }
      if (a.x < -H) { a.x = -H; b.x = Math.max(b.x, a.x + C.MIN_DIST); }
      if (b.x > H) { b.x = H; a.x = Math.min(a.x, b.x - C.MIN_DIST); }
    }
  }

  // ---------------------------------------------------------------- rounds / results
  function cardFor(raw, nA, nB) {
    var a = raw.s[0] * (1 + (nA || 0)), b = raw.s[1] * (1 + (nB || 0));
    var tot = a + b;
    if (tot < 1) return [10, 10];
    var share = a / tot;
    if (Math.abs(share - 0.5) < C.SCORE.evenShare) return [10, 10];
    var w = share > 0.5 ? 0 : 1;
    var ws = Math.max(share, 1 - share);
    var loser = 9 - raw.kd[1 - w];
    if (ws >= C.SCORE.dominantShare) loser -= 1;
    loser = Math.max(6, loser);
    return w === 0 ? [10, loser] : [loser, 10];
  }

  function endRound(n) {
    var f0 = n.fighters[0], f1 = n.fighters[1], S = C.SCORE;
    var raw = {
      s: [f0.dmgR * S.perDamage + f0.cleanR * S.perClean + f1.kd * S.perKnockdown,
          f1.dmgR * S.perDamage + f1.cleanR * S.perClean + f0.kd * S.perKnockdown],
      kd: [f0.kd, f1.kd]
    };
    n.rounds = n.rounds.concat([raw]);
    n.phase = 'roundend'; n.phaseT = 0; n.comboState = null;
    calmFighter(f0); calmFighter(f1);
    setIdle(f0); setIdle(f1);
    emit(n, 'round_end', { round: n.round, card: cardFor(raw, 0, 0) });
    emit(n, 'bell', { kind: 'end', round: n.round });
  }

  function stepRoundEnd(n) {
    n.phaseT++;
    var a = n.fighters[0], b = n.fighters[1];
    calmFighter(a); calmFighter(b);
    if (n.phaseT > 40) {
      var cx = n.round < C.ROUNDS ? C.CORNER_X : C.START_X;
      glide(a, -cx, C.GLIDE_SPEED); glide(b, cx, C.GLIDE_SPEED);
    } else { a.dir = 0; b.dir = 0; setIfFree(a, 'idle'); setIfFree(b, 'idle'); }
    setProg(a); setProg(b);
    if (n.phaseT >= C.ROUNDEND_FRAMES) {
      if (n.round < C.ROUNDS) {
        n.phase = 'rest'; n.phaseT = 0;
        setIdle(a); setIdle(b);
      } else {
        decide(n);
      }
    }
  }

  function stepRest(n) {
    n.phaseT++;
    var total = C.REST_SECONDS * C.FPS;
    var a = n.fighters[0], b = n.fighters[1];
    [a, b].forEach(function (f) {
      calmFighter(f);
      f.hp = Math.min(f.maxHp, f.hp + f.maxHp * C.REST.hpRecover / total);
      f.st = Math.min(f.maxSt, f.st + (f.maxSt * C.REST.stRecover) / total + (f.maxSt - f.st) * 0.004);
    });
    glide(a, -C.CORNER_X, C.GLIDE_SPEED); glide(b, C.CORNER_X, C.GLIDE_SPEED);
    setProg(a); setProg(b);
    if (n.phaseT >= total) {
      n.round++; n.phase = 'fight'; n.phaseT = 0;
      n.clock = C.ROUND_SECONDS * C.FPS;
      a.x = -C.START_X; b.x = C.START_X;
      [a, b].forEach(function (f) {
        f.kdLevel = Math.max(0, f.kdLevel - C.KNOCKDOWN.restLevelRecover);
        // Between rounds momentum is reduced to half of its value
        f.momentum = f.momentum * C.MOMENTUM.betweenRoundsKeep;
        f.idleNoHitT = 0; f.whiffStreak = 0; f.perfectBlockCounterT = 0; f.blockStunT = 0;
        f.kd = 0; f.dmgR = 0; f.cleanR = 0; f.comboN = 0; f.comboT = 0; f.repeatN = 0; f.lastType = null;
        f.counterT = 0; f.dodgeCd = 0; f.gassedT = 0; f.invulnT = 0; f.buffer = null; f.bufT = 0; f.kv = 0; f.pm = 0; setIdle(f);
      });
      emit(n, 'round_start', { round: n.round });
      emit(n, 'bell', { kind: 'start', round: n.round });
      emit(n, 'fight_start', { round: n.round });
    }
  }

  function decide(n) {
    var judges = [], v = [0, 0], k, r;
    for (k = 0; k < 3; k++) {
      var rows = [], t0 = 0, t1 = 0;
      for (r = 0; r < n.rounds.length; r++) {
        var nz = C.SCORE.judgeNoise;
        var card = cardFor(n.rounds[r], (R.next(n) - 0.5) * nz * 2, (R.next(n) - 0.5) * nz * 2);
        rows.push(card); t0 += card[0]; t1 += card[1];
      }
      judges.push({ rows: rows, total: [t0, t1] });
      if (t0 > t1) v[0]++; else if (t1 > t0) v[1]++;
    }
    var winner, detail;
    if (v[0] > v[1]) winner = 0; else if (v[1] > v[0]) winner = 1;
    else winner = n.fighters[0].dmg >= n.fighters[1].dmg ? 0 : 1;
    var wv = v[winner], lv = v[1 - winner];
    if (wv === 3) detail = 'Unanimous decision';
    else if (wv === 2 && lv === 1) detail = 'Split decision';
    else if (wv === 2) detail = 'Majority decision';
    else detail = 'Decision (judges level, awarded on damage)';
    finish(n, winner, 'Decision');
    n.result = { winner: n.result.winner, method: 'Decision', round: n.result.round, time: n.result.time, cards: judges, detail: detail };
    emit(n, 'decision', { winner: winner, detail: detail });
  }

  function finish(n, winner, method) {
    n.phase = 'finished'; n.phaseT = 0; n.count = null; n.comboState = null;
    var sec = Math.floor((C.ROUND_SECONDS * C.FPS - n.clock) / C.FPS);
    n.result = { winner: winner, method: method, round: n.round, time: sec, cards: null, detail: '' };
    var w = n.fighters[winner], l = n.fighters[1 - winner];
    if (method === 'KO') {
      w.action = 'victory'; w.t = 0; w.ptype = null; w.buffer = null; w.bufT = 0; w.kv = 0; w.dir = 0;
      emit(n, 'ko', { winner: winner, loser: 1 - winner, method: 'KO', round: n.round, x: l.x });
      emit(n, 'bell', { kind: 'ko', round: n.round });
    } else {
      calmFighter(w); calmFighter(l);
      w.action = 'victory'; w.t = 0;
    }
    setProg(w); setProg(l);
  }

  function stepFinished(n) {
    var prevX0 = n.fighters[0].x, prevX1 = n.fighters[1].x;
    n.phaseT++;
    var a = n.fighters[0], b = n.fighters[1];
    [a, b].forEach(function (f) {
      if (f.kv !== 0) { f.x += -f.facing * f.kv; f.kv *= 0.85; if (Math.abs(f.kv) < 0.0004) f.kv = 0; }
      if (f.action === 'knockdown' || f.action === 'victory') f.t++;
      else if (f.action === 'hit' || f.action === 'stagger') { f.t++; if (f.t >= f.dur) setIdle(f); }
      else if (!isFree(f.action)) setIdle(f);
      else { f.dir = 0; if (f.action !== 'idle') { f.action = 'idle'; f.t = 0; } else f.t++; }
      setProg(f);
    });
    separate(n, prevX0, prevX1);
  }

  g.Sim = {
    create: create,
    step: step,
    neutralInput: function () { return norm({}); },
    fatigue: fatigue,
    cardFor: cardFor,
    kdParams: kdParams
  };
})(typeof window !== 'undefined' ? window : globalThis);

