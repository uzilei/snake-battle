import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildChains, snakePath, pointAt, subPath, smoothPointAt, smoothSubPath, travelDirAt, turnProgress, taperScale } from '../src/shared/snake-path.js';

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

describe("direction of travel (the head's heading)", () => {
  test('a head that just turned faces the new way from the start of the tick', () => {
    // Was going right along y = 3, turned up at (3, 3).
    const prev = snake([[3, 3], [2, 3], [1, 3]]);
    const cur = snake([[3, 2], [3, 3], [2, 3]]);
    for (const t of [0, 0.3, 1]) {
      const { chains, front } = snakePath(cur, prev, t, N);
      assert.deepEqual(travelDirAt(chains, front), { x: 0, y: -1 });
    }
    // Further back the body still travels right.
    const { chains } = snakePath(cur, prev, 0.5, N);
    assert.deepEqual(travelDirAt(chains, 1.5), { x: 1, y: 0 });
  });

  test('golden: still the old way while on the first cell, the new way after the corner', () => {
    // Two cells right, then the turn: (3, 3) -> (4, 3) -> (4, 2).
    const prev = snake([[3, 3], [2, 3], [1, 3], [0, 3]]);
    const cur = snake([[4, 2], [4, 3], [3, 3], [2, 3]]);
    const at = (t) => {
      const { chains, front } = snakePath(cur, prev, t, N);
      return travelDirAt(chains, front);
    };
    assert.deepEqual(at(0.05), { x: 1, y: 0 }); // early: the head leads on a turning tick
    assert.deepEqual(at(0.75), { x: 0, y: -1 });
  });

  test('across a wrap, and nothing for a single point', () => {
    const chains = buildChains(cells([[0, 4], [9, 4], [8, 4]]), N);
    for (const u of [0, 0.5, 1, 1.5]) assert.deepEqual(travelDirAt(chains, u), { x: 1, y: 0 });
    assert.equal(travelDirAt(buildChains(cells([[2, 2]]), N), 0), null);
    assert.equal(travelDirAt(chains, 5), null);
  });
});

describe('snappier turns: the head runs ahead on a turning tick', () => {
  const TS = [0, 0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1];
  const plain = (cur, prev, t) => {
    // What the head would do with the plain slide: every other segment.
    const { segU } = snakePath(cur, prev, t, N);
    return segU.slice(1);
  };

  test('the curve: from 0 to 1, never backwards, more than halfway by 30% of the tick', () => {
    assert.equal(turnProgress(0), 0);
    assert.ok(Math.abs(turnProgress(1) - 1) < 1e-12);
    assert.ok(turnProgress(0.3) >= 0.5);
    let last = -1;
    for (let i = 0; i <= 200; i++) {
      const v = turnProgress(i / 200);
      assert.ok(v >= last - 1e-12);
      last = v;
    }
  });

  test('a turn: the head leads, lands on time, and the rest of the body is untouched', () => {
    const prev = snake([[3, 3], [2, 3], [1, 3], [0, 3]]);
    const cur = snake([[3, 2], [3, 3], [2, 3], [1, 3]]);
    for (const t of TS) {
      const path = snakePath(cur, prev, t, N);
      assert.ok(Math.abs(path.front - (1 - turnProgress(t))) < 1e-12);
      assert.deepEqual(path.segU.slice(1), plain(cur, prev, t));
      assertDrawable(path);
    }
    assert.equal(snakePath(cur, prev, 0, N).front, 1);
    assert.equal(snakePath(cur, prev, 1, N).front, 0);
    assert.ok(snakePath(cur, prev, 0.3, N).front <= 0.5);
  });

  test('straight on: the plain slide, exactly as before', () => {
    const prev = snake([[3, 3], [2, 3], [1, 3]]);
    const cur = snake([[4, 3], [3, 3], [2, 3]]);
    for (const t of TS) assert.equal(snakePath(cur, prev, t, N).front, 1 - t);
  });

  test('golden: a corner at either cell of a two-cell move counts', () => {
    const prev = snake([[3, 3], [2, 3], [1, 3], [0, 3]]);
    const lateTurn = snake([[4, 2], [4, 3], [3, 3], [2, 3]]); // right, then up
    const earlyTurn = snake([[3, 1], [3, 2], [3, 3], [2, 3]]); // up at once
    const straight = snake([[5, 3], [4, 3], [3, 3], [2, 3]]);
    for (const t of TS) {
      for (const cur of [lateTurn, earlyTurn]) {
        const path = snakePath(cur, prev, t, N);
        assert.ok(Math.abs(path.front - 2 * (1 - turnProgress(t))) < 1e-12);
        assertDrawable(path);
      }
      assert.equal(snakePath(straight, prev, t, N).front, 2 * (1 - t));
    }
  });

  test('turning while it grows, and across a wrap', () => {
    // Grew: the tail stays, the head turns.
    const prev = snake([[3, 3], [2, 3], [1, 3]]);
    const grown = snake([[3, 4], [3, 3], [2, 3], [1, 3]]);
    // Wrapped off the right edge at y = 3 and turned down straight after.
    const wPrev = snake([[0, 3], [9, 3], [8, 3]]);
    const wCur = snake([[0, 4], [0, 3], [9, 3]]);
    for (const t of TS) {
      for (const [cur, old] of [[grown, prev], [wCur, wPrev]]) {
        const path = snakePath(cur, old, t, N);
        assert.ok(Math.abs(path.front - (1 - turnProgress(t))) < 1e-12);
        assertDrawable(path);
      }
    }
    // Going straight across the wrap is a plain slide.
    const sCur = snake([[1, 3], [0, 3], [9, 3]]);
    assert.equal(snakePath(sCur, wPrev, 0.2, N).front, 0.8);
  });

  test('no lead without movement or for a one-cell snake', () => {
    const one = snake([[3, 3]]);
    assert.equal(snakePath(snake([[3, 2]]), one, 0.2, N).front, 0.8);
    const still = snake([[3, 2], [3, 3], [2, 3]]);
    assert.equal(snakePath(still, still, 0.2, N).front, 0);
  });
});

describe('taperScale', () => {
  const widths = (count) => Array.from({ length: count }, (_, j) => Math.round(taperScale(j, count) * 100));

  test('the head is always full width', () => {
    for (const count of [1, 2, 5, 21, 100]) assert.equal(taperScale(0, count), 1);
  });

  test('a short snake gets only the first steps, two segments each', () => {
    assert.deepEqual(widths(5), [100, 95, 95, 90, 90]); // 4 body segments: a 90% tail
    assert.deepEqual(widths(6), [100, 100, 95, 95, 90, 90]); // an odd segment left over stays full width
    assert.deepEqual(widths(2), [100, 100]); // one body segment: no full step fits
  });

  test('16 body segments and up reach the 60% minimum at the tail', () => {
    assert.deepEqual(widths(17), [100, 95, 95, 90, 90, 85, 85, 80, 80, 75, 75, 70, 70, 65, 65, 60, 60]);
    const w = widths(21); // 20 body segments
    assert.equal(w.at(-1), 60);
    assert.deepEqual(w.slice(1, 5), [100, 100, 100, 100]);
  });

  test('a long snake spreads its eight steps over the body', () => {
    const w = widths(41); // 40 body segments: five per step
    assert.deepEqual(w.slice(1), [95, 90, 85, 80, 75, 70, 65, 60].flatMap((x) => Array(5).fill(x)));
  });

  test('widths never grow toward the tail', () => {
    for (const count of [3, 9, 18, 33, 77]) {
      const w = widths(count);
      for (let j = 1; j < count; j++) assert.ok(w[j] <= w[j - 1]);
    }
  });
});
