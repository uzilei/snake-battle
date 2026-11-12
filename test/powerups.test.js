// Power-ups: movement effects (golden, freeze, ghost), spawning and every
// pickup's effect. Board positions are set by hand through engine._debug.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';

// Deterministic RNG (mulberry32).
function seeded(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Starts a round with the given snakes placed exactly. `snakes` maps id ->
// [segments (head first, as [x, y]), dir]. Tick 1 starts the round, so the
// first playing tick is tick 2 (even).
function setup(snakes, config = {}) {
  const engine = createEngine({
    config: { gridSize: 20, appleCount: 0, intermissionMs: 0, ...config },
    random: seeded(42),
  });
  for (const id of Object.keys(snakes)) engine.addPlayer(id, id);
  engine.tick();
  engine._debug.setApples([]);
  for (const [id, [segments, dir]] of Object.entries(snakes)) engine._debug.setSnake(id, segments, dir);
  return engine;
}

const player = (e, id) => e.getState().players.find((p) => p.id === id);
const snake = (e, id) => e.getState().snakes.find((s) => s.id === id);
const head = (e, id) => {
  const { x, y } = snake(e, id).segments[0];
  return [x, y];
};
const cells = (e, id) => snake(e, id).segments.map((c) => [c.x, c.y]);
const far = { z: [[[18, 18], [17, 18], [16, 18]], 'up'] }; // a bystander, so rounds don't end

describe('golden', () => {
  test('moves two cells per tick while active', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.setEffect('a', 'golden', 3000);
    e.tick();
    assert.deepEqual(cells(e, 'a'), [[7, 5], [6, 5], [5, 5]]);
  });

  test('hits a one-cell-wide body in the first of its two cells', () => {
    // b is a vertical wall at x = 6; a would pass it on the way to x = 7.
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: [[[6, 2], [6, 3], [6, 4], [6, 5], [6, 6], [6, 7]], 'up'], ...far });
    e._debug.setEffect('a', 'golden', 3000);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').kills, 1);
  });

  test('the second cell sees the board after everyone else moved', () => {
    // b's tail leaves (7,5) in the first sub-step, so a may enter it in the second.
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: [[[7, 2], [7, 3], [7, 4], [7, 5]], 'up'], ...far });
    e._debug.setEffect('a', 'golden', 3000);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(head(e, 'a'), [7, 5]);
  });

  test('a head entering a snake that is not moving is a body hit, not a head-on', () => {
    // In the second sub-step b stands still, so its head is just body.
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: [[[8, 5], [8, 6], [8, 7], [8, 8]], 'left'], ...far });
    e._debug.setEffect('a', 'golden', 3000);
    e.tick(); // sub-step 1: a -> (6,5), b -> (7,5); sub-step 2: a -> (7,5) = b's head
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'alive');
    assert.equal(player(e, 'b').kills, 1);
  });

  test('uses one unit of pending growth per cell', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { growthPerApple: 3 });
    e._debug.setApples([[6, 5]]);
    e.tick(); // eats at (6,5) on its normal move: pending 3
    e._debug.setEffect('a', 'golden', 3000);
    e.tick(); // two cells, two units
    assert.equal(snake(e, 'a').segments.length, 5);
    assert.equal(snake(e, 'a').pendingGrowth, 1);
  });

  test('eats apples on both cells it passes', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.setApples([[6, 5], [7, 5]]);
    e._debug.setEffect('a', 'golden', 3000);
    e.tick();
    assert.equal(snake(e, 'a').pendingGrowth, 1); // one grown on the second cell already
    assert.equal(snake(e, 'a').segments.length, 4);
    assert.equal(e.getState().events.filter((ev) => ev.type === 'eat').length, 2);
  });

  test('wraps through the edge cell by cell', () => {
    const e = setup({ a: [[[18, 5], [17, 5], [16, 5]], 'right'], ...far }, { wrapWalls: true });
    e._debug.setEffect('a', 'golden', 3000);
    e.tick();
    assert.deepEqual(cells(e, 'a'), [[0, 5], [19, 5], [18, 5]]);
  });
});

describe('effect timing', () => {
  test('lasts its duration in game time, then ends', () => {
    const e = setup({ a: [[[1, 5], [0, 5], [0, 6]], 'right'], ...far }, { tickMs: 100, gridSize: 40 });
    e._debug.setEffect('a', 'golden', 1000);
    let fast = 0;
    for (let i = 0; i < 12; i++) {
      const before = head(e, 'a')[0];
      e.tick();
      if (head(e, 'a')[0] - before === 2) fast++;
    }
    assert.equal(fast, 10); // 1000 ms at 100 ms per tick
    assert.equal(snake(e, 'a').effect, null);
  });

  test('the remaining time is in milliseconds, so a speed change keeps it', () => {
    const e = setup({ a: [[[1, 5], [0, 5], [0, 6]], 'right'], ...far }, { tickMs: 100 });
    e._debug.setEffect('a', 'ghost', 1000);
    e.tick();
    assert.equal(snake(e, 'a').effect.remainingMs, 900);
    e.updateConfig({ tickMs: 300 });
    e.tick();
    assert.equal(snake(e, 'a').effect.remainingMs, 600);
    assert.deepEqual(snake(e, 'a').effect, { type: 'ghost', remainingMs: 600, durationMs: 1000 });
  });

  test('a new timed effect replaces the current one', () => {
    const e = setup({ a: [[[1, 5], [0, 5], [0, 6]], 'right'], ...far });
    e._debug.setEffect('a', 'golden', 3000);
    e.tick();
    e._debug.setEffect('a', 'ghost', 3000);
    e.tick();
    assert.equal(snake(e, 'a').effect.type, 'ghost');
    assert.equal(head(e, 'a')[0], 4); // 2 cells, then 1
  });

  test('dying ends the effect', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'], ...far });
    e._debug.setEffect('a', 'golden', 3000);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(snake(e, 'a').effect, null);
  });
});

describe('freeze', () => {
  test('every other snake moves only every second tick; the freezer moves normally', () => {
    const e = setup({ a: [[[1, 2], [0, 2], [0, 3]], 'right'], b: [[[1, 8], [0, 8], [0, 9]], 'right'], c: [[[1, 12], [0, 12], [0, 13]], 'right'] });
    e._debug.setEffect('a', 'freeze', 3000);
    for (let i = 0; i < 4; i++) e.tick();
    assert.equal(head(e, 'a')[0], 5);
    assert.equal(head(e, 'b')[0], 3);
    assert.equal(head(e, 'c')[0], 3);
    assert.equal(snake(e, 'b').frozen, true);
    assert.equal(snake(e, 'a').frozen, false);
  });

  test('two freezers freeze each other', () => {
    const e = setup({ a: [[[1, 2], [0, 2], [0, 3]], 'right'], b: [[[1, 8], [0, 8], [0, 9]], 'right'] });
    e._debug.setEffect('a', 'freeze', 3000);
    e._debug.setEffect('b', 'freeze', 3000);
    for (let i = 0; i < 4; i++) e.tick();
    assert.equal(head(e, 'a')[0], 3);
    assert.equal(head(e, 'b')[0], 3);
  });

  test('a frozen golden snake moves two cells every second tick', () => {
    const e = setup({ a: [[[1, 2], [0, 2], [0, 3]], 'right'], b: [[[1, 8], [0, 8], [0, 9]], 'right'] });
    e._debug.setEffect('a', 'freeze', 3000);
    e._debug.setEffect('b', 'golden', 3000);
    for (let i = 0; i < 4; i++) e.tick();
    assert.equal(head(e, 'b')[0], 5);
  });

  test('the freeze ends when the freezer dies or leaves', () => {
    const e = setup({ a: [[[1, 2], [0, 2], [0, 3]], 'right'], b: [[[1, 8], [0, 8], [0, 9]], 'right'], ...far });
    e._debug.setEffect('a', 'freeze', 3000);
    assert.equal(snake(e, 'b').frozen, true);
    e.removePlayer('a');
    assert.equal(snake(e, 'b').frozen, false);
    e.tick();
    e.tick();
    assert.equal(head(e, 'b')[0], 3);
  });

  test('frozen snakes still meet head-on on the ticks they move', () => {
    const e = setup({ a: [[[3, 5], [2, 5], [1, 5]], 'right'], b: [[[5, 5], [5, 6], [5, 7], [5, 8]], 'left'], f: [[[18, 18], [17, 18], [16, 18]], 'up'] });
    e._debug.setEffect('f', 'freeze', 3000);
    e.tick(); // tick 2 (even): both frozen snakes move, into (4,5): the shorter a survives
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'a').kills, 1);
  });

  test('a moving head entering a frozen snake that sits out is a body hit', () => {
    const e = setup({ a: [[[3, 5], [2, 5], [1, 5]], 'right'], b: [[[5, 5], [5, 6], [5, 7], [5, 8]], 'up'] });
    e._debug.setEffect('a', 'freeze', 3000);
    e.tick(); // tick 2: both move. a -> (4,5), b -> (5,4)
    e.tick(); // tick 3: b sits out; a -> (5,5), b's neck
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').kills, 1);
  });
});

describe('ghost', () => {
  test('passes through bodies; nothing collides with it', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: [[[6, 2], [6, 3], [6, 4], [6, 5], [6, 6], [6, 7]], 'up'], c: [[[8, 6], [8, 7], [8, 8]], 'up'] });
    e._debug.setEffect('a', 'ghost', 3000);
    e.tick(); // a enters b's body
    e._debug.setSnake('c', [[7, 6], [8, 6], [9, 6]], 'up'); // c will enter (7,5)... a's next cell
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'alive');
    assert.equal(player(e, 'c').status, 'alive');
  });

  test('passes through heads: no head-on', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: [[[7, 5], [8, 5], [9, 5], [10, 5]], 'left'], ...far });
    e._debug.setEffect('a', 'ghost', 3000);
    e.tick(); // both into (6,5)
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'alive');
    assert.equal(e.getState().events.some((ev) => ev.type === 'headOn'), false);
    e.tick(); // swap cells
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'alive');
  });

  test('passes through its own body', () => {
    const e = setup({ a: [[[5, 5], [5, 6], [6, 6], [6, 5], [6, 4], [5, 4]], 'right'], ...far });
    e._debug.setEffect('a', 'ghost', 3000);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
  });

  test('walls still kill it; wrap-around still wraps', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'], ...far });
    e._debug.setEffect('a', 'ghost', 3000);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    const w = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'], ...far }, { wrapWalls: true });
    w._debug.setEffect('a', 'ghost', 3000);
    w.tick();
    assert.deepEqual(head(w, 'a'), [0, 5]);
  });

  test('still eats apples and grows', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.setApples([[6, 5]]);
    e._debug.setEffect('a', 'ghost', 3000);
    e.tick();
    assert.equal(snake(e, 'a').pendingGrowth, 1);
  });

  test('overlapping snakes are fine after the ghost ends; only heads entering cells collide', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: [[[6, 4], [6, 5], [6, 6], [6, 7], [6, 8], [6, 9], [6, 10]], 'up'], ...far }, { tickMs: 100 });
    e._debug.setEffect('a', 'ghost', 100);
    e.tick(); // a's head in b's body; the ghost ends after the next tick
    e.tick(); // a -> (7,5), its neck still on b
    assert.equal(snake(e, 'a').effect, null);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'alive');
  });

  test('a dead ghost still drops corpse apples', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'], ...far }, { corpseApples: true });
    e._debug.setEffect('a', 'ghost', 3000);
    e.tick();
    assert.equal(e.getState().apples.filter((a) => a.corpse).length, 3);
  });
});
