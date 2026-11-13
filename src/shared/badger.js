// The honey badger: a rare predator. Plain data shared by the engine and
// /display. How often one turns up and how long it stays are the
// badgerEverySec and badgerLifetimeSec settings (src/engine.js).

export const BADGER_RULES = Object.freeze({
  twemoji: '1f9a1', // 🦡, faces left
  warningTwemoji: '26a0', // ⚠️, in the middle of the spawn warning
  width: 5, // its block, in cells (never rotates)
  height: 3,
  warningMs: 2000, // the warning before it becomes active; it does nothing meanwhile
  moveEveryTicks: 4, // a quarter of a snake's speed
  // A fresh random direction (which may be the same one again) after this
  // many ticks (both included), or at once when the way ahead is blocked.
  turnMinTicks: 20,
  turnMaxTicks: 40,
  headClearance: 3, // a new badger's block is at least this many steps from every snake head
  blinkMs: 3000, // /display blinks it during its last 3 s, like a bomb
  // A snake holding scissors whose head enters its block takes 1 HP off it
  // (it has badgerHealth HP) instead of being bitten: the scissors are used
  // up and the snake is a ghost for this long, passing through.
  hitGhostMs: 1000,
  hitFlashMs: 180, // /display flashes it white on each hit
});
