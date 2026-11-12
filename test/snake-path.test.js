import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildChains, snakePath, pointAt, subPath, smoothPointAt, smoothSubPath } from '../src/shared/snake-path.js';

const cells = (list) => list.map(([x, y]) => ({ x, y }));
const snake = (list) => ({ segments: cells(list) });
const N = 10;

// No line may ever jump: inside a chain, consecutive points are one cell apart.
function assertContinuous(chains) {
  for (const chain of chains) {
    for (let i = 1; i < chain.length; i++) {
      const a = chain[i - 1];
      const b = chain[i];
      assert.equal(Math.abs(a.x - b.x) + Math.abs(a.y - b.y), 1, `gap between ${JSON.stringify(a)} and ${JSON.stringify(b)}`);
      assert.equal(b.u - a.u, 1);
    }
  }
}

// Every drawn sub-path stays within one cell per step, at any t.
function assertDrawable(path) {
  assertContinuous(path.chains);
  for (const chain of path.chains) {
    const pts = subPath(chain, path.front, path.back);
    if (!pts) continue;
    for (let i = 1; i < pts.length; i++) {
      assert.ok(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) <= 1 + 1e-9);
    }
  }
}

describe('chains', () => {
  test('a straight snake is one chain', () => {
    const chains = buildChains(cells([[3, 3], [2, 3], [1, 3]]), N);
    assert.equal(chains.length, 1);
    assertContinuous(chains);
  });

  test('a wrap splits the chain and runs both halves off the edge', () => {
    const chains = buildChains(cells([[0, 4], [9, 4], [8, 4]]), N);
    assert.equal(chains.length, 2);
    assertContinuous(chains);
    assert.deepEqual(chains[0], [{ x: 0, y: 4, u: 0 }, { x: -1, y: 4, u: 1 }]);
    assert.deepEqual(chains[1][0], { x: 10, y: 4, u: 0 });
  });

  test('a vertical wrap works the same way', () => {
    const chains = buildChains(cells([[5, 9], [5, 0], [5, 1]]), N);
    assert.equal(chains.length, 2);
    assertContinuous(chains);
    assert.deepEqual(chains[0][1], { x: 5, y: 10, u: 1 });
    assert.deepEqual(chains[1][0], { x: 5, y: -1, u: 0 });
  });

  test('any other jump is a plain split with no virtual cells', () => {
    const chains = buildChains(cells([[2, 2], [7, 7], [7, 8]]), N);
    assert.equal(chains.length, 2);
    assert.deepEqual(chains[0], [{ x: 2, y: 2, u: 0 }]);
    assert.deepEqual(chains[1], [{ x: 7, y: 7, u: 1 }, { x: 7, y: 8, u: 2 }]);
  });
});

describe('interpolation', () => {
  const before = snake([[3, 3], [2, 3], [1, 3]]);
  const after = snake([[4, 3], [3, 3], [2, 3]]);

  test('the head slides forward and the tail retracts', () => {
    for (const t of [0, 0.5, 1]) {
      const p = snakePath(after, before, t, N);
      assertDrawable(p);
      const chain = p.chains[0];
      assert.deepEqual(pointAt(chain, p.front), { x: 3 + t, y: 3 });
      assert.deepEqual(pointAt(chain, p.back), { x: 1 + t, y: 3 });
    }
  });

  test('corners stay square: the path goes through the corner cell', () => {
    const p = snakePath(snake([[3, 2], [3, 3], [2, 3]]), snake([[3, 3], [2, 3], [1, 3]]), 0.5, N);
    const pts = subPath(p.chains[0], p.front, p.back);
    assert.ok(pts.some((q) => q.x === 3 && q.y === 3));
  });

  test('a growing snake keeps its tail in place', () => {
    const grown = snake([[4, 3], [3, 3], [2, 3], [1, 3]]);
    for (const t of [0, 0.5, 1]) {
      const p = snakePath(grown, before, t, N);
      assertDrawable(p);
      assert.deepEqual(pointAt(p.chains[0], p.back), { x: 1, y: 3 });
      assert.deepEqual(pointAt(p.chains[0], p.front), { x: 3 + t, y: 3 });
    }
  });

  test('no previous state, a respawn or a dead snake: drawn in place', () => {
    const respawned = snake([[7, 7], [7, 8], [7, 9]]);
    for (const [cur, prev] of [[after, null], [respawned, after], [before, before]]) {
      const p = snakePath(cur, prev, 0.3, N);
      assertDrawable(p);
      assert.equal(p.front, 0);
      assert.equal(p.back, 2);
    }
  });

  test('head wrapping: both halves of the head are on their own chains', () => {
    const prev = snake([[9, 4], [8, 4], [7, 4]]);
    const cur = snake([[0, 4], [9, 4], [8, 4]]);
    for (const t of [0, 0.5, 1]) {
      const p = snakePath(cur, prev, t, N);
      assertDrawable(p);
      assert.equal(p.chains.length, 2);
      // Leaving on the right: the head pokes past x = 9 by t.
      assert.deepEqual(pointAt(p.chains[1], p.front), { x: 9 + t, y: 4 });
      // Entering on the left: the same head, coming in from x = -1.
      assert.deepEqual(pointAt(p.chains[0], p.front), { x: -1 + t, y: 4 });
    }
  });

  test('tail wrapping: the old tail retracts off the edge', () => {
    const prev = snake([[1, 4], [0, 4], [9, 4]]);
    const cur = snake([[2, 4], [1, 4], [0, 4]]);
    for (const t of [0, 0.5, 1]) {
      const p = snakePath(cur, prev, t, N);
      assertDrawable(p);
      assert.equal(p.chains.length, 2);
      assert.deepEqual(pointAt(p.chains[1], p.back), { x: 9 + t, y: 4 });
      assert.deepEqual(pointAt(p.chains[0], p.back), { x: -1 + t, y: 4 });
    }
  });

  test('nothing slides across a jump', () => {
    const prev = snake([[2, 2], [2, 3], [2, 4]]);
    const cur = snake([[8, 8], [2, 2], [2, 3]]); // e.g. through a portal
    const p = snakePath(cur, prev, 0.5, N);
    assertDrawable(p);
    assert.equal(p.front, 0);
    assert.deepEqual(pointAt(p.chains[0], p.front), { x: 8, y: 8 });
  });

  test('a one-cell snake slides as a dot', () => {
    const p = snakePath(snake([[5, 5]]), snake([[4, 5]]), 0.25, N);
    assert.equal(p.front, p.back);
    assert.deepEqual(pointAt(p.chains[0], p.front), { x: 4.25, y: 5 });
  });
});

describe('two cells per tick (golden)', () => {
  const prev = snake([[3, 3], [2, 3], [1, 3]]);

  test('the head slides two cells and the tail retracts two', () => {
    const cur = snake([[5, 3], [4, 3], [3, 3]]);
    for (const t of [0, 0.25, 0.5, 1]) {
      const p = snakePath(cur, prev, t, N);
      assertDrawable(p);
      assert.deepEqual(pointAt(p.chains[0], p.front), { x: 3 + 2 * t, y: 3 });
      assert.deepEqual(pointAt(p.chains[0], p.back), { x: 1 + 2 * t, y: 3 });
    }
  });

  test('growing by one on the way: the tail moves one cell', () => {
    const cur = snake([[5, 3], [4, 3], [3, 3], [2, 3]]);
    const p = snakePath(cur, prev, 0.5, N);
    assertDrawable(p);
    assert.deepEqual(pointAt(p.chains[0], p.front), { x: 4, y: 3 });
    assert.deepEqual(pointAt(p.chains[0], p.back), { x: 1.5, y: 3 });
  });

  test('growing by two: the tail stays put', () => {
    const cur = snake([[5, 3], [4, 3], [3, 3], [2, 3], [1, 3]]);
    const p = snakePath(cur, prev, 0.5, N);
    assertDrawable(p);
    assert.deepEqual(pointAt(p.chains[0], p.back), { x: 1, y: 3 });
  });

  test('through a wrapping edge', () => {
    const cur = snake([[0, 3], [9, 3], [8, 3]]);
    const p = snakePath(cur, snake([[8, 3], [7, 3], [6, 3]]), 0.5, N);
    assertDrawable(p);
    assert.equal(p.front, 1);
  });

  test('a portal jump on the way: nothing slides across it', () => {
    // Head went (3,3) -> (4,3), then into a portal at (5,3) and out at (8,8).
    const cur = snake([[8, 8], [4, 3], [3, 3]]);
    const p = snakePath(cur, prev, 0.5, N);
    assertDrawable(p);
    assert.equal(p.front, 0);
    assert.deepEqual(pointAt(p.chains[0], p.front), { x: 8, y: 8 });
    assert.equal(p.chains.length, 2);
  });
});

describe('rounded corners (stripes)', () => {
  // A zigzag like the playtest one: right, down, left, down, right.
  const zig = buildChains(cells([[0, 0], [1, 0], [2, 0], [2, 1], [1, 1], [0, 1], [0, 2], [1, 2], [2, 2]]), N)[0];
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  test('straight parts are unchanged', () => {
    const p = smoothPointAt(zig, 1);
    assert.deepEqual([p.x, p.y, p.tx, p.ty], [1, 0, 1, 0]);
  });

  test('a corner is a quarter circle of radius 1/2 around the grid corner, from edge middle to edge middle', () => {
    // Corner at (2,0) (u = 2): in going right, out going down; circle center (1.5, 0.5).
    const start = smoothPointAt(zig, 1.5);
    const end = smoothPointAt(zig, 2.5);
    assert.ok(near(start.x, 1.5) && near(start.y, 0) && near(start.tx, 1) && near(start.ty, 0));
    assert.ok(near(end.x, 2) && near(end.y, 0.5) && near(end.tx, 0) && near(end.ty, 1));
    for (const u of [1.6, 1.8, 2, 2.2, 2.4]) {
      const p = smoothPointAt(zig, u);
      assert.ok(near(Math.hypot(p.x - 1.5, p.y - 0.5), 0.5), `u = ${u}`);
      assert.ok(near(Math.hypot(p.tx, p.ty), 1));
      // The tangent is square to the radius, so a stripe's end points out from the center.
      assert.ok(near((p.x - 1.5) * p.tx + (p.y - 0.5) * p.ty, 0));
    }
  });

  test('back-to-back corners (a U-turn) share one center and join smoothly', () => {
    // Corners at (2,0) and (2,1) both turn around (1.5, 0.5).
    for (const u of [2.5, 2.7, 3, 3.3]) {
      const p = smoothPointAt(zig, u);
      assert.ok(near(Math.hypot(p.x - 1.5, p.y - 0.5), 0.5), `u = ${u}`);
    }
  });

  test('the smoothed path is continuous and stays well inside the body', () => {
    const pts = smoothSubPath(zig, 0, 8);
    for (let i = 1; i < pts.length; i++) assert.ok(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) <= 0.125 + 1e-9);
    // Never more than 0.21 cells off the straight path (the body is 0.35 each side).
    const poly = subPath(zig, 0, 8);
    const distToPoly = (q) => {
      let best = Infinity;
      for (let i = 1; i < poly.length; i++) {
        const a = poly[i - 1];
        const b = poly[i];
        const t = Math.max(0, Math.min(1, ((q.x - a.x) * (b.x - a.x) + (q.y - a.y) * (b.y - a.y)) / ((b.x - a.x) ** 2 + (b.y - a.y) ** 2)));
        best = Math.min(best, Math.hypot(q.x - (a.x + t * (b.x - a.x)), q.y - (a.y + t * (b.y - a.y))));
      }
      return best;
    };
    for (const q of pts) assert.ok(distToPoly(q) <= 0.21, `${q.x},${q.y}`);
  });

  test('ranges outside the chain give null; a wrap split keeps working', () => {
    assert.equal(smoothSubPath(zig, 9, 10), null);
    const [a, b] = buildChains(cells([[0, 4], [9, 4], [8, 4]]), N);
    assert.deepEqual(smoothSubPath(a, 0, 1).map((p) => [p.x, p.y]).at(-1), [-1, 4]);
    assert.ok(smoothSubPath(b, 0, 2).every((p) => p.y === 4));
  });
});
