import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, sanitizeConfig } from '../src/engine.js';

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
// [segments (head first, as [x, y]), dir].
function setup(snakes, config = {}) {
  const engine = createEngine({
    config: { gridSize: 20, appleCount: 0, intermissionMs: 0, ...config },
    random: seeded(42),
  });
  for (const id of Object.keys(snakes)) engine.addPlayer(id, id);
  engine.tick(); // waiting -> playing, spawns snakes randomly
  engine._debug.setApples([]);
  for (const [id, [segments, dir]] of Object.entries(snakes)) engine._debug.setSnake(id, segments, dir);
  return engine;
}

const player = (engine, id) => engine.getState().players.find((p) => p.id === id);
const snake = (engine, id) => engine.getState().snakes.find((s) => s.id === id);

describe('body collisions', () => {
  test('running into another snake body kills the attacker only', () => {
    const e = setup({
      a: [[[5, 4], [4, 4], [3, 4]], 'right'], // moves to (6,4)
      b: [[[7, 3], [7, 4], [7, 5], [6, 5]], 'up'],
      c: [[[15, 15], [14, 15], [13, 15]], 'right'],
    });
    e._debug.setSnake('b', [[6, 3], [6, 4], [6, 5], [6, 6]], 'right'); // (6,4) is mid-body
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'alive');
    assert.equal(player(e, 'c').status, 'alive');
  });

  test('last snake alive wins the round', () => {
    const e = setup({
      a: [[[5, 4], [4, 4], [3, 4]], 'right'],
      b: [[[6, 3], [6, 4], [6, 5], [6, 6]], 'right'],
    });
    e.tick();
    const s = e.getState();
    assert.equal(s.phase, 'intermission');
    assert.equal(s.winnerId, 'b');
  });

  test('moving into a tail that leaves this tick is safe', () => {
    const e = setup({
      a: [[[5, 5], [4, 5], [3, 5]], 'right'], // moves to (6,5)
      b: [[[6, 2], [6, 3], [6, 4], [6, 5]], 'up'], // tail (6,5) moves away
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'alive');
  });

  test('moving into the tail of a growing snake kills', () => {
    const e = setup({
      a: [[[15, 15], [14, 15], [13, 15]], 'right'],
      b: [[[6, 3], [6, 4], [6, 5], [6, 6]], 'up'],
      c: [[[15, 5], [14, 5], [13, 5]], 'right'],
    });
    e._debug.setApples([[6, 2]]);
    e.tick(); // b eats at (6,2): pending growth 1, body now (6,2)..(6,5)
    assert.equal(snake(e, 'b').pendingGrowth, 1);
    e._debug.setSnake('a', [[5, 5], [4, 5], [3, 5]], 'right'); // next: (6,5) = b's tail
    e.tick(); // b grows, so its tail stays put
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'alive');
  });

  test('running into a wall kills', () => {
    const e = setup({
      a: [[[19, 5], [18, 5], [17, 5]], 'right'],
      b: [[[10, 10], [9, 10], [8, 10]], 'right'],
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'alive');
  });
});

describe('self collisions', () => {
  test('turning into your own body kills you', () => {
    // Head (2,2) travelling left; turning down hits (2,3), which is not the tail.
    const e = setup({ a: [[[2, 2], [3, 2], [3, 3], [2, 3], [1, 3]], 'left'] });
    assert.equal(e.setDirection('a', 'down'), true);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
  });

  test('chasing your own tail is safe', () => {
    // 2x2 loop: the head moves onto the tail cell as the tail leaves it.
    const e = setup({ a: [[[2, 2], [3, 2], [3, 3], [2, 3]], 'left'] });
    e.setDirection('a', 'down');
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(snake(e, 'a').segments[0], { x: 2, y: 3 });
  });
});

describe('head-on collisions', () => {
  const bystander = [[[15, 15], [14, 15], [13, 15]], 'right'];

  test('same target cell: longer snake dies', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5], [1, 5]], 'right'], // length 4 -> (5,5)
      b: [[[6, 5], [7, 5], [8, 5]], 'left'], // length 3 -> (5,5)
      c: bystander,
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'alive');
  });

  test('same target cell: equal length kills both', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[6, 5], [7, 5], [8, 5]], 'left'],
      c: bystander,
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'c').status, 'alive');
  });

  test('tie between the last two snakes ends the round with no winner', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[6, 5], [7, 5], [8, 5]], 'left'],
    });
    e.tick();
    const s = e.getState();
    assert.equal(s.phase, 'intermission');
    assert.equal(s.winnerId, null);
  });

  test('heads swapping cells: longer snake dies', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'], // -> (5,5)
      b: [[[5, 5], [6, 5], [7, 5], [8, 5]], 'left'], // -> (4,5)
      c: bystander,
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'dead');
  });

  test('heads swapping cells: equal length kills both', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[5, 5], [6, 5], [7, 5]], 'left'],
      c: bystander,
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'dead');
  });

  test('three-way: unique shortest survives', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'], // len 3
      b: [[[6, 5], [7, 5], [8, 5], [9, 5]], 'left'], // len 4
      c: [[[5, 6], [5, 7], [5, 8], [5, 9]], 'up'], // len 4
      d: bystander,
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'c').status, 'dead');
  });
});

describe('direction handling', () => {
  test('180-degree turns are rejected', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    assert.equal(e.setDirection('a', 'left'), false);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(snake(e, 'a').segments[0], { x: 6, y: 5 });
  });

  test('double-tap within one tick cannot reverse the snake', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    assert.equal(e.setDirection('a', 'up'), true);
    // Relative to "up" this would be legal, but the snake is still moving right.
    assert.equal(e.setDirection('a', 'left'), false);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(snake(e, 'a').segments[0], { x: 5, y: 4 });
  });

  test('latest valid turn in a tick wins', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    e.setDirection('a', 'up');
    e.setDirection('a', 'down');
    e.tick();
    assert.deepEqual(snake(e, 'a').segments[0], { x: 5, y: 6 });
  });

  test('invalid directions and unknown players are ignored', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    assert.equal(e.setDirection('a', 'sideways'), false);
    assert.equal(e.setDirection('a', '__proto__'), false);
    assert.equal(e.setDirection('a', 42), false);
    assert.equal(e.setDirection('nobody', 'up'), false);
    e.tick();
    assert.deepEqual(snake(e, 'a').segments[0], { x: 6, y: 5 });
  });
});

describe('growth', () => {
  test('growthPerApple 3 adds one segment per tick over three ticks', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] }, { growthPerApple: 3 });
    e._debug.setApples([[6, 5]]);
    e.tick(); // eats
    assert.equal(snake(e, 'a').segments.length, 3);
    assert.equal(snake(e, 'a').pendingGrowth, 3);
    const lengths = [];
    for (let i = 0; i < 4; i++) {
      e.tick();
      lengths.push(snake(e, 'a').segments.length);
    }
    assert.deepEqual(lengths, [4, 5, 6, 6]);
  });

  test('pending growth stacks across apples', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] }, { growthPerApple: 2 });
    e._debug.setApples([[6, 5]]);
    e.tick(); // eats first: pending 2
    e._debug.setApples([[7, 5]]); // placed now: appleCount 0 would trim it otherwise
    e.tick(); // grows (pending 1), eats second: pending 3
    assert.equal(snake(e, 'a').pendingGrowth, 3);
    for (let i = 0; i < 4; i++) e.tick();
    assert.equal(snake(e, 'a').segments.length, 3 + 4);
  });

  test('eaten apples are replaced', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] }, { appleCount: 1 });
    e._debug.setApples([[6, 5]]);
    e.tick();
    const apples = e.getState().apples;
    assert.equal(apples.length, 1);
    assert.notDeepEqual(apples[0], { x: 6, y: 5 });
  });
});

describe('config', () => {
  test('values are clamped and unknown keys dropped', () => {
    assert.deepEqual(sanitizeConfig({ growthPerApple: 99, tickMs: 'fast', evil: 1 }), { growthPerApple: 10 });
    assert.deepEqual(sanitizeConfig({ growthPerApple: 0 }), { growthPerApple: 1 });
    assert.deepEqual(sanitizeConfig(null), {});
  });

  test('config object is shared and mutated in place', () => {
    const config = {};
    const e = createEngine({ config });
    e.updateConfig({ tickMs: 200 });
    assert.equal(config.tickMs, 200);
    assert.equal(config.growthPerApple, 1);
    assert.equal(config.maxPlayers, 12);
  });

  test('appleCount applies live', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    e.updateConfig({ appleCount: 5 });
    e.tick();
    assert.equal(e.getState().apples.length, 5);
    e.updateConfig({ appleCount: 2 });
    e.tick();
    assert.equal(e.getState().apples.length, 2);
  });

  test('gridSize applies only at the next round', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[6, 5], [7, 5], [8, 5]], 'left'],
    });
    e.updateConfig({ gridSize: 40 });
    assert.equal(e.getState().gridSize, 20);
    e.tick(); // tie, round ends
    assert.equal(e.getState().gridSize, 20);
    e.tick(); // intermissionMs 0: new round
    const s = e.getState();
    assert.equal(s.phase, 'playing');
    assert.equal(s.round, 2);
    assert.equal(s.gridSize, 40);
  });
});

describe('pre-round countdown', () => {
  function countdownEngine(config = {}) {
    const e = createEngine({
      config: { gridSize: 20, appleCount: 0, tickMs: 100, countdownMs: 300, ...config },
      random: seeded(7),
    });
    e.addPlayer('a', 'A');
    e.addPlayer('b', 'B');
    return e;
  }

  test('off by default: rounds start playing immediately', () => {
    const e = createEngine();
    e.addPlayer('a', 'A');
    e.tick();
    assert.equal(e.getState().phase, 'playing');
  });

  test('snakes are spawned but frozen until countdownMs elapses', () => {
    const e = countdownEngine();
    e.tick(); // round starts in countdown
    const start = e.getState();
    assert.equal(start.phase, 'countdown');
    assert.equal(start.countdownRemainingMs, 300);
    assert.ok(start.players.every((p) => p.status === 'alive'));
    e.tick();
    e.tick();
    assert.equal(e.getState().phase, 'countdown');
    assert.deepEqual(e.getState().snakes, start.snakes); // nobody moved
    e.tick(); // 300ms elapsed
    assert.equal(e.getState().phase, 'playing');
    assert.deepEqual(e.getState().snakes, start.snakes); // first move is on the next tick
    e.tick();
    assert.notDeepEqual(e.getState().snakes[0].segments, start.snakes[0].segments);
  });

  test('a turn queued during the countdown is applied on the first move', () => {
    const e = countdownEngine();
    e.tick();
    e._debug.setSnake('a', [[5, 5], [4, 5], [3, 5]], 'right');
    assert.equal(e.setDirection('a', 'left'), false); // still no reversing
    assert.equal(e.setDirection('a', 'up'), true);
    for (let i = 0; i < 4; i++) e.tick();
    assert.deepEqual(snake(e, 'a').segments[0], { x: 5, y: 4 });
  });

  test('players joining during the countdown get into the current round', () => {
    const e = countdownEngine();
    e.tick();
    e.addPlayer('late', 'Late');
    assert.equal(player(e, 'late').status, 'alive');
    assert.equal(snake(e, 'late').segments.length, 3);
  });

  test('countdown also runs after an intermission', () => {
    const e = countdownEngine({ intermissionMs: 0 });
    e.tick();
    e._debug.setSnake('a', [[19, 5], [18, 5], [17, 5]], 'right');
    e._debug.setSnake('b', [[5, 10], [4, 10], [3, 10]], 'right');
    for (let i = 0; i < 4; i++) e.tick(); // countdown ends, a hits the wall
    assert.equal(e.getState().phase, 'intermission');
    e.tick();
    assert.equal(e.getState().phase, 'countdown');
    assert.equal(e.getState().round, 2);
  });
});

describe('players and rounds', () => {
  test('maxPlayers is enforced, duplicates rejected', () => {
    const e = createEngine({ config: { maxPlayers: 2 } });
    assert.equal(e.addPlayer('a', 'A').ok, true);
    assert.deepEqual(e.addPlayer('a', 'A'), { ok: false, reason: 'duplicate' });
    assert.equal(e.addPlayer('b', 'B').ok, true);
    assert.deepEqual(e.addPlayer('c', 'C'), { ok: false, reason: 'full' });
  });

  test('colors are reused after a player leaves', () => {
    const e = createEngine();
    e.addPlayer('a', 'A');
    e.addPlayer('b', 'B');
    e.removePlayer('a');
    assert.equal(e.addPlayer('c', 'C').colorIndex, 0);
  });

  test('players joining mid-round are queued for the next round', () => {
    const e = setup({
      a: [[[5, 5], [4, 5], [3, 5]], 'right'],
      b: [[[5, 10], [4, 10], [3, 10]], 'right'],
    });
    e.addPlayer('late', 'Late');
    e.tick();
    assert.equal(player(e, 'late').status, 'queued');
    assert.equal(snake(e, 'late'), undefined);
    // end the round: b drives into the wall
    e._debug.setSnake('b', [[19, 10], [18, 10], [17, 10]], 'right');
    e.tick();
    assert.equal(e.getState().phase, 'intermission');
    e.tick();
    assert.equal(e.getState().phase, 'playing');
    assert.equal(player(e, 'late').status, 'alive');
  });

  test('intermission lasts intermissionMs, then the round resets', () => {
    const e = setup(
      {
        a: [[[19, 5], [18, 5], [17, 5]], 'right'],
        b: [[[5, 10], [4, 10], [3, 10]], 'right'],
      },
      { tickMs: 100, intermissionMs: 300 },
    );
    e.tick(); // a dies, b wins
    assert.equal(e.getState().winnerId, 'b');
    e.tick();
    e.tick();
    assert.equal(e.getState().phase, 'intermission');
    e.tick();
    const s = e.getState();
    assert.equal(s.phase, 'playing');
    assert.equal(s.round, 2);
    assert.ok(s.players.every((p) => p.status === 'alive' && p.length === 3));
  });

  test('a solo round ends when someone else is waiting', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    e.tick();
    assert.equal(e.getState().phase, 'playing');
    e.addPlayer('b', 'B');
    e.tick();
    assert.equal(e.getState().phase, 'intermission');
  });

  test('removing a player mid-round can decide the winner', () => {
    const e = setup({
      a: [[[5, 5], [4, 5], [3, 5]], 'right'],
      b: [[[5, 10], [4, 10], [3, 10]], 'right'],
    });
    e.removePlayer('a');
    e.tick();
    assert.equal(e.getState().winnerId, 'b');
  });

  test('getState returns a copy', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    e.getState().snakes[0].segments[0].x = 99;
    assert.deepEqual(snake(e, 'a').segments[0], { x: 5, y: 5 });
  });
});
