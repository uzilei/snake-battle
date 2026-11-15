import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { createBotBrain, BOT_BRAIN, queueBotMoves } from '../src/bot-brain.js';
import { createGame, resolveSidePanel } from '../src/server/game.js';
import { createRecords } from '../src/server/records.js';
import { botTarget, botName, BOT_NAME_PATTERN, MAX_SNAKES, pickBotSkill, validReservedBots, BOT_HIDDEN_SKILL } from '../src/shared/bots.js';
import { HAT_IDS } from '../src/shared/hats.js';

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

const quiet = () => {};
// A bystander in the bottom-right corner, so rounds don't end.
const far = { z: [[[18, 18], [18, 17], [18, 16]], 'left'] };
const row = (y, fromX, toX) => {
  const step = fromX <= toX ? 1 : -1;
  const out = [];
  for (let x = fromX; x !== toX + step; x += step) out.push([x, y]);
  return out;
};
const column = (x, fromY, toY) => row(0, fromY, toY).map(([y]) => [x, y]);

// Starts a round with the given snakes placed exactly (id -> [segments, dir]).
function setup(snakes, config = {}) {
  const engine = createEngine({
    config: { gridSize: 20, appleCount: 0, intermissionMs: 0, spawnShieldSec: 0, ...config },
    random: seeded(42),
  });
  for (const id of Object.keys(snakes)) engine.addPlayer(id, id, { bot: id !== 'z' });
  engine.tick(); // waiting -> playing
  engine._debug.setApples([]);
  for (const [id, [segments, dir]] of Object.entries(snakes)) engine._debug.setSnake(id, segments, dir);
  return engine;
}

// The direction the brain picks for `id` (skill 3: no mistakes).
function pick(engine, id = 'a', opts = {}, brain = createBotBrain({ random: seeded(1), onError: (err) => { throw err; } })) {
  return brain.think(engine.getState(), [id], { skill: 3, ...opts }).get(id);
}

const player = (e, id) => e.getState().players.find((p) => p.id === id);
const events = (e, type) => e.getState().events.filter((ev) => ev.type === type);

describe('engine: bot players', () => {
  test('a bot neither counts toward nor is held back by maxPlayers', () => {
    const e = createEngine({ config: { maxPlayers: 2 } });
    assert.equal(e.addPlayer('b1', 'Bot 1', { bot: true }).ok, true);
    assert.equal(e.addPlayer('a', 'A').ok, true);
    assert.equal(e.addPlayer('b', 'B').ok, true);
    assert.deepEqual(e.addPlayer('c', 'C'), { ok: false, reason: 'full' });
    assert.equal(e.addPlayer('b2', 'Bot 2', { bot: true }).ok, true);
    const players = e.getState().players;
    // People first in the list, whenever they joined.
    assert.deepEqual(players.map((p) => [p.id, p.bot]), [['a', false], ['b', false], ['b1', true], ['b2', true]]);
  });

  test('at each round start people take the first colors; those already below keep theirs', () => {
    const e = createEngine({ config: { appleCount: 0 } });
    e.addPlayer('a', 'A'); // 0
    e.addPlayer('b1', 'Bot 1', { bot: true }); // 1
    e.addPlayer('b2', 'Bot 2', { bot: true }); // 2
    e.addPlayer('c', 'C'); // 3
    e.addPlayer('d', 'D'); // 4
    e.tick();
    const colors = Object.fromEntries(e.getState().players.map((p) => [p.id, p.colorIndex]));
    assert.deepEqual(colors, { a: 0, c: 1, d: 2, b1: 3, b2: 4 });
    // Without bots nothing moves: a gap stays a gap.
    const plain = createEngine({ config: { appleCount: 0 } });
    plain.addPlayer('a', 'A');
    plain.addPlayer('b', 'B');
    plain.addPlayer('c', 'C');
    plain.removePlayer('a');
    plain.tick();
    assert.deepEqual(plain.getState().players.map((p) => p.colorIndex), [1, 2]);
  });

  test('setDirection with replace drops the queued turns first', () => {
    const e = setup({ a: [row(5, 5, 3), 'right'], ...far });
    e.setDirection('a', 'up');
    e.setDirection('a', 'left');
    assert.equal(e.setDirection('a', 'down', { replace: true }), true);
    e.tick();
    assert.equal(e.getState().snakes.find((s) => s.id === 'a').dir, 'down');
    e.tick();
    assert.equal(e.getState().snakes.find((s) => s.id === 'a').dir, 'down'); // nothing else was queued
    // Straight on: the queue is just emptied.
    e.setDirection('a', 'left');
    assert.equal(e.setDirection('a', 'down', { replace: true }), false);
    e.tick();
    assert.equal(e.getState().snakes.find((s) => s.id === 'a').dir, 'down');
  });

  test('only bots alive and a person waiting: the round ends at once, with no winner', () => {
    const e = setup({ a: [row(5, 5, 3), 'right'], b: [row(10, 5, 3), 'right'] });
    e.tick();
    assert.equal(e.getState().phase, 'playing');
    e.addPlayer('h', 'Human');
    assert.equal(player(e, 'h').status, 'queued');
    e.tick();
    assert.equal(e.getState().phase, 'intermission');
    assert.equal(e.getState().winnerId, null);
    e.tick(); // next round: the person plays
    assert.equal(player(e, 'h').status, 'alive');
  });

  describe('last person standing (/admin rule)', () => {
    // People h1 and h2, bot b; h2 drives into the right wall on the first tick.
    const round = (lastPersonWins, people = ['h1', 'h2']) => {
      const e = createEngine({ config: { gridSize: 20, appleCount: 0, spawnShieldSec: 0, lastPersonWins }, random: seeded(42) });
      for (const id of people) e.addPlayer(id, id);
      e.addPlayer('b', 'Bot', { bot: true });
      e.tick(); // waiting -> playing
      e._debug.setApples([]);
      e._debug.setSnake('h1', row(5, 5, 3), 'right');
      e._debug.setSnake('b', row(10, 5, 3), 'right');
      if (people.includes('h2')) e._debug.setSnake('h2', row(15, 19, 17), 'right');
      return e;
    };

    test('off by default', () => {
      assert.equal(createEngine().getState().rules.lastPersonWins, false);
    });

    test('on: the last person alive among bots wins at once', () => {
      const e = round(true);
      e.tick();
      assert.equal(player(e, 'h2').status, 'dead');
      const s = e.getState();
      assert.equal(s.phase, 'intermission');
      assert.equal(s.winnerId, 'h1');
      assert.equal(s.endReason, 'lastPerson');
    });

    test('off: the round plays on with the bot', () => {
      const e = round(false);
      e.tick();
      assert.equal(player(e, 'h2').status, 'dead');
      assert.equal(e.getState().phase, 'playing');
    });

    test('a round that started with one person: no free win against bots', () => {
      const e = round(true, ['h1']);
      e.tick();
      assert.equal(e.getState().phase, 'playing');
    });
  });

  test('people spawn first: on a board too small for everyone, a bot waits', () => {
    const e = createEngine({ config: { gridSize: 10, appleCount: 0 }, random: seeded(4) });
    for (let i = 1; i <= 40; i++) e.addPlayer(`b${i}`, `Bot ${i}`, { bot: true });
    e.addPlayer('h', 'Human');
    e.tick();
    assert.equal(player(e, 'h').status, 'alive');
    assert.ok(e.getState().players.some((p) => p.bot && p.status === 'queued'));
  });

  test('a round of bots only plays on; so does one with a person alive while another waits', () => {
    const e = setup({ a: [row(5, 5, 3), 'right'], b: [row(10, 5, 3), 'right'] });
    for (let i = 0; i < 5; i++) e.tick();
    assert.equal(e.getState().phase, 'playing');
    const m = setup({ a: [row(5, 5, 3), 'right'], z: [row(10, 5, 3), 'right'] }); // z is a person
    m.addPlayer('h', 'Human');
    m.tick();
    assert.equal(m.getState().phase, 'playing');
    assert.equal(player(m, 'h').status, 'queued');
  });
});

describe('bot brain: survive', () => {
  test('never into a wall', () => {
    const e = setup({ a: [row(5, 19, 17), 'right'], ...far });
    assert.ok(['up', 'down'].includes(pick(e)));
  });

  test('never into a body: the only safe way', () => {
    const e = setup({
      a: [row(5, 5, 3), 'right'],
      b: [column(6, 2, 8), 'up'], // (6, 5) ahead
      c: [row(4, 5, 2), 'right'], // its head above a's
      ...far,
    });
    assert.equal(pick(e), 'down');
  });

  test('moving into a tail that leaves this tick is fine', () => {
    // b's tail is at (6, 5), right ahead, and b isn't growing; up and down
    // lead into tiny pockets.
    const e = setup({
      a: [row(5, 5, 3), 'right'],
      b: [[[6, 2], [6, 3], [6, 4], [6, 5]], 'up'],
      ...far,
    });
    assert.equal(pick(e), 'right');
  });

  test('never into the badger', () => {
    const e = setup({ a: [row(10, 5, 3), 'right'], ...far });
    e._debug.setBadger([8, 10], { moveAt: 1e9 }); // x 6-10: (6, 10) is next
    assert.ok(['up', 'down'].includes(pick(e)));
  });

  test('never into a bomb that would kill it', () => {
    const e = setup({ a: [row(5, 6, 4), 'right'], ...far });
    e._debug.setBombs([[8, 5]]); // x 7-9, y 4-6
    assert.ok(['up', 'down'].includes(pick(e, 'a', { bombMode: 'kill' })));
    // In 'cut' mode a snake of 3 is too short to survive it too.
    assert.ok(['up', 'down'].includes(pick(e, 'a', { bombMode: 'cut' })));
  });

  test('a portal is judged by where it comes out', () => {
    const e = setup({
      a: [row(5, 5, 3), 'right'],
      b: [column(15, 12, 16), 'up'], // (15, 15) is mid-body
      ...far,
    });
    e._debug.addPortal([6, 5], [15, 15]);
    assert.ok(['up', 'down'].includes(pick(e)));
    // The same portal coming out somewhere free is fine (straight on).
    const free = setup({ a: [row(5, 5, 3), 'right'], ...far });
    free._debug.addPortal([6, 5], [12, 15]);
    assert.equal(pick(free), 'right');
  });

  test('not into a pocket smaller than itself, even for an apple', () => {
    // a (10 long) along row 10; w walls off the single cell (10, 9) above
    // its head, where an apple is.
    const e = setup({
      a: [row(10, 10, 1), 'right'],
      w: [[[11, 9], [11, 8], [10, 8], [9, 8], ...row(9, 9, 0)], 'right'],
      ...far,
    });
    e._debug.setApples([[10, 9]]);
    assert.notEqual(pick(e), 'up');
  });

  test('a long snake still tells a big pocket from open board', () => {
    // An inward spiral fills the top-left 19 x 19 cells: one wall chain of w
    // (growing, so it stays put), entrance at (18, 0), 163 free cells inside:
    // more than a fill capped at 150 would count, fewer than a's 200. a's
    // head is at (19, 0), facing the top wall: left into the spiral (an
    // apple just inside), right onto open board.
    const S = 18;
    const D = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    const turn = { down: 'left', left: 'up', up: 'right', right: 'down' };
    const taken = new Set([`${S},0`]); // the entrance stays open
    const open = (x, y) => !taken.has(`${x},${y}`);
    const free = (x, y) => x >= 0 && y >= 0 && x <= S && y <= S && open(x, y);
    const wall = [[S, 1]];
    taken.add(`${S},1`);
    // Straight on while the cell ahead and the one after are free, else turn.
    for (let dir = 'down', turns = 0, [x, y] = wall[0]; turns < 2; ) {
      const [dx, dy] = D[dir];
      if (free(x + dx, y + dy) && open(x + 2 * dx, y + 2 * dy)) {
        x += dx;
        y += dy;
        wall.push([x, y]);
        taken.add(`${x},${y}`);
        turns = 0;
      } else {
        dir = turn[dir];
        turns++;
      }
    }
    // a: down column 19, then back and forth along the bottom rows.
    const body = [...column(19, 0, 39)];
    for (let y = 39; body.length < 200; y--) body.push(...((39 - y) % 2 ? row(y, 39, 20) : row(y, 20, 39)));
    const e = setup(
      { a: [body.slice(0, 200), 'up'], w: [wall.reverse(), 'left'], z: [[[30, 20], [29, 20], [28, 20]], 'right'] },
      { gridSize: 40 },
    );
    e._debug.setApples([[17, 0]]);
    const state = e.getState();
    state.snakes.find((s) => s.id === 'w').pendingGrowth = 1000;
    // The spiral is what this test says it is.
    const pocket = new Set([`${S},0`]);
    for (const queue = [[S, 0]]; queue.length; ) {
      const [x, y] = queue.pop();
      for (const [dx, dy] of Object.values(D)) {
        const k = `${x + dx},${y + dy}`;
        if (free(x + dx, y + dy) && !pocket.has(k)) pocket.add(k) && queue.push([x + dx, y + dy]);
      }
    }
    assert.equal(pocket.size, 163);
    assert.equal(pick({ getState: () => state }), 'right');
  });

  // a's head at (19, 5), facing the right wall: up is its own body, down b's.
  const cornered = (others = {}) =>
    setup({
      a: [[[19, 5], [18, 5], [18, 4], [19, 4], [19, 3], [19, 2]], 'right'],
      b: [[[19, 8], [19, 7], [19, 6], [18, 6], [17, 6]], 'down'],
      ...far,
      ...others,
    });

  test('no way out: anything but the wall, and no spite move into another snake', () => {
    // up is its own body, down b's: no preference for b (the engine credits
    // b either way), so the first one that isn't the wall.
    assert.equal(pick(cornered()), 'up');
  });

  test('no way out between decisions too: never the wall', () => {
    const state = cornered().getState();
    const brain = createBotBrain({ random: seeded(5), onError: (err) => { throw err; } });
    const dirs = Array.from({ length: 400 }, () => brain.think(state, ['a'], { skill: 1 }).get('a'));
    assert.ok(dirs.every((d) => d !== 'right'));
  });

  // A golden bot's plan for this tick: [first, second].
  const plan = (e, id = 'a', opts = {}) => {
    const brain = createBotBrain({ random: seeded(1), onError: (err) => { throw err; } });
    const first = brain.think(e.getState(), [id], { skill: 3, ...opts }).get(id);
    return [first, brain.secondMoves().get(id)];
  };
  // Steers `ids` and ticks, as game.js does.
  const play = (e, brain, ids, ticks, opts = {}) => {
    for (let i = 0; i < ticks; i++) {
      const firsts = brain.think(e.getState(), ids, { skill: 3, ...opts });
      queueBotMoves(e.setDirection, firsts, brain.secondMoves());
      e.tick();
    }
  };

  test('a golden snake (two moves a tick) plans both cells: never straight into a body on the second', () => {
    const snakes = { a: [row(5, 5, 3), 'right'], b: [column(7, 2, 8), 'up'], ...far }; // (7, 5) is mid-body
    const plain = setup(snakes);
    assert.equal(pick(plain), 'right');
    const golden = setup(snakes);
    golden._debug.setEffect('a', 'golden', 3000);
    const [first, second] = plan(golden);
    assert.ok(first && second);
    assert.notDeepEqual([first, second], ['right', 'right']);
    const brain = createBotBrain({ random: seeded(1), onError: (err) => { throw err; } });
    play(golden, brain, ['a'], 1);
    assert.equal(player(golden, 'a').status, 'alive');
  });

  test('a golden bot 2 cells from a wall survives by turning, even on its second step', () => {
    // a's head at (18, 5) facing right: (19, 5), then the wall. b blocks
    // (18, 3) and c (18, 7), so going up or down two cells straight dies too;
    // a turn on the second step (or right, then up or down) doesn't.
    // b and c head off left; their bodies still cover (18, 3) and (18, 7)
    // after this tick's move (only the tails leave).
    const e = setup({
      a: [row(5, 18, 15), 'right'],
      b: [[...row(3, 14, 18), [18, 2]], 'left'],
      c: [[...row(7, 14, 18), [18, 8]], 'left'],
      ...far,
    });
    e._debug.setEffect('a', 'golden', 5000);
    const [first, second] = plan(e);
    assert.ok(first && second);
    const brain = createBotBrain({ random: seeded(1), onError: (err) => { throw err; } });
    play(e, brain, ['a'], 1);
    assert.equal(player(e, 'a').status, 'alive');
  });

  test('a golden bot can turn on its second step to reach food', () => {
    const e = setup({ a: [row(5, 5, 3), 'right'], ...far });
    e._debug.setApples([[6, 4]]); // right, then up: eaten this tick
    e._debug.setEffect('a', 'golden', 3000);
    assert.deepEqual(plan(e), ['right', 'up']);
    const brain = createBotBrain({ random: seeded(1), onError: (err) => { throw err; } });
    play(e, brain, ['a'], 1);
    const a = e.getState().snakes.find((s) => s.id === 'a');
    assert.deepEqual(a.segments[0], { x: 6, y: 4 });
    assert.ok(!e.getState().apples.some((p) => p.x === 6 && p.y === 4));
  });

  test("a golden bot's reaction wait counts both of its moves", () => {
    // random 0.99: every wait rolls the maximum (3 moves at skill 1), and a
    // reflex never fires, so the first decision comes once the wait is used up.
    const firstDecision = (golden) => {
      const e = setup({ a: [row(5, 5, 3), 'right'], ...far });
      if (golden) e._debug.setEffect('a', 'golden', 5000);
      const brain = createBotBrain({ random: () => 0.99, onError: (err) => { throw err; } });
      const state = e.getState();
      for (let n = 1; n <= 10; n++) if (brain.think(state, ['a'], { skill: 1 }).has('a')) return n;
      return null;
    };
    assert.equal(firstDecision(false), 4); // waits 3 ticks of 1 move
    assert.equal(firstDecision(true), 3); // waits 2 ticks of 2 moves
  });

  test('queueBotMoves: straight then a turn turns on the second move', () => {
    const e = setup({ a: [row(5, 5, 3), 'right'], ...far });
    e._debug.setEffect('a', 'golden', 3000);
    queueBotMoves(e.setDirection, new Map([['a', 'right']]), new Map([['a', 'down']]));
    e.tick();
    const a = e.getState().snakes.find((s) => s.id === 'a');
    assert.deepEqual(a.segments.slice(0, 3), [{ x: 6, y: 6 }, { x: 6, y: 5 }, { x: 5, y: 5 }]);
    // A plain answer still replaces the queue.
    queueBotMoves(e.setDirection, new Map([['a', 'right']]));
    assert.equal(e.setDirection('a', 'up'), true); // nothing stale ahead of it
  });

  test('a ghost with time to spare goes through bodies, but never walls', () => {
    const wall = { a: [row(5, 5, 3), 'right'], b: [column(6, 1, 15), 'up'], ...far };
    const e = setup(wall);
    e._debug.setApples([[8, 5]]);
    assert.notEqual(pick(e), 'right');
    e._debug.setEffect('a', 'ghost', 3000);
    assert.equal(pick(e), 'right');
    const edge = setup({ a: [row(5, 19, 17), 'right'], ...far });
    edge._debug.setEffect('a', 'ghost', 3000);
    assert.ok(['up', 'down'].includes(pick(edge)));
  });

  test('a bot that will not move this tick (frozen, odd tick) is left alone', () => {
    const e = setup({ a: [row(5, 19, 17), 'right'], ...far });
    e._debug.setEffect('z', 'freeze', 3000);
    const state = e.getState();
    const brain = createBotBrain({ random: seeded(1) });
    const moves = brain.think(state, ['a'], { skill: 3 });
    assert.equal(moves.has('a'), (state.tick + 1) % 2 === 0);
  });
});

describe('bot brain: flee and hunt', () => {
  test('keeps away from the head of a snake as long or shorter, not a longer one', () => {
    const equal = setup({ a: [row(10, 5, 3), 'right'], b: [row(10, 8, 10), 'left'], ...far });
    assert.ok(['up', 'down'].includes(pick(equal)));
    const longer = setup({ a: [row(10, 5, 3), 'right'], b: [row(10, 8, 13), 'left'], ...far });
    assert.equal(pick(longer), 'right');
  });

  test('keeps away from the badger', () => {
    const e = setup({ a: [row(10, 5, 3), 'right'], ...far });
    e._debug.setBadger([10, 10], { moveAt: 1e9 }); // x 8-12: (6, 10) is 2 away
    assert.ok(['up', 'down'].includes(pick(e)));
  });

  test('eats food it can reach', () => {
    const e = setup({ a: [row(5, 5, 3), 'right'], ...far }, { appleCount: 1 }); // 0 would clear it
    e._debug.setApples([[9, 9]]);
    const brain = createBotBrain({ random: seeded(1) });
    let ate = false;
    for (let t = 0; t < 12 && !ate; t++) {
      for (const [id, dir] of brain.think(e.getState(), ['a'], { skill: 3 })) e.setDirection(id, dir, { replace: true });
      e.tick();
      ate = events(e, 'eat').some((ev) => ev.id === 'a');
    }
    assert.ok(ate, 'never got to the apple');
  });

  test('a chicken a little further away beats an apple', () => {
    const e = setup({ a: [row(10, 10, 8), 'right'], ...far });
    e._debug.setApples([[12, 10]]); // 2 ahead
    e._debug.addChicken([10, 13], 'left', { moveAt: 1e9 }); // 3 below
    assert.equal(pick(e), 'down');
  });

  test('with scissors it goes for another snake\'s body', () => {
    // b fills row 9 and goes round and round it (walls wrap).
    const snakes = { a: [row(5, 5, 3), 'right'], b: [row(9, 19, 1), 'right'], ...far };
    const e = setup(snakes, { wrapWalls: true });
    e._debug.setEffect('a', 'scissors', 8000);
    assert.equal(pick(e), 'down');
    const brain = createBotBrain({ random: seeded(1) });
    let cut = false;
    for (let t = 0; t < 8 && !cut; t++) {
      for (const [id, dir] of brain.think(e.getState(), ['a'], { skill: 3 })) e.setDirection(id, dir, { replace: true });
      e.tick();
      cut = events(e, 'cut').some((ev) => ev.byId === 'a');
    }
    assert.ok(cut, 'never cut b');
    assert.equal(player(e, 'a').status, 'alive');
  });

  test('with scissors the badger is a target too, and it hits it', () => {
    const e = setup({ a: [row(10, 5, 3), 'right'], ...far });
    e._debug.setBadger([5, 15], { moveAt: 1e9 }); // y 14-16, below
    e._debug.setEffect('a', 'scissors', 8000);
    assert.equal(pick(e), 'down');
    const brain = createBotBrain({ random: seeded(1) });
    let hit = false;
    for (let t = 0; t < 12 && !hit; t++) {
      for (const [id, dir] of brain.think(e.getState(), ['a'], { skill: 3 })) e.setDirection(id, dir, { replace: true });
      e.tick();
      hit = events(e, 'badgerHit').some((ev) => ev.id === 'a');
    }
    assert.ok(hit, 'never hit the badger');
    assert.equal(player(e, 'a').status, 'alive');
  });
});

describe('bot brain: skill', () => {
  // Equal heads ahead: a careful bot turns away (right is safe, just risky).
  const scene = () => setup({ a: [row(10, 5, 3), 'right'], b: [row(10, 8, 10), 'left'], ...far });

  test('skill 3 never makes mistakes', () => {
    const brain = createBotBrain({ random: seeded(7) });
    const state = scene().getState();
    for (let i = 0; i < 200; i++) assert.notEqual(brain.think(state, ['a'], { skill: 3 }).get('a'), 'right');
  });

  test('a mistake is still a safe move: never the badger, a projectile, a body or a wall', () => {
    // Each scene: straight on is deadly, up and down are fine.
    const badger = setup({ a: [row(10, 5, 3), 'right'], ...far });
    badger._debug.setBadger([8, 10], { moveAt: 1e9 });
    const shot = setup({ a: [row(10, 5, 3), 'right'], ...far });
    shot._debug.addProjectile([8, 10], 'left', 'z'); // next tick: (7, 10) then (6, 10)
    const body = setup({ a: [row(10, 5, 3), 'right'], b: [column(6, 5, 15), 'up'], ...far });
    const wall = setup({ a: [row(10, 19, 17), 'right'], ...far });
    for (const [name, e] of Object.entries({ badger, shot, body, wall })) {
      const brain = createBotBrain({ random: seeded(3) });
      const state = e.getState();
      for (let i = 0; i < 200; i++) assert.notEqual(brain.think(state, ['a'], { skill: 1 }).get('a'), 'right', name);
    }
  });

  test('a ghost with time to spare ignores danger: straight past an equal head', () => {
    const e = setup({ a: [row(10, 5, 3), 'right'], b: [row(10, 8, 10), 'left'], ...far });
    e._debug.setEffect('a', 'ghost', 3000);
    assert.equal(pick(e), 'right');
    e._debug.setEffect('a', 'ghost', 1000); // not much left: careful again
    assert.ok(['up', 'down'].includes(pick(e)));
  });

  test('skill 1 sometimes ignores the danger and picks any safe move', () => {
    // A fresh brain each time.
    const random = seeded(7);
    const state = scene().getState();
    let risky = 0;
    for (let i = 0; i < 400; i++) {
      // The first direction a fresh brain gives within 4 moves (the longest wait is 3): its decision.
      const brain = createBotBrain({ random });
      let dir;
      for (let k = 0; k < 4 && !dir; k++) dir = brain.think(state, ['a'], { skill: 1 }).get('a');
      if (dir === 'right') risky++;
    }
    assert.ok(risky > 10 && risky < 100, `risky ${risky}`); // about 25% x 1/3
  });
});

describe('bot brain: reaction time', () => {
  // Food up and to the right: a fresh decision turns up; straight on is safe.
  const lure = () => {
    const e = setup({ a: [row(10, 5, 3), 'right'], ...far });
    e._debug.setApples([[5, 7]]);
    return e;
  };

  // The calls (one per move) on which it decides afresh. Straight on is safe
  // here, so in between it gives no direction at all.
  const decisions = (brain, state, skill, moves) =>
    Array.from({ length: moves }, () => brain.think(state, ['a'], { skill }).get('a'))
      .map((dir, i) => (dir ? i : -1))
      .filter((i) => i >= 0);

  // Moves between one decision and the next, over many decisions.
  const waitsBetween = (skill, seed, moves) => {
    const brain = createBotBrain({ random: seeded(seed), onError: (err) => { throw err; } });
    const got = decisions(brain, lure().getState(), skill, moves);
    return { first: got[0], waits: got.slice(1).map((i, k) => i - got[k] - 1) };
  };

  for (const skill of [1, 2, 3]) {
    const max = BOT_BRAIN.thinkWait[skill];
    test(max ? `skill ${skill} waits a random 0 to ${max} moves after each decision` : `skill ${skill} decides every move`, () => {
      const counts = Array(max + 1).fill(0);
      let total = 0;
      for (const seed of [1, 2, 3, 4]) {
        const { first, waits } = waitsBetween(skill, seed, 2000);
        assert.ok(first <= max, `seed ${seed}: first at ${first}`);
        for (const w of waits) {
          assert.ok(Number.isInteger(w) && w >= 0 && w <= max, `wait ${w}`);
          counts[w]++;
          total++;
        }
      }
      // Every wait as likely as the others (a fixed interval fails this).
      for (const c of counts) {
        assert.ok(Math.abs(c / total - 1 / (max + 1)) < 0.03, `waits ${counts}`);
      }
    });
  }

  test('the wait is rolled afresh after every decision, not repeated', () => {
    const { waits } = waitsBetween(1, 7, 400);
    const repeats = waits.slice(1).filter((w, k) => w === waits[k]).length;
    // Independent rolls of 0-3 repeat a quarter of the time.
    assert.ok(repeats / (waits.length - 1) < 0.4, `repeats ${repeats} of ${waits.length - 1}`);
  });

  test('between decisions it still turns away from certain death most of the time', () => {
    const state = setup({ a: [row(10, 19, 17), 'right'], ...far }).getState(); // facing the wall
    const brain = createBotBrain({ random: seeded(11) });
    const moves = 6000;
    let none = 0;
    for (let i = 0; i < moves; i++) {
      const dir = brain.think(state, ['a'], { skill: 1 }).get('a');
      assert.notEqual(dir, 'right');
      if (!dir) none++;
    }
    // A decision always turns, so it only misses between decisions: at skill 1
    // waits average 1.5 moves, so 1.5 of every 2.5 moves are in between.
    const reflex = 1 - none / (moves * 0.6);
    assert.ok(reflex > 0.75 && reflex < 0.95, `reflex ${reflex}`); // 85%
  });

  test('each round every bot starts at a random point of its countdown', () => {
    const brain = createBotBrain({ random: seeded(5) });
    const e = lure();
    const firsts = new Set();
    for (let round = 0; round < 60; round++) {
      brain.think({ ...e.getState(), phase: 'intermission' }, ['a'], { skill: 1 }); // between rounds: reset
      firsts.add(decisions(brain, e.getState(), 1, 4)[0]);
    }
    // Always within the first 4 moves, and not always on the same one.
    assert.deepEqual([...firsts].sort(), [0, 1, 2, 3]);
  });

  test('bots in one game spread their decisions over the ticks', () => {
    // 12 bots, each with food up and to the right of its head.
    const snakes = {};
    const apples = [];
    for (let i = 0; i < 12; i++) {
      snakes[`b${i}`] = [row(1 + i, 5, 3), 'right'];
      apples.push([7, 1 + i]);
    }
    const e = setup({ ...snakes, ...far });
    e._debug.setApples(apples);
    const ids = Object.keys(snakes);
    const brain = createBotBrain({ random: seeded(9) });
    const state = e.getState();
    const perTick = [0, 1, 2, 3].map(() => brain.think(state, ids, { skill: 1 }).size);
    assert.ok(perTick.reduce((a, b) => a + b, 0) >= 12); // each decided at least once
    assert.ok(Math.max(...perTick) < 12, `per tick ${perTick}`);
  });

  test('each bot thinks at its own skill when skills are given per bot', () => {
    // Two lured bots: a at skill 1 waits between decisions, b at skill 3 never does.
    const e = setup({ a: [row(10, 5, 3), 'right'], b: [row(14, 5, 3), 'right'], ...far });
    e._debug.setApples([[5, 7], [5, 11]]);
    const brain = createBotBrain({ random: seeded(4), onError: (err) => { throw err; } });
    const state = e.getState();
    const skills = new Map([['a', 1], ['b', 3]]);
    const decided = { a: 0, b: 0 };
    for (let i = 0; i < 40; i++) {
      const dirs = brain.think(state, ['a', 'b'], { skill: 3, skills });
      for (const id of ['a', 'b']) if (dirs.get(id)) decided[id]++;
    }
    assert.equal(decided.b, 40);
    assert.ok(decided.a < 25, `a decided ${decided.a} times`); // about 40 / 2.5
  });

  // Regression: with a fixed interval a bot circling an apple could fall into
  // step with the loop, deciding only where the apple wasn't next to its head
  // and keeping its course where it was, and never eat it.
  test('a bot circling right next to an apple eventually eats it', () => {
    // The 8 cells around the apple at (10, 10), in clockwise order.
    const ring = [[11, 9], [11, 10], [11, 11], [10, 11], [9, 11], [9, 10], [9, 9], [10, 9]];
    const dirTo = ([x, y], [px, py]) => (x > px ? 'right' : x < px ? 'left' : y > py ? 'down' : 'up');
    for (const skill of [1, 2]) {
      for (let at = 0; at < ring.length; at++) {
        for (const seed of [1, 2, 3]) {
          const segments = Array.from({ length: 6 }, (_, i) => ring[(at - i + ring.length) % ring.length]);
          const e = setup({ a: [segments, dirTo(segments[0], segments[1])], ...far }, { appleCount: 1 });
          e._debug.setApples([[10, 10]]);
          const brain = createBotBrain({ random: seeded(seed), onError: (err) => { throw err; } });
          const eaten = () => !e.getState().apples.some((a) => a.x === 10 && a.y === 10);
          let ticks = 0;
          for (; ticks < 100 && !eaten(); ticks++) {
            for (const [id, dir] of brain.think(e.getState(), ['a'], { skill })) e.setDirection(id, dir, { replace: true });
            e._debug.setSnake('z', ...far.z); // keep the bystander parked
            e.tick();
          }
          assert.ok(eaten(), `skill ${skill}, head at ${ring[at]}, seed ${seed}: still circling`);
          assert.equal(player(e, 'a').status, 'alive');
        }
      }
    }
  });
});

describe('bot brain: cost', () => {
  test('24 bots on an 80 x 80 board, everything on: within the node budget, far under a tick', () => {
    const e = createEngine({
      config: {
        gridSize: 80, appleCount: 20, powerUps: true, powerUpChance: 50, bombsPerMinute: 20,
        ratChance: 20, chickenChance: 10, badgerEverySec: 30, intermissionMs: 0, spawnShieldSec: 0,
      },
      random: seeded(5),
    });
    const ids = Array.from({ length: 24 }, (_, i) => `b${i + 1}`);
    for (const id of ids) e.addPlayer(id, id, { bot: true });
    const brain = createBotBrain({ random: seeded(9), onError: (err) => { throw err; } });
    let total = 0;
    let ticks = 0;
    for (let t = 0; t < 300; t++) {
      const started = performance.now();
      const moves = brain.think(e.getState(), ids, { skill: 2 });
      total += performance.now() - started;
      assert.ok(brain.nodesUsed() <= BOT_BRAIN.nodeBudget + 4 * 24, `nodes ${brain.nodesUsed()}`);
      for (const [id, dir] of moves) e.setDirection(id, dir, { replace: true });
      e.tick();
      ticks++;
    }
    const mean = total / ticks;
    assert.ok(mean < 15, `mean think ${mean.toFixed(2)} ms`); // the fastest tick is 50 ms
  });

  test('fuzz: random boards with every feature, wrapping or not, never throw', () => {
    for (const seed of [1, 2, 3, 4]) {
      const e = createEngine({
        config: {
          gridSize: 12 + seed * 4, appleCount: 6, powerUps: true, powerUpChance: 60, bombsPerMinute: 20, ratChance: 20,
          chickenChance: 20, badgerEverySec: 30, wrapWalls: seed % 2 === 0, corpseApples: true, intermissionMs: 0,
          bombMode: seed % 2 ? 'cut' : 'kill',
        },
        random: seeded(seed),
      });
      const ids = Array.from({ length: 8 }, (_, i) => `b${i}`);
      for (const id of ids) e.addPlayer(id, id, { bot: true });
      const brain = createBotBrain({ random: seeded(seed + 10), onError: (err) => { throw err; } });
      for (let t = 0; t < 600; t++) {
        for (const [id, dir] of brain.think(e.getState(), ids, { skill: 1 + (t % 3), bombMode: e.config.bombMode })) {
          e.setDirection(id, dir, { replace: true });
        }
        e.tick();
      }
    }
  });
});

describe('server: bots', () => {
  function newGame(settings = {}, { records } = {}) {
    const game = createGame({ log: quiet, random: seeded(3), records });
    game.engine.updateConfig({ intermissionMs: 0, spawnShieldSec: 0 });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    if (Object.keys(settings).length) admin.send({ t: 'settings', ...settings });
    return { game, admin };
  }
  function fakeClient(game, opts) {
    const sent = [];
    const conn = game.connect({ send: (m) => sent.push(m), close: () => {} }, opts);
    return { sent, send: (obj) => conn.message(JSON.stringify(obj)), last: (t) => sent.filter((m) => m.t === t).at(-1) };
  }
  function phone(game, name) {
    const c = fakeClient(game);
    c.send({ t: 'hello', role: 'player' });
    c.send({ t: 'join', name });
    return c;
  }
  const botsOf = (game) => game.engine.getState().players.filter((p) => p.bot);

  test('off by default; the settings are checked', () => {
    const { game, admin } = newGame();
    assert.equal(game.settings.bots, 0);
    assert.equal(game.settings.botFill, false);
    assert.deepEqual([game.settings.botWeight1, game.settings.botWeight2, game.settings.botWeight3], [0, 1, 0]);
    game.tickOnce();
    assert.equal(botsOf(game).length, 0);
    for (const bad of [{ bots: 25 }, { bots: -1 }, { bots: 2.5 }, { botWeight1: -1 }, { botWeight3: 11 }, { botWeight2: 1.5 }, { botSkill: 2 }, { botFill: 'yes' }]) {
      admin.send({ t: 'settings', ...bad });
      assert.equal(admin.last('error').code, 'badMessage', JSON.stringify(bad));
    }
    assert.equal(game.settings.bots, 0);
  });

  test('bots fill an empty board and play: "Bot 1", "Bot 2"..., marked as bots', () => {
    const { game } = newGame({ bots: 3 });
    game.tickOnce(); // waiting: they join, and the round starts
    const state = game.engine.getState();
    assert.equal(state.phase, 'playing');
    assert.deepEqual(botsOf(game).map((p) => p.name), ['Bot 1', 'Bot 2', 'Bot 3']);
    assert.ok(botsOf(game).every((p) => p.status === 'alive'));
    for (let i = 0; i < 20; i++) game.tickOnce();
    assert.equal(game.health().bots.count, 3);
    assert.equal(typeof game.health().bots.thinkMeanMs, 'number');
    assert.equal(game.health().players, 0); // people only
  });

  test('the winner stays on the board through the intermission; bots leave at its end', () => {
    const { game, admin } = newGame({ bots: 2 });
    game.engine.updateConfig({ intermissionMs: 1000, tickMs: 200 });
    game.tickOnce();
    admin.send({ t: 'kick', id: 'b2' }); // gone mid-round: Bot 1 wins
    game.tickOnce();
    assert.equal(game.engine.getState().winnerId, 'b1');
    admin.send({ t: 'settings', bots: 0 });
    for (let i = 0; i < 3; i++) {
      game.tickOnce();
      assert.equal(game.engine.getState().phase, 'intermission');
      assert.deepEqual(botsOf(game).map((p) => p.id), ['b1']); // the winner, still listed
    }
    game.tickOnce(); // the last one: they leave, nobody's left
    game.tickOnce();
    assert.equal(botsOf(game).length, 0);
    assert.equal(game.engine.getState().phase, 'waiting');
  });

  test('a failing bot never stops the tick', () => {
    const logs = [];
    const game = createGame({ log: (l) => logs.push(l), random: seeded(3) });
    Object.assign(game.settings, { bots: 2 });
    game.tickOnce();
    const tick = game.engine.getState().tick;
    const real = game.engine.getState;
    game.engine.getState = () => {
      throw new Error('boom');
    };
    try {
      assert.doesNotThrow(() => game.tickOnce());
    } catch {
      /* broadcast also reads the state */
    }
    game.engine.getState = real;
    assert.ok(game.engine.getState().tick > tick, 'the engine ticked');
    assert.ok(logs.some((l) => l.startsWith('[bots] failed')));
  });

  test('fill mode: bots step aside for people at the next round', () => {
    const { game } = newGame({ bots: 4, botFill: true });
    game.tickOnce();
    assert.equal(botsOf(game).length, 4);
    phone(game, 'Anna');
    game.tickOnce(); // only bots alive, Anna waiting: the round ends
    assert.equal(game.engine.getState().phase, 'intermission');
    game.tickOnce(); // between rounds: one bot leaves, the round starts
    assert.deepEqual(botsOf(game).map((p) => p.name), ['Bot 1', 'Bot 2', 'Bot 3']);
    assert.equal(game.engine.getState().players.find((p) => p.name === 'Anna').status, 'alive');
  });

  test('fill math, and past 24 snakes it falls back to fill', () => {
    assert.equal(botTarget({ bots: 4, botFill: true }, 0), 4);
    assert.equal(botTarget({ bots: 4, botFill: true }, 1), 3);
    assert.equal(botTarget({ bots: 4, botFill: true }, 4), 0);
    assert.equal(botTarget({ bots: 4, botFill: true }, 9), 0);
    assert.equal(botTarget({ bots: 4, botFill: false }, 9), 4);
    assert.equal(botTarget({ bots: 20, botFill: false }, 3), 20);
    assert.equal(botTarget({ bots: 20, botFill: false }, 4), 20); // exactly 24
    assert.equal(botTarget({ bots: 20, botFill: false }, 6), 14);
    assert.equal(botTarget({ bots: 24, botFill: false }, 1), 23);
    assert.equal(MAX_SNAKES, 24);
    for (let bots = 0; bots <= 24; bots++) {
      for (let people = 0; people <= 24; people++) {
        for (const botFill of [false, true]) assert.ok(botTarget({ bots, botFill }, people) + people <= Math.max(24, people));
      }
    }
  });

  test('bots join and leave only between rounds, or at a restart', () => {
    const { game, admin } = newGame({ bots: 2 });
    game.tickOnce();
    assert.equal(botsOf(game).length, 2);
    admin.send({ t: 'settings', bots: 5 });
    game.tickOnce();
    assert.equal(game.engine.getState().phase, 'playing');
    assert.equal(botsOf(game).length, 2);
    admin.send({ t: 'restart' });
    assert.equal(botsOf(game).length, 5);
    assert.ok(botsOf(game).every((p) => p.status === 'alive'));
    admin.send({ t: 'settings', bots: 1 });
    admin.send({ t: 'restart' });
    assert.deepEqual(botsOf(game).map((p) => p.name), ['Bot 1']);
  });

  test('a person joining 24 snakes mid-round: the lowest-numbered bot leaves at once and they take its color', () => {
    const { game } = newGame({ bots: 24 });
    game.tickOnce();
    assert.equal(game.engine.getState().phase, 'playing');
    assert.equal(botsOf(game).length, 24);
    const anna = phone(game, 'Anna');
    const players = game.engine.getState().players;
    assert.equal(botsOf(game).length, 23);
    assert.ok(!players.some((p) => p.name === 'Bot 1'), 'the lowest number leaves');
    const colors = players.map((p) => p.colorIndex);
    assert.equal(new Set(colors).size, colors.length, 'a color twice');
    assert.ok(colors.every((c) => c < 24), JSON.stringify(colors));
    assert.equal(anna.last('joined').colorIndex, 0); // Bot 1's
    assert.equal(players[0].name, 'Anna'); // first in the list
    // A second person: Bot 2 goes.
    phone(game, 'Luca');
    assert.equal(botsOf(game).length, 22);
    assert.ok(!game.engine.getState().players.some((p) => p.name === 'Bot 2'));
    // Next round (it ends at once: only bots alive, people waiting): the
    // bots are renumbered 1-22 after the people, colors 2-23.
    for (let i = 0; i < 10 && game.engine.getState().round === 1; i++) game.tickOnce();
    const next = game.engine.getState();
    assert.equal(next.round, 2);
    assert.deepEqual(next.players.slice(0, 2).map((p) => [p.name, p.colorIndex]), [['Anna', 0], ['Luca', 1]]);
    assert.deepEqual(botsOf(game).map((p) => p.name), Array.from({ length: 22 }, (_, i) => `Bot ${i + 1}`));
    assert.deepEqual(botsOf(game).map((p) => p.colorIndex), Array.from({ length: 22 }, (_, i) => i + 2));
  });

  test('every round the bots are refreshed: renumbered, new ids, hats picked again', () => {
    const { game, admin } = newGame({ bots: 6 });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    game.tickOnce();
    const first = botsOf(game).map((p) => p.id);
    const hatsOf = (ids) => ids.map((id) => display.last('state').hats?.[id] ?? null);
    const firstHats = hatsOf(first);
    admin.send({ t: 'kick', id: first[0] }); // a gap: Bot 1 gone
    const pickedAgain = [];
    for (let r = 0; r < 4; r++) {
      admin.send({ t: 'restart' }); // the same settings
      const ids = botsOf(game).map((p) => p.id);
      assert.deepEqual(botsOf(game).map((p) => p.name), ['Bot 1', 'Bot 2', 'Bot 3', 'Bot 4', 'Bot 5', 'Bot 6']);
      assert.ok(ids.every((id) => !first.includes(id)), 'the same bots stayed');
      game.tickOnce();
      pickedAgain.push(JSON.stringify(hatsOf(ids)));
    }
    assert.ok(pickedAgain.some((h) => h !== JSON.stringify(firstHats)), 'hats never changed');
  });

  test('people get the first colors: someone who joined after the bots moves down at the next round', () => {
    const { game } = newGame({ bots: 3 });
    game.tickOnce(); // Bot 1-3: colors 0-2
    const anna = phone(game, 'Anna');
    assert.equal(anna.last('joined').colorIndex, 3); // the free one, for now
    for (let i = 0; i < 10 && game.engine.getState().round === 1; i++) game.tickOnce();
    const s = game.engine.getState();
    assert.equal(s.round, 2);
    assert.deepEqual(s.players.map((p) => [p.name, p.colorIndex]), [['Anna', 0], ['Bot 1', 1], ['Bot 2', 2], ['Bot 3', 3]]);
    // Her phone hears about it.
    assert.equal(anna.last('me').players.self.colorIndex, 0);
  });

  test('below 24, or when the person is turned away, no bot leaves mid-round', () => {
    const { game } = newGame({ bots: 10 });
    game.tickOnce();
    phone(game, 'Anna');
    assert.equal(botsOf(game).length, 10);
    const full = newGame({ bots: 24 }).game;
    full.engine.updateConfig({ maxPlayers: 1 });
    full.tickOnce();
    phone(full, 'Anna'); // takes the one place a person has (a bot makes room)
    assert.equal(botsOf(full).length, 23);
    assert.equal(phone(full, 'Luca').last('error').code, 'full');
    assert.equal(botsOf(full).length, 23);
  });

  test('bots are not counted for maxPlayers', () => {
    const { game } = newGame({ bots: 3 });
    game.engine.updateConfig({ maxPlayers: 1 });
    game.tickOnce();
    const a = phone(game, 'Anna');
    assert.equal(a.last('joined').name, 'Anna');
    const b = phone(game, 'Luca');
    assert.equal(b.last('error').code, 'full');
  });

  test('a phone cannot take a bot\'s name', () => {
    const { game } = newGame();
    for (const name of ['Bot 3', 'bot3', ' BOT  12 ']) assert.equal(phone(game, name).last('error').code, 'nameTaken', name);
    assert.equal(phone(game, 'Botanica').last('joined').name, 'Botanica');
    assert.ok(BOT_NAME_PATTERN.test(botName(24)));
  });

  test('records: bots are never recorded; a person\'s kill of a bot counts', () => {
    const records = createRecords({}, { now: () => 5000 });
    const { game, admin } = newGame({ bots: 2, leaderboard: true }, { records });
    const anna = phone(game, 'Anna');
    game.tickOnce(); // round starts: Anna and two bots
    const id = anna.last('joined').id;
    // Anna's projectile hits Bot 1's body.
    game.engine._debug.setSnake('b1', row(10, 10, 4), 'right');
    game.engine._debug.addProjectile([7, 8], 'down', id);
    game.tickOnce();
    assert.equal(game.engine.getState().players.find((p) => p.id === id).kills, 1);
    admin.send({ t: 'restart' }); // the round counts: no win, kills and lengths do
    const top = records.top();
    assert.deepEqual(top.kills, [{ name: 'Anna', value: 1 }]);
    assert.ok([...top.score, ...top.kills, ...top.wins].every((e) => !/^Bot/.test(e.name)), JSON.stringify(top));
  });

  describe('reserved bots', () => {
    const names = (game) => botsOf(game).map((p) => p.name);
    const hatOf = (admin, name) => admin.last('admin').players.find((p) => p.name === name).hat;

    test('none by default; names are cleaned, must be visible, unique and not "Bot N"; hats checked', () => {
      const { game, admin } = newGame();
      assert.deepEqual(game.settings.reservedBots, []);
      admin.send({ t: 'settings', reservedBots: [{ name: '  Rex   il\u200b Re ', hat: 'cap' }, { name: 'Nina' }] });
      assert.deepEqual(game.settings.reservedBots, [{ name: 'Rex il Re', hat: 'cap' }, { name: 'Nina', hat: null }]);
      const bad = [
        [{ name: '' }],
        [{ name: ' \u3164 ' }],
        [{ name: 'Bot 7' }],
        [{ name: 'bot3' }],
        [{ name: 'Nina' }, { name: ' Nina ' }],
        [{ name: 'Rex', hat: 'crown' }],
        [{ name: 42 }],
        [null],
        'Rex',
        Array.from({ length: 51 }, (_, i) => ({ name: `R${i}` })),
      ];
      for (const reservedBots of bad) {
        admin.send({ t: 'settings', reservedBots });
        assert.equal(admin.last('error').code, 'badMessage', JSON.stringify(reservedBots));
      }
      assert.equal(game.settings.reservedBots.length, 2);
      assert.ok(validReservedBots([{ name: 'Nina' }, { name: 'nina' }])); // case-sensitive, like player names
    });

    test('they fill first, with their own hats; the rest are "Bot 1", "Bot 2"...; all still bots', () => {
      const { game, admin } = newGame({ bots: 4, reservedBots: [{ name: 'Rex', hat: 'tophat' }, { name: 'Nina', hat: null }] });
      admin.send({ t: 'hello', role: 'admin' });
      game.tickOnce();
      const list = names(game);
      assert.deepEqual([...list.slice(0, 2)].sort(), ['Nina', 'Rex']);
      assert.deepEqual(list.slice(2), ['Bot 1', 'Bot 2']);
      assert.ok(game.engine.getState().players.every((p) => p.bot));
      assert.equal(hatOf(admin, 'Rex'), 'tophat');
      assert.equal(hatOf(admin, 'Nina'), null);
      assert.ok(admin.last('admin').players.every((p) => p.source === 'bot'));
    });

    test('more profiles than bots: a random pick of them each round, no "Bot N"', () => {
      const pool = ['Ada', 'Bea', 'Cid', 'Dan', 'Eva', 'Fil'];
      const { game, admin } = newGame({ bots: 2, reservedBots: pool.map((name) => ({ name })) });
      game.tickOnce();
      const picks = new Set();
      for (let i = 0; i < 12; i++) {
        const list = names(game);
        assert.equal(list.length, 2);
        assert.ok(list.every((n) => pool.includes(n)), list.join());
        picks.add([...list].sort().join());
        admin.send({ t: 'restart' }); // between rounds: the bots are refreshed
      }
      assert.ok(picks.size > 3, [...picks].join(' | '));
    });

    test('a profile whose name a person is using sits the round out', () => {
      const { game } = newGame({ bots: 2, reservedBots: [{ name: 'Rex' }, { name: 'Nina' }] });
      phone(game, 'Rex');
      game.tickOnce();
      assert.deepEqual(names(game), ['Nina', 'Bot 1']);
    });

    test('never recorded, whatever their name', () => {
      const records = createRecords({}, { now: () => 5000 });
      const { game, admin } = newGame({ bots: 2, leaderboard: true, reservedBots: [{ name: 'Rex' }] }, { records });
      for (let i = 0; i < 6; i++) game.tickOnce();
      admin.send({ t: 'restart' });
      const top = records.top();
      assert.deepEqual([...top.score, ...top.kills, ...top.wins], []);
    });
  });

  test('records: a round won by a bot has no winner', () => {
    const records = createRecords({}, { now: () => 5000 });
    const { game } = newGame({ bots: 1, leaderboard: true }, { records });
    const anna = phone(game, 'Anna');
    game.tickOnce();
    game.engine._debug.setSnake(anna.last('joined').id, row(5, 29, 27), 'right'); // into the wall (30 x 30)
    game.engine._debug.setEffect('b1', 'ghost', 5000); // so it surely survives the tick
    game.tickOnce();
    const state = game.engine.getState();
    assert.equal(state.phase, 'intermission');
    assert.equal(state.winnerId, 'b1');
    assert.deepEqual(records.top().wins, []);
    assert.deepEqual(records.top().score.map((e) => e.name), ['Anna']);
  });

  test('the auto side panel counts people only', () => {
    const bot = { bot: true };
    assert.equal(resolveSidePanel('auto', { phase: 'playing', players: [bot, bot, bot, { bot: false }] }), 'join');
    assert.equal(resolveSidePanel('auto', { phase: 'playing', players: [bot, { bot: false }, { bot: false }] }), 'leaderboard');
  });

  test('each bot gets a random hat or none, kept while it plays, shown like a phone hat', () => {
    const { game, admin } = newGame({ bots: 20 });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    game.tickOnce();
    const hats = display.last('state').hats;
    const ids = botsOf(game).map((p) => p.id);
    // Listed only when wearing one (like a phone that picked none).
    assert.ok(Object.values(hats).every((h) => HAT_IDS.includes(h)), JSON.stringify(hats));
    const picks = new Set(ids.map((id) => hats[id] ?? 'none'));
    assert.ok(picks.has('none'), 'nobody went without');
    assert.ok(picks.size > 2, 'too few different hats');
    for (let i = 0; i < 5; i++) game.tickOnce();
    assert.deepEqual(display.last('state').hats, hats); // the same ones
    assert.ok(admin.last('admin').players.filter((p) => p.bot).every((p) => p.hat === null || HAT_IDS.includes(p.hat)));
    admin.send({ t: 'settings', hats: false }); // the hats toggle covers them too
    assert.equal(display.last('state').hats, null);
  });

  test('/admin lists bots and can kick one (it comes back next round)', () => {
    const { game, admin } = newGame({ bots: 2 });
    game.tickOnce();
    assert.deepEqual(admin.last('admin').players.filter((p) => p.bot).map((p) => p.source), ['bot', 'bot']);
    admin.send({ t: 'kick', id: 'b1' });
    assert.equal(botsOf(game).length, 1);
    assert.equal(game.health().bots.count, 1);
    admin.send({ t: 'restart' });
    assert.equal(botsOf(game).length, 2);
    assert.deepEqual(botsOf(game).map((p) => p.name).sort(), ['Bot 1', 'Bot 2']);
  });

  test('new bots get their skills by the /admin weights', () => {
    const { game, admin } = newGame({ bots: 24, botWeight1: 0, botWeight2: 0, botWeight3: 1 });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    game.tickOnce();
    const skillsOf = () => botsOf(game).map((p) => display.last('state').botSkills[p.id]);
    assert.deepEqual([...new Set(skillsOf())], [3]);
    admin.send({ t: 'settings', botWeight1: 1, botWeight2: 1, botWeight3: 1 });
    admin.send({ t: 'restart' });
    game.tickOnce();
    assert.deepEqual([...new Set(skillsOf())].sort(), [1, 2, 3]); // 24 bots: all three show up
    // Only the bots: people get no skill.
    phone(game, 'Anna');
    game.tickOnce();
    assert.equal(Object.keys(display.last('state').botSkills).length, botsOf(game).length);
  });

  test('"mostra il livello dei bot": on by default; off, /display gets the robot for every bot', () => {
    const { game, admin } = newGame({ bots: 3, botWeight1: 0, botWeight2: 0, botWeight3: 1 });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    game.tickOnce();
    assert.equal(game.settings.botLevels, true);
    const skills = () => Object.values(display.last('state').botSkills);
    assert.deepEqual(skills(), [3, 3, 3]);
    admin.send({ t: 'settings', botLevels: false });
    assert.deepEqual(skills(), [BOT_HIDDEN_SKILL, BOT_HIDDEN_SKILL, BOT_HIDDEN_SKILL]);
    admin.send({ t: 'settings', botLevels: 'no' });
    assert.equal(admin.last('error').code, 'badMessage');
    admin.send({ t: 'settings', botLevels: true });
    assert.deepEqual(skills(), [3, 3, 3]); // the skills themselves never changed
  });

  test('settings saved with the old single bot skill keep it as the only weight', () => {
    const old = createGame({ log: quiet, savedSettings: { config: {}, settings: { botSkill: 3, bots: 4 } } });
    assert.deepEqual([old.settings.botWeight1, old.settings.botWeight2, old.settings.botWeight3], [0, 0, 1]);
    assert.equal(old.settings.bots, 4);
    assert.equal('botSkill' in old.settings, false);
    // Weights saved too: they win.
    const both = createGame({ log: quiet, savedSettings: { config: {}, settings: { botSkill: 3, botWeight1: 2, botWeight2: 0, botWeight3: 0 } } });
    assert.deepEqual([both.settings.botWeight1, both.settings.botWeight2, both.settings.botWeight3], [2, 0, 0]);
  });
});

describe('bot skill weights', () => {
  const share = (settings, n = 6000) => {
    const random = seeded(8);
    const counts = { 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < n; i++) counts[pickBotSkill(settings, random)]++;
    return [1, 2, 3].map((k) => counts[k] / n);
  };
  const near = (got, want) => got.every((v, i) => Math.abs(v - want[i]) < 0.03);

  test('skills come up in proportion to their weights', () => {
    const got = share({ botWeight1: 1, botWeight2: 2, botWeight3: 1 });
    assert.ok(near(got, [0.25, 0.5, 0.25]), `${got}`);
    assert.deepEqual(share({ botWeight1: 0, botWeight2: 0, botWeight3: 4 }), [0, 0, 1]);
    assert.deepEqual(share({ botWeight1: 0, botWeight2: 7, botWeight3: 0 }), [0, 1, 0]);
  });

  test('all weights at 0: each skill as likely', () => {
    const got = share({ botWeight1: 0, botWeight2: 0, botWeight3: 0 });
    assert.ok(near(got, [1 / 3, 1 / 3, 1 / 3]), `${got}`);
  });
});
