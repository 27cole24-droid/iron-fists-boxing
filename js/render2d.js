/* render2d.js - Canvas 2D renderer. Read-only: draws a state snapshot, never changes it.
 *
 * Renderer interface (the 3D renderer in step 2 implements the same one):
 *   var r = Renderer2D.create();
 *   r.init(container)                          build DOM/canvas inside container
 *   r.render(state, events, alpha, prevState)  draw. `alpha` (0..1) blends prevState -> state.
 *                                              `events` = sim events since the previous render call.
 *   r.resize()                                 call when the container size changes
 *   r.destroy()                                remove everything this renderer created
 * Posing comes from pose.js (shared with 3D), so the same animation data drives both.
 */
(function (g) {
  'use strict';
  var Pose = g.Pose, C = g.Config, RNG = g.RNG;

  // ------------------------------------------------------------------ helpers
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function hexToRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
  }
  function shade(hex, amt) {
    var c = hexToRgb(hex), t = amt < 0 ? 0 : 255, p = Math.abs(amt);
    return 'rgb(' + Math.round(lerp(c[0], t, p)) + ',' + Math.round(lerp(c[1], t, p)) + ',' + Math.round(lerp(c[2], t, p)) + ')';
  }
  function rot(x, y, a) { return { x: x * Math.cos(a) + y * Math.sin(a), y: -x * Math.sin(a) + y * Math.cos(a) }; }
  function isPunch(a) { return a === 'jab' || a === 'hook' || a === 'uppercut'; }

  // ------------------------------------------------------------------ boxer art (local plane: +x forward, +y up, meters)
  var OUTLINE = 'rgba(12,10,20,0.55)';

  function strokePath(ctx, pts, w, col) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineWidth = w; ctx.strokeStyle = col; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.stroke();
  }
  function limb2(ctx, a, b, c, w1, w2, col) {
    strokePath(ctx, [a, b], w1 + 0.026, OUTLINE);
    strokePath(ctx, [b, c], w2 + 0.026, OUTLINE);
    strokePath(ctx, [a, b], w1, col);
    strokePath(ctx, [b, c], w2, col);
    strokePath(ctx, [a, b], w1 * 0.3, 'rgba(255,255,255,0.10)');
  }
  function circle(ctx, x, y, r, fill, line) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (line) { ctx.lineWidth = 0.02; ctx.strokeStyle = line; ctx.stroke(); }
  }
  function drawGlove(ctx, el, gl, color) {
    var dx = gl.x - el.x, dy = gl.y - el.y, len = Math.sqrt(dx * dx + dy * dy) || 1, ux = dx / len, uy = dy / len;
    strokePath(ctx, [{ x: gl.x - ux * 0.14, y: gl.y - uy * 0.14 }, { x: gl.x - ux * 0.05, y: gl.y - uy * 0.05 }], 0.12, '#e9e6df');
    strokePath(ctx, [{ x: gl.x - ux * 0.14, y: gl.y - uy * 0.14 }, { x: gl.x - ux * 0.05, y: gl.y - uy * 0.05 }], 0.03, 'rgba(0,0,0,0.12)');
    circle(ctx, gl.x + ux * 0.025, gl.y + uy * 0.025, 0.112, color, OUTLINE);
    // thumb + highlight
    circle(ctx, gl.x + ux * 0.0 - uy * 0.0 + 0.0, gl.y + 0.065, 0.045, shade(color, -0.12), null);
    circle(ctx, gl.x + 0.025, gl.y + 0.03, 0.04, 'rgba(255,255,255,0.28)', null);
  }
  function drawShoe(ctx, ft, color) {
    strokePath(ctx, [{ x: ft.x - 0.03, y: ft.y - 0.01 }, { x: ft.x + 0.14, y: ft.y - 0.02 }], 0.1, OUTLINE);
    strokePath(ctx, [{ x: ft.x - 0.03, y: ft.y - 0.01 }, { x: ft.x + 0.14, y: ft.y - 0.02 }], 0.082, color);
    strokePath(ctx, [{ x: ft.x - 0.03, y: ft.y - 0.052 }, { x: ft.x + 0.15, y: ft.y - 0.06 }], 0.016, '#e8e8e8');
  }

  function drawHead(ctx, J, look, mood) {
    var c = J.head, a = J.headAngle, R = J.headR, skin = look.skin, hair = look.hair;
    var p;
    strokePath(ctx, [J.shoulder, c], 0.09, OUTLINE);
    strokePath(ctx, [J.shoulder, c], 0.075, shade(skin, -0.08));
    // hair (back part)
    var style = look.hairStyle;
    if (style === 'afro') { p = rot(-0.035, 0.045, a); circle(ctx, c.x + p.x, c.y + p.y, 0.172, hair, 'rgba(0,0,0,0.4)'); }
    else if (style === 'short') { p = rot(-0.012, 0.012, a); circle(ctx, c.x + p.x, c.y + p.y, R + 0.014, hair, 'rgba(0,0,0,0.4)'); }
    else if (style === 'spiky') {
      for (var i = 0; i < 6; i++) {
        var ang = -0.9 + i * 0.4;
        var b0 = rot(Math.sin(ang) * 0.07, Math.cos(ang) * 0.07, a), b1 = rot(Math.sin(ang) * 0.2, Math.cos(ang) * 0.2 - 0.0, a);
        strokePath(ctx, [{ x: c.x + b0.x, y: c.y + b0.y }, { x: c.x + b1.x, y: c.y + b1.y }], 0.05 - i * 0.002, hair);
      }
      p = rot(-0.012, 0.012, a); circle(ctx, c.x + p.x, c.y + p.y, R + 0.012, hair, null);
    }
    // face
    circle(ctx, c.x, c.y, R, skin, OUTLINE);
    if (style === 'short' || style === 'afro' || style === 'spiky') {
      // redraw the front of the face over hair edge
      p = rot(0.025, -0.022, a); circle(ctx, c.x + p.x, c.y + p.y, R - 0.014, skin, null);
    }
    if (style === 'mohawk') {
      var m0 = rot(-0.1, 0.045, a), m1 = rot(-0.03, 0.17, a), m2 = rot(0.07, 0.125, a);
      strokePath(ctx, [{ x: c.x + m0.x, y: c.y + m0.y }, { x: c.x + m1.x, y: c.y + m1.y }, { x: c.x + m2.x, y: c.y + m2.y }], 0.052, hair);
    }
    // shading
    p = rot(0.0, 0.0, a);
    ctx.beginPath(); ctx.arc(c.x, c.y, R, 0.2 + (Math.PI / 2 - a), 3.1 + (Math.PI / 2 - a)); ctx.lineWidth = 0.014; ctx.strokeStyle = 'rgba(255,255,255,0.14)'; ctx.stroke();
    // ear, nose
    p = rot(-0.035, -0.005, a); circle(ctx, c.x + p.x, c.y + p.y, 0.03, shade(skin, -0.12), OUTLINE);
    p = rot(R - 0.002, -0.01, a); circle(ctx, c.x + p.x, c.y + p.y, 0.022, skin, null);
    // eye
    var e = rot(0.062, 0.028, a);
    if (mood === 'down') {
      var d1 = rot(0.045, 0.045, a), d2 = rot(0.08, 0.012, a), d3 = rot(0.045, 0.012, a), d4 = rot(0.08, 0.045, a);
      strokePath(ctx, [{ x: c.x + d1.x, y: c.y + d1.y }, { x: c.x + d2.x, y: c.y + d2.y }], 0.014, '#111');
      strokePath(ctx, [{ x: c.x + d3.x, y: c.y + d3.y }, { x: c.x + d4.x, y: c.y + d4.y }], 0.014, '#111');
    } else if (mood === 'hurt') {
      var h1 = rot(0.045, 0.028, a), h2 = rot(0.085, 0.028, a);
      strokePath(ctx, [{ x: c.x + h1.x, y: c.y + h1.y }, { x: c.x + h2.x, y: c.y + h2.y }], 0.016, '#111');
    } else {
      circle(ctx, c.x + e.x, c.y + e.y, 0.027, '#fff', 'rgba(0,0,0,0.5)');
      var pu = rot(0.075, 0.028, a); circle(ctx, c.x + pu.x, c.y + pu.y, 0.014, '#111', null);
    }
    // brow
    var b1p = rot(0.035, 0.07 + (mood === 'fight' ? 0.012 : 0), a), b2p = rot(0.095, 0.058 - (mood === 'fight' ? 0.012 : 0), a);
    strokePath(ctx, [{ x: c.x + b1p.x, y: c.y + b1p.y }, { x: c.x + b2p.x, y: c.y + b2p.y }], 0.02, style === 'bald' ? shade(skin, -0.45) : hair);
    // mouth / mouthguard
    var m1p = rot(0.058, -0.056, a), m2p = rot(0.104, -0.05, a);
    if (mood === 'hurt' || mood === 'down') circle(ctx, c.x + m2p.x - 0.01, c.y + m2p.y - 0.005, 0.02, '#3a0d12', null);
    else { strokePath(ctx, [{ x: c.x + m1p.x, y: c.y + m1p.y }, { x: c.x + m2p.x, y: c.y + m2p.y }], 0.03, '#f4f4f4'); strokePath(ctx, [{ x: c.x + m1p.x, y: c.y + m1p.y - 0.004 }, { x: c.x + m2p.x, y: c.y + m2p.y - 0.004 }], 0.008, '#c33'); }
  }

  /** Draw one boxer in local coordinates. The caller has already set up translate/scale. */
  function paintBoxer(ctx, look, J, mood) {
    var skin = look.skin, dark = shade(skin, -0.16);
    // back arm
    limb2(ctx, J.shoulderB, J.elbowB, J.gloveB, 0.105, 0.095, dark);
    drawGlove(ctx, J.elbowB, J.gloveB, shade(look.glove, -0.2));
    // legs
    limb2(ctx, J.hip, J.kneeB, J.footB, 0.16, 0.125, dark);
    drawShoe(ctx, J.footB, shade(look.shoe, -0.1));
    limb2(ctx, J.hip, J.kneeF, J.footF, 0.17, 0.13, skin);
    drawShoe(ctx, J.footF, look.shoe);
    // torso
    var H = J.hip, S = J.shoulder, l = J.lean;
    var n = { x: Math.cos(l), y: -Math.sin(l) }, u = { x: Math.sin(l), y: Math.cos(l) };
    function pt(o, k1, v1, k2, v2) { return { x: o.x + n.x * k1 + u.x * v1, y: o.y + n.y * k1 + u.y * v1 }; }
    var bw = pt(H, -0.115, 0), fw = pt(H, 0.12, 0), fc = pt(H, 0.2, 0.32), fs = pt(S, 0.125, -0.02), top = pt(S, 0.0, 0.07), bs = pt(S, -0.13, -0.02), bm = pt(H, -0.19, 0.3);
    ctx.beginPath();
    ctx.moveTo(bw.x, bw.y); ctx.lineTo(fw.x, fw.y);
    ctx.quadraticCurveTo(fc.x, fc.y, fs.x, fs.y);
    ctx.quadraticCurveTo(top.x, top.y, bs.x, bs.y);
    ctx.quadraticCurveTo(bm.x, bm.y, bw.x, bw.y);
    ctx.closePath();
    var gr = ctx.createLinearGradient(H.x - n.x * 0.16, H.y - n.y * 0.16, H.x + n.x * 0.2, H.y + n.y * 0.2);
    gr.addColorStop(0, shade(skin, -0.2)); gr.addColorStop(0.55, skin); gr.addColorStop(1, shade(skin, 0.12));
    ctx.fillStyle = gr; ctx.fill(); ctx.lineWidth = 0.022; ctx.strokeStyle = OUTLINE; ctx.lineJoin = 'round'; ctx.stroke();
    // pec / ab hints
    var p1 = pt(H, 0.17, 0.3), p2 = pt(H, 0.02, 0.27);
    ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.quadraticCurveTo(pt(H, 0.1, 0.22).x, pt(H, 0.1, 0.22).y, p2.x, p2.y);
    ctx.lineWidth = 0.012; ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.stroke();
    // trunks
    var tf = { x: H.x + (J.kneeF.x - H.x) * 0.58, y: H.y + (J.kneeF.y - H.y) * 0.58 };
    var tb = { x: H.x + (J.kneeB.x - H.x) * 0.55, y: H.y + (J.kneeB.y - H.y) * 0.55 };
    var wb0 = pt(H, -0.128, 0.075), wb1 = pt(H, 0.135, 0.075);
    function trunkPass(extra, col) {
      strokePath(ctx, [H, tb], 0.24 + extra, col);
      strokePath(ctx, [H, tf], 0.255 + extra, col);
      circle(ctx, H.x, H.y, 0.135 + extra / 2, col, null);
    }
    trunkPass(0.026, OUTLINE);
    trunkPass(0, look.trunks);
    // waistband + hems
    strokePath(ctx, [wb0, wb1], 0.06, look.trim);
    [[tf, J.kneeF], [tb, J.kneeB]].forEach(function (pair) {
      var dx = pair[1].x - H.x, dy = pair[1].y - H.y, ln = Math.sqrt(dx * dx + dy * dy) || 1, px = -dy / ln, py = dx / ln;
      var e = pair[0];
      strokePath(ctx, [{ x: e.x + px * 0.125, y: e.y + py * 0.125 }, { x: e.x - px * 0.125, y: e.y - py * 0.125 }], 0.038, look.trim);
    });
    strokePath(ctx, [pt(H, -0.05, 0.0), pt(H, -0.05, -0.1)], 0.01, 'rgba(0,0,0,0.18)');
    // head
    drawHead(ctx, J, look, mood);
    // front arm
    limb2(ctx, J.shoulderF, J.elbowF, J.gloveF, 0.11, 0.1, skin);
    drawGlove(ctx, J.elbowF, J.gloveF, look.glove);
  }

  // ------------------------------------------------------------------ renderer
  function Renderer2D() {
    this.canvas = null; this.ctx = null; this.container = null;
    this.w = 0; this.h = 0; this.dpr = 1;
    this.particles = []; this.shake = 0; this.flash = 0; this.excite = 0; this.last = 0;
    this.cam = { x: 0, view: 7 }; this.camInit = false;
    this.crowd = null; this.mat = null; this.vig = null; this.flashDots = [];
    this._onResize = null;
  }

  Renderer2D.prototype.init = function (container) {
    this.container = container;
    var cv = document.createElement('canvas');
    cv.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;';
    container.appendChild(cv);
    this.canvas = cv; this.ctx = cv.getContext('2d');
    this.last = performance.now();
    this.resize();
  };

  Renderer2D.prototype.destroy = function () {
    if (this.canvas && this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    this.canvas = null; this.ctx = null; this.particles = []; this.crowd = null; this.mat = null; this.vig = null;
  };

  Renderer2D.prototype.resize = function () {
    if (!this.canvas) return;
    var c = this.container;
    var w = Math.max(2, c.clientWidth), h = Math.max(2, c.clientHeight);
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.buildStatic();
  };

  function makeCanvas(w, h) { var c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; }

  Renderer2D.prototype.buildStatic = function () {
    var W = this.w, H = this.h, dpr = this.dpr, rnd = RNG.make(1234), i, r, x;
    // crowd: two layers
    var ch = Math.round(H * 0.55);
    var layers = [makeCanvas(W + 80, ch), makeCanvas(W + 80, ch)];
    this.dots = [];
    for (var L = 0; L < 2; L++) {
      var cx = layers[L].getContext('2d');
      for (r = 0; r < 3; r++) {
        var row = L * 3 + r;
        var headR = H * 0.0155 * (0.75 + row * 0.16);
        var base = ch * (0.30 + row * 0.115);
        var sp = headR * 2.25;
        for (x = -20 - rnd() * sp; x < W + 90; x += sp * (0.9 + rnd() * 0.35)) {
          var hy = base - headR + (rnd() - 0.5) * 5;
          var lum = 10 + row * 5 + rnd() * 8;
          var col = 'rgb(' + Math.round(lum) + ',' + Math.round(lum - 1 + row) + ',' + Math.round(lum * 2 + 8) + ')';
          cx.fillStyle = col;
          cx.beginPath(); cx.ellipse(x, hy + headR * 2.7, headR * 1.55, headR * 1.9, 0, Math.PI, 0); cx.fill();
          cx.fillRect(x - headR * 1.55, hy + headR * 2.7, headR * 3.1, ch);
          cx.beginPath(); cx.arc(x, hy, headR, 0, 6.2832); cx.fill();
          cx.strokeStyle = 'rgba(255,214,170,' + (0.05 + row * 0.02) + ')'; cx.lineWidth = 1.2;
          cx.beginPath(); cx.arc(x, hy, headR, Math.PI * 1.15, Math.PI * 1.85); cx.stroke();
          if (rnd() < 0.2 && row >= 1) {   // arms up
            cx.strokeStyle = col; cx.lineWidth = headR * 0.7; cx.lineCap = 'round';
            cx.beginPath(); cx.moveTo(x + headR, hy + headR * 2.2); cx.lineTo(x + headR * 1.7, hy - headR * 1.2); cx.stroke();
          }
          if (rnd() < 0.05) this.dots.push({ x: x, y: hy - headR * 0.5 + L * 0 });
        }
      }
    }
    this.crowd = layers;
    // canvas mat texture
    var pc = makeCanvas(40, 40), px = pc.getContext('2d');
    px.fillStyle = 'rgba(255,255,255,0.05)';
    for (i = 0; i < 40; i += 4) { px.fillRect(i, 0, 1, 40); }
    px.fillStyle = 'rgba(0,0,0,0.07)';
    for (i = 0; i < 40; i += 4) { px.fillRect(0, i, 40, 1); }
    for (i = 0; i < 60; i++) { px.fillStyle = 'rgba(255,255,255,' + (rnd() * 0.06) + ')'; px.fillRect(rnd() * 40, rnd() * 40, 1, 1); }
    this.mat = this.ctx.createPattern(pc, 'repeat');
    // vignette
    var vg = makeCanvas(W, H), vx = vg.getContext('2d');
    var gr = vx.createRadialGradient(W / 2, H * 0.55, Math.min(W, H) * 0.25, W / 2, H * 0.55, Math.max(W, H) * 0.75);
    gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,8,0.62)');
    vx.fillStyle = gr; vx.fillRect(0, 0, W, H);
    this.vig = vg;
  };

  // ---- events -> particles / shake
  Renderer2D.prototype.spawn = function (p) { if (this.particles.length < 400) this.particles.push(p); };

  Renderer2D.prototype.handleEvents = function (events, state) {
    if (!events) return;
    var i, k, e, TEXT = { jab: ['POP!', 'TAP!', 'SNAP!'], hook: ['WHAM!', 'SMACK!', 'WHAP!'], uppercut: ['BOOM!', 'CRACK!', 'KAPOW!'] };
    for (i = 0; i < events.length; i++) {
      e = events[i];
      switch (e.type) {
        case 'punch_landed':
          this.shake += (3 + e.dmg * 0.9) * (e.heavy ? 1.7 : 1);
          this.excite = Math.min(3, this.excite + (e.heavy ? 0.6 : 0.12));
          this.spawn({ k: 'ring', x: e.x, y: e.y, life: 0.28, max: 0.28, size: e.heavy ? 0.65 : 0.4, col: e.grade === 'green' ? '74,222,128' : undefined });
          var n = Math.round(8 + e.dmg * (e.heavy ? 1.3 : 0.9));
          for (k = 0; k < n; k++) {
            var ang = (Math.random() - 0.5) * 2.6, sp = 2.5 + Math.random() * (e.heavy ? 9 : 6);
            var spCol = e.grade === 'green' ? (Math.random() < 0.6 ? '#4ade80' : '#bbf7d0') : (Math.random() < 0.5 ? '#fff6b0' : '#ffb347');
            this.spawn({ k: 'spark', x: e.x, y: e.y, vx: Math.cos(ang) * sp * e.dir, vy: Math.sin(ang) * sp * 0.8 + 1, life: 0.2 + Math.random() * 0.3, max: 0.5, g: 0, len: 0.06 + Math.random() * 0.12, col: spCol });
          }
          var ns = 6 + Math.round(e.dmg * 0.8);
          for (k = 0; k < ns; k++) {
            this.spawn({ k: 'sweat', x: e.x, y: e.y, vx: (Math.random() * 3 + 0.8) * e.dir, vy: Math.random() * 3 + 0.5, life: 0.5 + Math.random() * 0.5, max: 1, g: -9, r: 0.012 + Math.random() * 0.012 });
          }
          if (!e.signatureHit) {
            var label = e.counter ? 'COUNTER!' : TEXT[e.punch][Math.floor(Math.random() * 3)];
            if (e.heavy || e.counter || Math.random() < 0.45)
              this.spawn({ k: 'text', x: e.x, y: e.y + 0.3, vx: 0.2 * e.dir, vy: 0.9, life: 0.7, max: 0.7, text: label, col: e.counter ? '#ff9d2e' : (e.heavy ? '#ff4d4d' : '#ffe14d'), size: e.heavy || e.counter ? 0.3 : 0.2, rotv: (Math.random() - 0.5) * 0.3 });
          }
          break;
        case 'perfect_block':
          this.shake += 3.5;
          this.spawn({ k: 'text', x: e.x, y: 1.95, vx: 0, vy: 0.6, life: 0.75, max: 0.75, text: 'PERFECT BLOCK!', col: '#38bdf8', size: 0.22, rotv: 0 });
          this.spawn({ k: 'ring', x: e.x, y: 1.45, life: 0.25, max: 0.25, size: 0.45, col: '56,189,248' });
          break;
        case 'momentum_ready':
          var mfx = state && state.fighters[e.who] ? state.fighters[e.who].x : 0;
          this.spawn({ k: 'text', x: mfx, y: 2.05, vx: 0, vy: 0.55, life: 0.9, max: 0.9, text: 'COMBO READY!', col: '#4ade80', size: 0.23, rotv: 0 });
          this.spawn({ k: 'ring', x: mfx, y: 1.1, life: 0.38, max: 0.38, size: 0.85, col: '74,222,128' });
          break;
        case 'combo_too_far':
          var tfx = state && state.fighters[e.who] ? state.fighters[e.who].x : 0;
          this.spawn({ k: 'text', x: tfx, y: 1.95, vx: 0, vy: 0.5, life: 0.75, max: 0.75, text: 'TOO FAR!', col: '#f87171', size: 0.22, rotv: 0 });
          break;
        case 'combo_start':
          this.shake += 10;
          this.flash = Math.max(this.flash, 0.35);
          this.excite = 3;
          this.spawn({ k: 'ring', x: e.x || 0, y: 1.15, life: 0.45, max: 0.45, size: 1.2, col: '250,204,21' });
          break;
        case 'combo_hit':
          var gCol = e.grade === 'green' ? '#4ade80' : (e.grade === 'good' ? '#facc15' : '#f87171');
          var gTxt = e.grade === 'green' ? 'GREEN! PERFECT!' : (e.grade === 'good' ? 'GOOD!' : (e.gradeText || 'MISS!'));
          this.spawn({ k: 'text', x: e.x, y: (e.y || 1.4) + 0.38, vx: 0, vy: 0.85, life: 0.8, max: 0.8, text: gTxt, col: gCol, size: e.grade === 'green' ? 0.28 : 0.22, rotv: 0 });
          break;
        case 'blocked':
          this.shake += 1.8;
          for (k = 0; k < 7; k++) this.spawn({ k: 'spark', x: e.x, y: e.y, vx: (Math.random() * 4 + 1) * (e.type && -1 || -1) * (state && state.fighters[e.who].facing || 1), vy: (Math.random() - 0.3) * 3, life: 0.2 + Math.random() * 0.15, max: 0.35, g: 0, len: 0.05 + Math.random() * 0.06, col: '#cfe3ff' });
          this.spawn({ k: 'ring', x: e.x, y: e.y, life: 0.2, max: 0.2, size: 0.28, col: '180,210,255' });
          break;
        case 'dodged':
          this.spawn({ k: 'text', x: e.x, y: 1.9, vx: 0, vy: 0.5, life: 0.6, max: 0.6, text: 'DODGE', col: '#7fd1ff', size: 0.2, rotv: 0 });
          break;
        case 'guard_break':
          this.shake += 6;
          this.spawn({ k: 'text', x: e.x, y: 2.0, vx: 0, vy: 0.6, life: 0.9, max: 0.9, text: 'GUARD BREAK!', col: '#ffd24d', size: 0.24, rotv: 0 });
          for (k = 0; k < 14; k++) this.spawn({ k: 'spark', x: e.x, y: 1.4, vx: (Math.random() - 0.5) * 8, vy: Math.random() * 5, life: 0.4, max: 0.4, g: -8, len: 0.08, col: '#ffd24d' });
          break;
        case 'knockdown':
          this.shake += 20; this.flash = Math.max(this.flash, 0.5); this.excite = 3;
          for (k = 0; k < 18; k++) this.spawn({ k: 'dust', x: e.x + (Math.random() - 0.5) * 0.8, y: 0.05, vx: (Math.random() - 0.5) * 2.5, vy: Math.random() * 0.8, life: 0.8 + Math.random() * 0.5, max: 1.3, g: 0.2, r: 0.1 + Math.random() * 0.14 });
          break;
        case 'get_up_success':
          this.excite = Math.min(3, this.excite + 1.2);
          var fx = state && state.fighters[e.who] ? state.fighters[e.who].x : 0;
          this.spawn({ k: 'text', x: fx, y: 1.9, vx: 0, vy: 0.65, life: 0.85, max: 0.85, text: 'RISEN!', col: '#4ade80', size: 0.26, rotv: 0 });
          break;
        case 'ko':
          this.shake += 28; this.flash = 1; this.excite = 3;
          break;
        case 'bell':
          this.excite = Math.min(3, this.excite + 0.8);
          break;
      }
    }
  };

  // ---- main draw
  Renderer2D.prototype.render = function (state, events, alpha, prev) {
    var ctx = this.ctx; if (!ctx) return;
    prev = prev || state; alpha = clamp(alpha === undefined ? 1 : alpha, 0, 1);
    var W = this.w, H = this.h, dpr = this.dpr;
    var now = performance.now(), realDt = Math.min(0.05, (now - this.last) / 1000); this.last = now;
    var dt = realDt * (state.hitstop > 0 ? 0.1 : state.timeScale);
    this.handleEvents(events, state);

    var F = state.fighters, PF = prev.fighters;
    var x = [lerp(PF[0].x, F[0].x, alpha), lerp(PF[1].x, F[1].x, alpha)];
    var time = (state.tick + alpha) / 60;

    // camera
    var dist = Math.abs(x[1] - x[0]), mid = (x[0] + x[1]) / 2;
    var portrait = H > W * 1.05;   // tall/narrow screens (phones held vertically): zoom in so boxers stay big
    var targetView = portrait ? clamp(dist + 2.5, 3.9, 8.6) : clamp(dist + 3.6, 5.6, 8.6);
    if (state.slowmo > 0 || state.comboState) targetView *= 0.78;
    if (!this.camInit) { this.cam.x = mid * 0.85; this.cam.view = targetView; this.camInit = true; }
    var k = 1 - Math.exp(-realDt * 5);
    this.cam.x += (clamp(mid * 0.85, -1.4, 1.4) - this.cam.x) * k;
    this.cam.view += (targetView - this.cam.view) * k;
    var S = Math.min(W / this.cam.view, H / 3.4);
    var gy = H * 0.77;
    var camX = this.cam.x;
    function sx(wx, depth) { return W / 2 + (wx - camX) * S * (depth || 1); }

    // shake
    this.shake *= Math.exp(-realDt * 9);
    var shk = this.shake * (S / 200), shx = (Math.random() - 0.5) * 2 * shk, shy = (Math.random() - 0.5) * 2 * shk;
    if (state.hitstop > 0) { shx += (Math.random() - 0.5) * 3; shy += (Math.random() - 0.5) * 3; }
    this.excite *= Math.exp(-realDt * 0.7);

    ctx.setTransform(dpr, 0, 0, dpr, shx * dpr, shy * dpr);

    // ---- background
    var bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#07080f'); bg.addColorStop(0.5, '#15112a'); bg.addColorStop(1, '#241a33');
    ctx.fillStyle = bg; ctx.fillRect(-20, -20, W + 40, H + 40);

    // crowd
    var yBack = gy - 0.42 * S, crowdBottom = yBack - 0.55 * S;
    var par = -camX * S * 0.12;
    var ex = 1 + this.excite;
    for (var L = 0; L < 2; L++) {
      var bob = Math.sin(time * (1.3 + L * 0.7) + L) * 2.2 * ex * (L + 1);
      ctx.drawImage(this.crowd[L], par - 40 + par * L * 0.4, crowdBottom - this.crowd[L].height + bob);
    }
    // crowd camera flashes
    if (Math.random() < 0.08 * ex && this.dots.length) this.flashDots.push({ d: this.dots[Math.floor(Math.random() * this.dots.length)], life: 3 });
    for (var fi = this.flashDots.length - 1; fi >= 0; fi--) {
      var fd = this.flashDots[fi];
      ctx.fillStyle = 'rgba(255,255,255,' + (0.35 + fd.life * 0.2) + ')';
      ctx.beginPath(); ctx.arc(par - 40 + fd.d.x, crowdBottom - this.crowd[0].height + fd.d.y, 2.2, 0, 6.2832); ctx.fill();
      if (--fd.life <= 0) this.flashDots.splice(fi, 1);
    }
    // dark floor behind ring
    var floorG = ctx.createLinearGradient(0, crowdBottom, 0, H);
    floorG.addColorStop(0, '#0a0912'); floorG.addColorStop(1, '#17121f');
    ctx.fillStyle = floorG; ctx.fillRect(-20, crowdBottom, W + 40, H);

    // spot beams
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    [0.22, 0.5, 0.78].forEach(function (fx, idx) {
      var tx = W * fx, bx = sx((idx - 1) * 1.8);
      var bgr = ctx.createLinearGradient(0, 0, 0, gy);
      bgr.addColorStop(0, 'rgba(255,236,200,0.10)'); bgr.addColorStop(1, 'rgba(255,236,200,0.0)');
      ctx.fillStyle = bgr; ctx.beginPath(); ctx.moveTo(tx - 12, 0); ctx.lineTo(tx + 12, 0); ctx.lineTo(bx + S * 1.6, gy); ctx.lineTo(bx - S * 1.6, gy); ctx.closePath(); ctx.fill();
    });
    ctx.restore();

    this.drawRingBack(ctx, S, gy, camX, W, H, sx);

    if (state.comboState) {
      ctx.save();
      ctx.fillStyle = 'rgba(4, 3, 14, 0.36)';
      ctx.fillRect(-20, -20, W + 40, H + 40);
      var spotX = sx((x[0] + x[1]) * 0.5);
      var spotG = ctx.createRadialGradient(spotX, gy - S * 0.9, S * 0.2, spotX, gy - S * 0.7, S * 2.2);
      spotG.addColorStop(0, 'rgba(74, 222, 128, 0.16)');
      spotG.addColorStop(0.55, 'rgba(250, 204, 21, 0.08)');
      spotG.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = spotG;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // ---- fighters
    var order = [0, 1];
    if (state.comboState) {
      order = state.comboState.attacker === 0 ? [1, 0] : [0, 1];
    } else if (isPunch(F[0].action) && !isPunch(F[1].action)) {
      order = [1, 0];
    }
    // shadows first
    for (var si = 0; si < 2; si++) {
      var sxp = sx(x[si]);
      var sg = ctx.createRadialGradient(sxp, gy + 0.03 * S, 1, sxp, gy + 0.03 * S, S * 0.6);
      sg.addColorStop(0, 'rgba(0,0,0,0.5)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save(); ctx.translate(0, gy + 0.03 * S); ctx.scale(1, 0.2); ctx.translate(0, -(gy + 0.03 * S)); ctx.fillStyle = sg;
      ctx.beginPath(); ctx.arc(sxp, gy + 0.03 * S, S * 0.6, 0, 6.2832); ctx.fill(); ctx.restore();
    }
    var heads = [];
    for (var oi = 0; oi < 2; oi++) {
      var i = order[oi], f = F[i], pf = PF[i];
      var look = g.Boxers.byId(f.bid).look;
      var cA = this.ctxFor(f, time + i * 0.37), cB = this.ctxFor(pf, time - 1 / 60 + i * 0.37);
      var P = Pose.lerpPose(Pose.evaluate(pf.action, pf.prog, cB), Pose.evaluate(f.action, f.prog, cA), alpha);
      var J = Pose.solve(P, { arm: f.p.armScale });
      var mood = (f.action === 'knockdown') ? 'down' : ((f.action === 'hit' || f.action === 'stagger' || f.action === 'getup') ? 'hurt' : (isPunch(f.action) || f.action === 'block' ? 'fight' : 'calm'));

      var isReady = f.momentum >= C.MOMENTUM.max;
      var isComboAttacker = !!(state.comboState && state.comboState.attacker === i);
      if (isReady || isComboAttacker) {
        var pulse = 0.65 + 0.35 * Math.sin(time * 9.5 + i);
        var auraX = sx(x[i]), auraY = gy - S * 0.98;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        var ag = ctx.createRadialGradient(auraX, auraY, S * 0.08, auraX, auraY, S * (0.72 + pulse * 0.14));
        if (isComboAttacker) {
          ag.addColorStop(0, 'rgba(74, 222, 128, ' + (0.42 * pulse) + ')');
          ag.addColorStop(0.5, 'rgba(250, 204, 21, ' + (0.24 * pulse) + ')');
        } else {
          ag.addColorStop(0, 'rgba(74, 222, 128, ' + (0.34 * pulse) + ')');
          ag.addColorStop(0.55, 'rgba(34, 197, 94, ' + (0.16 * pulse) + ')');
        }
        ag.addColorStop(1, 'rgba(0, 0, 0, 0)');
        ctx.fillStyle = ag;
        ctx.beginPath(); ctx.arc(auraX, auraY, S * 0.88, 0, 6.2832); ctx.fill();
        // Floor energy ring under glowing fighter
        ctx.translate(auraX, gy + 0.02 * S); ctx.scale(1, 0.22);
        ctx.strokeStyle = isComboAttacker ? 'rgba(250, 204, 21, ' + (0.7 * pulse) + ')' : 'rgba(74, 222, 128, ' + (0.7 * pulse) + ')';
        ctx.lineWidth = Math.max(2, S * 0.035);
        ctx.beginPath(); ctx.arc(0, 0, S * (0.52 + 0.06 * pulse), 0, 6.2832); ctx.stroke();
        ctx.restore();
      }

      ctx.save();
      if (f.invulnT > 0 && f.action !== 'getup' && (Math.floor(state.tick / 3) % 2 === 1)) {
        ctx.globalAlpha = 0.65;
      }
      ctx.translate(sx(x[i]), gy); ctx.scale(f.facing * S, -S);
      paintBoxer(ctx, look, J, mood);
      ctx.restore();
      heads.push({ i: i, hx: sx(x[i]) + f.facing * J.head.x * S, hy: gy - J.head.y * S, f: f });
    }

    // In-world NBA 2K-style vertical Shot/Combo Meter next to the attacking boxer
    if (state.comboState && (state.comboState.stage === 'meter' || state.comboState.stage === 'strike')) {
      this.drawComboWorldMeter(ctx, state.comboState, x, S, gy, sx);
    }

    // front ropes (faint) + front posts
    this.drawRingFront(ctx, S, gy, W, H, sx);

    // ---- particles
    this.updateParticles(ctx, dt, S, gy, sx, heads, state);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.drawImage(this.vig, 0, 0, W, H);
    if (state.slowmo > 0) { ctx.fillStyle = 'rgba(10,0,20,0.18)'; ctx.fillRect(0, 0, W, H); }
    if (this.flash > 0.01) { ctx.fillStyle = 'rgba(255,255,255,' + (this.flash * 0.55) + ')'; ctx.fillRect(0, 0, W, H); this.flash *= Math.exp(-realDt * 7); }
  };

  Renderer2D.prototype.ctxFor = function (f, time) {
    return { time: time, dir: f.dir, variant: f.action === 'hit' || f.action === 'stagger' ? f.hitType : (f.action === 'dodge' ? (f.dodgeDir > 0 ? 'slip' : 'back') : undefined) };
  };

  Renderer2D.prototype.drawComboWorldMeter = function (ctx, cs, x, S, gy, sx) {
    var atk = cs.attacker;
    var side = atk === 0 ? -1 : 1;
    var mx = sx(x[atk]) + side * S * 0.62;
    var myBottom = gy - S * 0.25;
    var mh = Math.max(90, S * 1.35);
    var mw = Math.max(12, S * 0.11);
    var myTop = myBottom - mh;

    ctx.save();
    // Outer track frame
    ctx.fillStyle = 'rgba(8, 10, 22, 0.9)';
    ctx.strokeStyle = cs.locked
      ? (cs.grade === 'green' ? '#4ade80' : (cs.grade === 'good' ? '#facc15' : '#f87171'))
      : 'rgba(255, 255, 255, 0.65)';
    ctx.lineWidth = 2.5;
    ctx.fillRect(mx - mw * 0.5 - 2, myTop - 2, mw + 4, mh + 4);
    ctx.strokeRect(mx - mw * 0.5 - 2, myTop - 2, mw + 4, mh + 4);

    // Red base zone (0..1 from bottom to top)
    ctx.fillStyle = 'rgba(239, 68, 68, 0.42)';
    ctx.fillRect(mx - mw * 0.5, myTop, mw, mh);

    // Good (yellow) zone
    var goodLo = clamp(cs.greenCenter - cs.goodHalf, 0, 1);
    var goodHi = clamp(cs.greenCenter + cs.goodHalf, 0, 1);
    var yGoodTop = myBottom - goodHi * mh;
    var yGoodBot = myBottom - goodLo * mh;
    ctx.fillStyle = 'rgba(250, 204, 21, 0.78)';
    ctx.fillRect(mx - mw * 0.5, yGoodTop, mw, Math.max(2, yGoodBot - yGoodTop));

    // Green (perfect) zone
    var greenLo = clamp(cs.greenCenter - cs.greenHalf, 0, 1);
    var greenHi = clamp(cs.greenCenter + cs.greenHalf, 0, 1);
    var yGreenTop = myBottom - greenHi * mh;
    var yGreenBot = myBottom - greenLo * mh;
    ctx.fillStyle = '#22c55e';
    ctx.fillRect(mx - mw * 0.5, yGreenTop, mw, Math.max(3, yGreenBot - yGreenTop));
    ctx.strokeStyle = '#bbf7d0';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(mx - mw * 0.5, yGreenTop, mw, Math.max(3, yGreenBot - yGreenTop));

    // Sweeping cursor bar
    var cur = clamp(cs.locked && cs.lockPos !== null ? cs.lockPos : cs.cursor, 0, 1);
    var cy = myBottom - cur * mh;
    // Fill trail up to cursor
    ctx.fillStyle = cs.locked
      ? (cs.grade === 'green' ? 'rgba(74, 222, 128, 0.38)' : (cs.grade === 'good' ? 'rgba(250, 204, 21, 0.32)' : 'rgba(248, 113, 113, 0.32)'))
      : 'rgba(255, 255, 255, 0.22)';
    ctx.fillRect(mx - mw * 0.5, cy, mw, myBottom - cy);

    // Bright cursor indicator needle
    ctx.fillStyle = cs.locked
      ? (cs.grade === 'green' ? '#4ade80' : (cs.grade === 'good' ? '#fde047' : '#f87171'))
      : '#ffffff';
    ctx.fillRect(mx - mw * 0.85, cy - 3, mw * 1.7, 6);
    ctx.strokeStyle = '#090814';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(mx - mw * 0.85, cy - 3, mw * 1.7, 6);
    ctx.restore();
  };

  Renderer2D.prototype.drawRingBack = function (ctx, S, gy, camX, W, H, sx) {
    var yBack = gy - 0.42 * S, yFront = gy + 0.4 * S;
    var bx0 = sx(-3.3, 0.96) , bx1 = sx(3.3, 0.96), fx0 = sx(-3.65, 1.04), fx1 = sx(3.65, 1.04);
    // apron
    var apr = ctx.createLinearGradient(0, yFront, 0, H);
    apr.addColorStop(0, '#7c1823'); apr.addColorStop(0.15, '#5e111b'); apr.addColorStop(1, '#16090d');
    ctx.fillStyle = apr; ctx.fillRect(fx0 - 80, yFront, fx1 - fx0 + 160, H - yFront + 10);
    ctx.fillStyle = '#e9e3d6'; ctx.fillRect(fx0 - 80, yFront, fx1 - fx0 + 160, Math.max(2, S * 0.025));
    // mat
    var mg = ctx.createLinearGradient(0, yBack, 0, yFront);
    mg.addColorStop(0, '#254577'); mg.addColorStop(1, '#3a62a3');
    ctx.fillStyle = mg;
    ctx.beginPath(); ctx.moveTo(bx0, yBack); ctx.lineTo(bx1, yBack); ctx.lineTo(fx1, yFront); ctx.lineTo(fx0, yFront); ctx.closePath(); ctx.fill();
    ctx.fillStyle = this.mat; ctx.fill();
    // border band
    ctx.lineWidth = Math.max(2, S * 0.03); ctx.strokeStyle = 'rgba(235,235,245,0.55)';
    ctx.beginPath(); ctx.moveTo(sx(-3.0, 0.97), yBack + S * 0.05); ctx.lineTo(sx(3.0, 0.97), yBack + S * 0.05); ctx.lineTo(sx(3.3, 1.03), yFront - S * 0.05); ctx.lineTo(sx(-3.3, 1.03), yFront - S * 0.05); ctx.closePath(); ctx.stroke();
    // center logo
    ctx.save(); ctx.translate(sx(0), gy); ctx.scale(1, 0.26);
    ctx.lineWidth = S * 0.05; ctx.strokeStyle = 'rgba(240,240,255,0.28)'; ctx.beginPath(); ctx.arc(0, 0, S * 1.35, 0, 6.2832); ctx.stroke();
    ctx.fillStyle = 'rgba(240,240,255,0.22)'; ctx.font = 'bold ' + Math.round(S * 0.62) + 'px Impact, "Arial Black", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('IRON FISTS', 0, 0);
    ctx.restore();
    // floor light pool
    var lp = ctx.createRadialGradient(sx(0), gy, 1, sx(0), gy, S * 3.4);
    lp.addColorStop(0, 'rgba(255,244,220,0.20)'); lp.addColorStop(1, 'rgba(255,244,220,0)');
    ctx.save(); ctx.translate(0, gy); ctx.scale(1, 0.32); ctx.translate(0, -gy); ctx.fillStyle = lp; ctx.beginPath(); ctx.arc(sx(0), gy, S * 3.4, 0, 6.2832); ctx.fill(); ctx.restore();

    // back posts + ropes
    var d = 0.96, postTop = yBack - 1.62 * S * d, ropeH = [0.55, 0.98, 1.4], ropeCol = ['#d9363b', '#f1efe9', '#3566d8'];
    var pw = Math.max(5, S * 0.085);
    for (var r = 0; r < 3; r++) {
      var ry = yBack - ropeH[r] * S * d;
      ctx.beginPath(); ctx.moveTo(bx0, ry); ctx.quadraticCurveTo((bx0 + bx1) / 2, ry + S * 0.06, bx1, ry);
      ctx.lineWidth = Math.max(3, S * 0.036); ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.stroke();
      ctx.lineWidth = Math.max(2, S * 0.028); ctx.strokeStyle = ropeCol[r]; ctx.stroke();
      ctx.lineWidth = Math.max(1, S * 0.008); ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.moveTo(bx0, ry - S * 0.008); ctx.quadraticCurveTo((bx0 + bx1) / 2, ry + S * 0.052, bx1, ry - S * 0.008); ctx.stroke();
    }
    [[bx0, '#c22a30'], [bx1, '#2455c4']].forEach(function (p) {
      var pg = ctx.createLinearGradient(p[0] - pw, 0, p[0] + pw, 0);
      pg.addColorStop(0, '#444a58'); pg.addColorStop(0.5, '#9aa2b4'); pg.addColorStop(1, '#3a3f4c');
      ctx.fillStyle = pg; ctx.fillRect(p[0] - pw / 2, postTop, pw, yBack - postTop);
      ctx.fillStyle = p[1];
      for (var j = 0; j < 3; j++) {
        var py = yBack - ropeH[j] * S * d;
        ctx.beginPath(); ctx.roundRect ? ctx.roundRect(p[0] - pw * 0.9, py - S * 0.07, pw * 1.8, S * 0.14, 4) : ctx.rect(p[0] - pw * 0.9, py - S * 0.07, pw * 1.8, S * 0.14); ctx.fill();
      }
    });
  };

  Renderer2D.prototype.drawRingFront = function (ctx, S, gy, W, H, sx) {
    var yFront = gy + 0.4 * S, d = 1.04, ropeH = [0.55, 0.98, 1.4], ropeCol = ['#d9363b', '#f1efe9', '#3566d8'];
    var x0 = sx(-3.65, d), x1 = sx(3.65, d), pw = Math.max(6, S * 0.1);
    ctx.save(); ctx.globalAlpha = 0.28;
    for (var r = 0; r < 3; r++) {
      var ry = yFront - ropeH[r] * S * d;
      ctx.beginPath(); ctx.moveTo(x0, ry); ctx.quadraticCurveTo((x0 + x1) / 2, ry + S * 0.07, x1, ry);
      ctx.lineWidth = Math.max(2, S * 0.032); ctx.strokeStyle = ropeCol[r]; ctx.stroke();
    }
    ctx.restore();
    [[x0, '#c22a30'], [x1, '#2455c4']].forEach(function (p) {
      var top = yFront - 1.75 * S * d;
      var pg = ctx.createLinearGradient(p[0] - pw, 0, p[0] + pw, 0);
      pg.addColorStop(0, '#3a3f4c'); pg.addColorStop(0.5, '#a9b1c3'); pg.addColorStop(1, '#343946');
      ctx.fillStyle = pg; ctx.fillRect(p[0] - pw / 2, top, pw, yFront - top);
      ctx.fillStyle = p[1];
      for (var j = 0; j < 3; j++) {
        var py = yFront - ropeH[j] * S * d;
        ctx.beginPath(); ctx.rect(p[0] - pw * 0.9, py - S * 0.08, pw * 1.8, S * 0.16); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fillRect(p[0] - pw * 0.9, py - S * 0.08, pw * 0.5, S * 0.16); ctx.fillStyle = p[1];
      }
    });
  };

  Renderer2D.prototype.updateParticles = function (ctx, dt, S, gy, sx, heads, state) {
    var arr = this.particles, i, p;
    // sweat from tired boxers
    for (i = 0; i < heads.length; i++) {
      var hd = heads[i], f = hd.f;
      if (f.st < f.maxSt * 0.3 && Math.random() < dt * 7 && state.phase === 'fight')
        this.spawn({ k: 'sweat', x: (hd.hx - W2(this)) / S, y: 0, hx: hd.hx, hy: hd.hy, scr: true, vx: (Math.random() - 0.5) * 1.5 - f.facing, vy: Math.random() * 1.5, life: 0.6, max: 0.6, g: -6, r: 0.014 });
    }
    function W2(self) { return self.w / 2; }
    for (i = arr.length - 1; i >= 0; i--) {
      p = arr[i];
      if (dt > 0) {
        p.life -= dt;
        if (p.life <= 0) { arr.splice(i, 1); continue; }
        if (p.scr) { p.hx += p.vx * S * dt; p.hy -= p.vy * S * dt; p.vy += (p.g || 0) * dt; }
        else {
          p.x += (p.vx || 0) * dt; p.y += (p.vy || 0) * dt;
          if (p.g) p.vy += p.g * dt;
          if (p.k === 'dust') { p.vx *= 0.96; }
          if (p.k === 'sweat' && p.y < 0) { p.y = 0; p.vy *= -0.2; p.vx *= 0.5; }
        }
      }
      var t = clamp(p.life / p.max, 0, 1);
      var px = p.scr ? p.hx : sx(p.x), py = p.scr ? p.hy : gy - p.y * S;
      if (p.k === 'spark') {
        var vl = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || 1;
        ctx.strokeStyle = p.col; ctx.globalAlpha = t; ctx.lineWidth = Math.max(1.5, S * 0.014); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px - p.vx / vl * p.len * S * (0.4 + t), py + p.vy / vl * p.len * S * (0.4 + t)); ctx.stroke(); ctx.globalAlpha = 1;
      } else if (p.k === 'ring') {
        var rr = p.size * S * (1 - t * 0.85);
        ctx.strokeStyle = 'rgba(' + (p.col || '255,255,255') + ',' + t * 0.8 + ')'; ctx.lineWidth = Math.max(2, S * 0.03 * t);
        ctx.beginPath(); ctx.arc(px, py, rr, 0, 6.2832); ctx.stroke();
        ctx.fillStyle = 'rgba(255,240,200,' + t * 0.25 + ')'; ctx.fill();
      } else if (p.k === 'sweat') {
        ctx.fillStyle = 'rgba(200,230,255,' + (0.4 + t * 0.5) + ')';
        ctx.beginPath(); ctx.arc(px, py, Math.max(1.2, p.r * S), 0, 6.2832); ctx.fill();
      } else if (p.k === 'dust') {
        ctx.fillStyle = 'rgba(200,190,175,' + t * 0.28 + ')';
        ctx.beginPath(); ctx.arc(px, py, p.r * S * (1.6 - t * 0.6), 0, 6.2832); ctx.fill();
      } else if (p.k === 'text') {
        ctx.save(); ctx.translate(px, py); ctx.rotate(p.rotv * (1 - t) * 2 + p.rotv); ctx.scale(1 + (1 - t) * 0.15, 1 + (1 - t) * 0.15);
        ctx.globalAlpha = Math.min(1, t * 2.2);
        ctx.font = 'italic 900 ' + Math.round(p.size * S) + 'px Impact, "Arial Black", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = Math.max(3, p.size * S * 0.18); ctx.strokeStyle = '#150a1e'; ctx.lineJoin = 'round'; ctx.strokeText(p.text, 0, 0);
        ctx.fillStyle = p.col; ctx.fillText(p.text, 0, 0);
        ctx.restore();
      }
    }
  };

  // ------------------------------------------------------------------ menu previews (same art + same pose data)
  var PREVIEW_SEQ = [['idle', 1.3, null], ['jab', 0.55, 'jab'], ['idle', 0.35, null], ['jab', 0.55, 'jab'], ['hook', 0.8, 'hook'], ['idle', 0.4, null], ['uppercut', 1.0, 'uppercut'], ['idle', 0.6, null], ['block', 0.9, null], ['idle', 0.5, null]];
  var PREVIEW_TOTAL = PREVIEW_SEQ.reduce(function (a, s) { return a + s[1]; }, 0);

  function drawPreview(canvas, boxer, time, facing) {
    var ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    var t = time % PREVIEW_TOTAL, i = 0, acc = 0;
    while (i < PREVIEW_SEQ.length - 1 && t >= acc + PREVIEW_SEQ[i][1]) { acc += PREVIEW_SEQ[i][1]; i++; }
    var seg = PREVIEW_SEQ[i], prog = (t - acc) / seg[1], act = seg[0];
    var P = Pose.evaluate(act, act === 'block' ? Math.min(1, prog * 3) : prog, { time: time });
    var J = Pose.solve(P, { arm: 0.9 + 0.02 * boxer.stats.reach });
    var S = H * 0.5;
    ctx.save();
    var sg = ctx.createRadialGradient(W / 2, H * 0.92, 2, W / 2, H * 0.92, S * 0.7);
    sg.addColorStop(0, 'rgba(0,0,0,0.5)'); sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save(); ctx.translate(0, H * 0.92); ctx.scale(1, 0.22); ctx.translate(0, -H * 0.92); ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(W / 2, H * 0.92, S * 0.7, 0, 6.2832); ctx.fill(); ctx.restore();
    ctx.translate(W / 2 - 0.15 * S * (facing || 1), H * 0.92); ctx.scale((facing || 1) * S, -S);
    paintBoxer(ctx, boxer.look, J, (act === 'idle') ? 'calm' : 'fight');
    ctx.restore();
  }

  g.BoxerArt = { paint: paintBoxer, drawPreview: drawPreview, shade: shade };
  g.Renderer2D = { id: '2d', label: '2D', create: function () { return new Renderer2D(); } };
})(typeof window !== 'undefined' ? window : globalThis);
