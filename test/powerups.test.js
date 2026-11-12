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

// Power-ups on, no random bombs unless a test asks for them.
const PU = { powerUps: true, bombsPerMinute: 0 };
const onlyWeight = (type) => ({
  weightGolden: 0,
  weightGhost: 0,
  weightGun: 0,
  weightMagnet: 0,
  weightFreeze: 0,
  weightScissors: 0,
  weightPortal: 0,
  weightFeast: 0,
  weightShield: 0,
  [`weight${type[0].toUpperCase()}${type.slice(1)}`]: 5,
});
// Two snakes looping forever on a wrapping board, out of each other's way.
const loopers = {
  a: [[[2, 3], [1, 3], [0, 3]], 'right'],
  b: [[[2, 12], [1, 12], [0, 12]], 'right'],
};

describe('spawning', () => {
  test('power-ups take the place of an apple and count toward appleCount', () => {
    const e = setup(loopers, { ...PU, wrapWalls: true, appleCount: 5, powerUpChance: 100, ...onlyWeight('ghost') });
    e.tick();
    const s = e.getState();
    assert.equal(s.powerUps.length, 5);
    assert.equal(s.apples.length, 0);
    assert.ok(s.powerUps.every((p) => p.type === 'ghost'));
  });

  test('chance 0 or all weights 0: apples only', () => {
    for (const config of [{ powerUpChance: 0 }, { powerUpChance: 100, ...onlyWeight('ghost'), weightGhost: 0 }]) {
      const e = setup(loopers, { ...PU, wrapWalls: true, appleCount: 10, ...config });
      e.tick();
      assert.equal(e.getState().powerUps.length, 0, JSON.stringify(config));
      assert.equal(e.getState().apples.length, 10);
    }
  });

  test('a power-up with weight 0 never spawns', () => {
    const e = setup(loopers, { ...PU, wrapWalls: true, appleCount: 30, powerUpChance: 100, weightGun: 0 });
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      e.restartRound();
      for (const p of e.getState().powerUps) seen.add(p.type);
    }
    assert.equal(seen.has('gun'), false);
    assert.ok(seen.size >= 6, [...seen].join()); // the others all show up
  });

  test('with power-ups off the game is exactly what it was (same random numbers)', () => {
    const run = (config) => {
      const e = createEngine({ config: { gridSize: 20, appleCount: 4, intermissionMs: 0, corpseApples: true, ...config }, random: seeded(7) });
      for (const id of ['a', 'b', 'c']) e.addPlayer(id, id);
      const dirs = ['up', 'right', 'down', 'left'];
      const out = [];
      for (let i = 0; i < 300; i++) {
        e.setDirection(['a', 'b', 'c'][i % 3], dirs[(i * 7) % 4]);
        e.tick();
        const s = e.getState();
        out.push(JSON.stringify([s.round, s.apples, s.snakes.map((x) => x.segments)]));
      }
      return out;
    };
    // Power-up settings without the toggle change nothing.
    assert.deepEqual(run({ powerUpChance: 100, bombsPerMinute: 20 }), run({}));
  });

  test('lowering appleCount trims the newest apples and power-ups, never bombs or extras', () => {
    const e = setup({ ...loopers, c: [[[2, 16], [1, 16], [0, 16]], 'right'] }, { ...PU, wrapWalls: true, appleCount: 3, corpseApples: true });
    e._debug.setApples([[5, 7], [6, 7]]);
    e._debug.addPowerUps([[7, 7, 'ghost']]);
    e._debug.setBombs([[8, 7]]);
    e.tick();
    assert.equal(e.getState().apples.length + e.getState().powerUps.length, 3); // full: nothing new
    // c turns into its own body: 6 corpse apples, on top of appleCount.
    e._debug.setSnake('c', [[10, 16], [10, 17], [11, 17], [11, 16], [11, 15], [10, 15]], 'right');
    e.updateConfig({ appleCount: 1 });
    e.tick();
    const s = e.getState();
    assert.equal(s.apples.filter((a) => a.corpse).length, 6);
    assert.deepEqual(s.apples.filter((a) => !a.corpse), [{ x: 5, y: 7 }]);
    assert.deepEqual(s.powerUps, []);
    assert.equal(s.bombs.length, 1);
  });

  test('bombs do not count toward appleCount', () => {
    const e = setup(loopers, { ...PU, wrapWalls: true, appleCount: 2, powerUpChance: 0 });
    e._debug.setBombs([[5, 7], [6, 7], [7, 7]]);
    e.tick();
    assert.equal(e.getState().apples.length, 2);
    assert.equal(e.getState().bombs.length, 3);
  });

  test('no item spawns on a portal, a bomb or a snake', () => {
    const e = setup(loopers, { ...PU, gridSize: 10, wrapWalls: true, appleCount: 30, powerUpChance: 50 });
    e._debug.setBombs([[5, 5]]);
    e._debug.addPortal([4, 4], [6, 6]);
    e.tick();
    const s = e.getState();
    const taken = new Set(['5,5', '4,4', '6,6', ...s.snakes.flatMap((x) => x.segments.map((c) => `${c.x},${c.y}`))]);
    for (const it of [...s.apples, ...s.powerUps]) assert.equal(taken.has(`${it.x},${it.y}`), false, `${it.x},${it.y}`);
  });
});

describe('bombs', () => {
  test('an uneaten bomb disappears after 10 seconds', () => {
    const e = setup(loopers, { ...PU, wrapWalls: true, tickMs: 100 });
    e._debug.setBombs([[5, 7]]);
    for (let i = 0; i < 99; i++) e.tick();
    assert.deepEqual(e.getState().bombs, [{ x: 5, y: 7, remainingMs: 100 }]);
    e.tick();
    assert.deepEqual(e.getState().bombs, []);
    assert.ok(e.getState().events.some((ev) => ev.type === 'bombExpired'));
  });

  test('they spawn at bombsPerMinute, never more than 5 at once, away from heads', () => {
    const e = setup(loopers, { ...PU, wrapWalls: true, tickMs: 600, bombsPerMinute: 20 });
    let spawned = 0;
    let before = 0;
    for (let i = 0; i < 300; i++) {
      e.tick();
      const s = e.getState();
      assert.ok(s.bombs.length <= 5);
      if (s.bombs.length > before) {
        spawned++;
        const fresh = s.bombs[s.bombs.length - 1];
        for (const sn of s.snakes) {
          const h = sn.segments[0];
          const dx = Math.min(Math.abs(h.x - fresh.x), 20 - Math.abs(h.x - fresh.x));
          const dy = Math.min(Math.abs(h.y - fresh.y), 20 - Math.abs(h.y - fresh.y));
          assert.ok(dx + dy > 2, 'bomb next to a head');
        }
      }
      before = s.bombs.length;
    }
    assert.ok(spawned >= 10, `only ${spawned} bombs`);
  });

  test('no bombs while power-ups are off', () => {
    const e = setup(loopers, { wrapWalls: true, tickMs: 600, bombsPerMinute: 20 });
    for (let i = 0; i < 100; i++) e.tick();
    assert.deepEqual(e.getState().bombs, []);
  });
});

describe('picking up', () => {
  test('a power-up grows the snake like an apple, then takes effect', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { ...PU, growthPerApple: 2 });
    e._debug.addPowerUps([[6, 5, 'ghost']]);
    e.tick();
    assert.equal(snake(e, 'a').pendingGrowth, 2);
    assert.equal(snake(e, 'a').effect.type, 'ghost');
    assert.deepEqual(e.getState().powerUps, []);
    const ev = e.getState().events;
    assert.ok(ev.some((x) => x.type === 'eat' && x.item === 'ghost' && x.x === 6));
    assert.ok(ev.some((x) => x.type === 'pickup' && x.item === 'ghost' && x.id === 'a'));
  });

  test('an effect picked up mid-tick applies from the next tick', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, PU);
    e._debug.addPowerUps([[6, 5, 'golden']]);
    e.tick();
    assert.deepEqual(head(e, 'a'), [6, 5]); // one cell: it wasn't golden when the tick began
    e.tick();
    assert.deepEqual(head(e, 'a'), [8, 5]);
  });

  test('the eaten power-up is replaced under the same rules', () => {
    const e = setup(loopers, { ...PU, wrapWalls: true, appleCount: 1, powerUpChance: 100, ...onlyWeight('feast') });
    e._debug.setApples([]);
    e._debug.addPowerUps([[3, 3, 'ghost']]);
    e.tick();
    assert.equal(e.getState().powerUps.length, 1);
    assert.equal(e.getState().powerUps[0].type, 'feast');
  });
});

describe('rounds and state', () => {
  test('the toggle applies from the next round; a new round clears everything', () => {
    const e = setup(loopers, { wrapWalls: true, appleCount: 5, powerUpChance: 100 });
    e.updateConfig({ powerUps: true });
    e.tick();
    assert.equal(e.getState().powerUps.length, 0); // still the round that started without them
    e.restartRound();
    assert.equal(e.getState().powerUps.length, 5);
    e._debug.setBombs([[5, 7]]);
    e._debug.addPortal([4, 4], [6, 6]);
    e._debug.addProjectile([9, 9], 'up', 'a');
    e._debug.setEffect('a', 'ghost', 3000);
    e.updateConfig({ powerUps: false });
    e.restartRound();
    const s = e.getState();
    assert.deepEqual([s.powerUps, s.bombs, s.portals, s.projectiles], [[], [], [], []]);
    assert.ok(s.snakes.every((x) => x.effect === null));
    assert.equal(s.rules.powerUps, false);
  });

  test('getState returns copies of the new fields', () => {
    const e = setup(loopers, { ...PU, wrapWalls: true });
    e._debug.addPowerUps([[5, 7, 'ghost']]);
    e._debug.setBombs([[6, 7]]);
    e._debug.addPortal([4, 4], [6, 6]);
    e._debug.setEffect('a', 'golden', 3000);
    const s = e.getState();
    s.powerUps[0].type = 'x';
    s.bombs[0].x = 0;
    s.portals[0].entrance.x = 0;
    s.snakes[0].effect.type = 'x';
    const again = e.getState();
    assert.equal(again.powerUps[0].type, 'ghost');
    assert.equal(again.bombs[0].x, 6);
    assert.equal(again.portals[0].entrance.x, 4);
    assert.equal(again.snakes.find((x) => x.id === 'a').effect.type, 'golden');
  });

  test('corpse apples never land on power-ups or bombs', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'], ...far }, { ...PU, corpseApples: true, appleCount: 1 });
    e._debug.addPowerUps([[18, 5, 'ghost']]);
    e._debug.setBombs([[17, 5]]);
    e.tick();
    const s = e.getState();
    assert.deepEqual(s.apples, [{ x: 19, y: 5, corpse: true }]);
    assert.equal(s.powerUps.length, 1);
    assert.equal(s.bombs.length, 1);
  });
});
