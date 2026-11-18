/* ai.js - CPU opponent. Produces the same plain input objects as a human.
 * It only uses OBSERVABLE state (positions, actions, animation progress, health/stamina/momentum bars).
 * Opponent information is read through a delay buffer (reaction time); it never sees the
 * opponent's current input.
 */
(function (g) {
  'use strict';
  var C = g.Config, Boxers = g.Boxers, RNG = g.RNG;

  // All difficulty tuning lives in Config.CPU_DIFF (easy | normal = Medium | hard)
  var DIFFS = C.CPU_DIFF;

  function isPunch(a) { return a === 'jab' || a === 'hook' || a === 'uppercut'; }
  function isFree(a) { return a === 'idle' || a === 'walk' || a === 'block'; }

  function create(opts) {
    var idx = opts.index;
    var boxer = Boxers.byId(opts.boxerId);
    var P = boxer.ai;
    var diffName = DIFFS[opts.difficulty] ? opts.difficulty : 'normal';
    var D = DIFFS[diffName];
    var rnd = RNG.make(opts.seed || (idx * 977 + 13));
    var fwd = idx === 0 ? 1 : -1;
    var hist = [];
    var holds = { jab: 0, hook: 0, uppercut: 0, dodge: 0, combo: 0 };

    var ai = {
      plan: 'hold', planT: 0, queue: [], cool: 0, prevO: 'idle', reaction: null, guardOn: false,
      drift: 1, driftT: 0, mashT: 0, mashOn: false, punishedFor: -1, forced: false, lastTick: -1, punishRolled: false,
      freezeT: 0, readyT: 0, prefOff: 0, rangeFud: 0, counterRolled: false
    };

    function weighted(items) {
      var tot = 0, i;
      for (i = 0; i < items.length; i++) tot += items[i][1];
      if (tot <= 0) return items[0][0];
      var r = rnd() * tot;
      for (i = 0; i < items.length; i++) { r -= items[i][1]; if (r <= 0) return items[i][0]; }
      return items[items.length - 1][0];
    }

    function rangeOf(type, me) { return C.PUNCH[type].range * me.p.reach; }

    function oppPhase(o) {
      if (!isPunch(o.action)) return 'none';
      var p = C.PUNCH[o.action], tot = p.windup + p.active + p.recovery;
      if (o.prog < p.windup / tot) return 'windup';
      if (o.prog < (p.windup + p.active) / tot) return 'active';
      return 'recovery';
    }

    function buildQueue(me, dist) {
      var len = 1 + Math.floor(rnd() * Math.min(P.combo, D.comboCap));
      var q = [], last = null, i, d = dist;
      for (i = 0; i < len; i++) {
        var items = [];
        var rUp = rangeOf('uppercut', me), rHk = rangeOf('hook', me), rJb = rangeOf('jab', me);
        if (d <= rJb + 0.1) items.push(['jab', P.jab * (last === 'jab' ? 0.5 : 1)]);
        if (d <= rHk + 0.1) items.push(['hook', P.hook * (last === 'hook' ? 0.4 : 1)]);
        if (d <= rUp + 0.1) items.push(['uppercut', P.up * (last === 'uppercut' ? 0.2 : 1) * (me.st > 40 ? 1 : D.tiredUpper)]);
        if (!items.length) items.push(['jab', 1]);
        var t = weighted(items);
        q.push(t); last = t; d -= 0.12;
      }
      return q;
    }

    function choosePlan(me, o, dist) {
      var tired = me.st < 0.22 * me.maxSt;
      var oppTired = o.st < 0.28 * o.maxSt;
      var hpLow = me.hp < 28;
      var w = [];
      w.push(['approach', dist > P.pref + 0.5 ? 3 : 0.3]);
      w.push(['attack', P.aggr * D.aggr * (oppTired ? 2 : 1) * (tired ? D.tiredAttack : 1) * (dist < P.pref + 0.7 ? 2 : 0.5)]);
      w.push(['hold', P.patience * 1.6 * (tired ? 0.5 : 1)]);
      w.push(['retreat', (hpLow ? 1.2 : 0.2) + (tired ? 0.5 : 0) + D.retreatW]);
      if (D.idleW > 0) w.push(['idle', D.idleW]);
      if (tired) w.push(['rest', D.restW]);
      ai.prefOff = (rnd() * 2 - 1) * D.prefErr;   // misjudged preferred distance (walks too close / too far)
      ai.rangeFud = rnd() * D.rangeErr;           // misjudged punch range (throws from too far -> whiffs)
      ai.plan = weighted(w);
      ai.planT = Math.round((20 + rnd() * 40) * D.planMul);
      ai.queue = []; ai.forced = false;
      ai.guardOn = rnd() < P.defense * D.guard && dist < 2.2;
    }

    ai.think = function (state) {
      var out = { left: false, right: false, jab: false, hook: false, uppercut: false, block: false, dodge: false, combo: false, presses: 0, cpuDiff: diffName };
      var me = state.fighters[idx], op = state.fighters[1 - idx];
      hist.push({ x: op.x, action: op.action, prog: op.prog, hp: op.hp, st: op.st, maxSt: op.maxSt });
      if (hist.length > 80) hist.shift();
      var o = hist[Math.max(0, hist.length - 1 - D.react)];
      var tick = state.tick;

      function moveF() { if (fwd > 0) out.right = true; else out.left = true; }
      function moveB() { if (fwd > 0) out.left = true; else out.right = true; }
      function finalize() {
        // Edge actions pulse for 1 step only
        if (holds.jab > 0) { out.jab = true; holds.jab = 0; }
        if (holds.hook > 0) { out.hook = true; holds.hook = 0; }
        if (holds.uppercut > 0) { out.uppercut = true; holds.uppercut = 0; }
        if (holds.dodge > 0) { out.dodge = true; holds.dodge = 0; }
        if (holds.combo > 0) { out.combo = true; holds.combo = 0; }
        if (ai.cool > 0) ai.cool--;
        return out;
      }

      if (state.phase !== 'fight' || state.comboState) {
        ai.plan = 'hold'; ai.planT = 0; ai.reaction = null; ai.queue = [];
        return out;
      }

      // CPU does not mash keys; its get-up meter is simulated inside sim.js using the seeded RNG
      if (me.action === 'knockdown' || state.count) {
        holds.jab = 0; holds.hook = 0; holds.uppercut = 0; holds.dodge = 0; holds.combo = 0;
        return out;
      }
      if (me.action === 'hit' || me.action === 'stagger') { ai.reaction = null; ai.queue = []; return finalize(); }

      var dist = Math.abs(me.x - o.x);
      var canAct = isFree(me.action) || (isPunch(me.action) && me.landed && me.t >= me.cancelAt);

      // Seeded random 'brain freezes': a short idle, sometimes with a silly whiffed jab
      if (ai.freezeT > 0) { ai.freezeT--; return finalize(); }
      if (D.freezePerSec > 0 && canAct && !isPunch(me.action) && rnd() < D.freezePerSec / 60) {
        if (rnd() < D.sillyWhiffP && me.st > 25) holds.jab = 1;
        ai.freezeT = D.freezeMin + Math.floor(rnd() * (D.freezeMax - D.freezeMin + 1));
        ai.reaction = null; ai.queue = [];
        return finalize();
      }

      // Combo only after it has been READY for a while (sigDelayFrames), then rarely (sigChance)
      if (me.momentum >= C.MOMENTUM.max) ai.readyT++; else ai.readyT = 0;
      var pref = P.pref + ai.prefOff;

      // --- Signature Combo activation when Momentum is READY (100)
      if (me.momentum >= C.MOMENTUM.max && ai.readyT >= D.sigDelayFrames && canAct && o.action !== 'knockdown' && o.action !== 'getup') {
        var sigRange = ((boxer.signatureCombo && boxer.signatureCombo.range) || C.MOMENTUM.activateRange) * me.p.reach;
        if (dist <= sigRange * 0.96) {
          var mult = 1;
          if (o.action === 'stagger' || o.action === 'hit') mult = 3.5;
          else if (isPunch(o.action) && oppPhase(o) === 'recovery') mult = 2.6;
          else if (o.st < 0.35 * o.maxSt) mult = 2.0;
          if (rnd() < D.sigChance * mult) {
            holds.combo = 1;
            return finalize();
          }
        } else if (dist <= sigRange + 0.5) {
          moveF();
          return finalize();
        }
      }

      // --- observe a new opponent attack and decide how to react
      if (isPunch(o.action) && !isPunch(ai.prevO)) {
        ai.punishRolled = false;
        var oP = C.PUNCH[o.action];
        if (dist <= oP.range * 1.2 + 0.15 && rnd() > D.mistake) {
          var remain = Math.max(0, oP.windup - D.react);
          var r = rnd();
          var pDodge = D.dodgeP * P.dodge, pBlock = D.blockP * (0.4 + P.defense);
          if (r < pDodge && me.dodgeCd <= 0 && me.st > 20) {
            ai.reaction = { type: 'dodge', start: tick + Math.max(0, remain - 6), slip: rnd() < 0.2 * P.dodge, done: false };
          } else if (r < pDodge + pBlock) {
            ai.reaction = { type: 'block', start: tick + Math.max(0, remain - 5), until: tick + Math.max(0, remain - 5) + D.blockHold };
          }
        }
      }
      // punish an opponent who is recovering within range
      if (isPunch(o.action) && oppPhase(o) === 'recovery' && !ai.punishRolled && ai.cool <= 0 && dist < 1.25 && !ai.forced) {
        ai.punishRolled = true;
        if (rnd() < D.punishP * P.punish * 0.35 && me.st > 15) {
          ai.queue = buildQueue(me, dist).slice(0, 2); ai.plan = 'attack'; ai.planT = 40; ai.forced = true; ai.reaction = null;
        }
      }
      ai.prevO = o.action;
      // own counter after a successful dodge
      if (me.counterT > 0 && !ai.counterRolled) {
        ai.counterRolled = true;
        if (rnd() < D.counterP && !ai.forced && me.st > 12) {
          ai.queue = [rnd() < 0.5 + 0.3 * (P.hook / 2) ? 'hook' : 'jab']; if (dist < 0.9 && rnd() < 0.4) ai.queue = ['uppercut'];
          ai.plan = 'attack'; ai.planT = 30; ai.forced = true; ai.reaction = null;
        }
      } else if (me.counterT <= 0) ai.counterRolled = false;

      // --- execute reaction
      if (ai.reaction) {
        var R0 = ai.reaction;
        if (R0.type === 'dodge') {
          if (tick >= R0.start && !R0.done) {
            if (me.dodgeCd <= 0 && canAct) {
              holds.dodge = 1;
              if (R0.slip) moveF(); else moveB();
              R0.done = true;
            } else if (tick > R0.start + 10) ai.reaction = null;
          }
          if (R0.done && tick > R0.start + 24) ai.reaction = null;
          if (ai.reaction && R0.done) return finalize();
        } else if (R0.type === 'block') {
          if (tick >= R0.start) {
            if (tick > R0.until) ai.reaction = null;
            else { out.block = true; return finalize(); }
          }
        }
      }

      // --- plan selection
      ai.planT--;
      if (ai.planT <= 0) choosePlan(me, o, dist);
      var wall = idx === 0 ? -C.RING_HALF : C.RING_HALF;
      var cornered = Math.abs(me.x - wall) < 0.3;

      switch (ai.plan) {
        case 'approach':
          if (dist > pref + 0.1) { moveF(); if (ai.guardOn) out.block = false; }
          else ai.planT = 0;
          break;
        case 'hold':
          ai.driftT--;
          if (ai.driftT <= 0) { ai.drift = rnd() < 0.5 ? 1 : -1; ai.driftT = 10 + Math.floor(rnd() * 25); }
          if (dist < pref - 0.18) moveB();
          else if (dist > pref + 0.2) moveF();
          else if (ai.drift > 0 && dist > pref - 0.05) moveF();
          else if (ai.drift < 0 && dist < pref + 0.1) moveB();
          if (ai.guardOn) out.block = true;
          if (isPunch(o.action) && oppPhase(o) !== 'recovery' && dist < 1.4 && rnd() < 0.02) ai.planT = 0;
          break;
        case 'retreat':
          if (cornered) { ai.planT = 0; ai.guardOn = true; }
          else { moveB(); if (ai.guardOn || D.blockP > 0.4) out.block = true; }
          break;
        case 'idle':
          break;
        case 'rest':
          if (me.st > 0.55 * me.maxSt) { ai.planT = 0; break; }
          if (dist < 2.3 && !cornered) moveB();
          if (ai.guardOn || D.blockP > 0.4) out.block = true;
          break;
        case 'attack':
          if (!ai.queue.length) ai.queue = buildQueue(me, dist);
          var type = ai.queue[0];
          var reach = rangeOf(type, me) * 0.93 * (1 + ai.rangeFud);
          if (me.st < C.PUNCH[type].stamina * D.restThresh) { ai.plan = 'rest'; ai.planT = 50; ai.queue = []; break; }
          if (dist > reach) { if (canAct && !isPunch(me.action)) moveF(); }
          else if (canAct && ai.cool <= 0 && !me.buffer) {
            holds[type] = 1; ai.cool = D.punchCool; ai.queue.shift();
            if (!ai.queue.length) { ai.planT = Math.min(ai.planT, 6 + Math.floor(rnd() * 14)); ai.forced = false; }
          }
          break;
      }
      return finalize();
    };

    return ai;
  }

  g.AI = { create: create, DIFFICULTIES: DIFFS };
})(typeof window !== 'undefined' ? window : globalThis);

