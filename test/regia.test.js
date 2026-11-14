// Regia: the /admin one-shot match controls (engine command(), several
// badgers, the server messages and "assisted" snakes in the records).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { createGame } from '../src/server/game.js';
import { createRecords } from '../src/server/records.js';
import { toRoman, badgerLabel } from '../src/shared/badger.js';
import { POWER_UP_RULES } from '../src/shared/powerups.js';

function seeded(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A playing round with snakes placed exactly (id -> [segments, dir]).
// Nothing spawns on its own unless asked for.
function setup(snakes, config = {}) {
  const engine = createEngine({
    config: { gridSize: 30, appleCount: 0, intermissionMs: 0, ratChance: 0, chickenChance: 0, spawnShieldSec: 0, badgerEverySec: 0, tickMs: 100, ...config },
    random: seeded(7),
  });
  for (const id of Object.keys(snakes)) engine.addPlayer(id, id);
  engine.tick();
  engine._debug.setApples([]);
  for (const [id, [segments, dir]] of Object.entries(snakes)) engine._debug.setSnake(id, segments, dir);
  return engine;
}
// Two snakes along the bottom rows, heading right with room ahead.
const TWO = { a: [[[5, 28], [4, 28], [3, 28]], 'right'], b: [[[5, 26], [4, 26], [3, 26]], 'right'] };
const state = (e) => e.getState();
const events = (e, type) => state(e).events.filter((ev) => ev.type === type);
const snake = (e, id) => state(e).snakes.find((s) => s.id === id);

describe('command(): validation', () => {
  test('refused unless a round is being played', () => {
    const e = createEngine({ config: { countdownMs: 1000, tickMs: 100 }, random: seeded(1) });
    assert.equal(e.command({ kind: 'spawn', item: 'apple' }), false); // waiting
    e.addPlayer('a', 'a');
    e.tick();
    assert.equal(state(e).phase, 'countdown');
    assert.equal(e.command({ kind: 'spawn', item: 'apple' }), false);
  });

  test('unknown kinds, items, ids, dead snakes and bad amounts are refused', () => {
    const e = setup(TWO);
    for (const bad of [
      null,
      'spawn',
      { kind: 'explode' },
      { kind: 'spawn', item: 'dragon' },
      { kind: 'spawn', item: 'feast ' },
      { kind: 'spawn', item: '__proto__' },
      { kind: 'grow', id: 'zz', amount: 5 },
      { kind: 'grow', id: 'a', amount: 0 },
      { kind: 'grow', id: 'a', amount: 51 },
      { kind: 'grow', id: 'a', amount: 2.5 },
      { kind: 'grow', id: 'a', amount: '5' },
      { kind: 'powerUp', id: 'a', item: 'toString' },
      { kind: 'powerUp', id: 'a', item: 'rat' },
      { kind: 'powerUp', id: 5, item: 'golden' },
      { kind: 'smite', id: 'nobody' },
    ]) {
      assert.equal(e.command(bad), false, JSON.stringify(bad));
    }
    e.command({ kind: 'smite', id: 'b' });
    e.tick();
    assert.equal(e.command({ kind: 'grow', id: 'b', amount: 5 }), false); // dead now
  });

  test('a command waits for the next tick, and a restart drops it', () => {
    const e = setup(TWO);
    assert.equal(e.command({ kind: 'spawn', item: 'apple' }), true);
    assert.equal(state(e).apples.length, 0);
    e.restartRound();
    e._debug.setApples([]);
    e.tick();
    assert.equal(state(e).apples.length, 0);
  });
});

describe('command(): spawning', () => {
  test('every kind of item appears on the next tick, as an extra on top of appleCount', () => {
    const e = setup(TWO, { appleCount: 2 });
    e.tick(); // the two regular apples
    assert.equal(state(e).apples.length, 2);
    for (const item of ['apple', 'apple', 'rat', 'chicken', 'golden', 'shield']) assert.equal(e.command({ kind: 'spawn', item }), true);
    e.tick();
    const s = state(e);
    assert.equal(s.apples.length, 4); // 2 regular + 2 bonus
    assert.equal(s.rats.length, 1);
    assert.equal(s.chickens.length, 1);
    assert.deepEqual(s.powerUps.map((p) => p.type).sort(), ['golden', 'shield']);
    e.tick(); // syncApples leaves the extras alone
    assert.equal(state(e).apples.length, 4);
    assert.equal(state(e).powerUps.length, 2);
  });

  test('power-ups spawn even with the power-up rule off', () => {
    const e = setup(TWO, { powerUps: false });
    e.command({ kind: 'spawn', item: 'magnet' });
    e.tick();
    assert.deepEqual(state(e).powerUps.map((p) => p.type), ['magnet']);
  });

  test('bombs ignore maxBombs and the power-up rule; the natural spawner still respects the cap', () => {
    const e = setup(TWO, { powerUps: false });
    const many = POWER_UP_RULES.maxBombs + 3;
    for (let i = 0; i < many; i++) e.command({ kind: 'spawn', item: 'bomb' });
    e.tick();
    assert.equal(state(e).bombs.length, many);

    const n = setup(TWO, { powerUps: true, bombsPerMinute: 20 });
    n._debug.setEffect('a', 'ghost', 60000);
    n._debug.setEffect('b', 'ghost', 60000);
    for (let i = 0; i < 20; i++) n.tick();
    assert.ok(state(n).bombs.length <= POWER_UP_RULES.maxBombs);
  });
});

describe('several badgers', () => {
  test('each spawn adds one more, numbered 1, 2, 3; `badger` is the first', () => {
    const e = setup(TWO);
    for (let i = 0; i < 3; i++) assert.equal(e.command({ kind: 'spawn', item: 'badger' }), true);
    e.tick();
    const s = state(e);
    assert.equal(s.badgers.length, 3);
    assert.deepEqual(s.badgers.map((b) => b.n), [1, 2, 3]);
    assert.equal(s.badger.id, s.badgers[0].id);
    const spawned = events(e, 'badgerSpawn');
    assert.equal(spawned.length, 3);
    assert.deepEqual(spawned.map((ev) => ev.badgerId), s.badgers.map((b) => b.id));
  });

  test('each one expires on its own; a new one takes the lowest free number', () => {
    const e = setup(TWO);
    e._debug.addBadger([5, 5]);
    e._debug.addBadger([14, 5], { remainingMs: 100 });
    e._debug.addBadger([23, 5]);
    const second = state(e).badgers[1];
    e.tick();
    assert.deepEqual(events(e, 'badgerGone').map((ev) => ev.badgerId), [second.id]);
    assert.deepEqual(state(e).badgers.map((b) => b.n), [1, 3]);
    e.command({ kind: 'spawn', item: 'badger' });
    e.tick();
    assert.deepEqual(state(e).badgers.map((b) => b.n), [1, 3, 2]);
  });

  test('each one moves', () => {
    const e = setup(TWO);
    e._debug.addBadger([5, 5]);
    e._debug.addBadger([20, 10]);
    e.tick();
    assert.deepEqual(state(e).badgers.map((b) => [b.x, b.y]), [[4, 5], [19, 10]]);
  });

  test('a projectile kills only the badger it hits, a kill for the shooter', () => {
    const e = setup(TWO);
    e._debug.addBadger([5, 5], { moveAt: 1e9 });
    e._debug.addBadger([15, 5], { moveAt: 1e9 });
    const [first, second] = state(e).badgers;
    e._debug.addProjectile([15, 9], 'up', 'a');
    e.tick(); // y 8, 7
    e.tick(); // y 6: inside the second badger
    const killed = events(e, 'badgerKilled');
    assert.equal(killed.length, 1);
    assert.equal(killed[0].badgerId, second.id);
    assert.equal(killed[0].byId, 'a');
    assert.deepEqual(state(e).badgers.map((b) => b.id), [first.id]);
    assert.equal(state(e).players.find((p) => p.id === 'a').kills, 1);
  });

  test('each one bites on its own', () => {
    // a heads up into the badger above it, b into the one above it.
    const e = setup({ a: [[[5, 9], [5, 10], [5, 11], [5, 12], [5, 13]], 'up'], b: [[[20, 9], [20, 10], [20, 11]], 'up'] });
    e._debug.addBadger([5, 7], { moveAt: 1e9 });
    e._debug.addBadger([20, 7], { moveAt: 1e9 });
    e.tick();
    assert.deepEqual(events(e, 'badgerBite').map((ev) => ev.id).sort(), ['a', 'b']);
  });

  test('the timer waits until every badger is gone, then brings one again', () => {
    const e = setup(
      { a: [[[5, 28], [4, 28], [3, 28]], 'right'], b: [[[5, 26], [4, 26], [3, 26]], 'right'] },
      { badgerEverySec: 30, wrapWalls: true },
    );
    e._debug.setEffect('a', 'ghost', 1e9);
    e._debug.setEffect('b', 'ghost', 1e9);
    e._debug.addBadger([5, 5], { remainingMs: 1e9 });
    e._debug.addBadger([20, 10], { remainingMs: 1e9 });
    let spawns = 0;
    for (let i = 0; i < 600; i++) {
      e.tick();
      spawns += events(e, 'badgerSpawn').length;
    }
    assert.equal(spawns, 0);
    assert.equal(state(e).badgers.length, 2);
    e.command({ kind: 'removeBadger' });
    e.tick();
    assert.equal(events(e, 'badgerGone').length, 2);
    assert.equal(state(e).badgers.length, 0);
    for (let i = 0; i < 500 && !spawns; i++) {
      e.tick();
      spawns += events(e, 'badgerSpawn').length;
    }
    assert.equal(spawns, 1); // 15-45 s of play
  });

  test('names: a Roman numeral only with more than one on the board', () => {
    assert.deepEqual([1, 2, 3, 4, 9, 14, 40, 90, 400, 1994].map(toRoman), ['I', 'II', 'III', 'IV', 'IX', 'XIV', 'XL', 'XC', 'CD', 'MCMXCIV']);
    assert.equal(toRoman(0), '');
    assert.equal(badgerLabel('Torquato Tasso', 1, 1), 'Torquato Tasso');
    assert.equal(badgerLabel('Torquato Tasso', 2, 3), 'Torquato Tasso II');
    assert.equal(badgerLabel('', 2, 3), '');
    assert.equal(badgerLabel(null, 1, 2), '');
  });
});

describe('command(): one snake', () => {
  test('grow adds pending growth', () => {
    const e = setup(TWO);
    e.command({ kind: 'grow', id: 'a', amount: 5 });
    e.tick();
    assert.equal(snake(e, 'a').segments.length, 4);
    assert.equal(snake(e, 'a').pendingGrowth, 4);
  });

  test('a power-up works as if eaten: timed ones become the effect, instant ones run', () => {
    const e = setup(TWO);
    e.command({ kind: 'powerUp', id: 'a', item: 'golden' });
    e.command({ kind: 'powerUp', id: 'b', item: 'feast' });
    e.tick();
    assert.equal(snake(e, 'a').effect.type, 'golden');
    // Laid round b's head before it moves, so it may eat some at once.
    assert.equal(state(e).apples.length + events(e, 'eat').length, POWER_UP_RULES.feastApples);
    assert.deepEqual(events(e, 'pickup').map((ev) => [ev.id, ev.item]), [['a', 'golden'], ['b', 'feast']]);
    e.command({ kind: 'powerUp', id: 'b', item: 'gun' });
    e.tick();
    assert.equal(events(e, 'shot').length, 1);
  });

  test('a bomb that kills drops corpse apples, like any death', () => {
    const e = setup(TWO, { bombMode: 'kill', corpseApples: true });
    e.command({ kind: 'powerUp', id: 'a', item: 'bomb' });
    e.tick();
    assert.equal(state(e).players.find((p) => p.id === 'a').status, 'dead');
    assert.equal(state(e).apples.filter((a) => a.corpse).length, 3);
  });

  test('smite: dead at once through a shield, nobody gets the kill, corpse apples, and the round can end', () => {
    const e = setup(TWO, { corpseApples: true });
    e._debug.setEffect('a', 'shield', 10000);
    e.command({ kind: 'smite', id: 'a' });
    e.tick();
    assert.deepEqual(events(e, 'death'), [{ type: 'death', id: 'a', killerId: null }]);
    assert.equal(state(e).apples.filter((a) => a.corpse).length, 3);
    assert.equal(state(e).phase, 'intermission');
    assert.equal(state(e).winnerId, 'b');
  });
});

// ---- server: messages and "assisted" snakes ----

function fakeClient(game, opts) {
  const sent = [];
  const conn = game.connect({ send: (m) => sent.push(m), close: () => {} }, opts);
  return {
    sent,
    send: (obj) => conn.message(JSON.stringify(obj)),
    last: (t) => sent.filter((m) => m.t === t).at(-1),
  };
}

describe('Regia on the server', () => {
  // Two phones (p1 Anna, p2 Luca) and the global leaderboard on.
  function twoPlayers() {
    const records = createRecords({}, { now: () => 5000 });
    const game = createGame({ log: () => {}, records });
    game.engine.updateConfig({ intermissionMs: 0 });
    game.settings.leaderboard = true;
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    for (const [i, name] of ['Anna', 'Luca'].entries()) {
      const phone = fakeClient(game);
      phone.send({ t: 'hello', role: 'player' });
      phone.send({ t: 'join', name, session: `session-${i}-abcdefghijklmnop` });
    }
    return { game, records, admin };
  }
  // Starts a round with p1 about to hit the wall and p2 (6 segments) safe.
  function start(game) {
    game.tickOnce();
    game.engine._debug.setSnake('p1', [[29, 5], [28, 5], [27, 5]], 'right');
    game.engine._debug.setSnake('p2', [[8, 15], [7, 15], [6, 15], [5, 15], [4, 15], [3, 15]], 'right');
  }
  const errors = (c) => c.sent.filter((m) => m.t === 'error').length;

  test('bad payloads, and anything outside a playing round, are rejected', () => {
    const { game, admin } = twoPlayers();
    admin.send({ t: 'spawn', item: 'apple' }); // still waiting
    assert.equal(errors(admin), 1);
    start(game);
    for (const bad of [
      { t: 'spawn', item: 'dragon' },
      { t: 'spawn' },
      { t: 'grow', id: 'p1', amount: 999 },
      { t: 'grow', id: 'nobody', amount: 5 },
      { t: 'givePowerUp', id: 'p1', item: '__proto__' },
      { t: 'givePowerUp', id: 'p1' },
      { t: 'smite', id: ['p1'] },
    ]) {
      const before = errors(admin);
      admin.send(bad);
      assert.equal(errors(admin), before + 1, JSON.stringify(bad));
    }
    admin.send({ t: 'pause' });
    const before = errors(admin);
    admin.send({ t: 'spawn', item: 'apple' });
    assert.equal(errors(admin), before + 1); // not while paused
  });

  test('help from the Regia marks a snake assisted: its length that round is no record, its win still counts', () => {
    const { game, records, admin } = twoPlayers();
    start(game);
    admin.send({ t: 'grow', id: 'p2', amount: 5 });
    assert.equal(admin.last('admin').players.find((p) => p.id === 'p2').assisted, true);
    assert.equal(admin.last('admin').players.find((p) => p.id === 'p1').assisted, false);
    game.tickOnce(); // p1 hits the wall: Luca wins
    const top = records.top();
    assert.deepEqual(top.wins, [{ name: 'Luca', value: 1 }]);
    assert.deepEqual(top.score.map((r) => r.name), ['Anna']);

    // The mark lasts one round.
    start(game);
    assert.equal(admin.last('admin').players.find((p) => p.id === 'p2').assisted, false);
    game.tickOnce();
    assert.deepEqual(records.top().score.map((r) => r.name).sort(), ['Anna', 'Luca']);
  });

  test('a given power-up marks it too; smites and spawns mark nobody', () => {
    const { game, records, admin } = twoPlayers();
    start(game);
    admin.send({ t: 'givePowerUp', id: 'p1', item: 'shield' });
    admin.send({ t: 'spawn', item: 'badger' });
    admin.send({ t: 'smite', id: 'p2' });
    const players = admin.last('admin').players;
    assert.equal(players.find((p) => p.id === 'p1').assisted, true);
    assert.equal(players.find((p) => p.id === 'p2').assisted, false);
    game.tickOnce(); // Luca smitten (Anna's shield turns her off the wall): Anna wins
    assert.equal(game.engine.getState().winnerId, 'p1');
    const top = records.top();
    assert.deepEqual(top.wins, [{ name: 'Anna', value: 1 }]);
    assert.deepEqual(top.score.map((r) => r.name), ['Luca']);
    assert.equal(admin.last('admin').badgers, 1);
  });
});
