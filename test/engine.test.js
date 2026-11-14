import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, sanitizeConfig, SPAWN_DISTANCE } from '../src/engine.js';

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
  test('going straight into your own body kills you', () => {
    // Head (2,2) travelling down; (2,3) ahead is body, not the tail.
    const e = setup({ a: [[[2, 2], [2, 1], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3]], 'down'] });
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
  });

  test('going straight into your own body with scissors cuts it there', () => {
    const e = setup({ a: [[[2, 2], [2, 1], [3, 1], [3, 2], [3, 3], [2, 3], [1, 3], [0, 3]], 'down'], z: [[[15, 15], [14, 15], [13, 15]], 'right'] }, { appleCount: 0 });
    e._debug.setEffect('a', 'scissors', 5000);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(snake(e, 'a').segments.map((c) => [c.x, c.y]), [[2, 3], [2, 2], [2, 1], [3, 1], [3, 2], [3, 3]]);
  });
});

describe('suicide-turn protection', () => {
  const cells = (e, id) => snake(e, id).segments.map((c) => [c.x, c.y]);
  const bystander = { z: [[[15, 15], [14, 15], [13, 15]], 'right'] };

  test('a turn into your own body is skipped: the snake goes straight on', () => {
    // Head (2,2) travelling left; turning down would hit (2,3), not the tail.
    const e = setup({ a: [[[2, 2], [3, 2], [3, 3], [2, 3], [1, 3]], 'left'] });
    assert.equal(e.setDirection('a', 'down'), true);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(snake(e, 'a').segments[0], { x: 1, y: 2 });
    assert.equal(snake(e, 'a').dir, 'left');
  });

  test('a U-turn with an extra swipe no longer self-kills', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5], [2, 5], [1, 5]], 'right'], ...bystander }, { appleCount: 0 });
    for (const dir of ['up', 'left', 'down']) assert.equal(e.setDirection('a', dir), true);
    e.tick();
    assert.deepEqual(snake(e, 'a').segments[0], { x: 5, y: 4 }); // up
    e.tick();
    assert.deepEqual(snake(e, 'a').segments[0], { x: 4, y: 4 }); // left, alongside the body
    e.tick(); // down would be (4,5), its own body: straight on instead
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(snake(e, 'a').segments[0], { x: 3, y: 4 });
  });

  test('the rest of the queue carries on after a skipped turn', () => {
    const e = setup({ a: [[[2, 2], [3, 2], [3, 3], [2, 3], [1, 3]], 'left'], ...bystander }, { appleCount: 0 });
    for (const dir of ['down', 'left', 'up']) assert.equal(e.setDirection('a', dir), true);
    e.tick(); // down: skipped
    e.tick(); // left: already going left
    e.tick(); // up
    assert.deepEqual(cells(e, 'a').slice(0, 3), [[0, 1], [0, 2], [1, 2]]);
    assert.equal(snake(e, 'a').dir, 'up');
  });

  test('a legitimate turn right next to the body still works', () => {
    const e = setup({ a: [[[2, 2], [3, 2], [3, 3], [2, 3], [1, 3]], 'left'] });
    e.setDirection('a', 'up');
    e.tick();
    assert.deepEqual(snake(e, 'a').segments[0], { x: 2, y: 1 });
  });

  test('turning onto a tail that moves away is allowed; onto one that stays (growing) is not', () => {
    const shape = [[[3, 2], [4, 2], [4, 3], [3, 3], [2, 3], [1, 3]], 'left'];
    for (const [apple, expected] of [[false, { x: 2, y: 3 }], [true, { x: 1, y: 2 }]]) {
      const e = setup({ a: shape, ...bystander }, { appleCount: 0 });
      if (apple) e._debug.setApples([[2, 2]]);
      e.tick(); // head (2,2); the tail is now at (2,3)
      e.setDirection('a', 'down');
      e.tick();
      assert.equal(player(e, 'a').status, 'alive');
      assert.deepEqual(snake(e, 'a').segments[0], expected);
    }
  });

  test('a turn whose portal exit is your own body is skipped too', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5], [2, 5], [1, 5]], 'right'], ...bystander }, { appleCount: 0 });
    e._debug.addPortal([5, 4], [3, 5]);
    e.setDirection('a', 'up');
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(snake(e, 'a').segments[0], { x: 6, y: 5 });
  });

  test('only your own body: turning into another snake or a wall still kills', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], b: [[[8, 4], [7, 4], [6, 4], [5, 4], [4, 4]], 'right'], ...bystander }, { appleCount: 0 });
    e.setDirection('a', 'up'); // (5,4): b's body
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    const w = setup({ a: [[[5, 0], [4, 0], [3, 0]], 'right'], ...bystander }, { appleCount: 0 });
    w.setDirection('a', 'up');
    w.tick();
    assert.equal(player(w, 'a').status, 'dead');
  });

  test('after a skipped turn, a queued reversal is dropped, even by a snake that became a ghost meanwhile', () => {
    for (const ghostAfterSkip of [false, true]) {
      // Heading left with body below: 'down' is skipped, which leaves 'right'
      // queued: a reversal into the neck.
      const e = setup({ a: [[[2, 2], [3, 2], [3, 3], [2, 3], [1, 3]], 'left'], ...bystander }, { appleCount: 0 });
      for (const dir of ['down', 'right']) assert.equal(e.setDirection('a', dir), true);
      e.tick();
      if (ghostAfterSkip) e._debug.setEffect('a', 'ghost', 5000); // nothing in its body would stop it
      e.tick();
      assert.equal(player(e, 'a').status, 'alive');
      assert.equal(snake(e, 'a').dir, 'left');
      assert.deepEqual(snake(e, 'a').segments[0], { x: 0, y: 2 });
    }
  });

  test('scissors: a turn into your own body is skipped too, so nothing is cut', () => {
    const e = setup({ a: [[[2, 2], [3, 2], [3, 3], [2, 3], [1, 3]], 'left'], ...bystander }, { appleCount: 0 });
    e._debug.setEffect('a', 'scissors', 5000);
    e.setDirection('a', 'down');
    e.tick();
    assert.equal(snake(e, 'a').segments.length, 5);
    assert.deepEqual(snake(e, 'a').segments[0], { x: 1, y: 2 });
    assert.equal(snake(e, 'a').effect.type, 'scissors');
  });

  test('a ghost turns through its own body as before', () => {
    const e = setup({ a: [[[2, 2], [3, 2], [3, 3], [2, 3], [1, 3]], 'left'], ...bystander }, { appleCount: 0 });
    e._debug.setEffect('a', 'ghost', 5000);
    e.setDirection('a', 'down');
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(snake(e, 'a').segments[0], { x: 2, y: 3 });
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

  test('a quick double-tap U-turns over two ticks without reversing', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    assert.equal(e.setDirection('a', 'up'), true);
    assert.equal(e.setDirection('a', 'left'), true); // valid after "up"
    e.tick();
    assert.deepEqual(snake(e, 'a').segments[0], { x: 5, y: 4 });
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.deepEqual(snake(e, 'a').segments[0], { x: 4, y: 4 });
  });

  test('buffered turns apply one per tick, in order (zigzag)', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'left'] });
    e._debug.setSnake('a', [[5, 5], [6, 5], [7, 5]], 'left');
    for (const d of ['up', 'left', 'up']) assert.equal(e.setDirection('a', d), true);
    const heads = [];
    for (let i = 0; i < 4; i++) {
      e.tick();
      heads.push(snake(e, 'a').segments[0]);
    }
    assert.deepEqual(heads, [
      { x: 5, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 3 },
      { x: 4, y: 2 }, // queue empty: keeps going up
    ]);
  });

  test('a turn reversing the previous queued turn is rejected', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    assert.equal(e.setDirection('a', 'up'), true);
    assert.equal(e.setDirection('a', 'down'), false); // opposite of the queued "up"
    assert.equal(e.setDirection('a', 'up'), false); // repeat: no wasted slot
    e.tick();
    e.tick();
    assert.deepEqual(snake(e, 'a').segments[0], { x: 5, y: 3 });
  });

  test('when the buffer is full the newest turn replaces the last one', () => {
    const e = setup({ a: [[[10, 10], [9, 10], [8, 10]], 'right'] });
    for (const d of ['up', 'right', 'down']) assert.equal(e.setDirection('a', d), true);
    assert.equal(e.setDirection('a', 'up'), true); // replaces "down" (valid after "right")
    assert.equal(e.setDirection('a', 'left'), false); // invalid after "right": "up" is kept
    const heads = [];
    for (let i = 0; i < 3; i++) {
      e.tick();
      heads.push(snake(e, 'a').segments[0]);
    }
    assert.deepEqual(heads, [
      { x: 10, y: 9 },
      { x: 11, y: 9 },
      { x: 11, y: 8 },
    ]);
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
    assert.equal(config.maxPlayers, 24);
  });

  test('appleCount applies live', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] }, { ratChance: 0, chickenChance: 0 }); // plain apples only
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

  test('restartRound respawns everyone, including queued players', () => {
    const e = setup({
      a: [[[5, 5], [4, 5], [3, 5]], 'right'],
      b: [[[5, 10], [4, 10], [3, 10]], 'right'],
    });
    e.addPlayer('late', 'Late');
    e.tick();
    e.tick();
    assert.equal(player(e, 'late').status, 'queued');
    e.restartRound();
    const s = e.getState();
    assert.equal(s.round, 2);
    assert.equal(s.phase, 'playing');
    assert.ok(s.players.every((p) => p.status === 'alive' && p.length === 3));
  });

  test('restartRound with no players returns to waiting', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    e.removePlayer('a');
    e.restartRound();
    assert.equal(e.getState().phase, 'waiting');
  });

  test('getState returns a copy', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'] });
    e.getState().snakes[0].segments[0].x = 99;
    assert.deepEqual(snake(e, 'a').segments[0], { x: 5, y: 5 });
  });
});

describe('corpse apples', () => {
  const kill = (config) =>
    setup(
      {
        a: [[[5, 4], [4, 4], [3, 4]], 'right'], // hits b's body at (6,4)
        b: [[[6, 3], [6, 4], [6, 5], [6, 6]], 'left'],
        c: [[[15, 15], [14, 15], [13, 15]], 'right'],
      },
      config,
    );
  const corpseCells = (e) =>
    e
      .getState()
      .apples.filter((a) => a.corpse)
      .map(({ x, y }) => `${x},${y}`)
      .sort();

  test('a dead snake turns into one apple per segment, on top of appleCount', () => {
    const e = kill({ corpseApples: true, appleCount: 2 });
    e._debug.setApples([[0, 0], [0, 1]]);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.deepEqual(corpseCells(e), ['3,4', '4,4', '5,4']);
    assert.equal(e.getState().apples.length, 2 + 3);
  });

  test('extra apples do not count toward appleCount: the regular ones stay at appleCount', () => {
    const e = kill({ corpseApples: true, appleCount: 2 });
    e._debug.setApples([[16, 15], [0, 0]]); // c eats (16,15) this tick
    e.tick();
    const count = () => {
      const apples = e.getState().apples;
      return [apples.filter((a) => !a.corpse).length, apples.filter((a) => a.corpse).length];
    };
    // 3 corpse apples, and the eaten regular one is still replaced.
    assert.deepEqual(count(), [2, 3]);
    // b eats the corpse apples one by one; the regular ones stay at 2.
    e._debug.setSnake('b', [[6, 3], [6, 2], [6, 1]], 'down');
    e._debug.setSnake('c', [[15, 15], [14, 15], [13, 15]], 'right');
    e.setDirection('b', 'left'); // (5,3)
    e.tick();
    assert.deepEqual(count(), [2, 3]);
    e.setDirection('b', 'down'); // (5,4) corpse
    e.tick();
    e.setDirection('b', 'left'); // (4,4) corpse
    e.tick();
    assert.deepEqual(count(), [2, 1]);
    e.tick(); // (3,4), the last corpse apple
    assert.deepEqual(count(), [2, 0]);
  });

  test('lowering appleCount removes regular apples only', () => {
    const e = kill({ corpseApples: true, appleCount: 2 });
    e._debug.setApples([[0, 0], [0, 1]]);
    e.tick();
    e.updateConfig({ appleCount: 0 });
    e.tick();
    const apples = e.getState().apples;
    assert.equal(apples.length, 3);
    assert.ok(apples.every((a) => a.corpse));
  });

  test('no corpse apple under a head that moved into the dead tail', () => {
    // a dies hitting c's body; b moves into a's tail cell, which counts as
    // vacated, so b survives on a cell that a's corpse still covers.
    const e = setup(
      {
        a: [[[5, 5], [4, 5], [3, 5]], 'right'],
        b: [[[3, 6], [3, 7], [3, 8]], 'up'], // moves to (3,5)
        c: [[[6, 4], [6, 5], [6, 6], [6, 7]], 'up'],
      },
      { corpseApples: true },
    );
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'alive');
    assert.deepEqual(snake(e, 'b').segments[0], { x: 3, y: 5 });
    assert.deepEqual(corpseCells(e), ['4,5', '5,5']);
  });

  test('no corpse apple under a head that passed through the dead head', () => {
    const e = setup(
      {
        a: [[[5, 5], [4, 5], [3, 5], [2, 5]], 'right'],
        b: [[[6, 5], [7, 5], [8, 5]], 'left'], // shorter: survives the head-on
      },
      { corpseApples: true },
    );
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.deepEqual(snake(e, 'b').segments[0], { x: 5, y: 5 });
    assert.deepEqual(corpseCells(e), ['2,5', '3,5', '4,5']);
  });

  test('off by default: dead snakes leave no apples', () => {
    const e = kill({});
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(e.getState().apples.length, 0);
  });

  test('turning it on mid-round applies from the next round only', () => {
    const e = kill({});
    e.updateConfig({ corpseApples: true });
    assert.equal(e.getState().rules.corpseApples, false);
    e.tick();
    assert.equal(e.getState().apples.length, 0);
    e.restartRound();
    assert.equal(e.getState().rules.corpseApples, true);
    assert.equal(e.getState().rules.wrapWalls, false); // the other rule stays off
  });
});

describe('wrap-around walls', () => {
  const cases = [
    ['right', [[19, 5], [18, 5], [17, 5]], { x: 0, y: 5 }],
    ['left', [[0, 5], [1, 5], [2, 5]], { x: 19, y: 5 }],
    ['down', [[5, 19], [5, 18], [5, 17]], { x: 5, y: 0 }],
    ['up', [[5, 0], [5, 1], [5, 2]], { x: 5, y: 19 }],
  ];
  for (const [dir, segments, expected] of cases) {
    test(`leaving through the ${dir} edge enters from the opposite one`, () => {
      const e = setup({ a: [segments, dir] }, { wrapWalls: true });
      e.tick();
      assert.equal(player(e, 'a').status, 'alive');
      assert.deepEqual(snake(e, 'a').segments[0], expected);
    });
  }

  test('walls still kill when it is off', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'] });
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
  });

  test('bodies on the other side of the edge still collide', () => {
    const e = setup(
      {
        a: [[[19, 5], [18, 5], [17, 5]], 'right'], // wraps into (0,5)
        b: [[[0, 4], [0, 5], [0, 6], [0, 7]], 'up'], // (0,5) stays body
        c: [[[10, 15], [9, 15], [8, 15]], 'right'],
      },
      { wrapWalls: true },
    );
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'alive');
  });

  test('apples on the other side of the edge are eaten', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'] }, { wrapWalls: true });
    e._debug.setApples([[0, 5]]);
    e.tick();
    assert.equal(snake(e, 'a').pendingGrowth, 1);
  });

  test('turning it on mid-round applies from the next round only', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'], b: [[[5, 15], [4, 15], [3, 15]], 'right'] });
    e.updateConfig({ wrapWalls: true });
    assert.equal(e.getState().rules.wrapWalls, false);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    e.restartRound();
    assert.equal(e.getState().rules.wrapWalls, true);
    assert.equal(e.getState().rules.corpseApples, false); // the other rule stays off
  });
});

describe('corpse apples with wrap-around walls', () => {
  const straddle = () =>
    setup(
      {
        a: [[[1, 5], [0, 5], [19, 5], [18, 5]], 'right'], // body crosses the left/right edge
        b: [[[2, 4], [2, 5], [2, 6], [2, 7]], 'up'], // a runs into (2,5)
        c: [[[17, 6], [16, 6], [15, 6]], 'right'],
      },
      { wrapWalls: true, corpseApples: true },
    );

  test('a body straddling an edge becomes apples, all inside the board', () => {
    const e = straddle();
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    const apples = e.getState().apples;
    const corpse = apples.filter((a) => a.corpse).map(({ x, y }) => `${x},${y}`).sort();
    assert.deepEqual(corpse, ['0,5', '18,5', '19,5', '1,5'].sort());
    assert.ok(apples.every((a) => a.x >= 0 && a.y >= 0 && a.x < 20 && a.y < 20));
  });

  test('corpse apples can be eaten by wrapping across the edge', () => {
    const e = straddle();
    e.tick(); // a dies, c moves to (18,6)
    e.setDirection('c', 'up'); // (18,5) corpse
    e.tick();
    e.setDirection('c', 'right'); // (19,5) corpse
    e.tick();
    e.tick(); // wraps to (0,5) corpse
    const c = snake(e, 'c');
    assert.deepEqual(c.segments[0], { x: 0, y: 5 });
    assert.equal(c.pendingGrowth + c.segments.length - 3, 3); // three apples eaten
    assert.equal(e.getState().apples.filter((a) => a.corpse).length, 1);
  });
});

describe('config toggles', () => {
  test('only real booleans are accepted', () => {
    assert.deepEqual(sanitizeConfig({ wrapWalls: true, corpseApples: 'yes' }), { wrapWalls: true });
    assert.deepEqual(sanitizeConfig({ wrapWalls: 1, corpseApples: false }), { corpseApples: false });
  });

  test('both default to off', () => {
    const e = createEngine();
    assert.equal(e.config.wrapWalls, false);
    assert.equal(e.config.corpseApples, false);
    assert.deepEqual(e.getState().rules, { corpseApples: false, wrapWalls: false, timeLimitWin: false, targetLengthWin: false, lastPersonWins: false, powerUps: false });
  });
});

describe('tick events', () => {
  const bystander = [[[15, 15], [14, 15], [13, 15]], 'right'];
  const events = (e) => e.getState().events;

  test('eating an apple reports who ate it and where', () => {
    const e = setup({ a: [[[4, 5], [3, 5], [2, 5]], 'right'], c: bystander });
    e._debug.setApples([[5, 5]]);
    e.tick();
    assert.deepEqual(events(e), [{ type: 'eat', id: 'a', x: 5, y: 5 }]);
  });

  test('a wall death is a death event only', () => {
    const e = setup({ a: [[[19, 5], [18, 5], [17, 5]], 'right'], c: bystander });
    e.tick();
    assert.deepEqual(events(e), [{ type: 'death', id: 'a', killerId: null }]);
  });

  test('head-on into the same cell reports the collision and the deaths', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[6, 5], [7, 5], [8, 5]], 'left'],
      c: bystander,
    });
    e.tick();
    const ev = events(e);
    assert.deepEqual(ev.find((x) => x.type === 'headOn'), { type: 'headOn', ids: ['a', 'b'] });
    assert.deepEqual(ev.filter((x) => x.type === 'death').map((x) => x.id).sort(), ['a', 'b']);
  });

  test('heads passing through each other count as head-on', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[5, 5], [6, 5], [7, 5]], 'left'],
      c: bystander,
    });
    e.tick();
    assert.ok(events(e).some((x) => x.type === 'headOn'));
  });

  test('events last one tick and are cleared by a restart', () => {
    const e = setup({ a: [[[4, 5], [3, 5], [2, 5]], 'right'], c: bystander });
    e._debug.setApples([[5, 5]]);
    e.tick();
    assert.equal(events(e).length, 1);
    e.tick();
    assert.deepEqual(events(e), []);
    e._debug.setApples([[7, 5]]);
    e.tick();
    assert.equal(events(e).length, 1);
    e.restartRound();
    assert.deepEqual(events(e), []);
  });
});

describe('spawn direction', () => {
  // Cells between the head and the edge it faces.
  const ahead = (x, y, dir, n) => ({ right: n - 1 - x, left: x, down: n - 1 - y, up: y })[dir];

  test('new snakes face away from the nearest edge (towards the center)', () => {
    for (const gridSize of [10, 11, 20, 30]) {
      for (let seed = 1; seed <= 25; seed++) {
        const e = createEngine({ config: { gridSize, appleCount: 3, maxPlayers: 6 }, random: seeded(seed) });
        for (let i = 0; i < 6; i++) e.addPlayer(`p${i}`, `P${i}`);
        e.tick(); // spawns and moves once
        for (const s of e.getState().snakes) {
          // Undo the first move to get the spawn cell.
          const { x, y } = s.segments[1];
          const best = Math.max(...['up', 'down', 'left', 'right'].map((d) => ahead(x, y, d, gridSize)));
          assert.equal(ahead(x, y, s.dir, gridSize), best, `grid ${gridSize} seed ${seed}: (${x},${y}) facing ${s.dir}`);
          assert.ok(best >= (gridSize - 1) / 2);
        }
      }
    }
  });
});

describe('spawn distance', () => {
  const manhattan = (a, b, n, wrap) => {
    let dx = Math.abs(a.x - b.x);
    let dy = Math.abs(a.y - b.y);
    if (wrap) {
      dx = Math.min(dx, n - dx);
      dy = Math.min(dy, n - dy);
    }
    return dx + dy;
  };
  // Spawn positions: a countdown keeps every snake where it spawned.
  function spawned(gridSize, count, seed, extra = {}) {
    const e = createEngine({
      config: { gridSize, appleCount: 3, maxPlayers: 24, countdownMs: 5000, ...extra },
      random: seeded(seed),
    });
    for (let i = 0; i < count; i++) e.addPlayer(`p${i}`, `P${i}`);
    e.tick();
    return e;
  }
  // Every head is far enough from every cell of every other snake.
  function assertSpread(snakes, n, wrap, label) {
    for (const s of snakes) {
      for (const o of snakes) {
        if (o === s) continue;
        for (const c of o.segments) {
          assert.ok(manhattan(s.segments[0], c, n, wrap) >= SPAWN_DISTANCE, `${label}: ${s.id} too close to ${o.id}`);
        }
      }
    }
  }

  test(`heads spawn at least ${SPAWN_DISTANCE} cells from every other snake`, () => {
    for (let seed = 1; seed <= 20; seed++) {
      const e = spawned(30, 12, seed);
      const { snakes, phase } = e.getState();
      assert.equal(phase, 'countdown');
      assert.equal(snakes.length, 12);
      assertSpread(snakes, 30, false, `seed ${seed}`);
    }
  });

  test('with wrap-around walls the distance is measured across the edges', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const e = spawned(14, 3, seed, { wrapWalls: true });
      assertSpread(e.getState().snakes, 14, true, `seed ${seed}`);
    }
  });

  test('a crowded board relaxes the distance instead of leaving players out', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const e = spawned(10, 12, seed);
      const { snakes, players } = e.getState();
      assert.ok(players.every((p) => p.status === 'alive'), `seed ${seed}`);
      const cells = snakes.flatMap((s) => s.segments.map((c) => `${c.x},${c.y}`));
      assert.equal(new Set(cells).size, cells.length, 'no overlapping snakes');
      for (const c of snakes.flatMap((s) => s.segments)) assert.ok(c.x >= 0 && c.y >= 0 && c.x < 10 && c.y < 10);
    }
  });

  test('a player joining during the countdown keeps the distance too', () => {
    for (let seed = 1; seed <= 10; seed++) {
      const e = spawned(30, 6, seed);
      e.addPlayer('late', 'Late');
      assert.equal(player(e, 'late').status, 'alive');
      assertSpread(e.getState().snakes, 30, false, `seed ${seed}`);
    }
  });
});

describe('kills', () => {
  const kills = (e, id) => player(e, id).kills;
  const deathOf = (e, id) => e.getState().events.find((x) => x.type === 'death' && x.id === id);
  const bystander = [[[15, 15], [14, 15], [13, 15]], 'right'];

  test('running into another snake gives that snake the kill', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[5, 7], [5, 6], [5, 5], [5, 4]], 'down'],
      c: bystander,
    });
    e.tick(); // a hits b's body at (5, 5)
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(kills(e, 'b'), 1);
    assert.equal(deathOf(e, 'a').killerId, 'b');
  });

  test('walls and self-collisions give no kill', () => {
    const e = setup({
      a: [[[19, 5], [18, 5], [17, 5]], 'right'],
      s: [[[5, 10], [5, 11], [6, 11], [6, 10], [7, 10], [8, 10]], 'right'],
      c: bystander,
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 's').status, 'dead');
    assert.ok(e.getState().players.every((p) => p.kills === 0));
    assert.equal(deathOf(e, 's').killerId, null);
  });

  test('the snake that survives a head-on gets the kill; a tie gives none', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[6, 5], [7, 5], [8, 5], [9, 5]], 'left'],
      c: bystander,
    });
    e.tick(); // a (shorter) survives
    assert.equal(kills(e, 'a'), 1);
    assert.equal(deathOf(e, 'b').killerId, 'a');

    const tie = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[6, 5], [7, 5], [8, 5]], 'left'],
      c: bystander,
    });
    tie.tick();
    assert.ok(tie.getState().players.every((p) => p.kills === 0));
  });

  test('heads passing through each other: the survivor gets the kill', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[5, 5], [6, 5], [7, 5], [8, 5]], 'left'],
      c: bystander,
    });
    e.tick();
    assert.equal(kills(e, 'a'), 1);
  });

  test('a body hit wins over a head-on in the same cell', () => {
    // a and b meet at (5, 5), which is also c's body: c gets both kills.
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[6, 5], [7, 5], [8, 5], [9, 5]], 'left'],
      c: [[[5, 7], [5, 6], [5, 5], [5, 4]], 'down'],
      d: bystander,
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(kills(e, 'c'), 2);
    assert.equal(kills(e, 'a'), 0);
  });

  test("credited deaths number the killer's kills this round", () => {
    // c gets a and b at once, then e runs into c's body a tick later.
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[6, 5], [7, 5], [8, 5], [9, 5]], 'left'],
      c: [[[5, 7], [5, 6], [5, 5], [5, 4]], 'down'],
      d: bystander,
      e: [[[3, 7], [2, 7], [1, 7]], 'right'],
    });
    e.tick();
    assert.deepEqual(['a', 'b'].map((id) => deathOf(e, id).killNo).sort(), [1, 2]);
    e.tick(); // e reaches (5, 7): c's body by now
    assert.equal(player(e, 'e').status, 'dead');
    assert.deepEqual(deathOf(e, 'e'), { type: 'death', id: 'e', killerId: 'c', killNo: 3 });
  });

  test('the kill numbering starts again each round', () => {
    const e = setup({ a: [[[4, 5], [3, 5], [2, 5]], 'right'], b: [[[5, 7], [5, 6], [5, 5], [5, 4]], 'down'] });
    e.tick(); // a runs into b: b alone, the round ends
    assert.equal(deathOf(e, 'a').killNo, 1);
    for (let i = 0; i < 20 && !(e.getState().phase === 'playing' && e.getState().round === 2); i++) e.tick();
    assert.equal(e.getState().round, 2);
    e._debug.setSnake('a', [[4, 5], [3, 5], [2, 5]], 'right');
    e._debug.setSnake('b', [[5, 7], [5, 6], [5, 5], [5, 4]], 'down');
    e.tick();
    assert.equal(deathOf(e, 'a').killNo, 1);
  });

  describe('takedowns: killing the leader in kills or length', () => {
    const row = (y, fromX, toX) => {
      const step = fromX <= toX ? 1 : -1;
      const out = [];
      for (let x = fromX; x !== toX + step; x += step) out.push([x, y]);
      return out;
    };
    const column = (x, fromY, toY) => row(0, fromY, toY).map(([y]) => [x, y]);
    // v runs into k's body at (5, 5). v's body: `length` cells back from
    // (4, 5) along row 5, down column 0 and along row 19.
    const trail = [...row(5, 4, 0), ...column(0, 6, 19), ...row(19, 1, 19)];
    const victim = (length) => [trail.slice(0, length), 'right'];
    // Not the round's first kill (see the first blood tests), unless `first`.
    const scene = (vLength, others = {}, { first = false } = {}) => {
      const e = setup({ v: victim(vLength), k: [[[5, 7], [5, 6], [5, 5], [5, 4]], 'down'], c: bystander, ...others });
      if (!first) e._debug.setKilledThisRound(true);
      return e;
    };
    const takedownOf = (e) => {
      e.tick();
      assert.equal(player(e, 'v').status, 'dead');
      return deathOf(e, 'v').takedown;
    };

    test('the longest snake, above 20 cells: an MVP takedown', () => {
      assert.equal(takedownOf(scene(21)), 'mvp');
      assert.equal(takedownOf(scene(20)), undefined); // not above 20
      const short = scene(5);
      short.tick();
      assert.deepEqual(deathOf(short, 'v'), { type: 'death', id: 'v', killerId: 'k', killNo: 1 });
    });

    test('not the longest: no MVP takedown; tied for longest: still one', () => {
      // c: a long snake in rows 12 and 11, heading up out of (19, 12).
      const long = (length) => [[...row(12, 19, 1), ...row(11, 1, 5)].slice(0, length), 'up'];
      assert.equal(takedownOf(scene(21, { c: long(22) })), undefined);
      assert.equal(takedownOf(scene(21, { c: long(21) })), 'mvp');
    });

    test('the most kills this round, above 2: a streak takedown', () => {
      for (const [kills, want] of [[3, 'streak'], [2, undefined]]) {
        const e = scene(3);
        e._debug.setKills('v', kills);
        assert.equal(takedownOf(e), want, `${kills} kills`);
      }
      const e = scene(3);
      e._debug.setKills('v', 3);
      e._debug.setKills('c', 4); // c leads
      assert.equal(takedownOf(e), undefined);
      const tie = scene(3);
      tie._debug.setKills('v', 4);
      tie._debug.setKills('c', 4);
      assert.equal(takedownOf(tie), 'streak');
    });

    test('both leaders at once: the streak wins', () => {
      const e = scene(22);
      e._debug.setKills('v', 3);
      assert.equal(takedownOf(e), 'streak');
    });

    test('only a credited kill is a takedown', () => {
      const e = setup({ v: [[[19, 5], [18, 5], [17, 5]], 'right'], c: bystander }); // into the wall
      e._debug.setKills('v', 5);
      e.tick();
      assert.deepEqual(deathOf(e, 'v'), { type: 'death', id: 'v', killerId: null });
    });

    test("the round's first credited kill is first blood, over MVP but not a streak", () => {
      assert.equal(takedownOf(scene(5, {}, { first: true })), 'firstBlood');
      assert.equal(takedownOf(scene(5)), undefined);
      assert.equal(takedownOf(scene(22, {}, { first: true })), 'firstBlood');
      const streak = scene(3, {}, { first: true });
      streak._debug.setKills('v', 3);
      assert.equal(takedownOf(streak), 'streak');
    });

    test('first blood: every credited kill on that tick, none after, again next round', () => {
      // c gets a and b at once (both first blood), then e a tick later (not).
      const e = setup({
        a: [[[4, 5], [3, 5], [2, 5]], 'right'],
        b: [[[6, 5], [7, 5], [8, 5], [9, 5]], 'left'],
        c: [[[5, 7], [5, 6], [5, 5], [5, 4]], 'down'],
        d: bystander,
        e: [[[3, 7], [2, 7], [1, 7]], 'right'],
      });
      e.tick();
      assert.deepEqual(['a', 'b'].map((id) => deathOf(e, id).takedown), ['firstBlood', 'firstBlood']);
      e.tick();
      assert.equal(deathOf(e, 'e').takedown, undefined);
      // A new round: first blood again.
      for (let i = 0; i < 400 && e.getState().round === 1; i++) e.tick();
      for (let i = 0; i < 20 && e.getState().phase !== 'playing'; i++) e.tick();
      assert.equal(e.getState().round, 2);
      e._debug.setSnake('a', [[4, 5], [3, 5], [2, 5]], 'right');
      e._debug.setSnake('c', [[5, 7], [5, 6], [5, 5], [5, 4]], 'down');
      e.tick();
      assert.equal(deathOf(e, 'a').takedown, 'firstBlood');
    });

    test('a death nobody gets does not use up first blood', () => {
      const e = setup({ w: [[[19, 5], [18, 5], [17, 5]], 'right'], v: victim(3), k: [[[5, 7], [5, 6], [5, 5], [5, 4]], 'down'], c: bystander });
      e._debug.setSnake('v', [[4, 9], [3, 9], [2, 9]], 'right'); // v waits a tick
      e.tick(); // w into the wall: no kill
      assert.deepEqual(deathOf(e, 'w'), { type: 'death', id: 'w', killerId: null });
      e._debug.setSnake('v', victim(3)[0], 'right');
      e._debug.setSnake('k', [[5, 7], [5, 6], [5, 5], [5, 4]], 'down');
      e.tick();
      assert.equal(deathOf(e, 'v').takedown, 'firstBlood');
    });

    test('leaders are taken as the tick began: a third kill on the tick it dies does not count', () => {
      // a runs into c's body (c's third kill) while c runs into d's body.
      const e = setup({
        a: [[[4, 5], [3, 5], [2, 5]], 'right'],
        c: [[[5, 6], [5, 5], [5, 4], [5, 3]], 'down'],
        d: [[[6, 7], [5, 7], [4, 7]], 'right'],
        z: bystander,
      });
      e._debug.setKills('c', 2);
      e._debug.setKilledThisRound(true);
      e.tick();
      assert.equal(deathOf(e, 'a').killNo, 3);
      assert.equal(deathOf(e, 'c').killerId, 'd');
      assert.equal(deathOf(e, 'c').takedown, undefined);
    });

    // s shoots v: a projectile at (6, 9) flying left meets v's head at (5, 9).
    const shooter = [[[10, 12], [9, 12], [8, 12]], 'right'];
    const shotScene = (vSnake = [[[4, 9], [3, 9], [2, 9]], 'right'], { first = false } = {}) => {
      const e = setup({ v: vSnake, s: shooter, c: bystander });
      if (!first) e._debug.setKilledThisRound(true);
      const head = vSnake[0][0];
      e._debug.addProjectile([head[0] + 2, head[1]], 'left', 's');
      return e;
    };

    test('a projectile kill is a HIT', () => {
      const e = shotScene();
      e.tick();
      assert.deepEqual(deathOf(e, 'v'), { type: 'death', id: 'v', killerId: 's', killNo: 1, takedown: 'hit' });
    });

    test('a gun fired right next to a body is a HIT too', () => {
      const e = setup({ v: [[[8, 9], [8, 8], [8, 7]], 'down'], s: [[[6, 9], [5, 9], [4, 9]], 'right'], c: bystander });
      e._debug.setKilledThisRound(true);
      e._debug.addPowerUps([[7, 9, 'gun']]); // eaten at x 7: fires into (8, 9), v's body by then
      e.tick();
      assert.deepEqual(deathOf(e, 'v'), { type: 'death', id: 'v', killerId: 's', killNo: 1, takedown: 'hit' });
    });

    test('HIT comes last: a streak, first blood or MVP takedown wins over it', () => {
      const streak = shotScene();
      streak._debug.setKills('v', 3);
      assert.equal(takedownOf(streak), 'streak');
      assert.equal(takedownOf(shotScene(undefined, { first: true })), 'firstBlood');
      assert.equal(takedownOf(shotScene(victim(21))), 'mvp');
    });

    test('shot while running into a body: the body gets the kill, no HIT', () => {
      const e = scene(3);
      e._debug.addProjectile([6, 5], 'left', 'c'); // meets v at (5, 5), k's body
      e.tick();
      assert.deepEqual(deathOf(e, 'v'), { type: 'death', id: 'v', killerId: 'k', killNo: 1 });
    });
  });

  test('a killer that dies on the same tick still gets the kill', () => {
    // a runs into b's body at (5, 5) while b's head leaves the board.
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[0, 6], [0, 5], [0, 4], [1, 4], [2, 4], [3, 4], [4, 4], [5, 4], [5, 5], [5, 6]], 'left'],
      c: bystander,
    });
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(kills(e, 'b'), 1);
  });

  test('kills reset at the start of every round', () => {
    const e = setup({
      a: [[[4, 5], [3, 5], [2, 5]], 'right'],
      b: [[[5, 7], [5, 6], [5, 5], [5, 4]], 'down'],
      c: bystander,
    });
    e.tick();
    assert.equal(kills(e, 'b'), 1);
    e.restartRound();
    assert.ok(e.getState().players.every((p) => p.kills === 0));
  });
});

describe('win conditions', () => {
  // An 80-wide board and the slowest ticks: snakes heading right live for 60+ ticks.
  const LONG = { gridSize: 80, tickMs: 300 };
  // A straight snake of `length` heading right, tail at x.
  const row = (y, length, x = 3) => [Array.from({ length }, (_, i) => [x + length - 1 - i, y]), 'right'];
  const state = (e) => e.getState();
  const runUntilEnd = (e, max = 200) => {
    for (let i = 0; i < max && state(e).phase === 'playing'; i++) e.tick();
    return state(e);
  };

  test('choices and new limits are validated', () => {
    assert.deepEqual(sanitizeConfig({ timeLimitWinner: 'kills' }), { timeLimitWinner: 'kills' });
    assert.deepEqual(sanitizeConfig({ timeLimitWinner: 'apples' }), {});
    assert.deepEqual(sanitizeConfig({ targetLength: 1 }), { targetLength: 4 }); // above the start length
    assert.deepEqual(sanitizeConfig({ timeLimitWin: 'yes', targetLengthWin: true }), { targetLengthWin: true });
    const e = createEngine();
    assert.equal(e.config.timeLimitWin, false);
    assert.equal(e.config.targetLengthWin, false);
    assert.equal(e.config.timeLimitWinner, 'longest');
  });

  test('time limit off: no timer', () => {
    const e = setup({ a: row(5, 3), b: row(10, 3) }, LONG);
    assert.equal(state(e).timeRemainingMs, null);
  });

  test('time limit: the longest living snake wins', () => {
    const e = setup({ a: row(5, 5), b: row(10, 3), c: row(15, 4) }, { ...LONG, timeLimitWin: true, roundTimeLimitSec: 15 });
    assert.equal(state(e).timeRemainingMs, 15000);
    e.tick();
    assert.equal(state(e).timeRemainingMs, 14700);
    const end = runUntilEnd(e);
    assert.equal(end.phase, 'intermission');
    assert.equal(end.endReason, 'time');
    assert.equal(end.winnerId, 'a');
    assert.equal(end.tick, 1 + 50); // the setup tick, then 15 s at 300 ms per tick
  });

  test('time limit: a full tie is a draw', () => {
    const e = setup({ a: row(5, 4), b: row(10, 4) }, { ...LONG, timeLimitWin: true, roundTimeLimitSec: 15 });
    const end = runUntilEnd(e);
    assert.equal(end.endReason, 'time');
    assert.equal(end.winnerId, null);
  });

  test('time limit by kills: most kills wins, ties broken by length', () => {
    const cfg = { ...LONG, timeLimitWin: true, roundTimeLimitSec: 15, timeLimitWinner: 'kills' };
    // d runs into b's body on the first tick: b has 1 kill, a is longer.
    const e = setup(
      {
        a: row(5, 6),
        b: [[[6, 12], [5, 12], [4, 12], [3, 12]], 'right'],
        c: row(20, 3),
        d: [[[4, 11], [4, 10], [4, 9]], 'down'],
      },
      cfg,
    );
    const end = runUntilEnd(e);
    assert.equal(player(e, 'b').kills, 1);
    assert.equal(end.endReason, 'time');
    assert.equal(end.winnerId, 'b');

    const noKills = setup({ a: row(5, 6), b: row(10, 4) }, cfg); // nobody has kills: longest
    assert.equal(runUntilEnd(noKills).winnerId, 'a');
  });

  test('the timer only runs while playing, not in the countdown', () => {
    const e = createEngine({
      config: { ...LONG, timeLimitWin: true, roundTimeLimitSec: 15, countdownMs: 1800, appleCount: 0 },
      random: seeded(3),
    });
    e.addPlayer('a', 'A');
    e.addPlayer('b', 'B');
    e.tick(); // round starts in the countdown
    e.tick();
    assert.equal(state(e).phase, 'countdown');
    assert.equal(state(e).timeRemainingMs, 15000);
  });

  test('target length: the first snake to reach it wins at once', () => {
    const e = setup({ a: row(5, 4), b: row(10, 3) }, { ...LONG, targetLengthWin: true, targetLength: 5 });
    e._debug.setApples([[7, 5]]);
    e.tick(); // eats: length 4 plus 1 pending growth, which doesn't count yet
    assert.equal(state(e).phase, 'playing');
    e.tick(); // grows to 5
    const s = state(e);
    assert.equal(s.phase, 'intermission');
    assert.equal(s.endReason, 'target');
    assert.equal(s.winnerId, 'a');
  });

  test('target length: on the same tick the longest wins, a full tie is a draw', () => {
    const cfg = { ...LONG, targetLengthWin: true, targetLength: 5 };
    const e = setup({ a: row(5, 6), b: row(10, 5), c: row(15, 3) }, cfg);
    e.tick();
    assert.equal(state(e).endReason, 'target');
    assert.equal(state(e).winnerId, 'a');
    const tie = setup({ a: row(5, 5), b: row(10, 5), c: row(15, 3) }, cfg);
    tie.tick();
    assert.equal(state(tie).endReason, 'target');
    assert.equal(state(tie).winnerId, null);
  });

  test('same tick: last snake alive comes first, then target, then time', () => {
    // b dies on the wall while a reaches the target: last snake alive.
    const a = setup({ a: row(5, 6), b: [[[79, 10], [78, 10], [77, 10]], 'right'] }, { ...LONG, targetLengthWin: true, targetLength: 5 });
    a.tick();
    assert.equal(state(a).endReason, 'lastAlive');
    assert.equal(state(a).winnerId, 'a');
    // The target is reached on the very tick the time runs out: target.
    const t = setup(
      { a: row(5, 4), b: row(10, 6) },
      { ...LONG, targetLengthWin: true, targetLength: 7, timeLimitWin: true, roundTimeLimitSec: 15 },
    );
    for (let i = 0; i < 49; i++) t.tick();
    assert.equal(state(t).phase, 'playing');
    t._debug.setSnake('a', [[30, 5], [29, 5], [28, 5], [27, 5], [26, 5], [25, 5], [24, 5]], 'right');
    t.tick();
    assert.equal(state(t).timeRemainingMs, 0);
    assert.equal(state(t).endReason, 'target');
    assert.equal(state(t).winnerId, 'a');
  });

  test('win settings are locked when the round starts', () => {
    const e = setup({ a: row(5, 4), b: row(10, 3) }, { ...LONG, targetLengthWin: true, targetLength: 5 });
    e.updateConfig({ targetLength: 4, timeLimitWin: true });
    assert.equal(state(e).win.targetLength, 5);
    assert.equal(state(e).timeRemainingMs, null);
    e.tick();
    assert.equal(state(e).phase, 'playing');
    e.restartRound();
    assert.equal(state(e).win.targetLength, 4);
    assert.equal(state(e).rules.timeLimitWin, true);
  });

  test('a solo round can end on time or target, but nobody wins', () => {
    const e = setup({ a: row(5, 4) }, { ...LONG, targetLengthWin: true, targetLength: 4 });
    e.tick();
    assert.equal(state(e).endReason, 'target');
    assert.equal(state(e).winnerId, null);
    const t = setup({ a: row(5, 4) }, { ...LONG, timeLimitWin: true, roundTimeLimitSec: 15 });
    const end = runUntilEnd(t);
    assert.equal(end.endReason, 'time');
    assert.equal(end.winnerId, null);
  });
});
