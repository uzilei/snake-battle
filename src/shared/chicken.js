// The chicken: rare food that runs off when a snake comes close. Plain data
// shared by the engine and /display. How often one spawns is the
// chickenChance setting (src/engine.js). It turns like a rat (RAT_RULES'
// turn timer).

export const CHICKEN_RULES = Object.freeze({
  twemoji: '1f413', // 🐓, faces left
  alertTwemoji: '2757', // ❗, over it while it's alerted
  moveEveryTicks: 2, // calm: a rat's speed
  alertMoveEveryTicks: 1, // alerted: a snake's speed
  // A threat (a snake head, or any cell of the active badger) this many grid
  // steps away or closer alerts it.
  alertRadius: 2,
  calmAfterMs: 1000, // it calms down once no threat has been that close for this long
  fleeChance: 0.9, // alerted, each move: the way furthest from the nearest threat; otherwise it moves like a rat
  growthMultiplier: 25, // eating one grows a snake 25 x growthPerApple, plus a feast
  // Dying any other way (shot, caught by the badger...), it leaves a feast
  // power-up where it died.
});
