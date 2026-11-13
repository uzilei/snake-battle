// The honey badger: a 5x3 predator. Spawning, the warning, movement,
// bites, rats, projectiles and a long randomized run. Board positions are
// set by hand through engine._debug.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, sanitizeConfig, createDefaultConfig, CONFIG_LIMITS } from '../src/engine.js';
import { BADGER_RULES } from '../src/shared/badger.js';

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
// [segments (head first, as [x, y]), dir]. No spawn shield, rats or random
// badgers unless asked for.
function setup(snakes, config = {}) {
  const engine = createEngine({
    config: { gridSize: 20, appleCount: 0, intermissionMs: 0, ratChance: 0, spawnShieldSec: 0, badgerEverySec: 0, tickMs: 100, ...config },
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
const cells = (e, id) => snake(e, id).segments.map((c) => [c.x, c.y]);
const events = (e, type) => e.getState().events.filter((ev) => ev.type === type);
const badger = (e) => e.getState().badger;
const row = (y, fromX, toX) => {
  const out = [];
  const step = toX >= fromX ? 1 : -1;
  for (let x = fromX; x !== toX + step; x += step) out.push([x, y]);
  return out;
};
const far = { z: [[[18, 18], [18, 17], [18, 16]], 'left'] }; // a bystander, so rounds don't end
const STILL = { moveAt: 1e9 }; // a badger that doesn't move
// n ticks, putting the bystander back each time so it never reaches a wall.
function run(e, n) {
  for (let i = 0; i < n; i++) {
    e._debug.setSnake('z', far.z[0], far.z[1]);
    e.tick();
  }
}
// Whether the badger centered on (bx, by) covers (x, y).
const covers = (b, x, y) => Math.abs(x - b.x) <= 2 && Math.abs(y - b.y) <= 1;

describe('badger settings', () => {
  test('every 120 s on average by default (0 = never, else 30-600), 20 s lifetime', () => {
    assert.deepEqual(CONFIG_LIMITS.badgerEverySec, { min: 0, max: 600, default: 120, lowest: 30 });
    assert.equal(createDefaultConfig().badgerEverySec, 120);
    assert.equal(createDefaultConfig().badgerLifetimeSec, 20);
    assert.deepEqual(sanitizeConfig({ badgerEverySec: 0 }), { badgerEverySec: 0 });
    assert.deepEqual(sanitizeConfig({ badgerEverySec: 10 }), { badgerEverySec: 30 });
    assert.deepEqual(sanitizeConfig({ badgerEverySec: 900 }), { badgerEverySec: 600 });
    assert.deepEqual(sanitizeConfig({ badgerEverySec: -5 }), { badgerEverySec: 0 });
    assert.deepEqual(sanitizeConfig({ badgerEverySec: 'often' }), {});
    assert.deepEqual(sanitizeConfig({ badgerLifetimeSec: 1 }), { badgerLifetimeSec: CONFIG_LIMITS.badgerLifetimeSec.min });
  });
});

describe('badger spawning', () => {
  // Snakes circling on a wrapping board, so the round goes on.
  function circling(seed, config = {}) {
    const e = createEngine({
      config: { gridSize: 24, appleCount: 0, ratChance: 0, spawnShieldSec: 0, wrapWalls: true, badgerEverySec: 30, tickMs: 100, ...config },
      random: seeded(seed),
    });
    for (const id of ['a', 'b', 'c']) e.addPlayer(id, id);
    e.tick();
    return e;
  }
  // Steps from a head to the nearest cell of the block (the short way round
  // on a wrapping board).
  const steps = (h, b, n) => {
    const axis = (a, c, reach) => Math.max(0, Math.min(Math.abs(a - c), n - Math.abs(a - c)) - reach);
    return axis(h.x, b.x, 2) + axis(h.y, b.y, 1);
  };

  test('one turns up between 0.5x and 1.5x the average, fully on the board, 3+ steps from every head, warning first', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const e = circling(seed);
      let ms = 0;
      while (!badger(e) && ms < 60000) {
        // Keep the snakes alive: every few ticks, a turn.
        if (ms % 700 === 0) for (const id of ['a', 'b', 'c']) e.setDirection(id, ['up', 'left', 'down', 'right'][(ms / 700) % 4]);
        e.tick();
        ms += 100;
        const b = badger(e);
        if (!b) continue;
        assert.equal(e.getState().phase, 'playing');
        assert.ok(ms >= 15000 && ms <= 45000 + 100, `seed ${seed}: after ${ms} ms`);
        assert.deepEqual([b.width, b.height], [5, 3]);
        assert.ok(b.x - 2 >= 0 && b.x + 2 < 24 && b.y - 1 >= 0 && b.y + 1 < 24, `seed ${seed}: off the board`);
        // It's placed after the tick's moves: clear of the heads as they are now.
        const now = e.getState().snakes.filter((s) => s.alive).map((s) => s.segments[0]);
        for (const h of now) assert.ok(steps(h, b, 24) >= 3, `seed ${seed}: ${steps(h, b, 24)} steps from a head`);
        assert.equal(b.warningMs, BADGER_RULES.warningMs);
        assert.equal(events(e, 'badgerSpawn').length, 1);
      }
      assert.ok(badger(e), `seed ${seed}: never came`);
    }
  });

  test('the warning lasts 2 s, then it is active for its lifetime and goes', () => {
    const e = setup(far, { badgerLifetimeSec: 5 });
    e._debug.setBadger([10, 10], { warningMs: 2000 });
    run(e, 19);
    assert.equal(badger(e).warningMs, 100);
    assert.deepEqual([badger(e).x, badger(e).y], [10, 10]); // it doesn't move during the warning
    run(e, 1);
    assert.equal(badger(e).warningMs, 0);
    assert.equal(events(e, 'badgerActive').length, 1);
    run(e, 49);
    assert.ok(badger(e));
    run(e, 1); // 5 s of being active
    assert.equal(badger(e), null);
    assert.deepEqual(events(e, 'badgerGone').map((ev) => ev.type), ['badgerGone']);
  });

  test('during the warning it does nothing: no bites, no rats caught, projectiles fly through', () => {
    const e = setup({ a: [row(10, 7, 5), 'right'], ...far }, { appleCount: 1 });
    e._debug.setBadger([10, 10], { warningMs: 2000 });
    e._debug.addRat([7, 12], 'right', { moveAt: e.getState().tick + 1 });
    e._debug.addProjectile([7, 9], 'right', 'a');
    for (let i = 0; i < 3; i++) e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(snake(e, 'a').segments.length, 3);
    assert.equal(e.getState().rats.length, 1);
    assert.ok(badger(e));
    assert.equal(e.getState().projectiles.length, 1);
  });

  test('the average applies at once, even after the delay was drawn', () => {
    const e = setup(far, { badgerEverySec: 600 });
    run(e, 3000); // 300 s of play: the delay (300-900 s) has been drawn
    assert.equal(badger(e), null); // (with this seed it drew a longer one)
    e.updateConfig({ badgerEverySec: 30 }); // now due within 45 s: long past
    run(e, 1);
    assert.ok(badger(e));
  });

  test('a snake under the warning is safe when it activates, until it leaves and comes back', () => {
    const e = setup({ a: [row(10, 11, 9), 'right'], ...far }); // head at x 11, inside x 8-12
    e._debug.setBadger([10, 10], { warningMs: 200 });
    run(e, 2); // active at the end of the 2nd tick; a is at x 13, 12, 11
    assert.equal(badger(e).warningMs, 0);
    assert.deepEqual(cells(e, 'a'), row(10, 13, 11));
    assert.deepEqual([badger(e).x, badger(e).y], [10, 10]);
    e._debug.setBadger([10, 10], STILL); // keep it put from here on
    run(e, 3); // out the other side: x 16, 15, 14
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(snake(e, 'a').segments.length, 3);
    // Back in: down to (16, 11), then left until x 12.
    e.setDirection('a', 'down');
    run(e, 1);
    e.setDirection('a', 'left');
    run(e, 3); // x 15, 14, 13
    assert.equal(player(e, 'a').status, 'alive');
    run(e, 1);
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(events(e, 'badgerBite')[0].index, 0);
  });

  test('a rat under the warning is caught when the badger becomes active', () => {
    const e = setup(far, { appleCount: 1 });
    e._debug.setBadger([10, 10], { warningMs: 200 });
    e._debug.addRat([10, 10], 'up', { moveAt: 1e9 });
    run(e, 1);
    assert.equal(e.getState().rats.length, 1); // still the warning
    run(e, 1);
    assert.equal(e.getState().rats.length, 0);
    assert.deepEqual(events(e, 'ratCaught').map((ev) => [ev.x, ev.y]), [[10, 10]]);
  });

  test('a portal exit never opens inside it', () => {
    const e = setup({ a: [row(8, 3, 1), 'right'], ...far }, { gridSize: 12 });
    for (let i = 0; i < 30; i++) {
      e._debug.setSnake('a', row(8, 3, 1), 'right');
      e._debug.setSnake('z', [[11, 11], [11, 10], [11, 9]], 'left');
      e._debug.setBadger([6, 3], { warningMs: 5000 });
      e._debug.addPowerUps([[4, 8, 'portal']]);
      e.tick();
      const portal = e.getState().portals.at(-1);
      assert.ok(portal);
      for (const c of portal.ends) assert.ok(!covers({ x: 6, y: 3 }, c.x, c.y), `a portal end at ${c.x},${c.y}`);
    }
  });

  test('0 means never, and a new round clears it', () => {
    const e = setup(far, { badgerEverySec: 0 });
    for (let i = 0; i < 2000; i++) e.tick();
    assert.equal(badger(e), null);
    e._debug.setBadger([10, 10]);
    e.restartRound();
    assert.equal(badger(e), null);
  });

  test('no bomb lands on it', () => {
    const e = setup(far, { gridSize: 10, powerUps: true, bombsPerMinute: 20 });
    e.restartRound(); // power-ups apply from the next round
    for (const id of ['z']) e._debug.setSnake(id, [[9, 9], [9, 8], [9, 7]], 'left');
    e._debug.setBadger([4, 4], { ...STILL, remainingMs: 1e9 });
    let bombs = 0;
    for (let i = 0; i < 300 && player(e, 'z').status === 'alive'; i++) {
      e._debug.setSnake('z', [[9, 9], [9, 8], [9, 7]], 'left');
      e.tick();
      for (const b of e.getState().bombs) {
        bombs++;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) assert.ok(!covers(badger(e), b.x + dx, b.y + dy));
      }
    }
    assert.ok(bombs > 0);
  });
});

describe('badger movement', () => {
  test('one cell every 4 ticks, straight on until its turn timer runs out', () => {
    const e = setup(far);
    e._debug.setBadger([10, 10], { dir: 'left' });
    e.tick();
    assert.deepEqual([badger(e).x, badger(e).y], [9, 10]);
    for (let i = 0; i < 3; i++) e.tick();
    assert.deepEqual([badger(e).x, badger(e).y], [9, 10]);
    e.tick();
    assert.deepEqual([badger(e).x, badger(e).y], [8, 10]);
  });

  test('never leaves the board or wraps, even with wrap-around walls', () => {
    const e = setup(far, { wrapWalls: true });
    e._debug.setBadger([2, 1], { dir: 'left', remainingMs: 1e9 }); // in the top-left corner
    e.tick();
    const b = badger(e);
    assert.ok(b.dir === 'right' || b.dir === 'down', `turned ${b.dir}`);
    assert.ok(b.x >= 2 && b.y >= 1);
    // A long walk: always fully on the board, one cell at a time.
    let last = { x: b.x, y: b.y };
    for (let i = 0; i < 3000; i++) {
      e._debug.setSnake('z', [[18, 18], [18, 17], [18, 16]], 'left');
      e._debug.setEffect('z', 'ghost', 1e9); // the badger roams everywhere: don't get bitten
      e.tick();
      const now = badger(e);
      assert.ok(now.x - 2 >= 0 && now.x + 2 < 20 && now.y - 1 >= 0 && now.y + 1 < 20, `off the board at ${now.x},${now.y}`);
      assert.ok(Math.abs(now.x - last.x) + Math.abs(now.y - last.y) <= 1);
      last = now;
    }
  });

  test('a bomb or a portal end in the way turns it; snakes and items do not', () => {
    const e = setup({ a: [[[1, 1], [1, 2], [1, 3]], 'right'], ...far });
    e._debug.setApples([[7, 10]]);
    e._debug.setBadger([10, 10], { dir: 'left' });
    e.tick(); // apple and snake no obstacle
    assert.deepEqual([badger(e).x, badger(e).y], [9, 10]);
    e._debug.setBombs([[5, 10]]); // its cells x 4-6: the next step left would overlap
    for (let i = 0; i < 4; i++) e.tick();
    assert.notEqual(badger(e).dir, 'left');
    const t = setup(far);
    t._debug.addPortal([7, 11], [15, 3]);
    t._debug.setBadger([10, 10], { dir: 'left' });
    t.tick();
    assert.notEqual(badger(t).dir, 'left');
    assert.ok(!covers(badger(t), 7, 11));
  });
});

describe('badger bites', () => {
  // Badger at (10, 10): x 8-12, y 9-11.
  test('the badger moving onto a body cuts it at the closest new contact to the head', () => {
    // Row 12 below the block; the badger steps down onto x 8-12 of it.
    const e = setup({ a: [row(12, 15, 4), 'right'], ...far });
    e._debug.setBadger([10, 10], { dir: 'down' });
    e.tick();
    // After the move the body runs x 16..5; x 12 (index 4) is the first cell inside.
    assert.deepEqual(events(e, 'badgerBite'), [{ type: 'badgerBite', id: 'a', index: 4 }]);
    assert.deepEqual(cells(e, 'a'), row(12, 16, 13));
    assert.equal(player(e, 'a').status, 'alive');
  });

  test('cut segments follow the dead-snakes-become-apples toggle', () => {
    const e = setup({ a: [row(12, 15, 4), 'right'], ...far }, { corpseApples: true });
    e.restartRound();
    e._debug.setApples([]);
    e._debug.setSnake('a', row(12, 15, 4), 'right');
    e._debug.setSnake('z', far.z[0], 'left');
    e._debug.setBadger([10, 10], { dir: 'down' });
    e.tick();
    assert.deepEqual(e.getState().apples.map((a) => [a.x, a.y]).sort(), row(12, 12, 5).sort());
  });

  test('a head moving into the block dies, with no kill credit', () => {
    const e = setup({ a: [row(10, 7, 5), 'right'], ...far });
    e._debug.setBadger([10, 10], STILL);
    e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    assert.deepEqual(events(e, 'death'), [{ type: 'death', id: 'a', killerId: null }]);
    assert.ok(e.getState().players.every((p) => p.kills === 0));
  });

  test('the badger moving onto a head kills it', () => {
    // A frozen snake sitting out the tick, so only the badger moves.
    const e = setup({ a: [row(12, 12, 14), 'left'], ...far });
    run(e, 1);
    e._debug.setSnake('a', row(12, 12, 14), 'left');
    e._debug.setEffect('z', 'freeze', 5000);
    e._debug.setBadger([10, 10], { dir: 'down' }); // x 8-12, y 10-12 after its step
    e.tick();
    assert.deepEqual(events(e, 'badgerBite'), [{ type: 'badgerBite', id: 'a', index: 0 }]);
    assert.equal(player(e, 'a').status, 'dead');
  });

  test('a cut leaving fewer than 3 segments kills', () => {
    // After the move: x 14, 13, 12, ... so index 2 is the first one inside.
    const e = setup({ a: [row(12, 13, 8), 'right'], ...far });
    e._debug.setBadger([10, 10], { dir: 'down' });
    e.tick();
    assert.equal(events(e, 'badgerBite')[0].index, 2);
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(events(e, 'death')[0].killerId, null);
  });

  test('several snakes bitten in the same sub-step', () => {
    const e = setup({
      a: [row(12, 15, 4), 'right'], // the badger steps onto its body
      b: [row(10, 7, 5), 'right'], // its head walks in from the left
      c: [row(11, 13, 15), 'left'], // and this one's from the right
      ...far,
    });
    e._debug.setBadger([10, 10], { dir: 'down' }); // x 8-12, y 10-12 after its step
    e.tick();
    assert.deepEqual(
      events(e, 'badgerBite').map((ev) => [ev.id, ev.index]).sort(),
      [['a', 4], ['b', 0], ['c', 0]],
    );
    assert.equal(snake(e, 'a').segments.length, 4);
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'c').status, 'dead');
  });

  test('ghosts are never bitten', () => {
    const e = setup({ a: [row(10, 7, 5), 'right'], ...far });
    e._debug.setEffect('a', 'ghost', 3000);
    e._debug.setBadger([10, 10], STILL);
    for (let i = 0; i < 4; i++) e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(snake(e, 'a').segments.length, 3);
    assert.equal(events(e, 'badgerBite').length, 0);
  });

  test('a ghost that wears off partly inside is not cut until it touches it anew', () => {
    const e = setup({ a: [row(10, 6, 4), 'right'], ...far });
    e._debug.setEffect('a', 'ghost', 300); // wears off at the end of the 3rd tick, head at x 9
    e._debug.setBadger([10, 10], STILL);
    const bites = [];
    const run = (n) => {
      for (let i = 0; i < n; i++) {
        e.tick();
        bites.push(...events(e, 'badgerBite'));
      }
    };
    run(3);
    assert.equal(snake(e, 'a').effect, null);
    assert.deepEqual(cells(e, 'a'), row(10, 9, 7)); // head and neck inside
    run(4); // on through the block and out the other side
    assert.deepEqual(cells(e, 'a'), row(10, 13, 11));
    assert.equal(player(e, 'a').status, 'alive');
    run(2);
    assert.deepEqual(bites, []);
    // Back in: down, left, left into x 12.
    e.setDirection('a', 'down');
    run(1);
    e.setDirection('a', 'left');
    run(1);
    assert.equal(player(e, 'a').status, 'alive');
    run(2);
    assert.equal(player(e, 'a').status, 'dead');
    assert.equal(bites.length, 1);
    assert.equal(bites[0].index, 0);
  });

  test('a shield pops instead, and the snake slips through as a ghost', () => {
    const e = setup({ a: [row(10, 7, 5), 'right'], ...far });
    e._debug.setEffect('a', 'shield', 10000);
    e._debug.setBadger([10, 10], STILL);
    e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(snake(e, 'a').effect.type, 'ghost');
    assert.deepEqual(events(e, 'shieldPop').map((ev) => ev.id), ['a']);
    for (let i = 0; i < 4; i++) e.tick();
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(snake(e, 'a').segments.length, 3);
    // Shielded body cut: the shield pops and nothing is cut either.
    const t = setup({ a: [row(12, 15, 4), 'right'], ...far });
    t._debug.setEffect('a', 'shield', 10000);
    t._debug.setBadger([10, 10], { dir: 'down' });
    t.tick();
    assert.equal(snake(t, 'a').segments.length, 12);
    assert.equal(snake(t, 'a').effect.type, 'ghost');
  });

  test('a frozen snake standing still is bitten when the badger steps onto it', () => {
    const e = setup({ a: [row(12, 15, 4), 'right'], ...far });
    run(e, 1); // now on tick 2, so the next tick is odd: frozen snakes sit it out
    e._debug.setSnake('a', row(12, 15, 4), 'right');
    e._debug.setEffect('z', 'freeze', 5000); // freezes everyone else
    e._debug.setBadger([10, 10], { dir: 'down' });
    e.tick();
    assert.deepEqual(events(e, 'badgerBite'), [{ type: 'badgerBite', id: 'a', index: 3 }]);
    assert.deepEqual(cells(e, 'a'), row(12, 15, 13)); // it didn't move; x 12 down is gone
  });
});

describe('badger, rats and projectiles', () => {
  test('a rat running into it is caught: nobody grows or scores', () => {
    const e = setup(far, { appleCount: 1 }); // the rat is the one item
    e._debug.setBadger([10, 10], STILL);
    e._debug.addRat([7, 10], 'right');
    e.tick();
    assert.equal(e.getState().rats.length, 0);
    assert.equal(events(e, 'ratCaught').length, 1);
    assert.equal(events(e, 'eat').length, 0);
    assert.equal(snake(e, 'z').pendingGrowth, 0);
    assert.ok(e.getState().players.every((p) => p.kills === 0));
  });

  test('a rat it moves onto is caught', () => {
    const e = setup(far, { appleCount: 1 });
    e._debug.setBadger([10, 10], { dir: 'left' });
    e._debug.addRat([7, 10], 'up', { moveAt: 1e9 });
    e.tick();
    assert.equal(e.getState().rats.length, 0);
    assert.deepEqual(events(e, 'ratCaught').map((ev) => [ev.x, ev.y]), [[7, 10]]);
  });

  test('no rat spawns under it: that apple stays a plain apple', () => {
    const e = setup({ z: [[[0, 0], [0, 1], [0, 2]], 'right'] }, { gridSize: 10, ratChance: 100, appleCount: 70 });
    e._debug.setBadger([5, 5], STILL);
    e.tick();
    const s = e.getState();
    const under = s.apples.filter((a) => covers(s.badger, a.x, a.y));
    assert.ok(under.length > 0);
    assert.ok(s.rats.every((r) => !covers(s.badger, r.x, r.y)));
    assert.ok(s.rats.length > 0);
    assert.ok(s.powerUps.every((p) => !covers(s.badger, p.x, p.y)));
  });

  test('a projectile hitting it kills it, a kill for the shooter; the projectile is used up', () => {
    const e = setup({ a: [[[1, 1], [1, 2], [1, 3]], 'right'], ...far });
    e._debug.setBadger([10, 10], STILL);
    e._debug.addProjectile([5, 10], 'right', 'a');
    e.tick(); // x 6, 7
    assert.ok(badger(e));
    e.tick(); // x 8: in
    assert.equal(badger(e), null);
    assert.deepEqual(events(e, 'badgerKilled'), [{ type: 'badgerKilled', x: 10, y: 10, byId: 'a' }]);
    assert.equal(player(e, 'a').kills, 1);
    assert.equal(e.getState().projectiles.length, 0);
  });

  test('the badger stepping onto a projectile is killed too', () => {
    const e = setup({ a: [[[1, 1], [1, 2], [1, 3]], 'right'], ...far });
    e._debug.setBadger([10, 10], { dir: 'left' }); // x 7-11 after its step
    e._debug.addProjectile([7, 11], 'down', 'a'); // next cell (7, 12) is outside
    e.tick();
    assert.equal(badger(e), null);
    assert.equal(player(e, 'a').kills, 1);
  });

  test('a gun fired right next to it kills it', () => {
    const e = setup({ a: [row(10, 7, 5), 'right'], ...far });
    e._debug.setBadger([10, 10], STILL);
    e._debug.setSnake('a', row(10, 6, 4), 'right');
    e._debug.addPowerUps([[7, 10, 'gun']]); // eaten at x 7: fires into x 8
    e.tick();
    assert.equal(badger(e), null);
    assert.equal(player(e, 'a').kills, 1);
  });

  test('no kill credit for a shooter who has left', () => {
    const e = setup({ a: [[[1, 1], [1, 2], [1, 3]], 'right'], ...far });
    e._debug.setBadger([10, 10], STILL);
    e._debug.addProjectile([7, 10], 'right', 'a');
    e.removePlayer('a');
    e.tick();
    assert.equal(badger(e), null);
    assert.equal(events(e, 'badgerKilled')[0].byId, null);
  });
});

describe('badger fuzz', () => {
  // Rats, every power-up, bombs, six snakes steering at random, badgers
  // spawning on their own (and dropped in by hand now and then): after every
  // tick there's at most one badger, 5x3 and fully on the board, it moved at
  // most one cell and only every 4 ticks (never during its warning), never
  // onto a bomb or portal end, and no rat is inside an active one.
  test('a long random game with the badger on keeps every rule', () => {
    const dirs = ['up', 'down', 'left', 'right'];
    let natural = 0;
    let bites = 0;
    let caught = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const wrap = seed % 2 === 0;
      const random = seeded(seed);
      const e = createEngine({
        config: {
          gridSize: 18,
          appleCount: 12,
          intermissionMs: 0,
          ratChance: 40,
          powerUps: true,
          powerUpChance: 40,
          bombsPerMinute: 20,
          corpseApples: seed % 3 !== 0,
          wrapWalls: wrap,
          badgerEverySec: 30,
          badgerLifetimeSec: 10,
          spawnShieldSec: 10,
          tickMs: 300,
        },
        random: seeded(seed * 7919),
      });
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      for (const id of ids) e.addPlayer(id, id);
      let prev = null; // last tick's state
      let lastMove = -Infinity;
      for (let i = 0; i < 3000; i++) {
        for (const id of ids) if (random() < 0.3) e.setDirection(id, dirs[Math.floor(random() * 4)]);
        const s0 = e.getState();
        if (s0.phase === 'playing' && !s0.badger && random() < 0.01) {
          const at = { x: 2 + Math.floor(random() * 14), y: 1 + Math.floor(random() * 16) };
          if (!s0.rats.some((r) => covers(at, r.x, r.y))) e._debug.setBadger([at.x, at.y], { dir: dirs[Math.floor(random() * 4)] });
        }
        e.tick();
        const s = e.getState();
        natural += s.events.filter((ev) => ev.type === 'badgerSpawn').length;
        bites += s.events.filter((ev) => ev.type === 'badgerBite').length;
        caught += s.events.filter((ev) => ev.type === 'ratCaught').length;
        const b = s.badger;
        const where = `seed ${seed} tick ${s.tick}`;
        if (b) {
          assert.deepEqual([b.width, b.height], [5, 3]);
          assert.ok(b.x - 2 >= 0 && b.x + 2 < 18 && b.y - 1 >= 0 && b.y + 1 < 18, `${where}: badger off the board`);
          if (b.warningMs <= 0) for (const r of s.rats) assert.ok(!covers(b, r.x, r.y), `${where}: rat inside the badger`);
          const pb = prev?.round === s.round ? prev.badger : null;
          if (pb && pb.id === b.id) {
            const d = Math.abs(b.x - pb.x) + Math.abs(b.y - pb.y);
            assert.ok(d <= 1, `${where}: badger jumped`);
            if (d === 1) {
              assert.ok(pb.warningMs <= 0, `${where}: moved during its warning`);
              assert.ok(s.tick - lastMove >= 4, `${where}: moved too soon`);
              lastMove = s.tick;
              // Not onto a bomb or a portal end that was already there.
              const key = (x, y) => `${x},${y}`;
              const blocked = new Set();
              for (const bomb of prev.bombs) {
                if (!s.bombs.some((o) => o.x === bomb.x && o.y === bomb.y)) continue;
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) blocked.add(key(bomb.x + dx, bomb.y + dy));
              }
              for (const p of prev.portals) if (s.portals.some((o) => o.id === p.id)) for (const c of p.ends) blocked.add(key(c.x, c.y));
              for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) assert.ok(!blocked.has(key(b.x + dx, b.y + dy)), `${where}: moved onto a bomb or portal`);
            }
          } else lastMove = -Infinity;
        }
        prev = s;
      }
    }
    assert.ok(natural > 0, 'no badger ever spawned on its own');
    assert.ok(bites > 0, 'nobody was ever bitten');
    assert.ok(caught > 0, 'no rat was ever caught');
  });
});
