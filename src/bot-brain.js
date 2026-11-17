// Bot brain: picks a direction for each computer-controlled snake.
//
// Pure and browser-safe, like the engine, but it knows nothing of the
// engine's internals: it reads only what getState() returns (plus the live
// bomb mode) and its answer goes back through setDirection, like any input.
//
// Each bot that will move this tick weighs its (up to) three moves, in
// priority order:
//   1. Survive: never a move that dies next tick when another one doesn't,
//      and not one into a pocket too small for the snake. A charging laser's
//      line counts as deadly (but for its shooter): don't cross it or stay on
//      it. When every move
//      dies, anything but a wall (the engine credits the kill to a snake
//      that boxed it in either way).
//   2. Flee: keep away from heads that would win (or tie) a head-on, the
//      badger and bombs.
//   3. Hunt: the best food it can reach (chickens and rats first), or, with
//      scissors, another snake's body or the badger.
//   4. Wander: straight on while there's room.
// A ghost with time to spare skips 1 and 2 (walls still count). Lower skill
// sometimes ignores 2 and picks any safe move. A golden snake moves twice a
// tick, so it plans both: every 2-move path, both cells checked for 1, and 2
// to 4 weighed by where the path ends (see queueBotMoves).
//
// Work is bounded: one shared board per tick, small capped searches per bot,
// and a node budget for the whole tick, after which the remaining bots only
// do the cheap safety check.

import { DIRECTIONS } from './engine.js';
import { POWER_UP_RULES } from './shared/powerups.js';
import { BADGER_RULES } from './shared/badger.js';

const DIRS = Object.keys(DIRECTIONS);
const OPPOSITE = Object.freeze({ up: 'down', down: 'up', left: 'right', right: 'left' });

export const BOT_BRAIN = Object.freeze({
  nodeBudget: 60000, // search nodes per tick, shared by every bot
  // A flood fill stops counting at the snake's length plus this many cells
  // (never less than its length, or a long snake couldn't tell a big pocket
  // from open board); only the tick's node budget cuts it shorter.
  spaceExtra: 20,
  huntNodes: 1500, // nodes per bot's food search
  fleeRadius: 3, // cells (Manhattan)
  ghostSafeMs: 2000, // a ghost with more than this left ignores danger
  mistakeChance: Object.freeze({ 1: 0.25, 2: 0.08, 3: 0 }), // per skill: ignore step 2, pick a random safe move
  // Reaction time per skill: after each decision a bot waits a random 0 to
  // this many of its moves before the next one (rolled afresh every time, so
  // it can't fall into step with a loop it is running, like circling an
  // apple). In between it keeps going, but sees certain death one move ahead
  // reflexChance of the time. Each bot starts a round with a fresh roll, so
  // they don't all re-decide on the same tick.
  thinkWait: Object.freeze({ 1: 3, 2: 2, 3: 0 }),
  reflexChance: 0.85,
});

// Food values: what a bot would rather eat.
const VALUE = Object.freeze({ chicken: 6, rat: 4, powerUp: 2, apple: 1, target: 5 });

// Danger tiers of a move: 0 safe, 1 survivable but bad (a bomb that only
// cuts, a hit a shield takes), 2 deadly.
const SAFE = 0;
const BAD = 1;
const DEADLY = 2;
const NEVER = 0x7fff; // never free (in `freeAt`)

/**
 * @param {object} [options]
 * @param {() => number} [options.random]
 * @param {(err: Error) => void} [options.onError] a bot's decision failed (it goes straight on)
 */
export function createBotBrain({ random = Math.random, onError = () => {} } = {}) {
  let nodesUsed = 0; // in the latest think(), for tests and /health
  let seconds = new Map(); // latest think(): id -> a golden bot's second move
  const waits = new Map(); // id -> moves left before it re-decides (0: now)

  /**
   * @param {object} state engine.getState()
   * @param {string[]} ids the bots to steer
   * @param {object} [opts]
   * @param {number} [opts.skill] 1-3, for every bot not in `skills`
   * @param {Map<string, number>} [opts.skills] id -> 1-3, per bot
   * @param {'cut'|'kill'} [opts.bombMode]
   * @returns {Map<string, string>} id -> direction, for bots that move this tick and
   *   decide (or react) now; the others keep going. A golden bot (two moves a
   *   tick) plans both: this is the first, secondMoves() has the second.
   */
  function think(state, ids, { skill = 2, skills = null, bombMode = 'cut' } = {}) {
    nodesUsed = 0;
    seconds = new Map();
    const out = new Map();
    if (state.phase !== 'playing' || !ids.length) {
      waits.clear(); // a new countdown for every bot next round
      return out;
    }
    const board = buildBoard(state);
    let budget = BOT_BRAIN.nodeBudget;
    for (const id of ids) {
      const me = board.snakes.get(id);
      if (!me || !me.alive || !board.movesNext(me)) continue;
      const mySkill = skills?.get(id) ?? skill;
      const maxWait = BOT_BRAIN.thinkWait[mySkill] ?? 0;
      const roll = () => (maxWait > 0 ? Math.floor(random() * (maxWait + 1)) : 0);
      // First move this round: a fresh roll too (0: decide now).
      const wait = waits.get(id) ?? roll();
      // Between decisions only a reflex, and not always. The wait is in
      // moves: a golden tick is two.
      const reflex = wait > 0;
      const movesNow = me.effect === 'golden' ? 2 : 1;
      waits.set(id, reflex ? Math.max(0, wait - movesNow) : roll());
      if (reflex && random() >= BOT_BRAIN.reflexChance) continue;
      try {
        const { dir, dir2, nodes } = decide(board, me, { skill: mySkill, bombMode, budget, random, reflex });
        budget -= nodes;
        nodesUsed += nodes;
        if (dir) out.set(id, dir);
        if (dir && dir2) seconds.set(id, dir2);
      } catch (err) {
        // A brain bug must never stop the game: this bot just goes straight on.
        onError(err);
      }
    }
    return out;
  }

  return { think, nodesUsed: () => nodesUsed, secondMoves: () => seconds };
}

// Hands a think() result to the engine through `setDirection(id, dir, opts)`:
// one move replaces whatever was queued; a golden bot's two moves are queued
// in order, the first replacing the queue (`keep`: a "straight on" counts as
// a move, so straight-then-turn turns on the second).
export function queueBotMoves(setDirection, firsts, seconds = new Map()) {
  for (const [id, dir] of firsts) {
    const then = seconds.get(id);
    if (!then) {
      setDirection(id, dir, { replace: true });
      continue;
    }
    setDirection(id, dir, { replace: true, keep: true });
    setDirection(id, then, { keep: true });
  }
}

// ---- the board, built once per tick ----

function buildBoard(state) {
  const n = state.gridSize;
  const size = n * n;
  const wrap = Boolean(state.rules?.wrapWalls);
  const key = (x, y) => y * n + x;
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < n && y < n;
  const nextTick = state.tick + 1;

  const snakes = new Map();
  for (const s of state.snakes) {
    const ghostMs = s.effect?.type === 'ghost' ? s.effect.remainingMs : 0;
    snakes.set(s.id, {
      id: s.id,
      alive: s.alive,
      segments: s.segments,
      head: s.segments[0],
      dir: s.dir,
      length: s.segments.length,
      pendingGrowth: s.pendingGrowth,
      effect: s.effect?.type ?? null,
      ghostMs,
      frozen: s.frozen,
    });
  }
  // A frozen snake sits out every odd tick (as in the engine).
  const movesNext = (s) => !(s.frozen && nextTick % 2 === 1);

  // freeAt[cell]: in how many moves a snake segment there will be gone (0:
  // free now). A segment i from the head of a snake of length L leaves after
  // L - i of that snake's moves, later if it's growing or sitting out.
  const freeAt = new Int16Array(size);
  const owner = new Int16Array(size).fill(-1); // index into `order`, for "own body"
  const segIndex = new Int16Array(size);
  const order = [...snakes.values()];
  order.forEach((s, si) => {
    if (!s.alive || s.ghostMs > 0) return; // nothing collides with a ghost
    const L = s.length;
    const delay = s.pendingGrowth + (movesNext(s) ? 0 : 1);
    s.segments.forEach((c, i) => {
      if (!inBounds(c.x, c.y)) return;
      const k = key(c.x, c.y);
      const t = Math.min(NEVER - 1, L - i + delay);
      if (t > freeAt[k]) {
        freeAt[k] = t;
        owner[k] = si;
        segIndex[k] = i;
      }
    });
  });

  // Deadly no matter what: projectiles' next two cells, the active badger.
  const deadly = new Uint8Array(size);
  for (const p of state.projectiles ?? []) {
    const d = DIRECTIONS[p.dir];
    for (let i = 1; i <= 2; i++) {
      const x = p.x + d.x * i;
      const y = p.y + d.y * i;
      if (inBounds(x, y)) deadly[key(x, y)] = 1;
    }
  }
  // There can be several badgers (/admin can add more). inBadger: inside an
  // active one; badgerDistance: to the nearest one, warnings included.
  const allBadgers = state.badgers ?? (state.badger ? [state.badger] : []);
  const activeBadgers = allBadgers.filter((b) => b.warningMs <= 0);
  const badger = allBadgers.length ? allBadgers : null;
  const badgerActive = activeBadgers.length > 0;
  const reach = (b) => [(b.width - 1) / 2, (b.height - 1) / 2];
  const inBadger = (x, y) =>
    activeBadgers.some((b) => {
      const [bx, by] = reach(b);
      return Math.abs(x - b.x) <= bx && Math.abs(y - b.y) <= by;
    });
  // Distance from a cell to the nearest badger's block (Manhattan to the block, 0 inside).
  const badgerDistance = (x, y) =>
    allBadgers.reduce((min, b) => {
      const [bx, by] = reach(b);
      return Math.min(min, Math.max(0, Math.abs(x - b.x) - bx) + Math.max(0, Math.abs(y - b.y) - by));
    }, Infinity);

  // Charging lasers: their whole row or column is a hazard for every snake
  // but the shooter's, until it fires.
  const lasers = state.lasers ?? [];
  const onLaser = (x, y, id) => lasers.some((l) => l.shooterId !== id && (l.axis === 'row' ? y === l.index : x === l.index));

  const bombReach = (POWER_UP_RULES.bombSize - 1) / 2;
  const bombs = state.bombs ?? [];
  const inBomb = (x, y) => bombs.some((b) => Math.abs(x - b.x) <= bombReach && Math.abs(y - b.y) <= bombReach);

  // Food: cell -> value.
  const food = new Map();
  for (const a of state.apples) food.set(key(a.x, a.y), VALUE.apple);
  for (const p of state.powerUps ?? []) food.set(key(p.x, p.y), VALUE.powerUp);
  for (const r of state.rats ?? []) food.set(key(r.x, r.y), VALUE.rat);
  for (const c of state.chickens ?? []) food.set(key(c.x, c.y), VALUE.chicken);

  const portalExit = new Map();
  for (const p of state.portals ?? []) {
    if (p.closing) continue; // can't be entered
    const [a, b] = p.ends;
    portalExit.set(key(a.x, a.y), b);
    portalExit.set(key(b.x, b.y), a);
  }

  // One step as the engine takes it: wrapped or into a wall (null), then
  // through a portal end.
  function step(from, dir) {
    const d = DIRECTIONS[dir];
    let x = from.x + d.x;
    let y = from.y + d.y;
    if (wrap) {
      x = (x + n) % n;
      y = (y + n) % n;
    } else if (!inBounds(x, y)) return null;
    const exit = portalExit.get(key(x, y));
    return exit ? { x: exit.x, y: exit.y } : { x, y };
  }

  // Manhattan distance, the short way round when walls wrap.
  function distance(a, b) {
    let dx = Math.abs(a.x - b.x);
    let dy = Math.abs(a.y - b.y);
    if (wrap) {
      dx = Math.min(dx, n - dx);
      dy = Math.min(dy, n - dy);
    }
    return dx + dy;
  }

  return {
    n,
    size,
    key,
    step,
    distance,
    snakes,
    order,
    movesNext,
    freeAt,
    owner,
    segIndex,
    deadly,
    badger,
    badgerActive,
    inBadger,
    badgerDistance,
    bombs,
    inBomb,
    onLaser,
    food,
  };
}

// ---- one bot ----

// With `reflex` it only turns away from certain death straight ahead (dir
// null: keep going).
function decide(board, me, { skill, bombMode, budget, random, reflex = false }) {
  const { key, step } = board;
  const myIndex = board.order.indexOf(me);
  const scissors = me.effect === 'scissors';
  const shield = me.effect === 'shield';
  const golden = me.effect === 'golden';
  const carefree = me.ghostMs > BOT_BRAIN.ghostSafeMs; // ignores steps 1 and 2
  const ghostNow = me.ghostMs > 0; // its next move passes through anything but walls
  let nodes = 0;
  const left = () => budget - nodes;

  // How bad entering `cell` on its own move `t` (1 = this move) is, when the
  // other snakes have made `othersT` moves (a golden snake's second move this
  // tick is its move 2 but still their move 1).
  function danger(cell, t, canCut, othersT = t) {
    if (!cell) return DEADLY; // a wall
    if (ghostNow && othersT === 1) return SAFE;
    const k = key(cell.x, cell.y);
    let tier = SAFE;
    if (board.deadly[k] || board.onLaser(cell.x, cell.y, me.id)) tier = DEADLY;
    if (board.badgerActive && board.inBadger(cell.x, cell.y)) tier = Math.max(tier, canCut ? SAFE : DEADLY);
    const own = board.owner[k] === myIndex;
    if (board.freeAt[k] > (own ? t : othersT)) {
      // A segment still there when the head arrives. Scissors cut it, unless
      // it's its own or the head of a snake that isn't moving.
      const body = board.segIndex[k] >= 1 || board.movesNext(board.order[board.owner[k]]);
      tier = Math.max(tier, canCut && !own && body ? SAFE : DEADLY);
    }
    if (board.inBomb(cell.x, cell.y)) {
      const drop = Math.max(1, Math.round(me.length * POWER_UP_RULES.bombShrink));
      const kills = bombMode === 'kill' || me.length - drop < POWER_UP_RULES.minLength;
      tier = Math.max(tier, kills ? DEADLY : BAD);
    }
    if (tier === DEADLY && shield) tier = BAD; // the shield takes it
    return tier;
  }

  // Free cells reachable from `start` (entered on move 1), up to `cap`,
  // counting segments that will have left by the time they're reached.
  // `via`: a cell the head passed on the way (a golden snake's first), body by then.
  function space(start, cap, via = null) {
    const seen = new Set([key(start.x, start.y)]);
    if (via) seen.add(key(via.x, via.y));
    let frontier = [start];
    let count = 1;
    for (let t = 2; frontier.length && count < cap; t++) {
      const next = [];
      for (const c of frontier) {
        for (const d of DIRS) {
          if (count >= cap || nodes >= budget) break;
          nodes++;
          const to = step(c, d);
          if (!to) continue;
          const k = key(to.x, to.y);
          if (seen.has(k) || board.freeAt[k] > t || board.deadly[k]) continue;
          if (board.badgerActive && board.inBadger(to.x, to.y)) continue;
          seen.add(k);
          next.push(to);
          count++;
        }
      }
      frontier = next;
    }
    return count;
  }

  // The moves: not straight back. A golden snake moves twice a tick, so its
  // moves are paths of two (first direction, then second, neither a
  // reversal), judged by both cells and weighed by where it ends up (`end`).
  const moves = [];
  for (const dir of DIRS) {
    if (dir === OPPOSITE[me.dir]) continue;
    const cell = step(me.head, dir);
    const tier = carefree ? (cell ? SAFE : DEADLY) : danger(cell, 1, scissors);
    if (!golden) {
      moves.push({ dir, dir2: null, cell, end: cell, tier, space: 0, flee: 0, hunt: 0 });
      continue;
    }
    for (const dir2 of DIRS) {
      if (dir2 === OPPOSITE[dir]) continue;
      const cell2 = cell && step(cell, dir2);
      let tier2 = tier;
      if (tier < DEADLY) {
        // Scissors still unused only if the first cell wasn't a cut.
        const canCut = scissors && board.freeAt[key(cell.x, cell.y)] <= 1;
        tier2 = Math.max(tier, carefree ? (cell2 ? SAFE : DEADLY) : danger(cell2, 2, canCut, 1));
      }
      moves.push({ dir, dir2, cell, cell2, end: cell2 ?? cell, tier: tier2, space: 0, flee: 0, hunt: 0 });
    }
  }
  const answer = (m) => ({ dir: m.dir, dir2: m.dir2, nodes });
  const straight = (m) => m.dir === me.dir && (!golden || m.dir2 === me.dir);
  const best = Math.min(...moves.map((m) => m.tier));
  // Every move is deadly: at least not a wall (another snake might move).
  // Which snake gets the kill doesn't depend on it: the engine credits a
  // snake that boxed this one in, whichever way it goes.
  if (best === DEADLY) {
    const into = moves.find((m) => m.cell && (!golden || m.cell2)) ?? moves.find((m) => m.cell) ?? moves[0];
    return reflex && straight(into) ? { dir: null, dir2: null, nodes } : answer(into);
  }
  if (reflex) {
    const ahead = moves.find(straight);
    if (ahead && ahead.tier < DEADLY) return { dir: null, dir2: null, nodes };
    const ways = moves.filter((m) => m.tier === best);
    return answer(ways[Math.floor(random() * ways.length)]);
  }
  const options = moves.filter((m) => m.tier === best); // each with its cells: walls are deadly
  if (options.length === 1) return answer(options[0]);

  // Out of budget: the cheap answer, straight on if it's among the best.
  const cheap = () => answer(options.find(straight) ?? options[0]);
  if (left() <= 0) return cheap();

  // 1. Room: a pocket smaller than the snake is a trap.
  const want = me.length + BOT_BRAIN.spaceExtra;
  for (const m of options) {
    m.space = carefree ? want : space(m.end, want, golden ? m.cell : null);
    m.trapped = m.space < me.length;
  }
  // The budget ran out mid-count: the counts can't be compared.
  if (left() <= 0) return cheap();

  // 2. Flee: heads that win or tie a head-on, the badger, bombs.
  const threats = carefree
    ? []
    : [...board.snakes.values()].filter((s) => s !== me && s.alive && s.ghostMs <= 0 && s.length <= me.length);
  const R = BOT_BRAIN.fleeRadius;
  for (const m of options) {
    if (carefree) break;
    const at = m.end;
    for (const s of threats) {
      const d = board.distance(at, s.head);
      if (d <= R) m.flee += (R + 1 - d) * (d <= 1 ? 4 : 1); // right next to it: it could move there
    }
    if (board.badger && !scissors) {
      const d = board.badgerDistance(at.x, at.y);
      if (d <= R) m.flee += (R + 1 - d) * 2;
    }
    for (const b of board.bombs) {
      const d = Math.max(0, Math.abs(at.x - b.x) - 1) + Math.max(0, Math.abs(at.y - b.y) - 1);
      if (d <= 1) m.flee += 2 - d;
    }
  }

  // 3. Hunt: a breadth-first search from where the safe moves end, best
  // value / moves. Every path ending on the target's cell gets it; a golden
  // path also scores food on its first cell (eaten on move 1).
  const target = hunt(board, me, options.filter((m) => !m.trapped), {
    scissors,
    myIndex,
    first: golden ? 2 : 1,
    cap: Math.min(BOT_BRAIN.huntNodes, Math.max(0, left())),
    count: (k) => (nodes += k),
  });
  if (target) {
    const k = key(target.from.end.x, target.from.end.y);
    for (const m of options) if (key(m.end.x, m.end.y) === k) m.hunt = target.score;
  }
  if (golden) for (const m of options) if (!m.trapped) m.hunt = Math.max(m.hunt, board.food.get(key(m.cell.x, m.cell.y)) ?? 0);

  // A mistake (lower skill): any move that's safe and roomy.
  const roomy = options.filter((m) => !m.trapped);
  if (!carefree && roomy.length && random() < (BOT_BRAIN.mistakeChance[skill] ?? 0)) {
    return answer(roomy[Math.floor(random() * roomy.length)]);
  }

  // Trapped moves only when every move is; then the roomiest.
  const score = (m) =>
    (m.trapped ? -1e6 + m.space * 100 : 0) - m.flee * 10 + m.hunt * 30 +
    (m.dir === me.dir ? 1 : 0) + (golden && m.dir2 === m.dir ? 0.5 : 0) + m.space * 0.01;
  options.sort((a, b) => score(b) - score(a));
  return answer(options[0]);
}

// The best target reachable from the moves `starts` (from each one's `end`,
// reached on move `first`): { from: the move, score }.
function hunt(board, me, starts, { scissors, myIndex, first = 1, cap, count }) {
  if (!starts.length || cap <= 0) return null;
  const { key, step } = board;
  const seen = new Set();
  let frontier = [];
  for (const m of starts) {
    const k = key(m.end.x, m.end.y);
    if (seen.has(k)) continue;
    seen.add(k);
    frontier.push({ cell: m.end, from: m });
  }
  const valueAt = (c, k) => {
    let v = board.food.get(k) ?? 0;
    if (scissors) {
      const o = board.owner[k];
      if (o >= 0 && o !== myIndex && board.segIndex[k] >= 1) v = Math.max(v, VALUE.target);
      if (board.badgerActive && board.inBadger(c.x, c.y)) v = Math.max(v, VALUE.target);
    }
    return v;
  };
  let best = null;
  let used = 0;
  for (let t = first; frontier.length && used < cap; t++) {
    const next = [];
    for (const f of frontier) {
      const k = key(f.cell.x, f.cell.y);
      const v = valueAt(f.cell, k);
      if (v > 0) {
        const score = v / t;
        if (!best || score > best.score) best = { from: f.from, score };
      }
      // Don't search past a target (the body or badger it would hit).
      if (scissors && v === VALUE.target) continue;
      for (const d of DIRS) {
        if (used >= cap) break;
        used++;
        const to = step(f.cell, d);
        if (!to) continue;
        const tk = key(to.x, to.y);
        if (seen.has(tk) || board.deadly[tk]) continue;
        const blocked = board.freeAt[tk] > t + 1; // entered on move t + 1
        const target = scissors && valueAt(to, tk) === VALUE.target;
        if ((blocked || (board.badgerActive && board.inBadger(to.x, to.y))) && !target) continue;
        seen.add(tk);
        next.push({ cell: to, from: f.from });
      }
    }
    frontier = next;
    // Nothing further can beat the best so far by much: stop early.
    if (best && best.score >= VALUE.chicken / (t + 1)) break;
  }
  count(used);
  return best;
}
