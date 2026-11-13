// Snake Battle game engine.
//
// Pure game logic: no networking, rendering, input devices, DOM, or Node
// built-ins. Runs unchanged in Node and in the browser. All input arrives via
// setDirection(id, dir); time advances only via tick().

import { WEIGHTED_POWER_UPS, POWER_UP_TYPES, POWER_UP_RULES, weightKey } from './shared/powerups.js';
import { RAT_RULES } from './shared/rats.js';
import { CHICKEN_RULES } from './shared/chicken.js';
import { BADGER_RULES } from './shared/badger.js';

export const DIRECTIONS = Object.freeze({
  up: Object.freeze({ x: 0, y: -1 }),
  down: Object.freeze({ x: 0, y: 1 }),
  left: Object.freeze({ x: -1, y: 0 }),
  right: Object.freeze({ x: 1, y: 0 }),
});

const OPPOSITE = Object.freeze({ up: 'down', down: 'up', left: 'right', right: 'left' });

export const START_LENGTH = 3;
const SPAWN_CLEARANCE = 3; // free cells required ahead of a freshly spawned head
// Preferred minimum Manhattan distance between a new head and any other snake
// cell; relaxed one step at a time when the board is too crowded.
export const SPAWN_DISTANCE = 5;
export const INPUT_BUFFER_SIZE = 3; // queued turns per snake; one is applied per tick

export const PHASES = Object.freeze({
  WAITING: 'waiting', // no round running, waiting for players
  COUNTDOWN: 'countdown', // snakes spawned but frozen, round about to start
  PLAYING: 'playing',
  INTERMISSION: 'intermission',
});

export const CONFIG_LIMITS = Object.freeze({
  tickMs: { min: 50, max: 300, default: 200 },
  appleCount: { min: 0, max: 30, default: 3 },
  growthPerApple: { min: 1, max: 10, default: 1 },
  // % of new apples that are a rat instead (0 = no rats). Read live, and
  // independent of the powerUps toggle.
  ratChance: { min: 0, max: 100, default: 3 },
  // % of new apples that are a chicken instead (0 = no chickens), rolled
  // when the rat roll fails. Read live, independent of powerUps.
  chickenChance: { min: 0, max: 100, default: 2 },
  maxPlayers: { min: 1, max: 24, default: 24 },
  gridSize: { min: 10, max: 80, default: 30 },
  intermissionMs: { min: 0, max: 30000, default: 4000 },
  countdownMs: { min: 0, max: 10000, default: 0 }, // 0 = no pre-round countdown
  // Every snake spawns with a normal shield lasting this long (0 = none). Its
  // timer only runs while playing, so it starts after the countdown.
  spawnShieldSec: { min: 0, max: 10, default: 3 },
  // The honey badger (read live): on average one every badgerEverySec
  // seconds of play (0 = never; anything else is at least `lowest`), staying
  // badgerLifetimeSec once active.
  badgerEverySec: { min: 0, max: 600, default: 120, lowest: 30 },
  badgerLifetimeSec: { min: 5, max: 120, default: 20 },
  roundTimeLimitSec: { min: 15, max: 900, default: 120 }, // used when timeLimitWin is on
  targetLength: { min: START_LENGTH + 1, max: 300, default: 30 }, // used when targetLengthWin is on
  // Power-ups (used when powerUps is on; read live). Integers only, since
  // every number setting is rounded.
  powerUpChance: { min: 0, max: 100, default: 25 }, // % of new apples that are a power-up instead
  bombsPerMinute: { min: 0, max: 20, default: 4 }, // bombs spawn on their own, on top of appleCount
  // weightGolden, weightGhost, ...: relative odds of each power-up (0 = never).
  ...Object.fromEntries(WEIGHTED_POWER_UPS.map((p) => [weightKey(p.type), { min: 0, max: 10, default: p.defaultWeight }])),
});

// Settings with a fixed set of string values (first = default).
export const CONFIG_CHOICES = Object.freeze({
  // Who wins when the time limit runs out: the longest living snake, or the
  // living snake with the most kills this round (ties broken by length).
  timeLimitWinner: Object.freeze(['longest', 'kills']),
  // What a bomb does to a snake that sets it off: blow off the front half
  // ('cut'), or kill it outright ('kill'). Read live.
  bombMode: Object.freeze(['cut', 'kill']),
});

// On/off rules. Like gridSize, they are read when a round starts, so a change
// applies from the next round.
export const CONFIG_TOGGLES = Object.freeze({
  corpseApples: false, // a dead snake's segments turn into apples
  wrapWalls: false, // leaving one edge enters from the opposite one
  // Extra win conditions on top of "last snake alive" (which always applies);
  // whichever triggers first ends the round.
  timeLimitWin: false, // the round ends after roundTimeLimitSec
  targetLengthWin: false, // the first snake to reach targetLength wins
  powerUps: false, // power-ups spawn in place of some apples, plus bombs
});

export function createDefaultConfig() {
  const config = { ...CONFIG_TOGGLES };
  for (const [key, values] of Object.entries(CONFIG_CHOICES)) config[key] = values[0];
  for (const [key, limit] of Object.entries(CONFIG_LIMITS)) config[key] = limit.default;
  return config;
}

// Returns only the recognised, valid keys of `partial`: numbers rounded and
// clamped, toggles accepted only as real booleans, choices only as one of
// their listed values. Everything else is dropped.
export function sanitizeConfig(partial) {
  const out = {};
  if (partial === null || typeof partial !== 'object') return out;
  for (const [key, limit] of Object.entries(CONFIG_LIMITS)) {
    if (!Object.hasOwn(partial, key)) continue;
    const value = partial[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const v = Math.min(limit.max, Math.max(limit.min, Math.round(value)));
    // 0 means off; any other value is at least `lowest`.
    out[key] = limit.lowest && v > 0 && v < limit.lowest ? limit.lowest : v;
  }
  for (const key of Object.keys(CONFIG_TOGGLES)) {
    if (Object.hasOwn(partial, key) && typeof partial[key] === 'boolean') out[key] = partial[key];
  }
  for (const [key, values] of Object.entries(CONFIG_CHOICES)) {
    if (Object.hasOwn(partial, key) && values.includes(partial[key])) out[key] = partial[key];
  }
  return out;
}

/**
 * @param {object} [options]
 * @param {object} [options.config] Shared mutable config object. Missing keys
 *   are filled with defaults. The engine reads it every tick.
 * @param {() => number} [options.random] RNG returning [0, 1). Defaults to Math.random.
 */
export function createEngine({ config, random = Math.random } = {}) {
  const cfg = config ?? {};
  Object.assign(cfg, { ...createDefaultConfig(), ...sanitizeConfig(cfg) });

  // id -> { id, name, colorIndex, status: 'queued' | 'alive' | 'dead', snake, kills }
  // Map preserves join order, which keeps spawning deterministic.
  const players = new Map();

  let phase = PHASES.WAITING;
  let round = 0;
  let tickCount = 0;
  let gridSize = cfg.gridSize; // locked for the duration of a round
  let rules = lockRules(); // locked per round too
  let win = lockWin(); // the numbers behind rules.timeLimitWin / targetLengthWin
  let playingElapsed = 0; // ms of PLAYING ticks this round, for the time limit
  let endReason = null; // why the last round ended: 'lastAlive' | 'time' | 'target'
  // Board items. Apples, power-ups ({ x, y, type }) and creatures (rats and
  // chickens: { x, y, type: 'rat' | 'chicken', id, dir, ... }, see
  // moveCreatures) share one list in spawn order.
  // Regular ones count toward cfg.appleCount; extras (corpse: dead or cut
  // snakes, feast: the feast power-up) come on top of it.
  let apples = [];
  let bombs = []; // { x, y, remainingMs, since }: (x, y) is the center of a 3x3 block; on top of appleCount, despawn
  let projectiles = []; // { id, x, y, dir, ownerId }
  let portals = []; // { id, ends: [{x,y}, {x,y}], remainingMs, since }: two-way, both ends alike
  let nextObjectId = 1; // ids for projectiles, portals, creatures and badgers (for /display)
  // The honey badger, at most one: { id, x, y, dir, warningMs, remainingMs,
  // lifetimeMs, moveAt, turnAt, since }, (x, y) the center of its block.
  let badger = null;
  let badgerWaitMs = 0; // ms of play since the last badger (or the round start)
  // The next one is due after badgerDueFactor x the average (0.5 to 1.5),
  // drawn once half the average has passed; kept as a factor so a slider
  // change applies at once.
  let badgerDueFactor = null;
  let winnerId = null;
  let participants = 0; // snakes spawned at round start
  let intermissionElapsed = 0;
  let countdownElapsed = 0;
  // What happened during the latest tick, for renderers (effects, sounds...):
  // { type: 'eat', id, x, y } | { type: 'death', id } | { type: 'headOn', ids }.
  // Rebuilt every tick; read-only output, never input.
  let events = [];

  // Only on/off values: /admin lists the truthy ones as "active this round".
  function lockRules() {
    return Object.fromEntries(Object.keys(CONFIG_TOGGLES).map((k) => [k, cfg[k]]));
  }
  function lockWin() {
    return { timeLimitSec: cfg.roundTimeLimitSec, timeLimitWinner: cfg.timeLimitWinner, targetLength: cfg.targetLength };
  }

  const cellKey = (x, y) => y * gridSize + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < gridSize && y < gridSize;
  const randInt = (n) => Math.floor(random() * n);

  function aliveSnakes() {
    const list = [];
    for (const p of players.values()) if (p.status === 'alive') list.push(p.snake);
    return list;
  }

  const isExtra = (a) => Boolean(a.corpse || a.feast);
  // The items that run around: rats and chickens.
  const isCreature = (a) => a.type === 'rat' || a.type === 'chicken';

  // Bombs cover a block of cells around their center, always on the board.
  const BOMB_REACH = (POWER_UP_RULES.bombSize - 1) / 2;
  const bombCovers = (b, x, y) => Math.abs(x - b.x) <= BOMB_REACH && Math.abs(y - b.y) <= BOMB_REACH;
  function bombCells(b) {
    const out = [];
    for (let dy = -BOMB_REACH; dy <= BOMB_REACH; dy++) {
      for (let dx = -BOMB_REACH; dx <= BOMB_REACH; dx++) out.push({ x: b.x + dx, y: b.y + dy });
    }
    return out;
  }

  // Cells no new item may go to: snakes, items, bombs and both ends of portals.
  function occupiedCells() {
    const set = new Set();
    for (const s of aliveSnakes()) for (const c of s.segments) set.add(cellKey(c.x, c.y));
    for (const a of apples) set.add(cellKey(a.x, a.y));
    for (const b of bombs) for (const c of bombCells(b)) set.add(cellKey(c.x, c.y));
    for (const p of portals) for (const c of p.ends) set.add(cellKey(c.x, c.y));
    return set;
  }

  // Clears everything a round leaves on the board.
  function clearBoard() {
    apples = [];
    bombs = [];
    projectiles = [];
    portals = [];
    badger = null;
    badgerWaitMs = 0;
    badgerDueFactor = null;
  }

  function snakeCells() {
    const list = [];
    for (const s of aliveSnakes()) s.segments.forEach((c, i) => list.push({ x: c.x, y: c.y, head: i === 0 }));
    return list;
  }

  // ---- spawning -----------------------------------------------------------

  // Directions from (x, y) towards the center, along the axis the cell is
  // furthest off-center on: away from the nearest edge, so a new snake always
  // has at least half the board ahead of it. Ties give several options.
  function inwardDirs(x, y) {
    const mid = (gridSize - 1) / 2;
    const dx = mid - x;
    const dy = mid - y;
    const out = [];
    if (Math.abs(dx) >= Math.abs(dy) && dx !== 0) out.push(dx > 0 ? 'right' : 'left');
    if (Math.abs(dy) >= Math.abs(dx) && dy !== 0) out.push(dy > 0 ? 'down' : 'up');
    return out.length ? out : Object.keys(DIRECTIONS); // the exact center
  }

  // Manhattan distance, the short way round when walls wrap.
  function distance(a, b) {
    let dx = Math.abs(a.x - b.x);
    let dy = Math.abs(a.y - b.y);
    if (rules.wrapWalls) {
      dx = Math.min(dx, gridSize - dx);
      dy = Math.min(dy, gridSize - dy);
    }
    return dx + dy;
  }

  // The body a snake with its head at (hx, hy) facing `dir` would have, or null
  // if it or the `clearance` cells ahead of the head leave the board or hit an
  // occupied cell.
  function placement(hx, hy, dir, occupied, clearance) {
    const d = DIRECTIONS[dir];
    const segments = [];
    for (let i = -clearance; i < START_LENGTH; i++) {
      // i < 0: cells ahead of the head (must be free); i >= 0: body cells.
      const x = hx - d.x * i;
      const y = hy - d.y * i;
      if (!inBounds(x, y) || occupied.has(cellKey(x, y))) return null;
      if (i >= 0) segments.push({ x, y });
    }
    return segments;
  }

  // A random valid spawn, or null if there is none. `others` holds the other
  // snakes' cells ({ x, y, head }). The new head must be at least
  // `minDistance` from all of them, and the new body that far from their
  // heads, so the rule holds for the snakes already on the board too.
  // inward: face towards the center (see inwardDirs); otherwise any direction.
  function trySpawn(occupied, others, { clearance, minDistance = 0, inward = true }) {
    const heads = others.filter((c) => c.head);
    const far = (cell, list) => list.every((c) => distance(c, cell) >= minDistance);
    const dirsAt = (hx, hy) => (inward ? inwardDirs(hx, hy) : Object.keys(DIRECTIONS));
    const tryAt = (hx, hy, dir) => {
      if (minDistance > 0 && !far({ x: hx, y: hy }, others)) return null;
      const segments = placement(hx, hy, dir, occupied, clearance);
      return segments && (minDistance === 0 || segments.every((c) => far(c, heads))) ? { segments, dir } : null;
    };
    // Random picks first (fast on a roomy board)...
    for (let attempt = 0; attempt < 100; attempt++) {
      const hx = randInt(gridSize);
      const hy = randInt(gridSize);
      const dirs = dirsAt(hx, hy);
      const found = tryAt(hx, hy, dirs[randInt(dirs.length)]);
      if (found) return found;
    }
    // ...then every cell, so a crowded board relaxes only when it must.
    const options = [];
    for (let hy = 0; hy < gridSize; hy++) {
      for (let hx = 0; hx < gridSize; hx++) {
        for (const dir of dirsAt(hx, hy)) {
          const found = tryAt(hx, hy, dir);
          if (found) options.push(found);
        }
      }
    }
    return options.length ? options[randInt(options.length)] : null;
  }

  // Preferred: SPAWN_DISTANCE from every other snake, with SPAWN_CLEARANCE
  // free cells ahead. On a crowded board the distance is relaxed one cell at a
  // time, then the clearance, then the direction (any free spot, any way).
  function spawnSnake(occupied, others) {
    let placed = null;
    for (let minDistance = SPAWN_DISTANCE; !placed && minDistance >= 0; minDistance--) {
      placed = trySpawn(occupied, others, { clearance: SPAWN_CLEARANCE, minDistance });
    }
    placed ??= trySpawn(occupied, others, { clearance: 0 }) ?? trySpawn(occupied, others, { clearance: 0, inward: false });
    if (!placed) return null;
    placed.segments.forEach((c, i) => {
      occupied.add(cellKey(c.x, c.y));
      others.push({ x: c.x, y: c.y, head: i === 0 });
    });
    return { segments: placed.segments, dir: placed.dir, dirQueue: [], pendingGrowth: 0, effect: null };
  }

  function spawnApple(occupied) {
    for (let attempt = 0; attempt < 100; attempt++) {
      const x = randInt(gridSize);
      const y = randInt(gridSize);
      if (!occupied.has(cellKey(x, y))) return { x, y };
    }
    const free = [];
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) if (!occupied.has(cellKey(x, y))) free.push({ x, y });
    }
    return free.length ? free[randInt(free.length)] : null;
  }

  // Keeps the apple count in line with cfg.appleCount (applies live).
  // Power-ups and creatures take an apple's place and count toward it. Extra apples count
  // towards the total too, so no new apple spawns while the board already
  // holds appleCount or more. Lowering appleCount trims the newest regular
  // items (apples or power-ups) down to it; extras are never removed.
  function syncApples() {
    let excess = apples.filter((a) => !isExtra(a)).length - cfg.appleCount;
    for (let i = apples.length - 1; i >= 0 && excess > 0; i--) {
      if (!isExtra(apples[i])) {
        apples.splice(i, 1);
        excess--;
      }
    }
    if (apples.length >= cfg.appleCount) return;
    const occupied = occupiedCells();
    while (apples.length < cfg.appleCount) {
      const apple = spawnApple(occupied);
      if (!apple) break;
      // A creature that would start under the badger stays a plain apple.
      const creature = rollCreature();
      if (creature) apples.push(badgerCovers(apple.x, apple.y, true) ? apple : newCreature(apple, creature));
      else {
        const type = rollPowerUp();
        apples.push(type ? { ...apple, type } : apple);
      }
      occupied.add(cellKey(apple.x, apple.y));
    }
  }

  // Whether a spawning apple becomes a rat or a chicken (null: neither). The
  // rat is rolled first, then the chicken, both before the power-up; at 0%
  // a roll draws no random number, so games without them play out as before.
  function rollCreature() {
    if (cfg.ratChance > 0 && random() * 100 < cfg.ratChance) return 'rat';
    if (cfg.chickenChance > 0 && random() * 100 < cfg.chickenChance) return 'chicken';
    return null;
  }

  const ratTurnIn = () => RAT_RULES.turnMinTicks + randInt(RAT_RULES.turnMaxTicks - RAT_RULES.turnMinTicks + 1);

  // A rat or a chicken on (x, y), facing a random way. It first moves
  // moveEveryTicks after it appears (a chicken sooner if a head is near).
  function newCreature({ x, y }, type, dir = Object.keys(DIRECTIONS)[randInt(4)]) {
    return {
      x,
      y,
      type,
      id: nextObjectId++,
      dir,
      from: null, // the cell it last moved off, so it doesn't turn straight back
      left: null, // the cell it left during the current sub-step, if any
      moveAt: tickCount + RAT_RULES.moveEveryTicks,
      stepTicks: RAT_RULES.moveEveryTicks, // the interval set at its last move (for /display's slide)
      turnAt: tickCount + ratTurnIn(),
      ...(type === 'chicken' ? { calmMs: 0 } : {}), // alerted while > 0 (ms left until it calms down)
    };
  }

  // Whether a spawning apple becomes a power-up, and which one: null, or a
  // type picked by weight. With power-ups off it draws no random numbers,
  // so games without them play out exactly as before.
  function rollPowerUp() {
    if (!rules.powerUps || random() * 100 >= cfg.powerUpChance) return null;
    const weights = WEIGHTED_POWER_UPS.map((p) => cfg[weightKey(p.type)]);
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) return null;
    let r = random() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0 && weights[i] > 0) return WEIGHTED_POWER_UPS[i].type;
    }
    return null;
  }

  // Bombs: each tick one may spawn, at bombsPerMinute on average, where its
  // whole block is free and on the board, away from the heads where possible
  // (so it never lands right in front of someone).
  function spawnBombs() {
    if (!rules.powerUps || cfg.bombsPerMinute <= 0 || bombs.length >= POWER_UP_RULES.maxBombs) return;
    if (random() >= (cfg.bombsPerMinute * cfg.tickMs) / 60000) return;
    const occupied = occupiedCells();
    const heads = aliveSnakes().map((s) => s.segments[0]);
    // Nor on the badger, which bombs would box in.
    for (const c of badgerCells()) occupied.add(cellKey(c.x, c.y));
    const near = new Set(occupied);
    for (const h of heads) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > 2) continue;
          let x = h.x + dx;
          let y = h.y + dy;
          if (rules.wrapWalls) {
            x = (x + gridSize) % gridSize;
            y = (y + gridSize) % gridSize;
          }
          if (inBounds(x, y)) near.add(cellKey(x, y));
        }
      }
    }
    const cell = spawnBlock(near) ?? spawnBlock(occupied);
    if (cell) bombs.push({ x: cell.x, y: cell.y, remainingMs: POWER_UP_RULES.bombLifetimeMs, since: tickCount });
  }

  // A random center whose whole bomb block is on the board and free, or null.
  function spawnBlock(blocked) {
    const lo = BOMB_REACH;
    const span = gridSize - 2 * BOMB_REACH;
    if (span <= 0) return null;
    const fits = (x, y) => bombCells({ x, y }).every((c) => !blocked.has(cellKey(c.x, c.y)));
    for (let attempt = 0; attempt < 100; attempt++) {
      const x = lo + randInt(span);
      const y = lo + randInt(span);
      if (fits(x, y)) return { x, y };
    }
    const options = [];
    for (let y = lo; y < lo + span; y++) for (let x = lo; x < lo + span; x++) if (fits(x, y)) options.push({ x, y });
    return options.length ? options[randInt(options.length)] : null;
  }

  // ---- round lifecycle ----------------------------------------------------

  function startRound() {
    round++;
    gridSize = cfg.gridSize;
    rules = lockRules();
    win = lockWin();
    clearBoard();
    winnerId = null;
    endReason = null;
    intermissionElapsed = 0;
    playingElapsed = 0;
    participants = 0;
    const occupied = new Set();
    const others = []; // cells of the snakes spawned so far
    for (const p of players.values()) {
      p.kills = 0;
      if (!spawnInto(p, occupied, others)) {
        p.snake = null;
        p.status = 'queued'; // grid too crowded, try again next round
      }
    }
    countdownElapsed = 0;
    phase = cfg.countdownMs > 0 ? PHASES.COUNTDOWN : PHASES.PLAYING;
    syncApples();
  }

  // Puts a new snake for `p` on the board, with spawn protection. Every spawn
  // (round start, joining during the countdown, any future mid-round
  // respawn) goes through here. Effect timers only count down on playing
  // ticks, so a shield given during the countdown starts when play does.
  function spawnInto(p, occupied, others) {
    const snake = spawnSnake(occupied, others);
    if (!snake) return false;
    p.snake = snake;
    p.status = 'alive';
    participants++;
    if (cfg.spawnShieldSec > 0) setEffect(p, 'shield', cfg.spawnShieldSec * 1000);
    return true;
  }

  function endRound(winner, reason) {
    winnerId = winner;
    endReason = reason;
    phase = PHASES.INTERMISSION;
    intermissionElapsed = 0;
  }

  // The single best of `candidates` by `score` (higher first, then length),
  // or null on a full tie.
  function best(candidates, score) {
    const ranked = candidates
      .map((p) => ({ p, score: score(p), length: p.snake.segments.length }))
      .sort((a, b) => b.score - a.score || b.length - a.length);
    if (!ranked.length) return null;
    const [first, second] = ranked;
    if (second && second.score === first.score && second.length === first.length) return null;
    return first.p;
  }

  // Same-tick precedence: last snake alive, then target length, then time.
  function checkRoundEnd() {
    const alivePlayers = [...players.values()].filter((p) => p.status === 'alive');
    const solo = participants < 2;
    if (!solo && alivePlayers.length <= 1) return endRound(alivePlayers[0]?.id ?? null, 'lastAlive');
    // Solo round: ends when the snake dies, or as soon as someone is waiting
    // to join, so a lone player can't block the queue indefinitely.
    if (solo && (alivePlayers.length === 0 || [...players.values()].some((p) => p.status === 'queued'))) {
      return endRound(null, 'lastAlive');
    }
    // Extra win conditions. A solo round can end through them too, but never
    // with a winner (no free wins for playing alone).
    if (rules.targetLengthWin) {
      const reached = alivePlayers.filter((p) => p.snake.segments.length >= win.targetLength);
      if (reached.length) return endRound(solo ? null : (best(reached, () => 0)?.id ?? null), 'target');
    }
    if (rules.timeLimitWin && playingElapsed >= win.timeLimitSec * 1000) {
      const score = win.timeLimitWinner === 'kills' ? (p) => p.kills : () => 0;
      return endRound(solo ? null : (best(alivePlayers, score)?.id ?? null), 'time');
    }
  }

  // ---- movement & collisions ----------------------------------------------
  //
  // A tick is two sub-steps of one cell each. In the first every snake moves
  // (a frozen one only every second tick); in the second only golden snakes
  // do. Projectiles move in both. Checking one cell at a time means nothing
  // fast can jump over a cell. Who moves in each sub-step is decided when the
  // tick starts, so an effect picked up mid-tick applies from the next one.

  const effectOf = (p, type) => p.snake?.effect?.type === type;
  const isGhost = (p) => effectOf(p, 'ghost');
  const PERPENDICULAR = Object.freeze({ up: ['left', 'right'], down: ['left', 'right'], left: ['up', 'down'], right: ['up', 'down'] });

  // Frozen: some other living snake has the freeze effect.
  function isFrozen(p) {
    if (p.status !== 'alive') return false;
    for (const o of players.values()) if (o !== p && o.status === 'alive' && effectOf(o, 'freeze')) return true;
    return false;
  }

  // Freeze slows the creatures too: while any living snake has it, rats,
  // chickens and the badger move half as often (their move interval doubles).
  function creaturesFrozen() {
    for (const p of players.values()) if (p.status === 'alive' && effectOf(p, 'freeze')) return true;
    return false;
  }
  const creatureInterval = (ticks) => ticks * (creaturesFrozen() ? 2 : 1);

  function setEffect(p, type, durationMs) {
    p.snake.effect = { type, remainingMs: durationMs, durationMs, since: tickCount };
  }

  function step() {
    const alive = [...players.values()].filter((p) => p.status === 'alive');
    // A frozen snake sits out every odd tick, golden or not.
    const first = alive.filter((p) => !(tickCount % 2 === 1 && isFrozen(p)));
    const second = first.filter((p) => effectOf(p, 'golden'));
    substep(first, true);
    substep(second.filter((p) => p.status === 'alive'), false);
    magnetEat();
    countDown();
    badgerTimers();
    spawnBombs();
  }

  // Timers run on game time (tickMs per playing tick), so a speed change
  // mid-effect keeps its length in milliseconds. Everything starts counting
  // the tick after it appeared.
  function countDown() {
    for (const p of players.values()) {
      const e = p.snake?.effect;
      if (!e || e.since === tickCount) continue;
      e.remainingMs -= cfg.tickMs;
      if (e.remainingMs <= 0) p.snake.effect = null;
    }
    const tick = (list) =>
      list.filter((o) => {
        if (o.since !== tickCount) o.remainingMs -= cfg.tickMs;
        return o.remainingMs > 0;
      });
    const before = bombs;
    bombs = tick(bombs);
    // Where each one ran out (its block's center), for /display's fizzle.
    for (const b of before) if (!bombs.includes(b)) events.push({ type: 'bombExpired', x: b.x, y: b.y });
    portals = tick(portals);
  }

  // The cell one step from `from` in `dir`: wrapped when walls wrap, possibly
  // off the board otherwise. A head stepping onto either end of a portal
  // comes out of the other end instead (projectiles don't use portals).
  function nextCell(from, dir) {
    const d = DIRECTIONS[dir];
    let x = from.x + d.x;
    let y = from.y + d.y;
    if (rules.wrapWalls) {
      x = (x + gridSize) % gridSize;
      y = (y + gridSize) % gridSize;
    }
    return { x, y };
  }
  function throughPortal(cell) {
    for (const portal of portals) {
      const i = portal.ends.findIndex((c) => c.x === cell.x && c.y === cell.y);
      if (i !== -1) return { cell: { ...portal.ends[1 - i] }, portal };
    }
    return { cell, portal: null };
  }

  // cell -> [{ p, index }]: every segment that is still there after this
  // sub-step's moves (a moving snake's tail is left out unless it grows).
  // Ghosts are left out: nothing collides with them.
  function occupancy(moving) {
    const map = new Map();
    for (const p of players.values()) {
      if (p.status !== 'alive' || isGhost(p)) continue;
      const segs = p.snake.segments;
      const m = moving.get(p);
      const keep = m && !m.grows ? segs.length - 1 : segs.length;
      for (let i = 0; i < keep; i++) {
        const k = cellKey(segs[i].x, segs[i].y);
        let list = map.get(k);
        if (!list) map.set(k, (list = []));
        list.push({ p, index: i });
      }
    }
    return map;
  }

  // Snakes killed during the current sub-step, for their corpse apples.
  let fallen = [];

  // Marks a player dead. The kill counts only if the killer is still in the
  // game (it may have left mid-round), and never for yourself.
  function kill(p, by) {
    p.status = 'dead';
    p.snake.effect = null;
    fallen.push(p.snake);
    const credited = by && by !== p && players.get(by.id) === by ? by : null;
    if (credited) credited.kills++;
    events.push({ type: 'death', id: p.id, killerId: credited ? credited.id : null });
  }

  // A shield takes the hit: it pops and the snake is a ghost for a moment,
  // so it can slide clear of whatever it hit.
  function popShield(p) {
    setEffect(p, 'ghost', POWER_UP_RULES.shieldGhostMs);
    events.push({ type: 'shieldPop', id: p.id });
  }

  // A projectile hit outside a snake's own move (it was standing still, or
  // a gun went off right next to it).
  function shot(p, shooterId) {
    if (p.status !== 'alive') return;
    if (effectOf(p, 'shield')) return popShield(p);
    kill(p, players.get(shooterId) ?? null);
  }

  // Segments taken off a snake that stays alive (scissors, and any future
  // power-up that removes segments) become apples when dead snakes do, and
  // simply vanish otherwise.
  function removeSegments(cells) {
    if (!rules.corpseApples) return;
    const blocked = occupiedCells();
    for (const c of cells) {
      const k = cellKey(c.x, c.y);
      if (!inBounds(c.x, c.y) || blocked.has(k)) continue;
      blocked.add(k);
      apples.push({ x: c.x, y: c.y, corpse: true });
    }
  }

  // ---- power-up effects ----
  // What each power-up does when eaten. Timed ones only need to become the
  // snake's effect: the movement and collision code asks "is X active".
  const EFFECTS = {
    // 'cut' mode: blows off the front of the snake; it carries on from what's
    // left, as a ghost for a moment so it can't crash straight away. The
    // lost part vanishes (no apples to eat it back). Too little left: it
    // dies. 'kill' mode: it just dies. Nobody gets the kill either way, and
    // a shield pops instead.
    bomb(p) {
      if (effectOf(p, 'shield')) return popShield(p);
      if (cfg.bombMode === 'kill') return kill(p, null);
      const s = p.snake;
      const drop = Math.max(1, Math.round(s.segments.length * POWER_UP_RULES.bombShrink));
      if (s.segments.length - drop < POWER_UP_RULES.minLength) return kill(p, null);
      s.segments.splice(0, drop);
      s.dir = travelDir(s.segments[1], s.segments[0]) ?? s.dir;
      s.dirQueue = [];
      s.pendingGrowth = 0;
      setEffect(p, 'ghost', POWER_UP_RULES.bombGhostMs);
    },
    gun(p) {
      const s = p.snake;
      const head = s.segments[0];
      const d = DIRECTIONS[s.dir];
      const x = head.x + d.x;
      const y = head.y + d.y;
      events.push({ type: 'shot', id: p.id, x: head.x, y: head.y, dir: s.dir });
      if (!inBounds(x, y)) return events.push({ type: 'projectileEnd', x: head.x, y: head.y }); // fired into a wall
      const targets = solidAt(x, y);
      if (targets.length) {
        events.push({ type: 'projectileEnd', x, y, hit: true });
        for (const t of targets) shot(t, p.id);
        return;
      }
      if (badgerCovers(x, y)) {
        events.push({ type: 'projectileEnd', x, y, hit: true });
        return killBadger(p);
      }
      const creature = creatureHitBy(x, y);
      if (creature !== -1) {
        events.push({ type: 'projectileEnd', x, y, hit: true });
        return creatureDies(creature, 'shot');
      }
      const other = projectiles.findIndex((o) => o.x === x && o.y === y);
      if (other !== -1) {
        projectiles.splice(other, 1);
        return events.push({ type: 'projectileEnd', x, y });
      }
      projectiles.push({ id: nextObjectId++, x, y, dir: s.dir, ownerId: p.id });
    },
    // One end where it was eaten, the other somewhere safe with room ahead.
    // The head goes through at once, keeping its direction; the body
    // follows as the snake moves on.
    portal(p) {
      const s = p.snake;
      const other = findSafeCell(s.dir);
      if (!other) return;
      const head = s.segments[0];
      const portal = {
        id: nextObjectId++,
        ends: [{ x: head.x, y: head.y }, other],
        remainingMs: POWER_UP_RULES.portalLifetimeMs,
        since: tickCount,
      };
      portals.push(portal);
      s.segments[0] = { ...other };
      events.push({ type: 'teleport', id: p.id, portalId: portal.id });
    },
    feast(p) {
      spawnFeast(p.snake.segments[0]);
    },
  };
  for (const p of Object.values(POWER_UP_TYPES)) {
    if (p.durationMs) EFFECTS[p.type] = (player) => setEffect(player, p.type, p.durationMs);
  }

  // The direction of one step from `from` to `to` (across an edge when walls
  // wrap), or null if they aren't neighbours (e.g. a portal jump).
  function travelDir(from, to) {
    for (const dir of Object.keys(DIRECTIONS)) {
      const n = nextCell(from, dir);
      if (n.x === to.x && n.y === to.y) return dir;
    }
    return null;
  }

  function pickUp(player, type) {
    events.push({ type: 'pickup', id: player.id, item: type });
    EFFECTS[type]?.(player);
  }

  // Living, non-ghost players with a segment on (x, y).
  function solidAt(x, y) {
    const out = [];
    for (const p of players.values()) {
      if (p.status !== 'alive' || isGhost(p)) continue;
      if (p.snake.segments.some((c) => c.x === x && c.y === y)) out.push(p);
    }
    return out;
  }

  // Distance (in steps, the short way round when walls wrap) from the
  // nearest snake cell, for every cell: a breadth-first search from all of
  // them at once.
  function distanceFromSnakes() {
    const dist = new Array(gridSize * gridSize).fill(Infinity);
    let frontier = [];
    for (const s of aliveSnakes()) {
      for (const c of s.segments) {
        if (!inBounds(c.x, c.y) || dist[cellKey(c.x, c.y)] === 0) continue;
        dist[cellKey(c.x, c.y)] = 0;
        frontier.push(c);
      }
    }
    for (let d = 1; frontier.length; d++) {
      const next = [];
      for (const c of frontier) {
        for (const dir of Object.keys(DIRECTIONS)) {
          const n = nextCell(c, dir);
          if (!inBounds(n.x, n.y) || dist[cellKey(n.x, n.y)] !== Infinity) continue;
          dist[cellKey(n.x, n.y)] = d;
          next.push(n);
        }
      }
      frontier = next;
    }
    return dist;
  }

  // A free cell for a portal exit, by the same rules as spawning: with
  // SPAWN_CLEARANCE free cells ahead in `dir`, and as far as SPAWN_DISTANCE
  // from every snake. On a crowded board the distance is relaxed one step at
  // a time, then the room ahead, down to any free cell. null when the board
  // is full.
  function findSafeCell(dir) {
    const occupied = occupiedCells();
    for (const c of badgerCells()) occupied.add(cellKey(c.x, c.y)); // never into the badger

    const dist = distanceFromSnakes();
    const free = [];
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) if (!occupied.has(cellKey(x, y))) free.push({ x, y });
    }
    // Free cells straight ahead of c, up to `max`.
    const room = (c, max) => {
      let n = 0;
      for (let at = c; n < max; n++) {
        at = nextCell(at, dir);
        if (!inBounds(at.x, at.y) || occupied.has(cellKey(at.x, at.y))) break;
      }
      return n;
    };
    const ahead = new Map(free.map((c) => [c, room(c, SPAWN_CLEARANCE)]));
    for (let clearance = SPAWN_CLEARANCE; clearance >= 0; clearance--) {
      for (let d = SPAWN_DISTANCE; d >= 0; d--) {
        const ok = free.filter((c) => ahead.get(c) >= clearance && dist[cellKey(c.x, c.y)] >= d);
        if (ok.length) return ok[randInt(ok.length)];
      }
    }
    return null;
  }

  // The feast: feastApples extra apples on the free cells nearest `from`.
  function spawnFeast(from) {
    for (const c of nearestFreeCells(from, POWER_UP_RULES.feastApples)) apples.push({ x: c.x, y: c.y, feast: true });
  }

  // Up to `count` free cells closest to `from`, ties in random order.
  function nearestFreeCells(from, count) {
    const occupied = occupiedCells();
    const free = [];
    for (let y = 0; y < gridSize; y++) {
      for (let x = 0; x < gridSize; x++) {
        if (!occupied.has(cellKey(x, y))) free.push({ x, y, d: distance(from, { x, y }), r: random() });
      }
    }
    free.sort((a, b) => a.d - b.d || a.r - b.r);
    return free.slice(0, count);
  }

  // Magnet: after the moves, every plain fruit (a regular or extra apple)
  // within magnetRadius of a magnet head flies straight to it. Power-ups,
  // rats and bombs are never pulled. A pulled apple is eaten exactly like
  // an apple the head ran into: growth, an 'eat' event (with magnet: true
  // and where the apple was, for /display's flight), and a replacement
  // spawns as usual. Nothing on the way stops it.
  // An apple in reach of two magnets goes to the nearer head (the first
  // player on a tie).
  function magnetEat() {
    const magnets = [...players.values()].filter((p) => p.status === 'alive' && effectOf(p, 'magnet'));
    if (!magnets.length) return;
    apples = apples.filter((a) => {
      if (a.type) return true;
      let best = null;
      let bestD = Infinity;
      for (const p of magnets) {
        const d = distance(a, p.snake.segments[0]);
        if (d <= POWER_UP_RULES.magnetRadius && d < bestD) {
          best = p;
          bestD = d;
        }
      }
      if (!best) return true;
      best.snake.pendingGrowth += cfg.growthPerApple;
      events.push({ type: 'eat', id: best.id, x: a.x, y: a.y, magnet: true });
      return false;
    });
  }

  // Whether turning to `dir` now would put the head on a cell of the snake's
  // own body, through portals and wrapping walls. The tail doesn't count when
  // it moves off its cell this move (no growth pending). Only the snake's own
  // body: other snakes and walls are the player's problem.
  function turnsIntoOwnBody(s, dir) {
    const target = nextCell(s.segments[0], dir);
    if (!inBounds(target.x, target.y)) return false;
    const { cell } = throughPortal(target);
    const body = s.segments.slice(1, s.pendingGrowth > 0 ? undefined : -1);
    return body.some((c) => c.x === cell.x && c.y === cell.y);
  }

  // ---- creatures: rats and chickens ----
  // Every moveEveryTicks ticks (twice that while freeze slows creatures) a
  // rat runs one cell on, at the start of the
  // tick's first sub-step (before the snakes, against the board as it is).
  // It picks a fresh random direction when its timer (turnMinTicks to
  // turnMaxTicks) runs out, or at once when the cell ahead is a wall (it
  // wraps when walls do), a snake, a bomb, a portal end, an item or another
  // rat. It never turns back to the cell it just left unless that's the only
  // way out, and it stays put when boxed in. Portals mean nothing to it.
  //
  // A chicken moves the same way, with one difference: a threat within
  // alertRadius grid steps alerts it. Threats are snake heads (any, ghosts
  // too) and every cell of the active badger. Alerted, it moves every
  // alertMoveEveryTicks ticks (from that very tick), and each move it takes,
  // with fleeChance, the free way that ends furthest from the nearest threat
  // (even back where it came from); otherwise it moves like a rat. It calms
  // down once no threat has been that close for calmAfterMs.
  //
  // Eating happens in the snakes' item check: a creature that runs into the
  // cell a head is entering is eaten, and so is one leaving the cell a head
  // is entering (r.left), so it can never slip past a head.
  function moveCreatures() {
    const creatures = apples.filter(isCreature);
    if (!creatures.length) return;
    const blocked = occupiedCells(); // includes every creature, kept current below
    const heads = aliveSnakes().map((s) => s.segments[0]);
    const b = isActive(badger) ? badger : null;
    const nearestThreat = (c) =>
      heads.reduce((min, h) => Math.min(min, distance(c, h)), b ? stepsToBlock(c.x, c.y, b.x, b.y) : Infinity);
    for (const r of creatures) {
      const chicken = r.type === 'chicken';
      if (chicken) {
        if (nearestThreat(r) <= CHICKEN_RULES.alertRadius) {
          if (r.calmMs <= 0) r.moveAt = Math.min(r.moveAt, tickCount); // newly alerted: off at once
          r.calmMs = CHICKEN_RULES.calmAfterMs;
        } else if (r.calmMs > 0) r.calmMs -= cfg.tickMs;
      }
      const alerted = chicken && r.calmMs > 0;
      if (tickCount < r.moveAt) continue;
      const every = alerted ? CHICKEN_RULES.alertMoveEveryTicks : chicken ? CHICKEN_RULES.moveEveryTicks : RAT_RULES.moveEveryTicks;
      r.stepTicks = creatureInterval(every);
      r.moveAt = tickCount + r.stepTicks;
      const options = Object.keys(DIRECTIONS)
        .map((dir) => ({ dir, cell: nextCell(r, dir) }))
        .filter(({ cell }) => inBounds(cell.x, cell.y) && !blocked.has(cellKey(cell.x, cell.y)));
      let pick = null;
      if (alerted && options.length && random() < CHICKEN_RULES.fleeChance) {
        const away = options.map((o) => nearestThreat(o.cell));
        const most = Math.max(...away);
        const best = options.filter((o, i) => away[i] === most);
        pick = best[best.length > 1 ? randInt(best.length) : 0];
      } else if (tickCount < r.turnAt) pick = options.find((o) => o.dir === r.dir);
      if (!pick) {
        r.turnAt = tickCount + ratTurnIn();
        const onward = options.filter(({ cell }) => !(r.from && cell.x === r.from.x && cell.y === r.from.y));
        const pool = onward.length ? onward : options;
        if (!pool.length) continue; // boxed in
        pick = pool[randInt(pool.length)];
      }
      // The cell it leaves stays blocked for the other creatures this sub-step:
      // a head entering it still catches this one.
      r.from = r.left = { x: r.x, y: r.y };
      r.x = pick.cell.x;
      r.y = pick.cell.y;
      r.dir = pick.dir;
      blocked.add(cellKey(r.x, r.y));
    }
  }

  // The item a head entering (x, y) eats: the one on it, or a rat that just
  // ran off it.
  function itemAt(x, y) {
    const i = apples.findIndex((a) => a.x === x && a.y === y);
    return i !== -1 ? i : apples.findIndex((a) => a.left && a.left.x === x && a.left.y === y);
  }

  // A projectile entering (x, y) hits a creature on (x, y), or one that just
  // ran off it (which includes swapping places with the projectile).
  function creatureHitBy(x, y) {
    const on = (c) => c && c.x === x && c.y === y;
    return apples.findIndex((a) => isCreature(a) && (on(a) || on(a.left)));
  }

  // The creature apples[i] died, other than eaten by a snake (cause: 'shot'
  // or 'badger'): nobody grows or scores. A rat is simply gone. A chicken
  // leaves a feast power-up on its cell, in its place in the list, so it
  // still counts toward appleCount.
  function creatureDies(i, cause) {
    const c = apples[i];
    if (c.type === 'chicken') {
      apples[i] = { x: c.x, y: c.y, type: 'feast' };
      events.push({ type: 'chickenDied', chickenId: c.id, x: c.x, y: c.y, cause });
      return;
    }
    apples.splice(i, 1);
    if (cause === 'badger') events.push({ type: 'ratCaught', ratId: c.id, x: c.x, y: c.y });
  }

  // ---- one sub-step ----

  function substep(movers, creaturesMove) {
    fallen = [];
    for (const a of apples) if (isCreature(a)) a.left = null;
    // Which segments are inside the badger before anything moves.
    const inside = badgerSnapshot();
    if (creaturesMove) {
      moveCreatures();
      moveBadger();
      badgerEatsCreatures();
    }
    const moves = movers.map((p) => {
      const s = p.snake;
      if (s.dirQueue.length) {
        // One queued turn per move. A turn that would take the head straight
        // into the snake's own body is dropped and the snake goes straight on
        // instead (a swipe too many shouldn't be suicide); the rest of the
        // queue carries on next move. Going straight into it still counts.
        const turn = s.dirQueue.shift();
        if (turn !== OPPOSITE[s.dir] && (isGhost(p) || !turnsIntoOwnBody(s, turn))) s.dir = turn;
      }
      const head = s.segments[0];
      const target = nextCell(head, s.dir);
      const via = inBounds(target.x, target.y) ? throughPortal(target) : { cell: target, portal: null };
      return {
        player: p,
        snake: s,
        head,
        newHead: via.cell,
        portal: via.portal,
        grows: s.pendingGrowth > 0,
        length: s.segments.length,
        ghost: isGhost(p),
        wall: false,
      };
    });

    // Walls. A shield turns the snake aside instead (to a free side if there
    // is one) and makes it a ghost for a moment.
    for (const m of moves) {
      if (inBounds(m.newHead.x, m.newHead.y)) continue;
      if (!effectOf(m.player, 'shield')) {
        m.wall = true;
        continue;
      }
      const taken = new Set();
      for (const s of aliveSnakes()) for (const c of s.segments) taken.add(cellKey(c.x, c.y));
      const options = PERPENDICULAR[m.snake.dir]
        .map((dir) => ({ dir, cell: nextCell(m.head, dir) }))
        .filter((o) => inBounds(o.cell.x, o.cell.y));
      const pick = options.find((o) => !taken.has(cellKey(o.cell.x, o.cell.y))) ?? options[0];
      if (!pick) {
        m.wall = true;
        continue;
      }
      popShield(m.player);
      m.ghost = true;
      m.snake.dir = pick.dir;
      m.snake.dirQueue = [];
      const via = throughPortal(pick.cell);
      m.newHead = via.cell;
      m.portal = via.portal;
    }

    const moving = new Map(moves.map((m) => [m.player, m]));
    const body = occupancy(moving);
    const solid = moves.filter((m) => !m.ghost && !m.wall); // ghosts pass through heads too

    // Projectiles: one cell, checked against walls, each other (same cell or
    // swapping) and every solid segment after the moves, including new heads
    // and a head that swaps places with them.
    const shooterOf = new Map(); // player hit -> shooter id
    const gone = new Set();
    const ahead = projectiles.map((pr) => {
      const d = DIRECTIONS[pr.dir];
      return { pr, x: pr.x + d.x, y: pr.y + d.y };
    });
    for (const n of ahead) {
      if (!inBounds(n.x, n.y)) {
        gone.add(n.pr); // never wraps, even when walls do
        events.push({ type: 'projectileEnd', x: n.pr.x, y: n.pr.y });
      }
    }
    for (let i = 0; i < ahead.length; i++) {
      for (let j = i + 1; j < ahead.length; j++) {
        const a = ahead[i];
        const b = ahead[j];
        if (gone.has(a.pr) || gone.has(b.pr)) continue;
        const same = a.x === b.x && a.y === b.y;
        const swap = a.x === b.pr.x && a.y === b.pr.y && b.x === a.pr.x && b.y === a.pr.y;
        if (same || swap) {
          gone.add(a.pr);
          gone.add(b.pr);
          events.push({ type: 'projectileEnd', x: same ? a.x : (a.pr.x + b.pr.x) / 2, y: same ? a.y : (a.pr.y + b.pr.y) / 2 });
        }
      }
    }
    for (const n of ahead) {
      if (gone.has(n.pr)) continue;
      const hit = new Set((body.get(cellKey(n.x, n.y)) ?? []).map((h) => h.p));
      for (const m of solid) {
        const into = m.newHead.x === n.x && m.newHead.y === n.y;
        const swap = m.head.x === n.x && m.head.y === n.y && m.newHead.x === n.pr.x && m.newHead.y === n.pr.y;
        if (into || swap) hit.add(m.player);
      }
      if (!hit.size) {
        // The badger: entering its block, or the badger moving onto the
        // projectile, kills it (a kill for the shooter).
        if (badgerCovers(n.x, n.y) || badgerCovers(n.pr.x, n.pr.y)) {
          gone.add(n.pr);
          events.push({ type: 'projectileEnd', x: n.x, y: n.y, hit: true });
          killBadger(players.get(n.pr.ownerId) ?? null);
          continue;
        }
        // A creature in the way simply dies (no kill credit).
        const r = creatureHitBy(n.x, n.y);
        if (r === -1) continue;
        gone.add(n.pr);
        events.push({ type: 'projectileEnd', x: n.x, y: n.y, hit: true });
        creatureDies(r, 'shot');
        continue;
      }
      gone.add(n.pr);
      events.push({ type: 'projectileEnd', x: n.x, y: n.y, hit: true });
      for (const p of hit) if (!shooterOf.has(p)) shooterOf.set(p, n.pr.ownerId);
    }
    for (const n of ahead) {
      if (gone.has(n.pr)) continue;
      n.pr.x = n.x;
      n.pr.y = n.y;
    }
    projectiles = projectiles.filter((pr) => !gone.has(pr));

    // Heads: body hits and head-ons.
    const killer = new Map(); // move -> killing player
    const headOnGroups = [];
    const byCell = new Map();
    for (const m of solid) {
      const { x, y } = m.newHead;
      // Heads passing through each other: treated as head-on, not a body hit.
      const partner = solid.find(
        (o) => o !== m && o.head.x === x && o.head.y === y && o.newHead.x === m.head.x && o.newHead.y === m.head.y,
      );
      if (partner) {
        if (solid.indexOf(m) < solid.indexOf(partner)) headOnGroups.push([m, partner]);
        continue;
      }
      // A hit is a head entering a cell some body covers. A snake that isn't
      // moving this sub-step is all body, its head included.
      m.hits = body.get(cellKey(x, y)) ?? [];
      const other = m.hits.find((h) => h.p !== m.player);
      if (other) killer.set(m, other.p);
      const k = cellKey(x, y);
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k).push(m);
    }
    for (const group of byCell.values()) if (group.length > 1) headOnGroups.push(group);

    // Head-on: the shortest snake survives; if several share the shortest
    // length, all of them lose.
    const lostHeadOn = new Set();
    for (const group of headOnGroups) {
      events.push({ type: 'headOn', ids: group.map((m) => m.player.id) });
      const minLength = Math.min(...group.map((m) => m.length));
      const shortest = group.filter((m) => m.length === minLength);
      for (const m of group) if (m.length !== minLength || shortest.length > 1) lostHeadOn.add(m);
      if (shortest.length === 1) {
        // A body hit found above takes precedence over the head-on.
        for (const m of group) if (m !== shortest[0] && !killer.has(m)) killer.set(m, shortest[0].player);
      }
    }

    // Who dies. A shield takes any one hit. Scissors turn a hit on a body
    // (another snake's or its own, anywhere but a head) into a cut, but
    // don't help with anything else.
    const dead = new Set();
    const cuts = [];
    const postIndex = (h) => (moving.has(h.p) ? h.index + 1 : h.index); // where the cell is after the move
    for (const m of moves) {
      const p = m.player;
      const hits = m.hits ?? [];
      const wasShot = shooterOf.has(p);
      if (!m.wall && !hits.length && !lostHeadOn.has(m) && !wasShot) continue;
      if (m.wall) {
        dead.add(m);
        continue;
      }
      if (effectOf(p, 'shield')) {
        popShield(p);
        continue;
      }
      const cuttable = hits.length && hits.every((h) => postIndex(h) >= 1);
      if (effectOf(p, 'scissors') && cuttable && !lostHeadOn.has(m) && !wasShot) {
        p.snake.effect = null;
        for (const h of hits) cuts.push({ target: h.p, index: postIndex(h), by: p });
        continue;
      }
      dead.add(m);
      if (!killer.has(m) && wasShot) killer.set(m, players.get(shooterOf.get(p)) ?? null);
    }
    // Snakes hit by a projectile while standing still this sub-step.
    for (const [p, shooterId] of shooterOf) if (!moving.has(p)) shot(p, shooterId);

    for (const m of moves) {
      if (dead.has(m)) {
        kill(m.player, killer.get(m) ?? null);
        continue;
      }
      if (m.player.status !== 'alive') continue;
      m.snake.segments.unshift(m.newHead);
      if (m.grows) m.snake.pendingGrowth--;
      else m.snake.segments.pop();
      if (m.portal) events.push({ type: 'teleport', id: m.player.id, portalId: m.portal.id });
    }

    // Cuts, nearest the head first. Fewer than minLength segments left is a
    // kill for the cutter (none when it cut itself); otherwise the cut-off
    // part is removed.
    cuts.sort((a, b) => a.index - b.index);
    for (const { target, index, by } of cuts) {
      if (target.status !== 'alive' || index >= target.snake.segments.length) continue;
      events.push({ type: 'cut', id: target.id, byId: by.id });
      if (index < POWER_UP_RULES.minLength) kill(target, by);
      else removeSegments(target.snake.segments.splice(index));
    }

    // The badger bites before anything is eaten, so a head can't eat its
    // way out of it (e.g. through a portal power-up).
    badgerBites(inside);

    // Items: eaten by surviving heads (ghosts too). A power-up grows the
    // snake like an apple, then takes effect; a rat is worth
    // growthMultiplier apples, a chicken its own growthMultiplier plus a
    // feast round the eater, as if it had picked up the feast power-up.
    // A head entering any cell of a bomb sets it
    // off (a ghost passes through); it doesn't grow the snake.
    for (const m of moves) {
      if (dead.has(m) || m.player.status !== 'alive') continue;
      const { x, y } = m.newHead;
      const i = itemAt(x, y);
      if (i !== -1) {
        const [item] = apples.splice(i, 1);
        if (item.type === 'rat') {
          m.snake.pendingGrowth += cfg.growthPerApple * RAT_RULES.growthMultiplier;
          events.push({ type: 'eat', id: m.player.id, x, y, item: 'rat', ratId: item.id });
        } else if (item.type === 'chicken') {
          m.snake.pendingGrowth += cfg.growthPerApple * CHICKEN_RULES.growthMultiplier;
          events.push({ type: 'eat', id: m.player.id, x, y, item: 'chicken', chickenId: item.id });
          spawnFeast(m.newHead);
        } else {
          m.snake.pendingGrowth += cfg.growthPerApple;
          events.push(item.type ? { type: 'eat', id: m.player.id, x, y, item: item.type } : { type: 'eat', id: m.player.id, x, y });
          if (item.type) pickUp(m.player, item.type);
        }
      }
      if (m.player.status !== 'alive' || isGhost(m.player)) continue;
      const b = bombs.findIndex((o) => bombCovers(o, x, y));
      if (b !== -1) {
        const [bomb] = bombs.splice(b, 1);
        events.push({ type: 'eat', id: m.player.id, x: bomb.x, y: bomb.y, item: 'bomb' });
        pickUp(m.player, 'bomb');
      }
    }

    if (rules.corpseApples && fallen.length) dropCorpses(fallen);
    fallen = [];
  }

  // ---- the honey badger ----
  // A 5x3 block that never rotates or wraps. After a warning (when it does
  // nothing) it is active for badgerLifetimeSec: it wanders like a slow rat,
  // bites snakes that newly touch it, and eats rats. A projectile kills it.

  const B_REACH_X = (BADGER_RULES.width - 1) / 2;
  const B_REACH_Y = (BADGER_RULES.height - 1) / 2;
  const isActive = (b) => Boolean(b) && b.warningMs <= 0;
  // Whether the badger centered on (bx, by) covers (x, y).
  const blockCovers = (bx, by, x, y) => Math.abs(x - bx) <= B_REACH_X && Math.abs(y - by) <= B_REACH_Y;
  // Whether the active badger (or, with `warning`, one still in its warning)
  // covers (x, y).
  function badgerCovers(x, y, warning = false) {
    return Boolean(badger) && (warning || isActive(badger)) && blockCovers(badger.x, badger.y, x, y);
  }
  function blockCells(bx, by) {
    const out = [];
    for (let dy = -B_REACH_Y; dy <= B_REACH_Y; dy++) {
      for (let dx = -B_REACH_X; dx <= B_REACH_X; dx++) out.push({ x: bx + dx, y: by + dy });
    }
    return out;
  }
  // Its cells, warning included ([] without one).
  const badgerCells = () => (badger ? blockCells(badger.x, badger.y) : []);
  const blockInBounds = (bx, by) =>
    bx - B_REACH_X >= 0 && by - B_REACH_Y >= 0 && bx + B_REACH_X < gridSize && by + B_REACH_Y < gridSize;
  // Bombs and portal ends: what it can't move onto.
  function badgerBlockers() {
    const set = new Set();
    for (const b of bombs) for (const c of bombCells(b)) set.add(cellKey(c.x, c.y));
    for (const p of portals) for (const c of p.ends) set.add(cellKey(c.x, c.y));
    return set;
  }
  const blockFree = (bx, by, blockers) =>
    blockInBounds(bx, by) && blockCells(bx, by).every((c) => !blockers.has(cellKey(c.x, c.y)));
  const badgerTurnIn = () =>
    BADGER_RULES.turnMinTicks + randInt(BADGER_RULES.turnMaxTicks - BADGER_RULES.turnMinTicks + 1);

  // Steps from (x, y) to the nearest cell of the block centered on (bx, by),
  // the short way round when walls wrap (a head can still come at it that
  // way, even though the badger itself never wraps).
  function stepsToBlock(x, y, bx, by) {
    const axis = (a, b, reach) => {
      let d = Math.abs(a - b);
      if (rules.wrapWalls) d = Math.min(d, gridSize - d);
      return Math.max(0, d - reach);
    };
    return axis(x, bx, B_REACH_X) + axis(y, by, B_REACH_Y);
  }

  // A badger in its warning, fully on the board, clear of bombs and portal
  // ends, its block at least headClearance steps from every snake head.
  // Snakes' bodies and items may be under it. null when there's no room.
  function spawnBadger() {
    if (BADGER_RULES.width > gridSize || BADGER_RULES.height > gridSize) return null;
    const blockers = badgerBlockers();
    const heads = aliveSnakes().map((s) => s.segments[0]);
    const fits = (x, y) => blockFree(x, y, blockers) && heads.every((h) => stepsToBlock(h.x, h.y, x, y) >= BADGER_RULES.headClearance);
    const spanX = gridSize - 2 * B_REACH_X;
    const spanY = gridSize - 2 * B_REACH_Y;
    let at = null;
    for (let attempt = 0; attempt < 100 && !at; attempt++) {
      const x = B_REACH_X + randInt(spanX);
      const y = B_REACH_Y + randInt(spanY);
      if (fits(x, y)) at = { x, y };
    }
    if (!at) {
      const options = [];
      for (let y = B_REACH_Y; y < B_REACH_Y + spanY; y++) for (let x = B_REACH_X; x < B_REACH_X + spanX; x++) if (fits(x, y)) options.push({ x, y });
      if (!options.length) return null;
      at = options[randInt(options.length)];
    }
    const lifetimeMs = cfg.badgerLifetimeSec * 1000;
    badger = {
      id: nextObjectId++,
      x: at.x,
      y: at.y,
      dir: Object.keys(DIRECTIONS)[randInt(4)],
      warningMs: BADGER_RULES.warningMs,
      remainingMs: lifetimeMs,
      lifetimeMs,
      moveAt: Infinity, // set when it becomes active
      turnAt: Infinity,
      since: tickCount,
      passing: new Set(),
    };
    return badger;
  }

  // Gone (killed or expired): the wait for the next one starts over.
  function removeBadger() {
    badger = null;
    badgerWaitMs = 0;
    badgerDueFactor = null;
  }

  // Once per playing tick, after the moves: the warning and the lifetime run
  // down (from the tick after it appeared), and with none on the board the
  // next one comes due. The delay is drawn only once half the average has
  // passed (0.5 to 1.5 times the average), so short rounds draw no random
  // numbers for it at all.
  function badgerTimers() {
    if (badger) {
      if (badger.since === tickCount) return;
      if (badger.warningMs > 0) {
        badger.warningMs -= cfg.tickMs;
        if (badger.warningMs <= 0) {
          badger.warningMs = 0;
          badger.moveAt = tickCount + creatureInterval(BADGER_RULES.moveEveryTicks);
          badger.turnAt = tickCount + badgerTurnIn();
          events.push({ type: 'badgerActive', x: badger.x, y: badger.y });
          badgerEatsCreatures(); // any that ran under it during the warning
        }
        return;
      }
      badger.remainingMs -= cfg.tickMs;
      if (badger.remainingMs <= 0) {
        events.push({ type: 'badgerGone', x: badger.x, y: badger.y });
        removeBadger();
      }
      return;
    }
    if (cfg.badgerEverySec <= 0) return;
    badgerWaitMs += cfg.tickMs;
    const averageMs = cfg.badgerEverySec * 1000;
    if (badgerDueFactor === null) {
      if (badgerWaitMs < averageMs / 2) return;
      badgerDueFactor = 0.5 + random();
    }
    if (badgerWaitMs < badgerDueFactor * averageMs) return;
    if (spawnBadger()) events.push({ type: 'badgerSpawn', x: badger.x, y: badger.y });
  }

  // The ways away from the walls its block touches ([] off the walls).
  function awayFromWalls(b) {
    const out = [];
    if (b.x - B_REACH_X === 0) out.push('right');
    if (b.x + B_REACH_X === gridSize - 1) out.push('left');
    if (b.y - B_REACH_Y === 0) out.push('down');
    if (b.y + B_REACH_Y === gridSize - 1) out.push('up');
    return out;
  }

  // Every moveEveryTicks ticks (twice that under freeze), one cell on:
  // straight ahead until its turn
  // timer runs out, or at once when blocked (leaving the board, a bomb or a
  // portal end). Then it picks at random among the free ways: away from a
  // wall it touches if it can, else any but back (straight on included),
  // back only when that's the only way; boxed in, it stays put.
  function moveBadger() {
    const b = badger;
    if (!isActive(b) || tickCount < b.moveAt) return;
    b.stepTicks = creatureInterval(BADGER_RULES.moveEveryTicks);
    b.moveAt = tickCount + b.stepTicks;
    const blockers = badgerBlockers();
    const options = Object.keys(DIRECTIONS).filter((dir) => blockFree(b.x + DIRECTIONS[dir].x, b.y + DIRECTIONS[dir].y, blockers));
    let pick = tickCount < b.turnAt && options.includes(b.dir) ? b.dir : null;
    if (!pick) {
      b.turnAt = tickCount + badgerTurnIn();
      const away = awayFromWalls(b).filter((dir) => options.includes(dir));
      const onward = options.filter((dir) => dir !== OPPOSITE[b.dir]);
      const pool = away.length ? away : onward.length ? onward : options;
      if (!pool.length) return;
      pick = pool[randInt(pool.length)];
    }
    b.x += DIRECTIONS[pick].x;
    b.y += DIRECTIONS[pick].y;
    b.dir = pick;
  }

  // A creature inside the active badger (it ran in, the badger moved onto
  // it, or it was under the warning when the badger became active) dies
  // (see creatureDies): nobody grows or gets a kill.
  function badgerEatsCreatures() {
    if (!isActive(badger)) return;
    for (let i = apples.length - 1; i >= 0; i--) {
      if (isCreature(apples[i]) && badgerCovers(apples[i].x, apples[i].y)) creatureDies(i, 'badger');
    }
  }

  // A projectile got it: gone at once, a kill for the shooter (if still in
  // the game).
  function killBadger(by) {
    const credited = by && players.get(by.id) === by ? by : null;
    if (credited) credited.kills++;
    events.push({ type: 'badgerKilled', x: badger.x, y: badger.y, byId: credited ? credited.id : null });
    removeBadger();
  }

  // Before a sub-step: for every living snake, its head and the segments
  // already inside the active badger. null without an active badger.
  function badgerSnapshot() {
    if (!isActive(badger)) return null;
    const out = new Map();
    for (const p of players.values()) {
      if (p.status !== 'alive') continue;
      const segs = p.snake.segments;
      out.set(p, { head: segs[0], inside: new Set(segs.filter((c) => badgerCovers(c.x, c.y))) });
    }
    return out;
  }

  // After the moves: a segment touches the badger only when newly inside
  // it. The head counts when it moved in (from outside the block), any
  // segment when the badger moved onto it. Segments that were already in
  // (a body under the warning when it became active) don't count until they
  // have left. Ghosts are never bitten. Per snake, the new contact nearest the
  // head counts: the head dies, anywhere else is cut off there (dead if
  // fewer than minLength segments would be left). A shield pops instead.
  // Nobody gets a kill.
  // A snake touching it while immune (a ghost, which includes the second
  // after a shield pops) is passing through: never bitten, even once the
  // immunity ends and even as the badger moves onto more of it, until no
  // segment of it is inside any more.
  function badgerBites(before) {
    if (!before || !isActive(badger)) return;
    const passing = badger.passing;
    for (const p of players.values()) {
      const segs = p.status === 'alive' ? p.snake.segments : null;
      if (!segs || !segs.some((c) => badgerCovers(c.x, c.y))) {
        passing.delete(p);
        continue;
      }
      if (isGhost(p)) passing.add(p);
      if (passing.has(p)) continue;
      const was = before.get(p);
      // A segment's previous self: itself, or for the head the old head
      // (the same object when the snake didn't move).
      const wasInside = (i) => Boolean(was) && was.inside.has(i === 0 ? was.head : segs[i]);
      const index = segs.findIndex((c, i) => badgerCovers(c.x, c.y) && !wasInside(i));
      if (index === -1) continue;
      events.push({ type: 'badgerBite', id: p.id, index });
      if (effectOf(p, 'shield')) {
        popShield(p);
        passing.add(p);
      } else if (index < POWER_UP_RULES.minLength) kill(p, null);
      else removeSegments(segs.splice(index));
    }
  }

  // Every segment of the snakes that just died becomes an apple, except cells
  // a living snake now covers (e.g. a head that moved into a dead snake's tail
  // the same tick) and cells that already hold an apple.
  function dropCorpses(corpses) {
    const blocked = occupiedCells();
    for (const s of corpses) {
      for (const c of s.segments) {
        const k = cellKey(c.x, c.y);
        if (!inBounds(c.x, c.y) || blocked.has(k)) continue;
        blocked.add(k);
        apples.push({ x: c.x, y: c.y, corpse: true });
      }
    }
  }

  // ---- public API ---------------------------------------------------------

  function addPlayer(id, name) {
    if (players.has(id)) return { ok: false, reason: 'duplicate' };
    if (players.size >= cfg.maxPlayers) return { ok: false, reason: 'full' };
    const used = new Set([...players.values()].map((p) => p.colorIndex));
    let colorIndex = 0;
    while (used.has(colorIndex)) colorIndex++;
    const p = { id, name: String(name), colorIndex, status: 'queued', snake: null, kills: 0 };
    players.set(id, p);
    // The round hasn't really started during the countdown: join it now.
    if (phase === PHASES.COUNTDOWN) spawnInto(p, occupiedCells(), snakeCells());
    return { ok: true, colorIndex };
  }

  function removePlayer(id) {
    return players.delete(id);
  }

  function setDirection(id, dir) {
    const p = players.get(id);
    if (!p || p.status !== 'alive') return false;
    if (typeof dir !== 'string' || !Object.hasOwn(DIRECTIONS, dir)) return false;
    // Turns are buffered so quick sequences (zigzags, U-turns) aren't lost.
    // Each queued turn is validated against the one before it, so every tick
    // turns at most 90 degrees and the snake can never reverse into its neck.
    const queue = p.snake.dirQueue;
    // When full, the newest input replaces the last queued one (validated
    // against the turn before it), so a frantic tap never gets stuck behind old ones.
    const full = queue.length >= INPUT_BUFFER_SIZE;
    const prevIndex = queue.length - (full ? 2 : 1);
    const previous = prevIndex >= 0 ? queue[prevIndex] : p.snake.dir;
    if (dir === previous || dir === OPPOSITE[previous]) return false;
    if (full) queue.pop();
    queue.push(dir);
    return true;
  }

  function tick() {
    tickCount++;
    events = [];
    if (phase === PHASES.WAITING) {
      if (players.size > 0) startRound();
      return;
    }
    if (phase === PHASES.INTERMISSION) {
      intermissionElapsed += cfg.tickMs;
      if (intermissionElapsed >= cfg.intermissionMs) {
        if (players.size > 0) startRound();
        else {
          phase = PHASES.WAITING;
          clearBoard();
          winnerId = null;
        }
      }
      return;
    }
    if (phase === PHASES.COUNTDOWN) {
      // Read live, so shortening countdownMs mid-countdown takes effect at once.
      countdownElapsed += cfg.tickMs;
      if (countdownElapsed >= cfg.countdownMs) phase = PHASES.PLAYING;
      return;
    }
    playingElapsed += cfg.tickMs;
    step();
    syncApples();
    checkRoundEnd();
  }

  function getState() {
    return {
      phase,
      round,
      tick: tickCount,
      gridSize,
      rules: { ...rules },
      win: { ...win },
      // Only while the time limit applies to the round in progress.
      timeRemainingMs: rules.timeLimitWin ? Math.max(0, win.timeLimitSec * 1000 - playingElapsed) : null,
      winnerId,
      endReason,
      events: events.map((e) => ({ ...e, ...(e.ids ? { ids: [...e.ids] } : {}) })),
      intermissionRemainingMs:
        phase === PHASES.INTERMISSION ? Math.max(0, cfg.intermissionMs - intermissionElapsed) : 0,
      countdownRemainingMs: phase === PHASES.COUNTDOWN ? Math.max(0, cfg.countdownMs - countdownElapsed) : 0,
      apples: apples
        .filter((a) => !a.type)
        .map((a) => (a.corpse ? { x: a.x, y: a.y, corpse: true } : a.feast ? { x: a.x, y: a.y, feast: true } : { x: a.x, y: a.y })),
      powerUps: apples.filter((a) => a.type && !isCreature(a)).map((a) => ({ x: a.x, y: a.y, type: a.type })),
      // stepTicks: the ticks its last step takes (doubled by freeze), for
      // /display's slide.
      rats: apples.filter((a) => a.type === 'rat').map((a) => ({ id: a.id, x: a.x, y: a.y, dir: a.dir, stepTicks: a.stepTicks })),
      chickens: apples
        .filter((a) => a.type === 'chicken')
        .map((a) => ({ id: a.id, x: a.x, y: a.y, dir: a.dir, stepTicks: a.stepTicks, alerted: a.calmMs > 0 })),
      // Freeze is slowing the creatures and the badger (/display tints them blue).
      creaturesFrozen: creaturesFrozen(),
      bombs: bombs.map((b) => ({ x: b.x, y: b.y, remainingMs: b.remainingMs })),
      projectiles: projectiles.map((p) => ({ id: p.id, x: p.x, y: p.y, dir: p.dir, ownerId: p.ownerId })),
      portals: portals.map((p) => ({ id: p.id, ends: p.ends.map((c) => ({ x: c.x, y: c.y })), remainingMs: p.remainingMs })),
      // (x, y) is the center of its width x height block.
      badger: badger
        ? {
            id: badger.id,
            x: badger.x,
            y: badger.y,
            width: BADGER_RULES.width,
            height: BADGER_RULES.height,
            dir: badger.dir,
            stepTicks: badger.stepTicks ?? BADGER_RULES.moveEveryTicks,
            warningMs: badger.warningMs,
            remainingMs: badger.remainingMs,
            lifetimeMs: badger.lifetimeMs,
          }
        : null,
      players: [...players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        colorIndex: p.colorIndex,
        status: p.status,
        length: p.snake ? p.snake.segments.length : 0,
        kills: p.kills,
      })),
      snakes: [...players.values()]
        .filter((p) => p.snake)
        .map((p) => ({
          id: p.id,
          colorIndex: p.colorIndex,
          alive: p.status === 'alive',
          dir: p.snake.dir,
          pendingGrowth: p.snake.pendingGrowth,
          // The active timed effect, if any, and whether another snake's
          // freeze is slowing this one.
          effect: p.snake.effect
            ? { type: p.snake.effect.type, remainingMs: p.snake.effect.remainingMs, durationMs: p.snake.effect.durationMs }
            : null,
          frozen: isFrozen(p),
          segments: p.snake.segments.map((c) => ({ x: c.x, y: c.y })),
        })),
    };
  }

  // Abandons the current round (if any) and starts a fresh one with every
  // player, including queued ones. With no players it returns to waiting.
  function restartRound() {
    events = [];
    if (players.size > 0) startRound();
    else {
      phase = PHASES.WAITING;
      clearBoard();
      winnerId = null;
    }
  }

  function updateConfig(partial) {
    const accepted = sanitizeConfig(partial);
    Object.assign(cfg, accepted);
    return accepted;
  }

  // Test/setup hooks: place snakes and apples directly. Not for runtime use.
  const _debug = {
    setSnake(id, segments, dir) {
      const p = players.get(id);
      if (!p) throw new Error(`unknown player ${id}`);
      p.snake = { segments: segments.map(([x, y]) => ({ x, y })), dir, dirQueue: [], pendingGrowth: 0, effect: null };
      p.status = 'alive';
    },
    // Gives a snake a timed effect, as if it had just picked it up.
    setEffect(id, type, durationMs) {
      setEffect(players.get(id), type, durationMs);
    },
    setApples(list) {
      apples = list.map(([x, y]) => ({ x, y }));
    },
    // Adds power-ups ([x, y, type]) after the apples already there.
    addPowerUps(list) {
      for (const [x, y, type] of list) apples.push({ x, y, type });
    },
    // Adds a rat facing `dir` that next moves on tick `moveAt` (default: the
    // next tick) and keeps going straight until tick `turnAt`, when free.
    addRat([x, y], dir, { moveAt = tickCount + 1, turnAt = tickCount + 1000 } = {}) {
      apples.push({ ...newCreature({ x, y }, 'rat', dir), moveAt, turnAt });
    },
    // The same for a chicken (calm to begin with).
    addChicken([x, y], dir, { moveAt = tickCount + 1, turnAt = tickCount + 1000 } = {}) {
      apples.push({ ...newCreature({ x, y }, 'chicken', dir), moveAt, turnAt });
    },
    // Rat and chicken internals, for the movement tests.
    rats: () => apples.filter((a) => a.type === 'rat').map((a) => ({ ...a })),
    chickens: () => apples.filter((a) => a.type === 'chicken').map((a) => ({ ...a })),
    addPortal([ax, ay], [bx, by], remainingMs = POWER_UP_RULES.portalLifetimeMs) {
      portals.push({ id: nextObjectId++, ends: [{ x: ax, y: ay }, { x: bx, y: by }], remainingMs, since: tickCount });
    },
    addProjectile([x, y], dir, ownerId) {
      projectiles.push({ id: nextObjectId++, x, y, dir, ownerId });
    },
    // The power-up types that have an effect, for the completeness test.
    effectTypes: () => Object.keys(EFFECTS),
    // Puts a badger centered on (x, y): active by default, or in its warning
    // with warningMs > 0. It next moves on tick `moveAt` (default: the next
    // tick) and keeps going straight until tick `turnAt`, when free.
    setBadger([x, y], { dir = 'left', warningMs = 0, remainingMs = cfg.badgerLifetimeSec * 1000, moveAt = tickCount + 1, turnAt = tickCount + 1000 } = {}) {
      badger = { id: nextObjectId++, x, y, dir, warningMs, remainingMs, lifetimeMs: remainingMs, moveAt: warningMs > 0 ? Infinity : moveAt, turnAt: warningMs > 0 ? Infinity : turnAt, since: tickCount, passing: new Set() };
    },
    // When the badger next moves and next picks a direction (ticks).
    badgerTimers() {
      return badger ? { moveAt: badger.moveAt, turnAt: badger.turnAt } : null;
    },
    clearBadger() {
      removeBadger();
    },
    setBombs(list) {
      bombs = list.map(([x, y, remainingMs = POWER_UP_RULES.bombLifetimeMs]) => ({ x, y, remainingMs, since: tickCount }));
    },
  };

  return { addPlayer, removePlayer, setDirection, tick, getState, updateConfig, restartRound, config: cfg, _debug };
}
