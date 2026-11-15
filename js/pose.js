/* pose.js - renderer-independent boxer animation DATA + skeleton solver.
 *
 * Pose parameters (all radians unless noted), in the boxer's own side-view plane:
 *   +x = the direction the boxer faces, +y = up.
 *   limb angles are measured from "straight down", positive swings FORWARD (toward +x).
 *   lean   torso lean from vertical (positive = forward)
 *   head   head tilt relative to the torso
 *   shift  hip offset along x (meters, lunges)
 *   uaF/faF  lead (front) arm: upper arm absolute angle / forearm angle RELATIVE to upper arm
 *   uaB/faB  rear arm, same convention
 *   hipF/kneeF, hipB/kneeB  thigh absolute angle / shin angle relative to thigh
 *
 *   Pose.evaluate(action, progress, ctx) -> pose params       (data, no drawing)
 *   Pose.solve(params, dims)             -> joint positions   (planar, grounded)
 * A 2D renderer draws the planar joints directly; a 3D renderer maps x/y into world space.
 */
(function (g) {
  'use strict';
  var C = g.Config;
  var KEYS = ['lean', 'head', 'shift', 'uaF', 'faF', 'uaB', 'faB', 'hipF', 'kneeF', 'hipB', 'kneeB'];
  var BASE = { lean: 0.2, head: -0.08, shift: 0, uaF: 0.55, faF: 1.95, uaB: 0.35, faB: 2.25, hipF: 0.3, kneeF: -0.28, hipB: -0.32, kneeB: 0.1 };

  function mk(o) {
    var r = {}, i;
    for (i = 0; i < KEYS.length; i++) r[KEYS[i]] = (o && o[KEYS[i]] !== undefined) ? o[KEYS[i]] : BASE[KEYS[i]];
    return r;
  }
  function ease(x) { return x * x * (3 - 2 * x); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function lerpPose(a, b, t) {
    var r = {}, i;
    for (i = 0; i < KEYS.length; i++) r[KEYS[i]] = lerp(a[KEYS[i]], b[KEYS[i]], t);
    return r;
  }

  /** keyframes: [[t, partialPose], ...] with t ascending over 0..1 -> function(progress) */
  function keyed(frames) {
    var ks = frames.map(function (f) { return { t: f[0], p: mk(f[1]) }; });
    return function (p) {
      if (p <= ks[0].t) return lerpPose(ks[0].p, ks[0].p, 0);
      for (var i = 1; i < ks.length; i++) {
        if (p <= ks[i].t) {
          var span = ks[i].t - ks[i - 1].t;
          var u = span <= 0 ? 1 : (p - ks[i - 1].t) / span;
          return lerpPose(ks[i - 1].p, ks[i].p, ease(u));
        }
      }
      return lerpPose(ks[ks.length - 1].p, ks[ks.length - 1].p, 0);
    };
  }

  function fractions(type) {
    var P = C.PUNCH[type], tot = P.windup + P.active + P.recovery;
    return { wf: P.windup / tot, af: P.active / tot };
  }

  function punchAnim(type, windup, ext) {
    var f = fractions(type);
    return keyed([[0, {}], [f.wf, windup], [f.wf + f.af * 0.35, ext], [f.wf + f.af, ext], [1, {}]]);
  }

  var JAB = punchAnim('jab',
    { uaF: 0.1, faF: 2.4, lean: 0.1, shift: -0.05, uaB: 0.45, faB: 2.1, hipF: 0.25 },
    { uaF: 1.5, faF: 0.05, lean: 0.5, shift: 0.25, head: -0.2, hipF: 0.6, kneeF: -0.55, hipB: -0.5, kneeB: 0.2, uaB: 0.6, faB: 2.2 });

  var HOOK = punchAnim('hook',
    { uaB: 1.0, faB: 2.6, lean: -0.05, shift: -0.1, head: 0.05, uaF: 0.9, faF: 2.3, hipF: 0.35, hipB: -0.4 },
    { uaB: 1.6, faB: 0.7, lean: 0.55, shift: 0.2, head: -0.15, uaF: 0.9, faF: 2.3, hipF: 0.55, kneeF: -0.5, hipB: -0.55, kneeB: 0.25 });

  var UPPER = punchAnim('uppercut',
    { uaB: 0.1, faB: 1.0, lean: 0.45, shift: -0.1, head: -0.1, uaF: 0.7, faF: 2.2, hipF: 0.62, kneeF: -0.9, hipB: -0.6, kneeB: 0.35 },
    { uaB: 1.25, faB: 1.0, lean: 0.05, shift: 0.22, head: -0.25, uaF: 0.6, faF: 2.2, hipF: 0.35, kneeF: -0.3, hipB: -0.3, kneeB: 0.0 });

  var BLOCK_POSE = mk({ uaF: 1.0, faF: 2.15, uaB: 0.75, faB: 2.3, lean: 0.38, head: 0.12, hipF: 0.42, kneeF: -0.5, hipB: -0.44, kneeB: 0.2 });
  var BASE_POSE = mk({});

  var DODGE_BACK = keyed([[0, {}], [0.2, { lean: -0.5, head: 0.25, shift: -0.25, hipF: 0.6, kneeF: -0.8, hipB: -0.6, kneeB: 0.4, uaF: 0.3, faF: 2.3, uaB: 0.2, faB: 2.4 }],
    [0.7, { lean: -0.5, head: 0.25, shift: -0.25, hipF: 0.6, kneeF: -0.8, hipB: -0.6, kneeB: 0.4, uaF: 0.3, faF: 2.3, uaB: 0.2, faB: 2.4 }], [1, {}]]);
  var DODGE_SLIP = keyed([[0, {}], [0.2, { lean: 0.9, head: 0.2, shift: 0.15, hipF: 0.7, kneeF: -0.9, hipB: -0.7, kneeB: 0.4, uaF: 0.4, faF: 2.3, uaB: 0.5, faB: 2.2 }],
    [0.7, { lean: 0.9, head: 0.2, shift: 0.15, hipF: 0.7, kneeF: -0.9, hipB: -0.7, kneeB: 0.4, uaF: 0.4, faF: 2.3, uaB: 0.5, faB: 2.2 }], [1, {}]]);

  var KNOCKDOWN = keyed([
    [0, { lean: -0.3, head: -0.5, shift: -0.15, uaF: 0.3, faF: 1.0, uaB: 0.2, faB: 1.0 }],
    [0.35, { lean: -0.7, head: -0.3, shift: -0.35, hipF: 0.7, kneeF: -1.0, hipB: -0.1, kneeB: -1.2, uaF: 0.3, faF: 0.5, uaB: 0.4, faB: 0.4 }],
    [1, { lean: -1.5, head: -0.1, shift: -0.65, hipF: 1.5, kneeF: -0.05, hipB: 1.4, kneeB: -0.1, uaF: 0.7, faF: 0.2, uaB: 0.9, faB: 0.15 }]
  ]);
  var LYING = KNOCKDOWN(1);
  var GETUP = keyed([
    [0, { lean: -1.5, head: -0.1, shift: -0.65, hipF: 1.5, kneeF: -0.05, hipB: 1.4, kneeB: -0.1, uaF: 0.7, faF: 0.2, uaB: 0.9, faB: 0.15 }],
    [0.35, { lean: -0.55, head: -0.1, shift: -0.3, hipF: 1.3, kneeF: -0.5, hipB: 0.5, kneeB: -1.0, uaF: 0.1, faF: 0.4, uaB: 0.1, faB: 0.4 }],
    [0.65, { lean: 0.45, head: -0.1, shift: -0.1, hipF: 1.0, kneeF: -1.8, hipB: -0.25, kneeB: -1.5, uaF: 0.6, faF: 1.6, uaB: 0.4, faB: 1.8 }],
    [1, {}]
  ]);

  function idle(time) {
    var s = Math.sin(time * 6.2), c = Math.cos(time * 6.2);
    return mk({ lean: 0.2 + 0.02 * s, head: -0.08 + 0.015 * c, uaF: 0.55 + 0.05 * c, faF: 1.95 + 0.07 * s, uaB: 0.35 - 0.04 * c, faB: 2.25 - 0.05 * s,
                hipF: 0.3 + 0.05 * s, hipB: -0.32 - 0.05 * s });
  }

  function walk(time, dir) {
    var ph = time * 8.5 * (dir >= 0 ? 1 : -1);
    var s = Math.sin(ph), c = Math.cos(ph);
    return mk({ lean: 0.2 + 0.02 * s, uaF: 0.55 + 0.04 * c, faF: 1.95 + 0.06 * s,
                hipF: 0.3 + 0.32 * s, kneeF: -0.28 - 0.45 * Math.max(0, c),
                hipB: -0.32 - 0.32 * s, kneeB: 0.1 - 0.45 * Math.max(0, -c) });
  }

  function hit(p, variant) {
    var amp = variant === 'uppercut' ? 1.4 : (variant === 'hook' ? 1.0 : 0.75);
    var k = Math.pow(1 - p, 1.6) * (p < 0.08 ? p / 0.08 : 1);
    var hd = variant === 'hook' ? 0.4 : -0.5;
    return mk({ lean: 0.2 - 0.45 * amp * k, head: -0.08 + hd * amp * k, shift: -0.16 * amp * k,
                uaF: 0.55 - 0.3 * k, faF: 1.95 - 0.6 * k, uaB: 0.35 - 0.2 * k, faB: 2.25 - 0.6 * k,
                hipF: 0.3 + 0.2 * k, hipB: -0.32 - 0.15 * k });
  }

  function stagger(p) {
    var w = Math.sin(p * 16), k = Math.min(1, p * 6) * (1 - Math.max(0, (p - 0.85) / 0.15));
    return mk({ lean: 0.2 - 0.35 * k + 0.1 * w * k, head: -0.08 - 0.35 * k, shift: -0.1 * k,
                uaF: 0.55 - 0.35 * k, faF: 1.95 - 1.0 * k, uaB: 0.35 - 0.2 * k, faB: 2.25 - 1.1 * k,
                hipF: 0.3 + 0.25 * k + 0.1 * w * k, hipB: -0.32 - 0.2 * k - 0.1 * w * k, kneeF: -0.28 - 0.2 * k });
  }

  function victory(time) {
    var s = Math.sin(time * 8), s2 = Math.sin(time * 4);
    return mk({ lean: 0.04, head: 0.1, uaF: 2.7 + 0.12 * s, faF: 0.25, uaB: 2.9 - 0.12 * s, faB: 0.2,
                hipF: 0.2 + 0.07 * s2, hipB: -0.22 - 0.07 * s2, kneeF: -0.12, kneeB: 0.05 });
  }

  /** ctx: {time: seconds, dir: -1|0|1 movement relative to facing, variant: 'jab'|'hook'|'uppercut'|'slip'} */
  function evaluate(action, progress, ctx) {
    ctx = ctx || {}; var p = progress || 0; var time = ctx.time || 0;
    switch (action) {
      case 'jab': return JAB(p);
      case 'hook': return HOOK(p);
      case 'uppercut': return UPPER(p);
      case 'walk': return walk(time, ctx.dir || 0);
      case 'block': return lerpPose(BASE_POSE, BLOCK_POSE, ease(Math.min(1, p)));
      case 'dodge': return ctx.variant === 'slip' ? DODGE_SLIP(p) : DODGE_BACK(p);
      case 'hit': return hit(p, ctx.variant);
      case 'stagger': return stagger(p);
      case 'knockdown': return p >= 1 ? lerpPose(LYING, LYING, 0) : KNOCKDOWN(p);
      case 'getup': return GETUP(p);
      case 'victory': return victory(time);
      default: return idle(time);
    }
  }

  var DIMS = { arm: 1, upper: 0.34, fore: 0.32, thigh: 0.46, shin: 0.46, torso: 0.55, neck: 0.22, headR: 0.115 };

  /** Turn pose params into planar joint positions (meters), standing on y=0. */
  function solve(P, dims) {
    var D = dims || DIMS, arm = D.arm || 1;
    var UA = DIMS.upper * arm, FA = DIMS.fore * arm;
    function dv(a) { return { x: Math.sin(a), y: -Math.cos(a) }; }
    function seg(p, a, l) { var d = dv(a); return { x: p.x + d.x * l, y: p.y + d.y * l }; }
    var hip = { x: P.shift, y: 0 };
    var sh = { x: hip.x + Math.sin(P.lean) * DIMS.torso, y: hip.y + Math.cos(P.lean) * DIMS.torso };
    var ha = P.lean + P.head;
    var head = { x: sh.x + Math.sin(ha) * DIMS.neck, y: sh.y + Math.cos(ha) * DIMS.neck };
    var shF = { x: sh.x + 0.03, y: sh.y - 0.03 }, shB = { x: sh.x - 0.03, y: sh.y - 0.03 };
    var elF = seg(shF, P.uaF, UA), glF = seg(elF, P.uaF + P.faF, FA);
    var elB = seg(shB, P.uaB, UA), glB = seg(elB, P.uaB + P.faB, FA);
    var knF = seg(hip, P.hipF, DIMS.thigh), ftF = seg(knF, P.hipF + P.kneeF, DIMS.shin);
    var knB = seg(hip, P.hipB, DIMS.thigh), ftB = seg(knB, P.hipB + P.kneeB, DIMS.shin);
    var pts = [[ftF, 0.05], [ftB, 0.05], [knF, 0.08], [knB, 0.08], [hip, 0.13], [sh, 0.12], [head, DIMS.headR], [glF, 0.1], [glB, 0.1], [elF, 0.06], [elB, 0.06]];
    var minY = Infinity, i;
    for (i = 0; i < pts.length; i++) minY = Math.min(minY, pts[i][0].y - pts[i][1]);
    var dy = -minY;
    for (i = 0; i < pts.length; i++) pts[i][0].y += dy;
    [shF, shB].forEach(function (p) { p.y += dy; });
    return {
      hip: hip, shoulder: sh, head: head, headAngle: ha, headR: DIMS.headR, lean: P.lean,
      shoulderF: shF, shoulderB: shB, elbowF: elF, gloveF: glF, elbowB: elB, gloveB: glB,
      kneeF: knF, footF: ftF, kneeB: knB, footB: ftB, lift: dy
    };
  }

  g.Pose = { evaluate: evaluate, solve: solve, lerpPose: lerpPose, fractions: fractions, KEYS: KEYS, BASE: BASE, DIMS: DIMS };
})(typeof window !== 'undefined' ? window : globalThis);
