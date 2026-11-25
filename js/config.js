/* config.js - every tuning constant for the fight lives here. */
(function (g) {
  'use strict';
  var Config = {
    FPS: 60,
    DT: 1 / 60,
    MAX_STEPS_PER_FRAME: 6,

    // Match structure
    ROUNDS: 3,
    ROUND_SECONDS: 30,
    REST_SECONDS: 10,
    INTRO_FRAMES: 110,
    ROUNDEND_FRAMES: 150,

    // Ring geometry (meters, 1D line)
    RING_HALF: 3.0,
    MIN_DIST: 0.55,
    MAX_DIST: 6.0,
    START_X: 1.1,
    CORNER_X: 2.6,

    // Movement (m/s)
    MOVE_FWD: 1.55,
    MOVE_BACK: 1.2,
    BLOCK_MOVE_MUL: 0.45,
    GLIDE_SPEED: 2.6,

    HP_MAX: 100,

    // Stamina
    STAMINA_BASE: 70,
    STAMINA_PER_STAT: 7,
    REGEN_BASE: 6,            // per second
    REGEN_PER_STAT: 1.2,
    REGEN_BLOCK_MUL: 0.4,
    REGEN_MOVE_MUL: 0.7,
    FATIGUE_START: 0.45,      // below this fraction of max stamina you get tired
    FATIGUE_SLOW: 0.45,       // punches up to +45% slower when empty
    FATIGUE_WEAK: 0.4,        // punches up to -40% weaker when empty
    GASSED_DELAY: 45,         // frames with no regen after hitting zero
    MIN_STAMINA_TO_PUNCH: 2,

    BUFFER_FRAMES: 8,

    // Punches. windup/active/recovery are in frames at neutral speed.
    PUNCH: {
      jab:      { windup: 5,  active: 3, recovery: 10, damage: 4.4, stamina: 5,  range: 1.24, close: 0.95, minMul: 0.8, hitstun: 14, knock: 0.10, lunge: 0, hitHeight: 1.5 },
      hook:     { windup: 9,  active: 4, recovery: 16, damage: 8.2, stamina: 11, range: 1.05, close: 0.82, minMul: 0.8, hitstun: 20, knock: 0.26, lunge: 0, hitHeight: 1.5 },
      uppercut: { windup: 13, active: 4, recovery: 21, damage: 13,  stamina: 18, range: 0.92, close: 0.65, minMul: 0.4, hitstun: 30, knock: 0.40, lunge: 0, hitHeight: 1.35 }
    },
    WHIFF_EXTRA: 0.4,         // extra recovery fraction when a punch whiffs (you are open)
    HEAVY_DMG: 11,

    DODGE: { dur: 24, iStart: 2, iEnd: 14, dist: 0.95, slipDist: 0.35, moveFrames: 12, cost: 15, cooldown: 55 },

    BLOCK: {
      raise: 4,
      perfectWindow: 12,      // frames after raising guard that count as a "perfect block"
      perfectCounterWindow: 40, // frames after a perfect block where a landed punch counts as a counter
      reduce: { jab: 0.85, hook: 0.7, uppercut: 0.6 },
      drain: 1.1,             // stamina lost per point of pre-block damage
      guardBreakStun: 55
    },

    COMBO: { window: 120, perStep: 0.14, maxSteps: 4, repeatDecay: 0.78, repeatMin: 0.42 },
    MULT: { counterHit: 1.2, openRecovery: 1.15, whiff: 1.3, dodgeCounter: 1.5, dodgeCounterWindow: 50, tiredTarget: 1.1 },

    // Combo Meter (0 .. 100) & Signature Combo ("Big Moment") with NBA 2K Green Timing Meter
    MOMENTUM: {
      max: 100,
      // Gains (harder to earn: ~24-28 clean punches to fill 0 -> 100 because greening the combo is a KO)
      gainJab: 2.1,             // clean jab landed
      gainHook: 3.1,            // clean hook landed
      gainUppercut: 4.2,        // clean uppercut landed
      gainChainPerLink: 0.45,   // bonus per chain link when landing within COMBO.window (~2s)
      gainChainMaxLinks: 3,     // cap on chain link combo meter bonus
      gainCounter: 5.5,         // bonus for landing a counter after dodge or perfect block
      gainKnockdown: 10.0,      // bonus for scoring a knockdown
      gainBlocked: 0.4,         // tiny gain when opponent blocks your punch

      // Losses & Drain (punishes getting hit, whiffing, or playing passive)
      lossHeavyHit: 11.0,       // combo meter lost when taking a heavy hit
      lossKnockdown: 35.0,      // combo meter lost when knocked down
      lossWhiff: 2.8,           // combo meter lost on repeated whiffs (2+ in a row)
      idleGraceFrames: 180,     // 3.0 seconds (180 frames) without landing a punch before drain begins
      idleDrainPerSec: 3.8,     // combo meter drained per second after idleGraceFrames
      betweenRoundsKeep: 0.35,  // between rounds combo meter is reduced to 35% of its value

      // Activation
      activateRange: 1.28       // max base distance (scaled by boxer reach) to activate Signature Combo
    },

    // Signature Combo Move & NBA 2K-style Green Timing Meter
    COMBO_MOVE: {
      lockDist: 0.78,           // spacing (meters) boxers lock into during choreographed combo exchange
      introFrames: 14,          // dramatic freeze/windup frames when "COMBO!" triggers
      outroFrames: 18,          // recovery frames after the combo finishes
      meterFramesBase: 34,      // base frames for the timing cursor to sweep 0 -> 1 (faster sweep)
      strikeFrames: 14,         // frames to play each hit's punch impact animation after timing lock
      speedScalePerHit: 1.10,   // cursor sweeps 10% faster on each subsequent hit in the combo
      greenCenter: 0.74,        // target position (0..1) of the center of the Green Zone
      greenHalfWidth: 0.055,    // tighter Green Zone on hit 1 (total width = 0.11)
      greenShrinkPerHit: 0.88,  // Green Zone narrows by 12% on each subsequent hit
      goodHalfWidth: 0.16,      // half-width of the Yellow ("GOOD") zone surrounding Green

      // Timing Multipliers, Refunds & Green Combo Instant KO
      greenMult: 1.35,          // 135% damage on a GREEN (Perfect) release
      goodMult: 0.75,           // 75% damage on a YELLOW (Good) release
      missMult: 0.20,           // 20% glanced chip damage on a RED (Early/Late/Miss) release
      missBreaksCombo: true,    // a RED (Early/Late/Miss) release ends the combo early
      greenComboInstantKO: true,// greening the Combo Finisher (or all hits) triggers an INSTANT KO!
      perfectRefund: 4.0,       // combo meter refunded for each GREEN hit if fight continues
      allGreenBonusRefund: 10.0,// extra combo meter refunded if every hit is GREEN

      // CPU Timing accuracy on the Green Meter (per hit). Remaining probability = MISS (breaks the combo).
      // Easy: mostly GOOD, some MISS, very few PERFECT. Medium ~ old Easy. Hard ~ old Medium.
      cpuGreenProb: { easy: 0.04, normal: 0.12, hard: 0.26 },
      cpuGoodProb:  { easy: 0.62, normal: 0.50, hard: 0.46 }
      // (How often the CPU ACTIVATES its combo is controlled by CPU_DIFF.sigChance / sigDelayFrames below.)
    },

    // ======================================================================
    // VS CPU DIFFICULTY (applies ONLY in VS CPU mode; Local 2 Player is untouched)
    // Keys: easy (default, very forgiving) | normal = "Medium" (~old Easy) | hard (~old Medium)
    // ======================================================================
    CPU_DIFF: {
      //            reaction delay frames | share of attacks it reacts to with block / dodge / punish
      easy: {
        react: 30,            // frames of reaction delay (60 = 1s). Higher = slower to respond to the human
        blockP: 0.22,         // chance to answer an incoming punch with a block (~15-25% of the time overall)
        dodgeP: 0.04,         // chance to answer with a dodge (rare)
        punishP: 0.10,        // chance to punish the human's recovery
        mash: 3.0,            // legacy/unused hint
        mistake: 0.40,        // chance to completely ignore an incoming punch
        aggr: 1.00,           // how often it chooses to attack (fewer punches per second)
        guard: 0.30,          // multiplier on how often it sits in a guard stance
        comboCap: 2,          // max punches in a CPU chain
        planMul: 2.0,         // longer plans = slower decisions
        sigChance: 0.006,     // per-step chance to fire the signature combo once eligible (~1/4 of old Easy)
        sigDelayFrames: 300,  // must be READY this many frames (5s) before it will ever use the combo
        punchCool: 14,        // frames between its punches in a chain
        rangeErr: 0.25,       // throws from up to +35% too far away -> whiffs
        prefErr: 0.55,        // +/- meters it misjudges its preferred fighting distance (walks too close/far)
        idleW: 1.2,           // weight of the "just stand there" plan
        retreatW: 1.0,        // extra weight of retreating for no reason
        freezePerSec: 0.25,   // seeded chance per second to freeze up / throw a silly punch
        freezeMin: 12,        // freeze duration (frames), min
        freezeMax: 40,        // freeze duration (frames), max
        sillyWhiffP: 0.25,    // chance a freeze also throws a random jab
        blockHold: 10,        // frames a reactive block is held (drops the guard quickly)
        counterP: 0.12,       // chance to counter after a successful dodge
        tiredUpper: 2.5,      // weight of hooks/uppercuts it still throws while tired (wastes stamina)
        tiredAttack: 0.8,     // attack weight while tired (normal/hard ~0.08)
        restW: 0.8,           // weight of resting when tired (normal/hard 4)
        restThresh: 0.15      // stops to rest only when stamina < punch cost * this (normal/hard 1.1)
      },
      normal: {
        react: 22, blockP: 0.30, dodgeP: 0.20, punishP: 0.40, mash: 4.2, mistake: 0.28, aggr: 0.8, guard: 0.7,
        comboCap: 2, planMul: 1.5, sigChance: 0.025, sigDelayFrames: 120, punchCool: 7, rangeErr: 0.08, prefErr: 0.15,
        idleW: 0.6, retreatW: 0.3, freezePerSec: 0.1, freezeMin: 8, freezeMax: 20, sillyWhiffP: 0.2, blockHold: 24,
        counterP: 0.75, tiredUpper: 0.2, tiredAttack: 0.08, restW: 4, restThresh: 1.1
      },
      hard: {
        react: 14, blockP: 0.55, dodgeP: 0.40, punishP: 0.70, mash: 5.2, mistake: 0.12, aggr: 1.0, guard: 1.0,
        comboCap: 3, planMul: 1.0, sigChance: 0.065, sigDelayFrames: 45, punchCool: 5, rangeErr: 0.0, prefErr: 0.0,
        idleW: 0.0, retreatW: 0.0, freezePerSec: 0.0, freezeMin: 0, freezeMax: 0, sillyWhiffP: 0.0, blockHold: 28,
        counterP: 1.0, tiredUpper: 0.2, tiredAttack: 0.08, restW: 4, restThresh: 1.1
      }
    },

    // Human-only advantages in VS CPU mode (never applied to the CPU or in Local 2 Player).
    ASSIST: {
      easy: {
        dmgDealt: 1.25,            // human damage dealt multiplier
        dmgTaken: 0.70,            // human damage taken multiplier
        regenMul: 1.25,            // human stamina regen multiplier
        momentumMul: 1.30,         // human combo-meter gain multiplier
        greenZoneMul: 1.30,        // human green + good zone size multiplier on the timing meter
        cursorSlow: 1.25,          // human timing cursor takes 25% longer to sweep (= ~20% slower)
        getupDrainMul: 0.75,       // human get-up meter drains 25% slower
        getupGainMul: 1.25,        // each human get-up press adds 25% more
        getupRamp: 0.60,           // knockdown difficulty level ramps at 60% speed for the human
        hitRangeBonus: 0.05,       // meters added to the human's punch range (a few pixels)
        perfectBlockBonus: 4,      // extra frames in the human's perfect-block window
        dodgeIFrameBonus: 3        // extra i-frames on the human's dodge
      },
      normal: {
        dmgDealt: 1.10, dmgTaken: 0.85, regenMul: 1.10, momentumMul: 1.12, greenZoneMul: 1.12, cursorSlow: 1.08,
        getupDrainMul: 0.90, getupGainMul: 1.10, getupRamp: 0.85, hitRangeBonus: 0.02, perfectBlockBonus: 2, dodgeIFrameBonus: 1
      },
      hard: {
        dmgDealt: 1.0, dmgTaken: 1.0, regenMul: 1.0, momentumMul: 1.0, greenZoneMul: 1.0, cursorSlow: 1.0,
        getupDrainMul: 1.0, getupGainMul: 1.0, getupRamp: 1.0, hitRangeBonus: 0, perfectBlockBonus: 0, dodgeIFrameBonus: 0
      }
    },
    // Knockdown & 10-Count Get-Up Meter System (no TKO rule; unlimited knockdowns; much harder to get up)
    KNOCKDOWN: {
      fall: 36,                 // frames for initial fall-to-canvas animation
      getupAnim: 36,            // frames for stand-up animation once meter hits 100
      postGetupInvuln: 60,      // frames (~1.0s) of invulnerability after rising
      countTo: 10,              // 10-count KO limit
      countFrames: 60,          // frames per count tick (60 = 1.0 second per count)

      // Flash knockdown trigger on heavy uppercut against weakened opponent
      uppercutHpFrac: 0.30,
      uppercutMinDmg: 8,

      // Get-Up Meter (0 .. 100) — balanced so 1st KD is doable (~6.5-7.5 presses/s), getting harder each KD / prior KO
      meterMax: 100,
      pressCooldownFrames: 2,   // min frames between registered human presses (allows up to 30/s while blocking 8-key slams)
      basePressGain: 4.2,       // meter added per valid press on 1st knockdown (needs ~6.2+ presses/s sustained)
      pressShrinkPerKd: 0.14,   // press gain shrinks by 14% per subsequent knockdown / prior KO
      minPressGain: 1.5,        // floor on press gain at high knockdown counts
      baseDrainPerSec: 15.0,    // meter drained per second on 1st knockdown (at Chin 5)
      drainMultPerKd: 1.32,     // drain rate multiplies by 1.32x per subsequent knockdown / prior KO
      maxDrainPerSec: 85.0,     // cap on meter drain per second
      chinDrainFactor: 0.035,   // per point of Chin above/below 5 (-3.5% drain per Chin point)
      priorKoLevelPenalty: 1,   // extra difficulty levels added for each time this boxer was KO'd in prior fights
      maxLevelCap: 8,           // cap on effective knockdown difficulty level
      restLevelRecover: 0,      // 0 = knockdown difficulty never resets between rounds (every knockdown stacks)

      // Health & Stamina upon rising
      restoreBase: 0.22,        // 22% max HP restored on 1st knockdown
      restoreDecayPerKd: 0.04,  // -4% max HP restored per previous knockdown
      restorePerChin: 0.008,    // +0.8% max HP per Chin point above 5
      restoreMin: 0.08,         // minimum 8% max HP when getting up
      staminaRestoreFrac: 0.42, // stamina set to 42% of max when rising (partly drained)
      staminaMinFrac: 0.22,     // minimum stamina fraction when rising after many knockdowns

      // CPU Get-Up simulation (presses/sec before random variance)
      cpuMashBase: { easy: 5.0, normal: 6.4, hard: 7.4 }, // CPU presses/sec at Chin 5 (needs ~6.1/s to beat the 1st count, so Easy CPU mostly stays down)
      cpuMashChinBonus: 0.24,   // extra presses/sec per Chin point above 5
      cpuMashVariance: 1.8      // random +/- presses/sec modulation from seeded RNG
    },

    // ======================================================================
    // CAREER MODE tuning (js/career.js)
    // ======================================================================
    CAREER: {
      fightsPerVenue: 3,        // bouts per venue (last one is the venue champion / boss)
      startPoints: 3,           // free skill points at career start
      statCap: 10,              // max level of any stat
      costDivisor: 3,           // upgrade cost = ceil(currentStat / costDivisor) skill points
      winBase: 2,               // skill points for any win
      winPerVenue: 1,           // + this per venue climbed (Backyard 0 ... Stadium 4)
      koBonus: 1,               // + for winning by KO
      bossBonus: 1,             // + for beating a venue champion
      lossPoints: 1,            // consolation points for a loss (you can always retry)
      replayWinPoints: 2,       // points for rematches after the career is complete
      oppBaseBudget: 22,        // opponent total stat points at fight 1
      oppBudgetPerFight: 2.3,   // + per fight climbed (opponents get tougher)
      oppBossBonus: 3,          // + for venue champions
      oppMaxBudget: 50          // hard cap (5 stats x 10)
    },
    HITSTOP: { jab: 2, hook: 4, uppercut: 6, knockdown: 12, block: 1 },
    SLOWMO: { scale: 0.25, knockdown: 28, finish: 70 },

    REST: { hpRecover: 0.30, stRecover: 0.6 },
    SCORE: { perDamage: 1, perClean: 4, perKnockdown: 25, evenShare: 0.04, dominantShare: 0.8, judgeNoise: 0.12 }
  };
  g.Config = Config;
})(typeof window !== 'undefined' ? window : globalThis);




