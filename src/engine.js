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
  maxPlayers: { min: 1, max: 12, default: 12 },
  gridSize: { min: 10, max: 80, default: 30 },
  intermissionMs: { min: 0, max: 30000, default: 4000 },
  countdownMs: { min: 0, max: 10000, default: 0 }, // 0 = no pre-round countdown
});

export function createDefaultConfig() {
  const config = {};
  for (const [key, limit] of Object.entries(CONFIG_LIMITS)) config[key] = limit.default;
  return config;
}

// Returns only the recognised, valid keys of `partial`, rounded and clamped.
// Unknown keys and non-finite values are dropped.
export function sanitizeConfig(partial) {
  const out = {};
  if (partial === null || typeof partial !== 'object') return out;
  for (const [key, limit] of Object.entries(CONFIG_LIMITS)) {
    if (!Object.hasOwn(partial, key)) continue;
    const value = partial[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = Math.min(limit.max, Math.max(limit.min, Math.round(value)));
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
  let apples = []; // [{ x, y }]
  let winnerId = null;
  let participants = 0; // snakes spawned at round start
  let intermissionElapsed = 0;
  let countdownElapsed = 0;

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

  function trySpawn(occupied, clearance) {
    const dirs = Object.keys(DIRECTIONS);
    for (let attempt = 0; attempt < 400; attempt++) {
      const dir = dirs[randInt(dirs.length)];
      const d = DIRECTIONS[dir];
      const hx = randInt(gridSize);
      const hy = randInt(gridSize);
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
    const placed = trySpawn(occupied, SPAWN_CLEARANCE) ?? trySpawn(occupied, 0);
    if (!placed) return null;
    for (const c of placed.segments) occupied.add(cellKey(c.x, c.y));
    return { segments: placed.segments, dir: placed.dir, pendingDir: null, pendingGrowth: 0 };
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
  function syncApples() {
    if (apples.length > cfg.appleCount) apples.length = cfg.appleCount;
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
      if (s.pendingDir) {
        s.dir = s.pendingDir;
        s.pendingDir = null;
      }
      const head = s.segments[0];
      const d = DIRECTIONS[s.dir];
      return {
        player: p,
        snake: s,
        head,
        newHead: { x: head.x + d.x, y: head.y + d.y },
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
      const minLength = Math.min(...group.map((m) => m.length));
      const shortest = group.filter((m) => m.length === minLength);
      for (const m of group) if (m.length !== minLength || shortest.length > 1) dead.add(m);
    }

    for (const m of moves) {
      if (dead.has(m)) {
        m.player.status = 'dead';
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
    // Validate against the direction actually travelled, not the pending one,
    // so two quick taps within one tick can never add up to a reversal.
    if (dir === OPPOSITE[p.snake.dir]) return false;
    p.snake.pendingDir = dir; // at most one pending turn: the latest valid one wins
    return true;
  }

  function tick() {
    tickCount++;
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
      winnerId,
      intermissionRemainingMs:
        phase === PHASES.INTERMISSION ? Math.max(0, cfg.intermissionMs - intermissionElapsed) : 0,
      countdownRemainingMs: phase === PHASES.COUNTDOWN ? Math.max(0, cfg.countdownMs - countdownElapsed) : 0,
      apples: apples.map((a) => ({ x: a.x, y: a.y })),
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
      p.snake = { segments: segments.map(([x, y]) => ({ x, y })), dir, pendingDir: null, pendingGrowth: 0 };
      p.status = 'alive';
    },
    setApples(list) {
      apples = list.map(([x, y]) => ({ x, y }));
    },
  };

  return { addPlayer, removePlayer, setDirection, tick, getState, updateConfig, restartRound, config: cfg, _debug };
}
