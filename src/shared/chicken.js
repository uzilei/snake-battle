// The chicken: rare food that runs off when a snake comes close. Plain data
// shared by the engine and /display. How often one spawns is the
// chickenChance setting (src/engine.js). It turns like a rat (RAT_RULES'
// turn timer).

export const CHICKEN_RULES = Object.freeze({
  twemoji: '1f413', // 🐓, faces left
  alertTwemoji: '2757', // ❗, over it while it's alerted
  moveEveryTicks: 2, // calm: a rat's speed
  alertMoveEveryTicks: 1, // alerted: a snake's speed
  alertRadius: 2, // a snake head this many grid steps away (or closer) alerts it
  calmAfterMs: 1000, // it calms down once no head has been that close for this long
  fleeChance: 0.8, // alerted, each move: the way furthest from the nearest head; otherwise it moves like a rat
  growthMultiplier: 25, // eating one grows a snake 25 x growthPerApple, plus a feast
});
