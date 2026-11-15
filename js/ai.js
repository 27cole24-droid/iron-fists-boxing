/* ai.js - CPU opponent. Produces the same plain input objects as a human.
 * It only uses OBSERVABLE state (positions, actions, animation progress, health/stamina/momentum bars).
 * Opponent information is read through a delay buffer (reaction time); it never sees the
 * opponent's current input.
 */
(function (g) {
  'use strict';
  var C = g.Config, Boxers = g.Boxers, RNG = g.RNG;

  var DIFFS = {
    easy:   { react: 24, blockP: 0.30, dodgeP: 0.20, punishP: 0.40, mash: 4.2, mistake: 0.28, aggr: 0.8,  guard: 0.7, comboCap: 2, planMul: 1.5, sigChance: 0.025 },
    normal: { react: 14, blockP: 0.55, dodgeP: 0.40, punishP: 0.70, mash: 5.2, mistake: 0.12, aggr: 1.0,  guard: 1.0, comboCap: 3, planMul: 1.0, sigChance: 0.065 },
    hard:   { react: 7,  blockP: 0.80, dodgeP: 0.60, punishP: 0.90, mash: 6.5, mistake: 0.04, aggr: 1.15, guard: 1.2, comboCap: 5, planMul: 0.75, sigChance: 0.15 }
  };

  function isPunch(a) { return a === 'jab' || a === 'hook' || a === 'uppercut'; }
  function isFree(a) { return a === 'idle' || a === 'walk' || a === 'block'; }

  function create(opts) {
    var idx = opts.index;
    var boxer = Boxers.byId(opts.boxerId);
    var P = boxer.ai;
    var diffName = opts.difficulty || 'normal';
    var D = DIFFS[diffName] || DIFFS.normal;
    var rnd = RNG.make(opts.seed || (idx * 977 + 13));
    var fwd = idx === 0 ? 1 : -1;
    var hist = [];
    var holds = { jab: 0, hook: 0, uppercut: 0, dodge: 0, combo: 0 };

    var ai = {
      plan: 'hold', planT: 0, queue: [], cool: 0, prevO: 'idle', reaction: null, guardOn: false,
      drift: 1, driftT: 0, mashT: 0, mashOn: false, punishedFor: -1, forced: false, lastTick: -1, punishRolled: false
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
        if (d <= rUp + 0.1) items.push(['uppercut', P.up * (last === 'uppercut' ? 0.2 : 1) * (me.st > 40 ? 1 : 0.2)]);
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
      w.push(['attack', P.aggr * D.aggr * (oppTired ? 2 : 1) * (tired ? 0.08 : 1) * (dist < P.pref + 0.7 ? 2 : 0.5)]);
      w.push(['hold', P.patience * 1.6 * (tired ? 0.5 : 1)]);
      w.push(['retreat', (hpLow ? 1.2 : 0.2) + (tired ? 0.5 : 0)]);
      if (tired) w.push(['rest', 4]);
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

      // --- Signature Combo activation when Momentum is READY (100)
      if (me.momentum >= C.MOMENTUM.max && canAct && o.action !== 'knockdown' && o.action !== 'getup') {
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
            ai.reaction = { type: 'block', start: tick + Math.max(0, remain - 5), until: tick + Math.max(0, remain - 5) + 28 };
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
      if (me.counterT > 0 && !ai.forced && me.st > 12) {
        ai.queue = [rnd() < 0.5 + 0.3 * (P.hook / 2) ? 'hook' : 'jab']; if (dist < 0.9 && rnd() < 0.4) ai.queue = ['uppercut'];
        ai.plan = 'attack'; ai.planT = 30; ai.forced = true; ai.reaction = null;
      }

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
          if (dist > P.pref + 0.1) { moveF(); if (ai.guardOn) out.block = false; }
          else ai.planT = 0;
          break;
        case 'hold':
          ai.driftT--;
          if (ai.driftT <= 0) { ai.drift = rnd() < 0.5 ? 1 : -1; ai.driftT = 10 + Math.floor(rnd() * 25); }
          if (dist < P.pref - 0.18) moveB();
          else if (dist > P.pref + 0.2) moveF();
          else if (ai.drift > 0 && dist > P.pref - 0.05) moveF();
          else if (ai.drift < 0 && dist < P.pref + 0.1) moveB();
          if (ai.guardOn) out.block = true;
          if (isPunch(o.action) && oppPhase(o) !== 'recovery' && dist < 1.4 && rnd() < 0.02) ai.planT = 0;
          break;
        case 'retreat':
          if (cornered) { ai.planT = 0; ai.guardOn = true; }
          else { moveB(); out.block = true; }
          break;
        case 'rest':
          if (me.st > 0.55 * me.maxSt) { ai.planT = 0; break; }
          if (dist < 2.3 && !cornered) moveB();
          out.block = true;
          break;
        case 'attack':
          if (!ai.queue.length) ai.queue = buildQueue(me, dist);
          var type = ai.queue[0];
          var reach = rangeOf(type, me) * 0.93;
          if (me.st < C.PUNCH[type].stamina * 1.1) { ai.plan = 'rest'; ai.planT = 50; ai.queue = []; break; }
          if (dist > reach) { if (canAct && !isPunch(me.action)) moveF(); }
          else if (canAct && ai.cool <= 0 && !me.buffer) {
            holds[type] = 1; ai.cool = 5; ai.queue.shift();
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
