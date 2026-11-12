// Power-ups: movement effects (golden, freeze, ghost), spawning and every
// pickup's effect. Board positions are set by hand through engine._debug.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEngine, sanitizeConfig, CONFIG_LIMITS } from '../src/engine.js';
import { POWER_UPS, weightKey } from '../src/shared/powerups.js';
import { STRINGS } from '../src/shared/strings.js';
import { createGame } from '../src/server/game.js';

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

const projectiles = (e) => e.getState().projectiles;
const events = (e, type) => e.getState().events.filter((ev) => ev.type === type);
// A vertical snake moving up whose body covers column x from row y0 down.
const column = (x, y0, length) => [Array.from({ length }, (_, i) => [x, y0 + i]), 'up'];

describe('gun', () => {
  test('a projectile checks both cells it passes each tick (first cell)', () => {
    const e = setup({ b: column(6, 8, 6), ...far });
    e._debug.addProjectile([5, 10], 'right', 'z');
    e.tick();
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'z').kills, 1);
    assert.deepEqual(projectiles(e), []);
  });

  test('a projectile checks both cells it passes each tick (second cell)', () => {
    const e = setup({ b: column(7, 8, 6), ...far });
    e._debug.addProjectile([5, 10], 'right', 'z');
    e.tick();
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(e.getState().events.find((ev) => ev.type === 'death').killerId, 'z');
  });

  test('moves two cells per tick in a straight line', () => {
    const e = setup(far);
    e._debug.addProjectile([2, 10], 'right', 'z');
    e.tick();
    assert.deepEqual(projectiles(e).map((p) => [p.x, p.y]), [[4, 10]]);
  });

  test('a wall ends it, and it never wraps, even with wrap-around on', () => {
    const e = setup({ b: [[[0, 8], [0, 7], [0, 6], [0, 5], [0, 4]], 'down'], ...far }, { wrapWalls: true });
    e._debug.addProjectile([19, 5], 'right', 'z');
    e.tick();
    assert.deepEqual(projectiles(e), []);
    assert.equal(player(e, 'b').status, 'alive');
  });

  test('two projectiles meeting in a cell both disappear', () => {
    const e = setup(far);
    e._debug.addProjectile([5, 5], 'right', 'z');
    e._debug.addProjectile([7, 5], 'left', 'z');
    e.tick();
    assert.deepEqual(projectiles(e), []);
  });

  test('two projectiles swapping cells both disappear', () => {
    const e = setup(far);
    e._debug.addProjectile([5, 5], 'right', 'z');
    e._debug.addProjectile([6, 5], 'left', 'z');
    e.tick();
    assert.deepEqual(projectiles(e), []);
  });

  test('a head and a projectile swapping cells is a hit', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.addProjectile([6, 5], 'left', 'z');
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'z').kills, 1);
  });

  test('shooting yourself kills you, with no kill credit', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.addProjectile([8, 5], 'left', 'a');
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'a').kills, 0);
    assert.equal(events(e, 'death')[0].killerId, null);
  });

  test('projectiles pass through ghosts', () => {
    const e = setup({ b: column(6, 8, 6), c: column(8, 9, 6), ...far });
    e._debug.setEffect('b', 'ghost', 3000);
    e._debug.addProjectile([5, 10], 'right', 'z');
    e.tick();
    e.tick();
    assert.equal(player(e, 'b').status, 'alive');
    assert.equal(player(e, 'c').status, 'dead');
    assert.equal(player(e, 'z').kills, 1);
  });

  test('a shooter who left gets no kill, but the hit still counts', () => {
    const e = setup({ b: column(6, 8, 6), q: [[[15, 2], [14, 2], [13, 2]], 'right'], ...far });
    e._debug.addProjectile([5, 10], 'right', 'q');
    e.removePlayer('q');
    e.tick();
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(events(e, 'death')[0].killerId, null);
  });

  test('picking up a gun fires from the cell in front of the head', () => {
    const e = setup({ a: [[[3, 5], [2, 5], [1, 5]], 'right'], ...far }, PU);
    e._debug.addPowerUps([[4, 5, 'gun']]);
    e.tick();
    assert.deepEqual(projectiles(e).map((p) => [p.x, p.y, p.dir, p.ownerId]), [[6, 5, 'right', 'a']]); // spawned at (5,5), moved once
    for (let i = 0; i < 7; i++) e.tick(); // the shooter never catches its own shot
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(projectiles(e), []); // it hit the wall
  });

  test('a gun picked up facing a snake hits it at once', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: column(7, 3, 5), ...far }, PU);
    e._debug.addPowerUps([[6, 5, 'gun']]);
    e.tick();
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'a').kills, 1);
  });

  test('a gun picked up facing a wall fizzles', () => {
    const e = setup({ a: [[[18, 5], [17, 5], [16, 5]], 'right'], ...far }, PU);
    e._debug.addPowerUps([[19, 5, 'gun']]);
    e.tick();
    assert.deepEqual(projectiles(e), []);
    assert.equal(events(e, 'shot').length, 1);
    assert.equal(player(e, 'a').status, 'alive');
  });

  test('a dead snake hit by a projectile drops corpse apples', () => {
    const e = setup({ b: column(6, 8, 4), ...far }, { corpseApples: true });
    e._debug.addProjectile([5, 10], 'right', 'z');
    e.tick();
    assert.equal(e.getState().apples.filter((a) => a.corpse).length, 4);
  });
});

describe('shield', () => {
  test('a wall: turns aside to a free side and becomes a ghost for a moment', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'], b: [[[16, 4], [17, 4], [18, 4], [19, 4]], 'left'], ...far });
    e._debug.setEffect('a', 'shield', 10000);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(head(e, 'a'), [19, 6]); // (19,4) was taken
    assert.equal(snake(e, 'a').dir, 'down');
    assert.equal(snake(e, 'a').effect.type, 'ghost');
    assert.equal(events(e, 'shieldPop').length, 1);
  });

  test('a body: survives inside it, as a ghost; nobody gets a kill', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: column(6, 2, 6), ...far }, { tickMs: 100 });
    e._debug.setEffect('a', 'shield', 10000);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(head(e, 'a'), [6, 5]);
    assert.equal(player(e, 'b').kills, 0);
    assert.deepEqual(snake(e, 'a').effect, { type: 'ghost', remainingMs: 1000, durationMs: 1000 });
    for (let i = 0; i < 10; i++) e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(snake(e, 'a').effect, null); // the ghost lasts 1 s
  });

  test('a lost head-on: survives, and the winner gets no kill', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5], [2, 5]], 'right'], b: [[[7, 5], [8, 5], [9, 5]], 'left'], ...far });
    e._debug.setEffect('a', 'shield', 10000);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'alive');
    assert.equal(player(e, 'b').kills, 0);
  });

  test('a won head-on keeps the shield', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: [[[7, 5], [8, 5], [9, 5], [10, 5]], 'left'], ...far });
    e._debug.setEffect('a', 'shield', 10000);
    e.tick();
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'a').kills, 1);
    assert.equal(snake(e, 'a').effect.type, 'shield');
  });

  test('a projectile: the shield pops and the projectile is gone', () => {
    const e = setup({ b: column(6, 8, 6), ...far });
    e._debug.setEffect('b', 'shield', 10000);
    e._debug.addProjectile([5, 10], 'right', 'z');
    e.tick();
    assert.equal(player(e, 'b').status, 'alive');
    assert.equal(snake(e, 'b').effect.type, 'ghost');
    assert.deepEqual(projectiles(e), []);
    assert.equal(player(e, 'z').kills, 0);
  });

  test('its own body', () => {
    const e = setup({ a: [[[5, 5], [5, 6], [6, 6], [6, 5], [6, 4], [5, 4]], 'right'], ...far });
    e._debug.setEffect('a', 'shield', 10000);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
  });

  test('only one hit: the next one kills', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: column(6, 2, 6), ...far }, { tickMs: 100 });
    e._debug.setEffect('a', 'shield', 10000);
    e.tick(); // pops
    for (let i = 0; i < 11; i++) e.tick(); // ghost over; a reaches (17,5)
    e._debug.setSnake('b', [[18, 3], [18, 4], [18, 5], [18, 6], [18, 7]], 'up');
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
  });
});

describe('scissors', () => {
  test('cuts the other snake where it hits; with dead-snake apples on, the cut-off part becomes apples', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: column(6, 3, 8), ...far }, { corpseApples: true });
    e._debug.setEffect('a', 'scissors', 8000);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'alive');
    assert.deepEqual(cells(e, 'b'), [[6, 2], [6, 3], [6, 4]]); // 3 left: no kill
    assert.equal(player(e, 'a').kills, 0);
    // (6,5) is under a's head; the rest of the cut-off part is apples.
    assert.deepEqual(e.getState().apples.map((c) => [c.x, c.y]), [[6, 6], [6, 7], [6, 8], [6, 9]]);
    assert.ok(e.getState().apples.every((c) => c.corpse));
    assert.equal(snake(e, 'a').effect, null); // used up
    assert.equal(events(e, 'cut')[0].byId, 'a');
  });

  test('with dead-snake apples off, the cut-off part just vanishes', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: column(6, 3, 8), ...far }, { appleCount: 0 });
    e._debug.setEffect('a', 'scissors', 8000);
    e.tick();
    assert.deepEqual(cells(e, 'b'), [[6, 2], [6, 3], [6, 4]]);
    assert.deepEqual(e.getState().apples, []);
  });

  test('a cut leaving fewer than 3 segments kills, and the cutter gets the kill', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: column(6, 4, 5), ...far }, { corpseApples: true });
    e._debug.setEffect('a', 'scissors', 8000);
    e.tick();
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'a').kills, 1);
    assert.equal(player(e, 'a').status, 'alive');
    // The whole snake becomes apples, except the cell under a's head.
    assert.equal(e.getState().apples.filter((c) => c.corpse).length, 4);
  });

  test('head-ons are unaffected', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5], [2, 5]], 'right'], b: [[[7, 5], [8, 5], [9, 5]], 'left'], ...far });
    e._debug.setEffect('a', 'scissors', 8000);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').kills, 1);
  });

  test('running into your own body still kills', () => {
    const e = setup({ a: [[[5, 5], [5, 6], [6, 6], [6, 5], [6, 4], [5, 4]], 'right'], ...far });
    e._debug.setEffect('a', 'scissors', 8000);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
  });

  test('a ghost is not cut, and the scissors stay', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: column(6, 3, 8), ...far });
    e._debug.setEffect('a', 'scissors', 8000);
    e._debug.setEffect('b', 'ghost', 3000);
    e.tick();
    assert.equal(snake(e, 'b').segments.length, 8);
    assert.equal(snake(e, 'a').effect.type, 'scissors');
  });

  test('wears off after 8 seconds', () => {
    const e = setup({ a: [[[1, 5], [0, 5], [0, 6]], 'right'], ...far }, { tickMs: 400, gridSize: 40 });
    e._debug.setEffect('a', 'scissors', 8000);
    for (let i = 0; i < 19; i++) e.tick();
    assert.equal(snake(e, 'a').effect.type, 'scissors');
    e.tick();
    assert.equal(snake(e, 'a').effect, null);
  });
});

describe('bomb', () => {
  test('shrinks by a quarter and clears pending growth; the lost tail vanishes even with dead-snake apples on', () => {
    const row = Array.from({ length: 12 }, (_, i) => [12 - i, 5]);
    const e = setup({ a: [row, 'right'], ...far }, { ...PU, corpseApples: true, growthPerApple: 3 });
    e._debug.setApples([[13, 5]]);
    e._debug.setBombs([[14, 5]]);
    e.tick(); // apple: pending 3
    e.tick(); // grows to 13 on the move, then the bomb: round(13 * 0.75) = 10
    assert.equal(snake(e, 'a').segments.length, 10);
    assert.equal(snake(e, 'a').pendingGrowth, 0);
    assert.deepEqual(e.getState().apples, []);
    assert.deepEqual(e.getState().bombs, []);
  });

  test('never below 3, and it never grows the snake', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5], [2, 5]], 'right'], b: [[[5, 9], [4, 9], [3, 9]], 'right'], ...far }, PU);
    e._debug.setBombs([[6, 5], [6, 9]]);
    e.tick();
    assert.equal(snake(e, 'a').segments.length, 3);
    assert.equal(snake(e, 'b').segments.length, 3);
    assert.equal(snake(e, 'b').pendingGrowth, 0);
  });
});

describe('portal', () => {
  test('picking one up puts the entrance at the head and the exit somewhere safe', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, PU);
    e._debug.addPowerUps([[6, 5, 'portal']]);
    e.tick();
    const [portal] = e.getState().portals;
    assert.deepEqual(portal.entrance, { x: 6, y: 5 });
    assert.equal(portal.remainingMs, 8000);
    for (const s of e.getState().snakes) {
      for (const c of s.segments) assert.ok(Math.abs(c.x - portal.exit.x) + Math.abs(c.y - portal.exit.y) >= 5);
    }
  });

  test('a head entering the entrance comes out of the exit, same direction; the body follows', () => {
    const e = setup({ a: [[[7, 5], [6, 5], [5, 5]], 'right'], ...far });
    e._debug.addPortal([8, 5], [12, 12]);
    e.tick();
    assert.deepEqual(cells(e, 'a'), [[12, 12], [7, 5], [6, 5]]);
    assert.equal(events(e, 'teleport')[0].id, 'a');
    e.tick();
    e.tick();
    assert.deepEqual(cells(e, 'a'), [[14, 12], [13, 12], [12, 12]]);
  });

  test('any snake can use it, and it works across a wrapping edge', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'], ...far }, { wrapWalls: true });
    e._debug.addPortal([0, 5], [10, 10]);
    e.tick();
    assert.deepEqual(head(e, 'a'), [10, 10]);
  });

  test('coming out onto a body follows the normal rules', () => {
    const e = setup({ a: [[[7, 5], [6, 5], [5, 5]], 'right'], b: column(12, 10, 5), ...far });
    e._debug.addPortal([8, 5], [12, 12]);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').kills, 1);
  });

  test('lasts 8 seconds', () => {
    const e = setup(loopers, { wrapWalls: true, tickMs: 100 });
    e._debug.addPortal([10, 8], [15, 15]);
    for (let i = 0; i < 79; i++) e.tick();
    assert.equal(e.getState().portals.length, 1);
    e.tick();
    assert.deepEqual(e.getState().portals, []);
  });

  test('projectiles ignore portals', () => {
    const e = setup(far);
    e._debug.addPortal([6, 8], [15, 15]);
    e._debug.addProjectile([5, 8], 'right', 'z');
    e.tick();
    assert.deepEqual(projectiles(e).map((p) => [p.x, p.y]), [[7, 8]]);
  });

  test('on a nearly full board the exit takes any free cell; on a full one no portal appears', () => {
    const fill = (except) => {
      const list = [];
      for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (y !== 1 || x > 2) if (!except.some(([ex, ey]) => ex === x && ey === y)) list.push([x, y]);
      return list;
    };
    for (const [free, expected] of [[[[9, 9]], 1], [[], 0]]) {
      const e = setup({ a: [[[1, 1], [0, 1], [0, 2]], 'right'] }, { ...PU, gridSize: 10 });
      e._debug.setApples(fill(free)); // also under the tail, which moves off its cell
      e._debug.addPowerUps([[2, 1, 'portal']]);
      e.tick();
      const portals = e.getState().portals;
      assert.equal(portals.length, expected);
      if (expected) assert.deepEqual(portals[0].exit, { x: 9, y: 9 });
    }
  });
});

describe('magnet', () => {
  test('pulls nearby apples and power-ups one cell a tick, never into snakes, items or portals; not bombs', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { appleCount: 5 });
    e._debug.setEffect('a', 'magnet', 5000);
    // After the move the head is at (6,5).
    e._debug.setApples([[6, 8], [6, 9], [6, 2], [7, 5]]);
    e._debug.addPowerUps([[9, 5, 'ghost']]);
    e._debug.setBombs([[8, 5]]);
    e._debug.addPortal([6, 3], [15, 15]);
    e.tick();
    const s = e.getState();
    assert.deepEqual(s.apples.map((c) => [c.x, c.y]), [
      [6, 7], // pulled
      [6, 9], // too far (4)
      [6, 2], // the portal is in the way
      [7, 5], // the head is in the way: it stays to be eaten
    ]);
    assert.deepEqual(s.powerUps.map((c) => [c.x, c.y]), [[9, 5]]); // the bomb is in the way
    assert.deepEqual(s.bombs.map((c) => [c.x, c.y]), [[8, 5]]); // never pulled
  });

  test('pulls the short way round across a wrapping edge', () => {
    const e = setup({ a: [[[1, 5], [0, 5], [19, 5]], 'up'], ...far }, { wrapWalls: true, appleCount: 1 });
    e._debug.setEffect('a', 'magnet', 5000);
    e._debug.setApples([[18, 4]]); // 2 cells from the head at (1,4), across the edge
    e.tick();
    assert.deepEqual(e.getState().apples, [{ x: 19, y: 4 }]);
  });
});

describe('feast', () => {
  test('ten extra apples on the free cells closest to the eater', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { ...PU, appleCount: 1, powerUpChance: 0 });
    e._debug.addPowerUps([[6, 5, 'feast']]);
    e.tick();
    const feast = e.getState().apples.filter((c) => c.feast);
    assert.equal(feast.length, 10);
    for (const c of feast) assert.ok(Math.abs(c.x - 6) + Math.abs(c.y - 5) <= 2);
    // They're extras, like dead-snake apples: they stop new regular spawns.
    assert.equal(e.getState().apples.length, 10);
  });

  test('on a nearly full board it places what fits', () => {
    const e = setup({ a: [[[1, 1], [0, 1], [0, 2]], 'right'] }, { ...PU, gridSize: 10 });
    const list = [];
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (y > 2 && !(x === 9 && y > 6)) list.push([x, y]);
    e._debug.setApples(list); // leaves rows 0-2 (minus the snake and the feast) and three cells at (9, 7-9)
    e._debug.addPowerUps([[2, 1, 'feast']]);
    e.tick();
    assert.equal(e.getState().apples.filter((c) => c.feast).length, 10);
    const full = setup({ a: [[[1, 1], [0, 1], [0, 2]], 'right'] }, { ...PU, gridSize: 10 });
    const all = [];
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) if (!(y === 1 && x <= 2)) all.push([x, y]); // also under the tail
    full._debug.setApples(all.filter(([x, y]) => !(x === 9 && y === 9)));
    full._debug.addPowerUps([[2, 1, 'feast']]);
    full.tick();
    assert.deepEqual(full.getState().apples.filter((c) => c.feast), [{ x: 9, y: 9, feast: true }]);
  });
});

describe('solo rounds', () => {
  test('a lone player with every power-up on plays without errors and never wins', () => {
    const e = createEngine({ config: { gridSize: 12, appleCount: 8, intermissionMs: 0, ...PU, powerUpChance: 100, bombsPerMinute: 20, wrapWalls: true }, random: seeded(3) });
    e.addPlayer('a', 'a');
    const dirs = ['up', 'right', 'down', 'left'];
    for (let i = 0; i < 400; i++) {
      if (i % 3 === 0) e.setDirection('a', dirs[(i * 5) % 4]);
      e.tick();
      assert.equal(e.getState().winnerId, null);
    }
  });
});

describe('settings', () => {
  test('hostile values for the power-up settings are clamped or dropped', () => {
    assert.deepEqual(
      sanitizeConfig({ powerUps: 'yes', powerUpChance: 900, bombsPerMinute: -4, weightGun: 2.6, weightGhost: 'lots', weightNope: 3 }),
      { powerUpChance: 100, bombsPerMinute: 0, weightGun: 3 },
    );
  });

  test('a paused game does not run the timers', () => {
    const game = createGame({ log: () => {} });
    game.engine.addPlayer('a', 'A');
    game.engine.addPlayer('b', 'B');
    game.tickOnce(); // round starts
    game.engine._debug.setEffect('a', 'ghost', 3000);
    game.engine._debug.setBombs([[1, 1]]);
    const admin = game.connect({ send: () => {}, close: () => {} }, { admin: true, isAuthorized: () => true });
    admin.message(JSON.stringify({ t: 'pause' }));
    for (let i = 0; i < 50; i++) game.tickOnce();
    const s = game.engine.getState();
    assert.equal(s.snakes.find((x) => x.id === 'a').effect.remainingMs, 3000);
    assert.equal(s.bombs[0].remainingMs, 10000);
  });
});

describe('the power-up list', () => {
  test('every entry has its weight setting, Italian name, Twemoji file and effect', () => {
    const effects = createEngine()._debug.effectTypes();
    for (const p of POWER_UPS) {
      if (p.type === 'bomb') assert.equal(CONFIG_LIMITS[weightKey(p.type)], undefined);
      else assert.deepEqual(CONFIG_LIMITS[weightKey(p.type)], { min: 0, max: 10, default: p.defaultWeight }, p.type);
      assert.equal(typeof STRINGS.admin.powerUpNames[p.type], 'string', p.type);
      assert.ok(fs.existsSync(new URL(`../node_modules/@twemoji/svg/${p.twemoji}.svg`, import.meta.url)), p.twemoji);
      assert.ok(effects.includes(p.type), `no effect for ${p.type}`);
    }
    assert.equal(new Set(POWER_UPS.map((p) => p.type)).size, POWER_UPS.length);
  });
});
