/* rng.js - seeded deterministic RNG (mulberry32). */
(function (g) {
  'use strict';
  var RNG = {
    /** Advance the generator whose 32-bit state lives in obj.rng, return float in [0,1). Mutates obj.rng. */
    next: function (obj) {
      obj.rng = (obj.rng + 0x6D2B79F5) | 0;
      var a = obj.rng;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    /** Standalone stateful generator (used by the CPU and cosmetic code). */
    make: function (seed) {
      var o = { rng: seed | 0 };
      var f = function () { return RNG.next(o); };
      f.range = function (a, b) { return a + (b - a) * f(); };
      f.pick = function (arr) { return arr[Math.floor(f() * arr.length) % arr.length]; };
      return f;
    }
  };
  g.RNG = RNG;
})(typeof window !== 'undefined' ? window : globalThis);
