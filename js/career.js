/* career.js - Career mode data + progression (no DOM). Pure logic + localStorage persistence.
 *
 *  - 5 player specializations (each with its own stat spread, traits and signature combo)
 *  - 5 venues (Backyard -> Local Gym -> Warehouse -> City Arena -> Championship Stadium), 3 bouts each
 *  - Generated opponents that scale with career progress
 *  - Skill points earned per fight and spent on stat upgrades
 *
 * All tuning numbers live in Config.CAREER (config.js).
 */
(function (g) {
  'use strict';
  var C = g.Config, Boxers = g.Boxers;
  var KEY = 'ironFistsCareer_v1';
  var STATS = ['speed', 'power', 'stamina', 'chin', 'reach'];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  // ------------------------------------------------------------------ specializations
  var SPECS = [
    {
      id: 'swarmer', name: 'Swarmer', icon: '🌪️',
      blurb: 'Relentless pressure. Fast hands and a huge gas tank; chains punches into combos.',
      stats: { speed: 8, power: 5, stamina: 8, chin: 4, reach: 4 },
      traits: { jabSpeed: 0.85, comboBonus: 1.35 },
      combo: {
        name: 'Hurricane Rush', range: 1.2,
        hits: [
          { type: 'jab', label: 'Storm Jab', damage: 4.5, speed: 1.2, greenMul: 1.05 },
          { type: 'jab', label: 'Gale Jab', damage: 5.0, speed: 1.24, greenMul: 1.0 },
          { type: 'hook', label: 'Cyclone Hook', damage: 7.0, speed: 1.15, greenMul: 0.95 },
          { type: 'hook', label: 'Tempest Hook', damage: 7.5, speed: 1.15, greenMul: 0.92 },
          { type: 'uppercut', label: 'Eye of the Storm', damage: 12.0, speed: 1.08, greenMul: 0.88, finisher: true }
        ]
      }
    },
    {
      id: 'slugger', name: 'Slugger', icon: '🔨',
      blurb: 'One-punch power and a granite chin. Slow, but every hook and uppercut hurts.',
      stats: { speed: 3, power: 9, stamina: 5, chin: 8, reach: 4 },
      traits: { hookPower: 1.12, upperPower: 1.12, upperCost: 0.85 },
      combo: {
        name: 'Wrecking Ball', range: 1.15,
        hits: [
          { type: 'hook', label: 'Demolition Hook', damage: 10.5, speed: 0.9, greenMul: 0.95 },
          { type: 'hook', label: 'Rib Cracker', damage: 11.5, speed: 0.92, greenMul: 0.9 },
          { type: 'uppercut', label: 'Lights Out', damage: 16.5, speed: 0.86, greenMul: 0.82, finisher: true }
        ]
      }
    },
    {
      id: 'counter', name: 'Counterpuncher', icon: '🪞',
      blurb: 'Slips and punishes. Short dodge cooldown, big counter damage, patient and precise.',
      stats: { speed: 6, power: 5, stamina: 6, chin: 5, reach: 6 },
      traits: { blockEff: 1.15, dodgeCdMul: 0.6, counterMult: 1.35, iBonus: 4 },
      combo: {
        name: 'Mirror Break', range: 1.28,
        hits: [
          { type: 'jab', label: 'Feint Jab', damage: 5.5, speed: 1.08, greenMul: 1.08 },
          { type: 'uppercut', label: 'Rising Counter', damage: 9.0, speed: 1.05, greenMul: 1.02 },
          { type: 'hook', label: 'Reversal Hook', damage: 8.5, speed: 1.12, greenMul: 0.96 },
          { type: 'uppercut', label: 'Shatter', damage: 12.5, speed: 1.05, greenMul: 0.9, finisher: true }
        ]
      }
    },
    {
      id: 'outboxer', name: 'Out-Boxer', icon: '📏',
      blurb: 'Long reach and a laser jab. Wins from the outside and never gets hit clean.',
      stats: { speed: 7, power: 4, stamina: 7, chin: 4, reach: 8 },
      traits: { jabSpeed: 0.78, hookPower: 0.95 },
      combo: {
        name: 'Long Shadow', range: 1.4,
        hits: [
          { type: 'jab', label: 'Probe', damage: 5.0, speed: 1.2, greenMul: 1.08 },
          { type: 'jab', label: 'Needle', damage: 5.5, speed: 1.25, greenMul: 1.02 },
          { type: 'hook', label: 'Whip Hook', damage: 8.0, speed: 1.1, greenMul: 0.95 },
          { type: 'uppercut', label: 'Skyline', damage: 11.5, speed: 1.05, greenMul: 0.9, finisher: true }
        ]
      }
    },
    {
      id: 'tank', name: 'Iron Wall', icon: '🛡️',
      blurb: 'Impossible to hurt. Superb guard and chin; wears opponents down and wins late.',
      stats: { speed: 4, power: 6, stamina: 7, chin: 9, reach: 4 },
      traits: { blockEff: 1.3, hitstunMul: 0.7, hookPower: 1.05 },
      combo: {
        name: 'Siege Engine', range: 1.15,
        hits: [
          { type: 'hook', label: 'Battering Ram', damage: 9.5, speed: 0.95, greenMul: 0.98 },
          { type: 'jab', label: 'Rampart Jab', damage: 6.0, speed: 1.05, greenMul: 1.02 },
          { type: 'hook', label: 'Catapult', damage: 10.5, speed: 0.95, greenMul: 0.92 },
          { type: 'uppercut', label: 'Fortress Fall', damage: 14.0, speed: 0.92, greenMul: 0.86, finisher: true }
        ]
      }
    }
  ];

  // ------------------------------------------------------------------ appearance options
  var LOOKS = {
    skin: ['#f0c7a4', '#e2b27c', '#c68a5a', '#a8693f', '#7a4a2e', '#4a2c1b'],
    hairStyle: ['short', 'afro', 'spiky', 'mohawk', 'bald'],
    hair: ['#0d0b0a', '#3b2412', '#8a5a2b', '#e8c35a', '#c4202a', '#e8e8e8'],
    trunks: ['#c4202a', '#2563eb', '#12a150', '#8b5cf6', '#f59e0b', '#111827', '#ec4899', '#14b8a6'],
    glove: ['#d92b35', '#f2f2f2', '#19b45f', '#7c3aed', '#f59e0b', '#2563eb', '#ec4899', '#111827']
  };

  // ------------------------------------------------------------------ venues & bouts
  var VENUES = [
    { id: 'backyard',  name: 'Backyard Brawls',          place: "Dad's Backyard",       icon: '🏡', diff: 'easy' },
    { id: 'gym',       name: 'Local Gym Circuit',        place: 'Rusty Rec Center',     icon: '🏋️', diff: 'easy' },
    { id: 'warehouse', name: 'Underground Warehouse',    place: 'Pier 9 Warehouse',     icon: '🏭', diff: 'normal' },
    { id: 'arena',     name: 'City Arena Series',        place: 'Metro City Arena',     icon: '🏟️', diff: 'normal' },
    { id: 'stadium',   name: 'World Championship',       place: 'Iron Fists Stadium',   icon: '🏆', diff: 'hard' }
  ];

  var OPPONENTS = [
    ['Tommy Pike', 'Backyard Tommy'], ['Big Earl', 'The Fence Breaker'], ["Uncle Rocco", 'The Grill Master'],
    ['Marco Ruiz', 'Speed Bag'], ['Dante Cole', 'Heavy Bag'], ['Coach Barkley', 'The Old Lion'],
    ['Vlad Petrov', 'Crowbar'], ['Skeeter Jones', 'Switchblade'], ['Mad Dog Malone', 'The Warehouse King'],
    ['Andre Dubois', 'The Prince'], ['Hector Vega', 'El Martillo'], ['Tyrone Banks', 'City King'],
    ['Kenzo Mori', 'Thunder'], ['Viktor Kane', 'The Machine'], ['Apollo Stone', 'The Undisputed']
  ];

  function totalFights() { return OPPONENTS.length; }

  function venueFor(idx) {
    var i = clamp(idx, 0, totalFights() - 1);
    var vIdx = Math.floor(i / C.CAREER.fightsPerVenue);
    var inV = i % C.CAREER.fightsPerVenue;
    return { venue: VENUES[vIdx], venueIndex: vIdx, fightInVenue: inV + 1, boss: inV === C.CAREER.fightsPerVenue - 1 };
  }

  // ------------------------------------------------------------------ save data
  function blankSave(name, specId, look) {
    var spec = specById(specId);
    return {
      v: 1, name: String(name || 'ROOKIE').toUpperCase().slice(0, 14), spec: spec.id,
      look: {
        skin: look.skin, hairStyle: look.hairStyle, hair: look.hair, trunks: look.trunks, glove: look.glove
      },
      stats: JSON.parse(JSON.stringify(spec.stats)),
      points: C.CAREER.startPoints, fight: 0, wins: 0, losses: 0, kos: 0, earned: C.CAREER.startPoints
    };
  }

  function specById(id) {
    for (var i = 0; i < SPECS.length; i++) if (SPECS[i].id === id) return SPECS[i];
    return SPECS[0];
  }

  function load() {
    try {
      var raw = g.localStorage.getItem(KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s && s.v === 1 && s.stats && s.look) return s;
    } catch (_) {}
    return null;
  }
  function save(s) { try { g.localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) {} }
  function reset() { try { g.localStorage.removeItem(KEY); } catch (_) {} }

  // ------------------------------------------------------------------ boxer definitions
  function lookFull(l) {
    return { skin: l.skin, trunks: l.trunks, trim: '#ffffff', hair: l.hair, hairStyle: l.hairStyle, glove: l.glove, shoe: '#14161c' };
  }

  function playerDef(s) {
    var spec = specById(s.spec);
    return {
      id: 'career_player', name: s.name, nick: spec.name, style: spec.name,
      country: { code: 'USA', name: 'Your Hometown', css: 'linear-gradient(180deg,#d3202e 0 33%,#fff 33% 66%,#1f3fbf 66%)' },
      bio: spec.blurb,
      stats: JSON.parse(JSON.stringify(s.stats)),
      traits: JSON.parse(JSON.stringify(spec.traits)),
      look: lookFull(s.look),
      signatureCombo: JSON.parse(JSON.stringify(spec.combo)),
      ai: { aggr: 0.6, defense: 0.5, dodge: 0.3, jab: 2, hook: 1.5, up: 1, pref: 1, combo: 3, punish: 0.6, patience: 0.5 }
    };
  }

  function draftDef(name, specId, look) {
    var d = blankSave(name || 'ROOKIE', specId, look);
    return playerDef(d);
  }

  function opponentDef(idx) {
    var i = clamp(idx, 0, totalFights() - 1);
    var vf = venueFor(i);
    var tpl = Boxers.list[i % Boxers.list.length];
    var nm = OPPONENTS[i];
    var budget = Math.min(C.CAREER.oppMaxBudget, Math.round(C.CAREER.oppBaseBudget + C.CAREER.oppBudgetPerFight * i + (vf.boss ? C.CAREER.oppBossBonus : 0)));
    var sum = 0, k;
    for (k = 0; k < STATS.length; k++) sum += tpl.stats[STATS[k]];
    var stats = {};
    for (k = 0; k < STATS.length; k++) {
      stats[STATS[k]] = clamp(Math.round(tpl.stats[STATS[k]] / sum * budget), 1, 10);
    }
    var rng = (i * 2654435761) >>> 0;
    function pick(arr) { rng = (rng * 1664525 + 1013904223) >>> 0; return arr[(rng >>> 8) % arr.length]; }
    var ai = JSON.parse(JSON.stringify(tpl.ai));
    return {
      id: 'career_opp', name: nm[0], nick: nm[1], style: tpl.style,
      country: tpl.country, bio: vf.venue.place + (vf.boss ? ' — venue champion.' : ' — local contender.'),
      stats: stats, traits: JSON.parse(JSON.stringify(tpl.traits || {})),
      look: {
        skin: pick(LOOKS.skin), trunks: pick(LOOKS.trunks), trim: '#ffffff', hair: pick(LOOKS.hair),
        hairStyle: pick(LOOKS.hairStyle), glove: pick(LOOKS.glove), shoe: '#14161c'
      },
      signatureCombo: JSON.parse(JSON.stringify(tpl.signatureCombo)),
      ai: ai
    };
  }

  function register(s, idx) {
    Boxers.register(playerDef(s));
    Boxers.register(opponentDef(idx));
    return ['career_player', 'career_opp'];
  }

  // ------------------------------------------------------------------ upgrades & rewards
  function upgradeCost(cur) { return Math.max(1, Math.ceil(cur / C.CAREER.costDivisor)); }

  function canUpgrade(s, stat) {
    var cur = s.stats[stat];
    return cur < C.CAREER.statCap && s.points >= upgradeCost(cur);
  }

  function upgrade(s, stat) {
    if (STATS.indexOf(stat) < 0 || !canUpgrade(s, stat)) return false;
    s.points -= upgradeCost(s.stats[stat]);
    s.stats[stat] += 1;
    save(s);
    return true;
  }

  function applyResult(s, idx, win, method) {
    var K = C.CAREER, vf = venueFor(idx), finished = s.fight >= totalFights();
    var pts = 0, ko = (method === 'KO');
    if (win) {
      pts = finished ? K.replayWinPoints : (K.winBase + vf.venueIndex * K.winPerVenue + (ko ? K.koBonus : 0) + (vf.boss ? K.bossBonus : 0));
      s.wins++;
      if (ko) s.kos++;
      if (!finished && idx === s.fight) s.fight = Math.min(totalFights(), s.fight + 1);
    } else {
      pts = K.lossPoints;
      s.losses++;
    }
    s.points += pts;
    s.earned += pts;
    save(s);
    return { points: pts, win: win, ko: ko, boss: vf.boss, completed: win && s.fight >= totalFights() && idx === totalFights() - 1 };
  }

  g.Career = {
    STATS: STATS, SPECS: SPECS, LOOKS: LOOKS, VENUES: VENUES,
    specById: specById, venueFor: venueFor, totalFights: totalFights,
    blankSave: blankSave, load: load, save: save, reset: reset,
    playerDef: playerDef, draftDef: draftDef, opponentDef: opponentDef, register: register,
    upgradeCost: upgradeCost, canUpgrade: canUpgrade, upgrade: upgrade, applyResult: applyResult,
    difficultyFor: function (idx) { return venueFor(idx).venue.diff; },
    currentOpponentIndex: function (s) { return Math.min(s.fight, totalFights() - 1); }
  };
})(typeof window !== 'undefined' ? window : globalThis);
