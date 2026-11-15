/* boxers.js - fictional roster. Stats are 1..10 and are turned into real gameplay numbers by sim.js. */
(function (g) {
  'use strict';
  var list = [
    {
      id: 'viper', name: 'Rico Salazar', nick: 'The Viper', style: 'Fast Jabber',
      country: { code: 'CVE', name: 'Costa Verde', css: 'linear-gradient(180deg,#0f9d58 0 33%,#fff 33% 66%,#f4c20d 66%)' },
      bio: 'Lightning hands and endless footwork. Wins by a thousand stings.',
      stats: { speed: 9, power: 4, stamina: 7, chin: 4, reach: 6 },
      traits: { jabSpeed: 0.8, hookPower: 0.95 },
      look: { skin: '#c68a5a', trunks: '#12a150', trim: '#f4c20d', hair: '#15110f', hairStyle: 'short', glove: '#19b45f', shoe: '#101418' },
      signatureCombo: {
        name: 'Viper Fang Flurry',
        range: 1.32,
        hits: [
          { type: 'jab',      label: 'Flicker Jab',   damage: 4.5, speed: 1.18, greenMul: 1.05 },
          { type: 'jab',      label: 'Double Sting',  damage: 5.0, speed: 1.22, greenMul: 1.00 },
          { type: 'hook',     label: 'Sidewinder',    damage: 6.5, speed: 1.15, greenMul: 0.95 },
          { type: 'jab',      label: 'Blinding Snap', damage: 5.5, speed: 1.25, greenMul: 0.92 },
          { type: 'uppercut', label: 'Venom Fang',    damage: 11.5, speed: 1.10, greenMul: 0.88, finisher: true }
        ]
      },
      ai: { aggr: 0.75, defense: 0.35, dodge: 0.35, jab: 3.2, hook: 1.0, up: 0.4, pref: 1.05, combo: 4, punish: 0.7, patience: 0.4 }
    },
    {
      id: 'hammer', name: 'Dmitri Volkov', nick: 'The Hammer', style: 'Slow Heavy Hitter',
      country: { code: 'KRV', name: 'Kravia', css: 'linear-gradient(90deg,#c4202a 0 33%,#fff 33% 66%,#1d3f9f 66%)' },
      bio: 'Every punch is a freight train. Slow to start, terrifying to stop.',
      stats: { speed: 3, power: 10, stamina: 5, chin: 8, reach: 6 },
      traits: { hookPower: 1.12, upperPower: 1.12, upperCost: 0.85 },
      look: { skin: '#f0c7a4', trunks: '#c4202a', trim: '#111111', hair: '#e8c35a', hairStyle: 'mohawk', glove: '#d92b35', shoe: '#2a0f10' },
      signatureCombo: {
        name: 'Siberian Anvil Crush',
        range: 1.18,
        hits: [
          { type: 'hook',     label: 'Iron Sledge',      damage: 10.5, speed: 0.88, greenMul: 0.95 },
          { type: 'hook',     label: 'Rib Breaker',      damage: 11.5, speed: 0.92, greenMul: 0.90 },
          { type: 'uppercut', label: 'Doomsday Haymaker', damage: 16.5, speed: 0.85, greenMul: 0.82, finisher: true }
        ]
      },
      ai: { aggr: 0.7, defense: 0.45, dodge: 0.1, jab: 1.2, hook: 2.4, up: 1.9, pref: 0.82, combo: 2, punish: 0.6, patience: 0.5 }
    },
    {
      id: 'showtime', name: 'Jamal Carter', nick: 'Showtime', style: 'Balanced All-Rounder',
      country: { code: 'NCL', name: 'New Columbia', css: 'linear-gradient(180deg,#1f3fbf 0 50%,#fff 50% 62%,#d3202e 62% 78%,#fff 78% 88%,#d3202e 88%)' },
      bio: 'No weakness, great rhythm, and a flair for finishing combinations.',
      stats: { speed: 6, power: 6, stamina: 6, chin: 6, reach: 6 },
      traits: { comboBonus: 1.5 },
      look: { skin: '#7a4a2e', trunks: '#2563eb', trim: '#ffffff', hair: '#0d0b0a', hairStyle: 'afro', glove: '#f2f2f2', shoe: '#1b2a55' },
      signatureCombo: {
        name: 'Primetime Spotlight',
        range: 1.26,
        hits: [
          { type: 'jab',      label: 'Opening Act',   damage: 6.0,  speed: 1.00, greenMul: 1.05 },
          { type: 'hook',     label: 'Crowd Pleaser', damage: 8.5,  speed: 1.04, greenMul: 1.00 },
          { type: 'hook',     label: 'Flashbulb Hook', damage: 9.0,  speed: 1.08, greenMul: 0.94 },
          { type: 'uppercut', label: 'Main Event',    damage: 12.5, speed: 1.00, greenMul: 0.88, finisher: true }
        ]
      },
      ai: { aggr: 0.6, defense: 0.5, dodge: 0.3, jab: 2.0, hook: 1.8, up: 1.0, pref: 0.95, combo: 4, punish: 0.65, patience: 0.5 }
    },
    {
      id: 'shadow', name: 'Kenji Aoki', nick: 'The Shadow', style: 'Defensive Counterpuncher',
      country: { code: 'SKR', name: 'Sakura Isles', css: 'radial-gradient(circle at 50% 50%,#d9285a 0 26%,#f7f2ee 27%)' },
      bio: 'Slips everything, then punishes. Patience is his sharpest weapon.',
      stats: { speed: 7, power: 5, stamina: 6, chin: 5, reach: 8 },
      traits: { blockEff: 1.15, dodgeCdMul: 0.6, counterMult: 1.35, iBonus: 4 },
      look: { skin: '#e2b27c', trunks: '#1a1a24', trim: '#8b5cf6', hair: '#0c0c10', hairStyle: 'spiky', glove: '#7c3aed', shoe: '#14121f' },
      signatureCombo: {
        name: 'Phantom Eclipse Strike',
        range: 1.34,
        hits: [
          { type: 'jab',      label: 'Mirage Feint',   damage: 5.5,  speed: 1.08, greenMul: 1.08 },
          { type: 'uppercut', label: 'Rising Crescent', damage: 9.0,  speed: 1.05, greenMul: 1.02 },
          { type: 'hook',     label: 'Twilight Slash', damage: 8.5,  speed: 1.12, greenMul: 0.96 },
          { type: 'uppercut', label: 'Total Eclipse',  damage: 12.5, speed: 1.05, greenMul: 0.90, finisher: true }
        ]
      },
      ai: { aggr: 0.35, defense: 0.8, dodge: 0.85, jab: 2.2, hook: 1.4, up: 1.0, pref: 1.2, combo: 3, punish: 0.95, patience: 0.85 }
    }
  ];

  var byId = {};
  list.forEach(function (b) { byId[b.id] = b; });

  g.Boxers = {
    list: list,
    byId: function (id) { return byId[id]; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
