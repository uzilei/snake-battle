// Snake Battle game engine.
//
// Pure game logic: no networking, rendering, input devices, DOM, or Node
// built-ins. Runs unchanged in Node and in the browser. All input arrives via
// setDirection(id, dir); time advances only via tick().

export const DIRECTIONS = Object.freeze({
  up: Object.freeze({ x: 0, y: -1 }),
  down: Object.freeze({ x: 0, y: 1 }),
  left: Object.freeze({ x: -1, y: 0 }),
  right: Object.freeze({ x: 1, y: 0 }),
});

const OPPOSITE = Object.freeze({ up: 'down', down: 'up', left: 'right', right: 'left' });

export const START_LENGTH = 3;
const SPAWN_CLEARANCE = 3; // free cells required ahead of a freshly spawned head
export const INPUT_BUFFER_SIZE = 3; // queued turns per snake; one is applied per tick

export const PHASES = Object.freeze({
  WAITING: 'waiting', // no round running, waiting for players
  COUNTDOWN: 'countdown', // snakes spawned but frozen, round about to start
  PLAYING: 'playing',
  INTERMISSION: 'intermission',
});

export const CONFIG_LIMITS = Object.freeze({
  tickMs: { min: 80, max: 600, default: 150 }, // below ~80 ms phone swipes over wifi can't keep up
  appleCount: { min: 0, max: 30, default: 3 },
  growthPerApple: { min: 1, max: 10, default: 1 },
  maxPlayers: { min: 1, max: 24, default: 24 },
  gridSize: { min: 10, max: 80, default: 30 },
  intermissionMs: { min: 0, max: 30000, default: 4000 },
  countdownMs: { min: 0, max: 10000, default: 0 }, // 0 = no pre-round countdown
});

// On/off rules. Like gridSize, they are read when a round starts, so a change
// applies from the next round.
export const CONFIG_TOGGLES = Object.freeze({
  corpseApples: false, // a dead snake's segments turn into apples
  wrapWalls: false, // leaving one edge enters from the opposite one
});

export function createDefaultConfig() {
  const config = { ...CONFIG_TOGGLES };
  for (const [key, limit] of Object.entries(CONFIG_LIMITS)) config[key] = limit.default;
  return config;
}

// Returns only the recognised, valid keys of `partial`: numbers rounded and
// clamped, toggles accepted only as real booleans. Everything else is dropped.
export function sanitizeConfig(partial) {
  const out = {};
  if (partial === null || typeof partial !== 'object') return out;
  for (const [key, limit] of Object.entries(CONFIG_LIMITS)) {
    if (!Object.hasOwn(partial, key)) continue;
    const value = partial[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = Math.min(limit.max, Math.max(limit.min, Math.round(value)));
  }
  for (const key of Object.keys(CONFIG_TOGGLES)) {
    if (Object.hasOwn(partial, key) && typeof partial[key] === 'boolean') out[key] = partial[key];
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

  // id -> { id, name, colorIndex, status: 'queued' | 'alive' | 'dead', snake }
  // Map preserves join order, which keeps spawning deterministic.
  const players = new Map();

  let phase = PHASES.WAITING;
  let round = 0;
  let tickCount = 0;
  let gridSize = cfg.gridSize; // locked for the duration of a round
  let rules = { corpseApples: cfg.corpseApples, wrapWalls: cfg.wrapWalls }; // locked per round too
  let apples = []; // [{ x, y, corpse? }]; corpse apples come on top of cfg.appleCount
  let winnerId = null;
  let participants = 0; // snakes spawned at round start
  let intermissionElapsed = 0;
  let countdownElapsed = 0;
  // What happened during the latest tick, for renderers (effects, sounds...):
  // { type: 'eat', id, x, y } | { type: 'death', id } | { type: 'headOn', ids }.
  // Rebuilt every tick; read-only output, never input.
  let events = [];

  const cellKey = (x, y) => y * gridSize + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < gridSize && y < gridSize;
  const randInt = (n) => Math.floor(random() * n);

  function aliveSnakes() {
    const list = [];
    for (const p of players.values()) if (p.status === 'alive') list.push(p.snake);
    return list;
  }

  function occupiedCells() {
    const set = new Set();
    for (const s of aliveSnakes()) for (const c of s.segments) set.add(cellKey(c.x, c.y));
    for (const a of apples) set.add(cellKey(a.x, a.y));
    return set;
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

  // inward: face towards the center (see inwardDirs); otherwise any direction.
  function trySpawn(occupied, clearance, inward = true) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const hx = randInt(gridSize);
      const hy = randInt(gridSize);
      const dirs = inward ? inwardDirs(hx, hy) : Object.keys(DIRECTIONS);
      const dir = dirs[randInt(dirs.length)];
      const d = DIRECTIONS[dir];
      const segments = [];
      let ok = true;
      for (let i = -clearance; i < START_LENGTH && ok; i++) {
        // i < 0: cells ahead of the head (must be free); i >= 0: body cells.
        const x = hx - d.x * i;
        const y = hy - d.y * i;
        if (!inBounds(x, y) || occupied.has(cellKey(x, y))) ok = false;
        else if (i >= 0) segments.push({ x, y });
      }
      if (ok) return { segments, dir };
    }
    return null;
  }

  function spawnSnake(occupied) {
    // Last resort on a crowded board: any free spot, any direction.
    const placed = trySpawn(occupied, SPAWN_CLEARANCE) ?? trySpawn(occupied, 0) ?? trySpawn(occupied, 0, false);
    if (!placed) return null;
    for (const c of placed.segments) occupied.add(cellKey(c.x, c.y));
    return { segments: placed.segments, dir: placed.dir, dirQueue: [], pendingGrowth: 0 };
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
  // Corpse apples count towards the total, so no new apple spawns while the
  // board already holds appleCount or more. Lowering appleCount trims regular
  // apples down to it; corpse apples are never removed.
  function syncApples() {
    let excess = apples.filter((a) => !a.corpse).length - cfg.appleCount;
    for (let i = apples.length - 1; i >= 0 && excess > 0; i--) {
      if (!apples[i].corpse) {
        apples.splice(i, 1);
        excess--;
      }
    }
    if (apples.length >= cfg.appleCount) return;
    const occupied = occupiedCells();
    while (apples.length < cfg.appleCount) {
      const apple = spawnApple(occupied);
      if (!apple) break;
      apples.push(apple);
      occupied.add(cellKey(apple.x, apple.y));
    }
  }

  // ---- round lifecycle ----------------------------------------------------

  function startRound() {
    round++;
    gridSize = cfg.gridSize;
    rules = { corpseApples: cfg.corpseApples, wrapWalls: cfg.wrapWalls };
    apples = [];
    winnerId = null;
    intermissionElapsed = 0;
    participants = 0;
    const occupied = new Set();
    for (const p of players.values()) {
      const snake = spawnSnake(occupied);
      if (snake) {
        p.snake = snake;
        p.status = 'alive';
        participants++;
      } else {
        p.snake = null;
        p.status = 'queued'; // grid too crowded, try again next round
      }
    }
    countdownElapsed = 0;
    phase = cfg.countdownMs > 0 ? PHASES.COUNTDOWN : PHASES.PLAYING;
    syncApples();
  }

  function endRound(winner) {
    winnerId = winner;
    phase = PHASES.INTERMISSION;
    intermissionElapsed = 0;
  }

  function checkRoundEnd() {
    const alive = aliveSnakes();
    if (participants >= 2) {
      if (alive.length <= 1) {
        const survivor = [...players.values()].find((p) => p.status === 'alive');
        endRound(survivor ? survivor.id : null);
      }
      return;
    }
    // Solo round: ends when the snake dies, or as soon as someone is waiting
    // to join, so a lone player can't block the queue indefinitely.
    const someoneQueued = [...players.values()].some((p) => p.status === 'queued');
    if (alive.length === 0 || someoneQueued) endRound(null);
  }

  // ---- movement & collisions ----------------------------------------------

  function step() {
    const players_ = [...players.values()].filter((p) => p.status === 'alive');
    const moves = players_.map((p) => {
      const s = p.snake;
      if (s.dirQueue.length) s.dir = s.dirQueue.shift(); // one queued turn per tick
      const head = s.segments[0];
      const d = DIRECTIONS[s.dir];
      let x = head.x + d.x;
      let y = head.y + d.y;
      if (rules.wrapWalls) {
        x = (x + gridSize) % gridSize;
        y = (y + gridSize) % gridSize;
      }
      return {
        player: p,
        snake: s,
        head,
        newHead: { x, y },
        grows: s.pendingGrowth > 0,
        length: s.segments.length,
      };
    });

    // Post-move bodies: every current segment except tails that will move away.
    // The old head stays (it becomes the neck); new heads are handled below.
    const body = new Set();
    for (const m of moves) {
      const keep = m.grows ? m.length : m.length - 1;
      for (let i = 0; i < keep; i++) body.add(cellKey(m.snake.segments[i].x, m.snake.segments[i].y));
    }

    const dead = new Set();
    const headOnGroups = [];
    const byCell = new Map();

    for (const m of moves) {
      const { x, y } = m.newHead;
      if (!inBounds(x, y)) {
        dead.add(m);
        continue;
      }
      // Heads passing through each other: treated as head-on, not a body hit.
      const partner = moves.find(
        (o) => o !== m && o.head.x === x && o.head.y === y && o.newHead.x === m.head.x && o.newHead.y === m.head.y,
      );
      if (partner) {
        if (moves.indexOf(m) < moves.indexOf(partner)) headOnGroups.push([m, partner]);
        continue;
      }
      if (body.has(cellKey(x, y))) dead.add(m);
      const k = cellKey(x, y);
      if (!byCell.has(k)) byCell.set(k, []);
      byCell.get(k).push(m);
    }
    for (const group of byCell.values()) if (group.length > 1) headOnGroups.push(group);

    // Head-on: the shortest snake survives; if several share the shortest
    // length, all of them die.
    for (const group of headOnGroups) {
      events.push({ type: 'headOn', ids: group.map((m) => m.player.id) });
      const minLength = Math.min(...group.map((m) => m.length));
      const shortest = group.filter((m) => m.length === minLength);
      for (const m of group) if (m.length !== minLength || shortest.length > 1) dead.add(m);
    }

    for (const m of moves) {
      if (dead.has(m)) {
        m.player.status = 'dead';
        events.push({ type: 'death', id: m.player.id });
        continue;
      }
      m.snake.segments.unshift(m.newHead);
      if (m.grows) m.snake.pendingGrowth--;
      else m.snake.segments.pop();
    }

    // Apples: eaten by surviving heads.
    for (const m of moves) {
      if (dead.has(m)) continue;
      const i = apples.findIndex((a) => a.x === m.newHead.x && a.y === m.newHead.y);
      if (i !== -1) {
        apples.splice(i, 1);
        m.snake.pendingGrowth += cfg.growthPerApple;
        events.push({ type: 'eat', id: m.player.id, x: m.newHead.x, y: m.newHead.y });
      }
    }

    if (rules.corpseApples && dead.size) dropCorpses([...dead].map((m) => m.snake));
  }

  // Every segment of the snakes that just died becomes an apple, except cells
  // a living snake now covers (e.g. a head that moved into a dead snake's tail
  // the same tick) and cells that already hold an apple.
  function dropCorpses(corpses) {
    const blocked = new Set();
    for (const s of aliveSnakes()) for (const c of s.segments) blocked.add(cellKey(c.x, c.y));
    for (const a of apples) blocked.add(cellKey(a.x, a.y));
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
    const p = { id, name: String(name), colorIndex, status: 'queued', snake: null };
    players.set(id, p);
    // The round hasn't really started during the countdown: join it now.
    if (phase === PHASES.COUNTDOWN) {
      const snake = spawnSnake(occupiedCells());
      if (snake) {
        p.snake = snake;
        p.status = 'alive';
        participants++;
      }
    }
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
          apples = [];
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
      winnerId,
      events: events.map((e) => ({ ...e, ...(e.ids ? { ids: [...e.ids] } : {}) })),
      intermissionRemainingMs:
        phase === PHASES.INTERMISSION ? Math.max(0, cfg.intermissionMs - intermissionElapsed) : 0,
      countdownRemainingMs: phase === PHASES.COUNTDOWN ? Math.max(0, cfg.countdownMs - countdownElapsed) : 0,
      apples: apples.map((a) => (a.corpse ? { x: a.x, y: a.y, corpse: true } : { x: a.x, y: a.y })),
      players: [...players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        colorIndex: p.colorIndex,
        status: p.status,
        length: p.snake ? p.snake.segments.length : 0,
      })),
      snakes: [...players.values()]
        .filter((p) => p.snake)
        .map((p) => ({
          id: p.id,
          colorIndex: p.colorIndex,
          alive: p.status === 'alive',
          dir: p.snake.dir,
          pendingGrowth: p.snake.pendingGrowth,
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
      apples = [];
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
      p.snake = { segments: segments.map(([x, y]) => ({ x, y })), dir, dirQueue: [], pendingGrowth: 0 };
      p.status = 'alive';
    },
    setApples(list) {
      apples = list.map(([x, y]) => ({ x, y }));
    },
  };

  return { addPlayer, removePlayer, setDirection, tick, getState, updateConfig, restartRound, config: cfg, _debug };
}
