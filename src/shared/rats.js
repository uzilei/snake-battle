// The rat: rare food that runs around. Plain data shared by the engine and
// /display. How often one spawns is the ratChance setting (src/engine.js).

export const RAT_RULES = Object.freeze({
  twemoji: '1f400', // 🐀, faces left
  mouseTwemoji: '1f401', // 🐁, also faces left: /display draws each rat as one of the two
  moveEveryTicks: 2, // half the speed of a snake
  // A fresh random direction after this many ticks (both included), or at
  // once when the way ahead is blocked.
  turnMinTicks: 2,
  turnMaxTicks: 20,
  growthMultiplier: 4, // eating one grows a snake 4 x growthPerApple
});
