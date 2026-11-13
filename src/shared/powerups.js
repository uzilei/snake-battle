// The power-ups, in /admin order. Plain data shared by the engine, /admin and
// /display: the engine's weight settings, the /admin sliders and the /display
// sprites are all generated from this list.
//
// Adding a power-up: add an entry here, its effect in the engine's EFFECTS
// table (src/engine.js) and its Italian name in STRINGS.admin.powerUpNames.
//
//   type          id used everywhere
//   emoji         shown next to its /admin label
//   twemoji       file name in @twemoji/svg (served at /twemoji/<code>.svg)
//   durationMs    timed effects: how long it lasts; null = instant
//   defaultWeight how often it's picked relative to the others (0-10);
//                 left out for the bomb, which has its own frequency slider

export const POWER_UPS = Object.freeze(
  [
    { type: 'golden', emoji: '⭐', twemoji: '2b50', durationMs: 3000, defaultWeight: 3 },
    { type: 'ghost', emoji: '👻', twemoji: '1f47b', durationMs: 3000, defaultWeight: 3 },
    { type: 'gun', emoji: '🔫', twemoji: '1f52b', durationMs: null, defaultWeight: 1 },
    { type: 'magnet', emoji: '🧲', twemoji: '1f9f2', durationMs: 5000, defaultWeight: 3 },
    { type: 'freeze', emoji: '🧊', twemoji: '1f9ca', durationMs: 3000, defaultWeight: 2 },
    { type: 'scissors', emoji: '✂️', twemoji: '2702', durationMs: 8000, defaultWeight: 2 },
    { type: 'portal', emoji: '🌀', twemoji: '1f300', durationMs: null, defaultWeight: 2 },
    { type: 'feast', emoji: '🍗', twemoji: '1f357', durationMs: null, defaultWeight: 3 },
    { type: 'shield', emoji: '🛡️', twemoji: '1f6e1', durationMs: 10000, defaultWeight: 3 },
    { type: 'bomb', emoji: '💣', twemoji: '1f4a3', durationMs: null },
  ].map((p) => Object.freeze(p)),
);

export const POWER_UP_TYPES = Object.freeze(Object.fromEntries(POWER_UPS.map((p) => [p.type, p])));

// The ones that spawn in place of an apple, picked by weight.
export const WEIGHTED_POWER_UPS = Object.freeze(POWER_UPS.filter((p) => p.defaultWeight !== undefined));

// golden -> weightGolden: the config key of its weight slider.
export const weightKey = (type) => `weight${type[0].toUpperCase()}${type.slice(1)}`;

// Fixed numbers of the effects, shared so /display can draw them to scale.
export const POWER_UP_RULES = Object.freeze({
  bombLifetimeMs: 10000, // an uneaten bomb disappears after this long
  bombBlinkMs: 3000, // and blinks during its last this-many ms
  maxBombs: 5,
  bombSize: 3, // a bomb covers a bombSize x bombSize block around its center
  bombShrink: 0.25, // fraction of its length a snake loses off its front to a bomb
  bombGhostMs: 1000, // after a bomb, the snake is a ghost for this long
  minLength: 3, // a bomb or a cut that would leave fewer segments kills
  shieldGhostMs: 1000, // after a shield pops, the snake is a ghost for this long
  portalLifetimeMs: 8000,
  portalFadeMs: 2000, // /display fades a portal during its last this-many ms
  magnetRadius: 3, // cells (Manhattan): fruit this close flies into the mouth
  feastApples: 10,
});
