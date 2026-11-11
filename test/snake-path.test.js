import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildChains, snakePath, pointAt, subPath } from '../src/shared/snake-path.js';

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
