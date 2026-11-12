// Geometry for drawing a snake smoothly between two ticks. Pure functions,
// shared by /display and the tests; no DOM, no canvas.
//
// A snake is drawn as a polyline through cell centers. Positions along it are
// measured by `u`: u = i is the center of the i-th cell of the path (0 = the
// head's cell). Between ticks, every segment slides from its previous cell to
// its current one, so segment j sits at u = j + (1 - t): the head pokes out of
// the neck towards its new cell and the tail retracts from the cell it left.
// A golden snake moves two cells a tick, so its segments slide by 2 (1 - t).
//
// Wherever two consecutive cells aren't grid-adjacent the path is split into
// separate chains, so no line is ever drawn across the board:
// - a wrap-around (opposite edges) gets one virtual cell past the edge on
//   each side, so both halves run off the board instead of stopping short;
// - any other jump (e.g. a future portal) is a plain split, and segments
//   don't slide across it (they snap).

const adjacent = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
const sameCell = (a, b) => Boolean(a && b) && a.x === b.x && a.y === b.y;

// Unit step from `back` to `front` across opposite edges, or null.
function wrapStep(front, back, gridSize) {
  const dx = front.x - back.x;
  const dy = front.y - back.y;
  if (dy === 0 && Math.abs(dx) === gridSize - 1) return { x: -Math.sign(dx), y: 0 };
  if (dx === 0 && Math.abs(dy) === gridSize - 1) return { x: 0, y: -Math.sign(dy) };
  return null;
}

/**
 * Splits a list of cells (head first) into drawable chains.
 * @returns {Array<Array<{x:number, y:number, u:number}>>} consecutive points
 *   in a chain are always exactly one cell apart and one u apart.
 */
export function buildChains(cells, gridSize) {
  if (!cells.length) return [];
  const chains = [];
  let chain = [{ x: cells[0].x, y: cells[0].y, u: 0 }];
  for (let i = 1; i < cells.length; i++) {
    const p = cells[i - 1];
    const q = cells[i];
    if (adjacent(p, q)) {
      chain.push({ x: q.x, y: q.y, u: i });
      continue;
    }
    const d = wrapStep(p, q, gridSize);
    if (d) {
      chain.push({ x: p.x - d.x, y: p.y - d.y, u: i }); // past p's edge
      chains.push(chain);
      chain = [{ x: q.x + d.x, y: q.y + d.y, u: i - 1 }, { x: q.x, y: q.y, u: i }]; // past q's edge
    } else {
      chains.push(chain);
      chain = [{ x: q.x, y: q.y, u: i }];
    }
  }
  chains.push(chain);
  return chains;
}

/**
 * Where to draw a snake at fraction `t` (0..1) of the tick that produced `cur`.
 * @param {{segments: {x,y}[]}} cur snake in the latest state
 * @param {{segments: {x,y}[]}|null} prev the same snake one tick earlier, or
 *   null when there's nothing to slide from (new round, just joined, dead...)
 * @param {number} t
 * @param {number} gridSize
 * @returns {{ chains, front: number, back: number, segU: number[] }}
 *   front/back: u range to draw; segU[j]: u of segment j's center.
 */
export function snakePath(cur, prev, t, gridSize) {
  const segs = cur.segments;
  const n = segs.length;
  const old = prev?.segments ?? [];
  const k = cellsMoved(segs, old);
  // The old tail cells it left behind (fewer when it grew), so the tail can
  // retract out of them.
  const dropped = Math.max(0, k - Math.max(0, n - old.length));
  const cells = dropped ? [...segs, ...old.slice(old.length - dropped)] : segs;
  const chains = buildChains(cells, gridSize);

  const linked = (i) => adjacent(cells[i], cells[i + 1]) || Boolean(wrapStep(cells[i], cells[i + 1], gridSize));
  const segU = new Array(n);
  for (let j = 0; j < n; j++) {
    // Segments that existed one tick ago slide back along the k cells they
    // came through. A segment added by growth slides only as far as the
    // tail actually moved (in place after a one-cell move), and nothing
    // slides across a jump.
    const by = j < old.length ? k : dropped;
    let slides = by > 0 && j + by < cells.length;
    for (let i = j; slides && i < j + by; i++) slides = linked(i);
    segU[j] = slides ? j + by * (1 - Math.min(1, Math.max(0, t))) : j;
  }
  return { chains, front: segU[0] ?? 0, back: segU[n - 1] ?? 0, segU };
}

// How many cells the snake moved since `old`: 0 (dead, frozen or no
// previous state), 1, or 2 (golden).
function cellsMoved(segs, old) {
  const n = segs.length;
  if (!old.length || !n) return 0;
  if (n === 1) return !sameCell(segs[0], old[0]) && old.length === 1 ? 1 : 0;
  for (const k of [1, 2]) if (n > k && sameCell(segs[k], old[0])) return k;
  return 0;
}

// Point at position u on a chain (u must be within the chain's range).
export function pointAt(chain, u) {
  const first = chain[0].u;
  const i = Math.min(chain.length - 2, Math.max(0, Math.floor(u - first)));
  if (chain.length === 1) return { x: chain[0].x, y: chain[0].y };
  const a = chain[i];
  const b = chain[i + 1];
  const f = u - a.u;
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// ---- rounded corners (for the stripes) ----
// The body is drawn along the straight path, with round joins. Stripes follow
// a smoothed path instead: within half a cell of a corner it is a quarter
// circle of radius 1/2, from the middle of one cell edge to the middle of the
// next. Measured along it, a stripe's ends point out from the circle's center,
// so they turn through the bend instead of cutting straight across it.

// The corner at chain point i, or null if the path goes straight there.
function cornerAt(chain, i) {
  if (i <= 0 || i >= chain.length - 1) return null;
  const a = chain[i - 1];
  const c = chain[i];
  const b = chain[i + 1];
  const din = { x: c.x - a.x, y: c.y - a.y };
  const dout = { x: b.x - c.x, y: b.y - c.y };
  if (din.x === dout.x && din.y === dout.y) return null;
  return { c, din, dout };
}

/**
 * Point and unit tangent (direction of increasing u) at position u on the
 * smoothed path. u must be within the chain's range.
 * @returns {{x:number, y:number, tx:number, ty:number}}
 */
export function smoothPointAt(chain, u) {
  const first = chain[0].u;
  const i = Math.min(chain.length - 1, Math.max(0, Math.round(u - first)));
  const k = cornerAt(chain, i);
  if (k && Math.abs(u - chain[i].u) <= 0.5) {
    const { c, din, dout } = k;
    const a = (u - chain[i].u + 0.5) * (Math.PI / 2); // 0 at the incoming edge, 90 degrees at the outgoing one
    const ox = c.x + (dout.x - din.x) / 2; // the circle's center: a grid corner
    const oy = c.y + (dout.y - din.y) / 2;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    return {
      x: ox + (-dout.x * cos + din.x * sin) / 2,
      y: oy + (-dout.y * cos + din.y * sin) / 2,
      tx: din.x * cos + dout.x * sin,
      ty: din.y * cos + dout.y * sin,
    };
  }
  const p = pointAt(chain, u);
  if (chain.length === 1) return { ...p, tx: 0, ty: 0 };
  const s = Math.min(chain.length - 2, Math.max(0, Math.floor(u - first)));
  return { ...p, tx: chain[s + 1].x - chain[s].x, ty: chain[s + 1].y - chain[s].y };
}

/**
 * The smoothed path between u0 and u1 as a list of points (sampled every
 * `step`, so arcs come out round), or null if the chain doesn't overlap.
 */
export function smoothSubPath(chain, u0, u1, step = 0.125) {
  const lo = Math.max(u0, chain[0].u);
  const hi = Math.min(u1, chain[chain.length - 1].u);
  if (lo > hi) return null;
  const pts = [smoothPointAt(chain, lo)];
  for (let u = (Math.floor(lo / step) + 1) * step; u < hi - 1e-9; u += step) pts.push(smoothPointAt(chain, u));
  if (hi > lo) pts.push(smoothPointAt(chain, hi));
  return pts;
}

/**
 * The part of a chain between u0 and u1, as a list of points (corners kept),
 * or null if the chain doesn't overlap that range.
 */
export function subPath(chain, u0, u1) {
  const lo = Math.max(u0, chain[0].u);
  const hi = Math.min(u1, chain[chain.length - 1].u);
  if (lo > hi) return null;
  const pts = [pointAt(chain, lo)];
  for (const p of chain) if (p.u > lo && p.u < hi) pts.push({ x: p.x, y: p.y });
  if (hi > lo) pts.push(pointAt(chain, hi));
  return pts;
}
