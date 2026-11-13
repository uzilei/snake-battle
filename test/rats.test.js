// Rats: rare food that runs around. Movement, eating, projectiles, spawning
// and a long randomized run. Board positions are set by hand through
// engine._debug.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, sanitizeConfig, CONFIG_LIMITS } from '../src/engine.js';
import { RAT_RULES } from '../src/shared/rats.js';

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

// Starts a round with the given snakes placed exactly (id -> [segments head
// first, dir]) and an empty board. Tick 1 starts the round.
function setup(snakes, config = {}, seed = 42) {
  const engine = createEngine({
    config: { gridSize: 20, appleCount: 0, intermissionMs: 0, ratChance: 0, chickenChance: 0, ...config },
    random: seeded(seed),
  });
  for (const id of Object.keys(snakes)) engine.addPlayer(id, id);
  engine.tick();
  engine._debug.setApples([]);
  for (const [id, [segments, dir]] of Object.entries(snakes)) engine._debug.setSnake(id, segments, dir);
  return engine;
}

// Two bystanders in the bottom corners, heading up, so rounds don't end.
const far = {
  y: [[[1, 17], [1, 18], [1, 19]], 'up'],
  z: [[[18, 17], [18, 18], [18, 19]], 'up'],
};
const NEVER = 1e9; // a tick that never comes
// appleCount = the items placed by hand, so the next tick neither trims them
// nor spawns new ones (until something is eaten).
function fill(e) {
  const s = e.getState();
  e.updateConfig({ appleCount: s.apples.length + s.powerUps.length + s.rats.length + s.chickens.length });
}
const rats = (e) => e.getState().rats.map((r) => [r.x, r.y]);
const rat = (e) => e._debug.rats()[0];
const snake = (e, id) => e.getState().snakes.find((s) => s.id === id);
const events = (e, type) => e.getState().events.filter((ev) => ev.type === type);

describe('rat movement', () => {
  test('runs one cell every second tick, straight on', () => {
    const e = setup(far);
    e._debug.addRat([5, 10], 'right');
    const seen = [];
    for (let i = 0; i < 6; i++) {
      fill(e);
      e.tick();
      seen.push(rats(e)[0]);
    }
    assert.deepEqual(seen, [[6, 10], [6, 10], [7, 10], [7, 10], [8, 10], [8, 10]]);
    assert.equal(RAT_RULES.moveEveryTicks, 2);
  });

  test('freeze slows it: a cell every 4 ticks while any snake has freeze, tinted on /display', () => {
    const e = setup(far);
    e._debug.addRat([5, 10], 'right');
    e._debug.setEffect('y', 'freeze', 1600); // 8 ticks at 200 ms
    const seen = [];
    for (let i = 0; i < 12; i++) {
      fill(e);
      e.tick();
      seen.push(rats(e)[0][0]);
      if (i === 0) {
        assert.equal(e.getState().creaturesFrozen, true);
        assert.equal(e.getState().rats[0].stepTicks, 4);
      }
    }
    // Moves on ticks 1, 5 and 9 (frozen), then the freeze is over: every 2.
    assert.deepEqual(seen, [6, 6, 6, 6, 7, 7, 7, 7, 8, 8, 9, 9]);
    assert.equal(e.getState().creaturesFrozen, false);
    assert.equal(e.getState().rats[0].stepTicks, 2);
  });

  test(`picks a new random direction every ${RAT_RULES.turnMinTicks}-${RAT_RULES.turnMaxTicks} ticks`, () => {
    const gaps = new Set();
    const dirs = new Set();
    for (let seed = 1; seed <= 60; seed++) {
      const e = setup(far, {}, seed);
      e._debug.addRat([10, 8], 'right', { turnAt: e.getState().tick + 1 });
      fill(e);
      e.tick(); // the timer has run out: a fresh direction, and a fresh timer
      const r = rat(e);
      dirs.add(r.dir);
      gaps.add(r.turnAt - e.getState().tick);
    }
    assert.ok(Math.min(...gaps) >= RAT_RULES.turnMinTicks && Math.max(...gaps) <= RAT_RULES.turnMaxTicks, [...gaps].join());
    assert.ok(gaps.size >= 12, [...gaps].join()); // spread over the range
    assert.deepEqual([...dirs].sort(), ['down', 'left', 'right', 'up']);
  });

  test('a spawned rat faces a random way, with its timer in range', () => {
    const e = setup(far, { ratChance: 100, appleCount: 20 });
    e.restartRound();
    const tick = e.getState().tick;
    const list = e._debug.rats();
    assert.equal(list.length, 20);
    for (const r of list) {
      assert.ok(r.turnAt - tick >= RAT_RULES.turnMinTicks && r.turnAt - tick <= RAT_RULES.turnMaxTicks);
      assert.equal(r.moveAt, tick + RAT_RULES.moveEveryTicks);
    }
    assert.ok(new Set(list.map((r) => r.dir)).size >= 3);
  });

  test('never doubles back while it has another way to go', () => {
    // Two snakes running along the top rows with wrap on: no dead ends.
    const rows = {
      a: [[[5, 0], [4, 0], [3, 0]], 'right'],
      b: [[[5, 1], [4, 1], [3, 1]], 'right'],
    };
    for (let seed = 1; seed <= 10; seed++) {
      const e = setup(rows, { wrapWalls: true }, seed);
      e._debug.addRat([10, 10], 'right');
      const path = [rats(e)[0]];
      for (let i = 0; i < 400; i++) {
        fill(e);
        e.tick();
        const now = rats(e)[0];
        if (!now) break; // a snake caught it
        const last = path[path.length - 1];
        if (now[0] === last[0] && now[1] === last[1]) continue;
        if (path.length >= 2) assert.notDeepEqual(now, path[path.length - 2], `seed ${seed} tick ${i}`);
        path.push(now);
      }
      assert.ok(path.length > 20); // it kept moving
    }
  });

  // The rat runs from (8,10) to (9,10), then finds (10,10) blocked: it turns
  // up or down, never back to (8,10) and never onto the blocker.
  function turnsAside(block, config = {}) {
    for (let seed = 1; seed <= 8; seed++) {
      const e = setup(far, config, seed);
      block(e);
      e._debug.addRat([8, 10], 'right');
      fill(e);
      e.tick(); // (9,10)
      e.tick(); // resting
      e.tick(); // blocked: turns
      const [x, y] = rats(e).find(([rx]) => rx !== 10 && rx !== 12) ?? [];
      assert.ok(x === 9 && (y === 9 || y === 11), `seed ${seed}: at ${x},${y}`);
    }
  }

  test('turns at once in front of a snake', () => {
    // Long enough to still cover (10,10) after three moves down.
    const wall = Array.from({ length: 10 }, (_, i) => [10, 14 - i]);
    turnsAside((e) => e._debug.setSnake('y', wall, 'down'));
  });

  test('turns at once in front of a bomb, a portal end, an apple, a power-up or another rat', () => {
    turnsAside((e) => e._debug.setBombs([[11, 10]]), { powerUps: true, bombsPerMinute: 0 });
    turnsAside((e) => e._debug.addPortal([10, 10], [3, 3]));
    turnsAside((e) => e._debug.setApples([[10, 10]]));
    turnsAside((e) => e._debug.addPowerUps([[10, 10, 'ghost']]));
    turnsAside((e) => e._debug.addRat([10, 10], 'up', { moveAt: NEVER }));
  });

  test('turns at a wall, and runs through it when walls wrap', () => {
    const e = setup(far);
    e._debug.addRat([18, 5], 'right');
    fill(e);
    for (let i = 0; i < 14; i++) {
      e.tick();
      const [x, y] = rats(e)[0];
      assert.ok(x >= 0 && x < 20 && y >= 0 && y < 20);
    }
    assert.notEqual(rat(e).dir, 'right');

    const w = setup(far, { wrapWalls: true });
    w._debug.addRat([19, 5], 'right');
    fill(w);
    w.tick();
    assert.deepEqual(rats(w), [[0, 5]]);
  });

  test('portals mean nothing to it: it never goes through one', () => {
    const e = setup(far);
    e._debug.addPortal([12, 10], [3, 3]);
    e._debug.addRat([10, 10], 'right');
    fill(e);
    for (let i = 0; i < 6; i++) e.tick();
    const [x, y] = rats(e)[0];
    assert.ok(Math.abs(x - 10) + Math.abs(y - 10) <= 3); // walked, didn't jump
  });

  test('in a dead end it turns back', () => {
    const e = setup(far);
    e._debug.setApples([[10, 10], [9, 9], [9, 11]]);
    e._debug.addRat([8, 10], 'right');
    fill(e);
    e.tick(); // (9,10): the only way on is back
    e.tick();
    e.tick();
    assert.deepEqual(rats(e), [[8, 10]]);
  });

  test('boxed in, it stays put', () => {
    const e = setup(far);
    e._debug.setApples([[11, 10], [9, 10], [10, 9], [10, 11]]);
    e._debug.addRat([10, 10], 'right');
    for (let i = 0; i < 6; i++) {
      fill(e);
      e.tick();
      assert.deepEqual(rats(e), [[10, 10]]);
    }
  });
});

describe('eating rats', () => {
  test(`a head entering its cell eats it: ${RAT_RULES.growthMultiplier} x growthPerApple, an eat event`, () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { growthPerApple: 2 });
    e._debug.addRat([6, 5], 'up', { moveAt: NEVER });
    fill(e);
    e.tick();
    assert.deepEqual(rats(e), []);
    assert.equal(snake(e, 'a').pendingGrowth, 2 * RAT_RULES.growthMultiplier);
    const [ev] = events(e, 'eat');
    assert.deepEqual([ev.id, ev.x, ev.y, ev.item], ['a', 6, 5, 'rat']);
    assert.deepEqual(events(e, 'pickup'), []);
  });

  test('a rat running into the cell a head is entering is eaten (rats move first)', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.addRat([6, 6], 'up'); // steps onto (6,5) as the head does
    fill(e);
    e.tick();
    assert.deepEqual(rats(e), []);
    assert.equal(snake(e, 'a').pendingGrowth, RAT_RULES.growthMultiplier);
    assert.equal(events(e, 'eat')[0].item, 'rat');
  });

  test('a rat running off the cell a head is entering is eaten too: it can’t slip past', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.addRat([6, 5], 'down'); // leaves for (6,6) as the head enters (6,5)
    fill(e);
    e.tick();
    assert.deepEqual(rats(e), []);
    assert.equal(snake(e, 'a').pendingGrowth, RAT_RULES.growthMultiplier);
  });

  test('one cell further away it is not caught', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.addRat([7, 5], 'right');
    fill(e);
    e.tick();
    assert.deepEqual(rats(e), [[8, 5]]);
    assert.equal(snake(e, 'a').pendingGrowth, 0);
  });

  test('a ghost eats rats too', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.setEffect('a', 'ghost', 3000);
    e._debug.addRat([6, 5], 'up', { moveAt: NEVER });
    fill(e);
    e.tick();
    assert.deepEqual(rats(e), []);
    assert.equal(snake(e, 'a').pendingGrowth, RAT_RULES.growthMultiplier);
  });

  test('a golden snake catches one in its second step', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.setEffect('a', 'golden', 3000);
    e._debug.addRat([7, 5], 'up', { moveAt: NEVER });
    fill(e);
    e.tick();
    assert.deepEqual(rats(e), []);
  });

  test('the magnet does not pull rats', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.setEffect('a', 'magnet', 5000);
    e._debug.setApples([[8, 6]]);
    e._debug.addRat([6, 7], 'up', { moveAt: NEVER }); // 2 cells from the new head
    fill(e);
    e.tick();
    assert.deepEqual(rats(e), [[6, 7]]);
    assert.ok(!e.getState().apples.some((a) => a.x === 8 && a.y === 6)); // the apple was pulled
  });
});

describe('projectiles and rats', () => {
  test('a projectile kills a rat: both vanish, nobody gets a kill', () => {
    const e = setup(far);
    e._debug.addProjectile([5, 10], 'right', 'y');
    e._debug.addRat([7, 10], 'up', { moveAt: NEVER });
    fill(e);
    e.tick(); // two cells: (6,10), then (7,10)
    const s = e.getState();
    assert.deepEqual([s.rats, s.projectiles], [[], []]);
    assert.ok(events(e, 'projectileEnd').some((ev) => ev.hit && ev.x === 7 && ev.y === 10));
    assert.ok(s.players.every((p) => p.kills === 0));
  });

  test('a rat running onto a projectile, or off the cell it enters, is hit', () => {
    const onto = setup(far);
    onto._debug.addProjectile([6, 10], 'left', 'y'); // to (5,10)
    onto._debug.addRat([5, 10], 'right'); // to (6,10): they swap
    fill(onto);
    onto.tick();
    assert.deepEqual([onto.getState().rats, onto.getState().projectiles], [[], []]);

    const off = setup(far);
    off._debug.addProjectile([4, 10], 'right', 'y'); // to (5,10)
    off._debug.addRat([5, 10], 'up'); // leaves for (5,9)
    fill(off);
    off.tick();
    assert.deepEqual(off.getState().rats, []);
  });

  test('a rat stepping in behind or beside a moving projectile is not hit', () => {
    for (const [from, dir] of [[[5, 10], 'right'], [[6, 11], 'up']]) {
      const e = setup(far);
      e._debug.addProjectile([6, 10], 'right', 'y'); // leaves (6,10) for (7,10), (8,10)
      e._debug.addRat(from, dir); // steps onto (6,10)
      fill(e);
      e.tick();
      assert.deepEqual(rats(e), [[6, 10]], `from ${from}`);
      assert.deepEqual(e.getState().projectiles.map((p) => [p.x, p.y]), [[8, 10]]);
    }
  });

  test('a gun fired right next to a rat kills it', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { powerUps: true, bombsPerMinute: 0 });
    e._debug.addPowerUps([[6, 5, 'gun']]);
    e._debug.addRat([7, 5], 'up', { moveAt: NEVER });
    fill(e);
    e.tick();
    assert.deepEqual([e.getState().rats, e.getState().projectiles], [[], []]);
    assert.equal(e.getState().players.find((p) => p.id === 'a').kills, 0);
  });
});

describe('rat spawning', () => {
  test('at 100% every new apple is a rat (even with power-ups on); they count toward appleCount', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { ratChance: 100, appleCount: 4, powerUps: true, powerUpChance: 100, bombsPerMinute: 0 });
    e.restartRound();
    let s = e.getState();
    assert.deepEqual([s.rats.length, s.apples.length, s.powerUps.length], [4, 0, 0]);
    e._debug.setSnake('a', [[5, 5], [4, 5], [3, 5]], 'right');
    e._debug.setApples([]);
    e._debug.addRat([6, 5], 'up', { moveAt: NEVER });
    e.tick(); // eaten, and replaced
    s = e.getState();
    assert.equal(events(e, 'eat').length, 1);
    assert.equal(s.rats.length, 4);
  });

  test('an eaten rat is replaced like an apple; lowering appleCount trims rats too', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { appleCount: 1 });
    e._debug.addRat([6, 5], 'up', { moveAt: NEVER });
    fill(e);
    e.tick();
    assert.equal(e.getState().apples.length, 1); // ratChance 0: an apple this time

    const t = setup(far, { appleCount: 3, ratChance: 100 });
    t.tick();
    assert.equal(t.getState().rats.length, 3);
    t.updateConfig({ appleCount: 1 });
    t.tick();
    assert.equal(t.getState().rats.length, 1);
  });

  test('at 0% no rat ever appears', () => {
    const e = createEngine({ config: { gridSize: 12, appleCount: 10, intermissionMs: 0, ratChance: 0, chickenChance: 0, wrapWalls: true }, random: seeded(5) });
    e.addPlayer('a', 'a');
    e.addPlayer('b', 'b');
    for (let i = 0; i < 300; i++) {
      e.tick();
      assert.deepEqual(e.getState().rats, []);
    }
  });

  test('the setting is a whole percentage, live, default low', () => {
    assert.deepEqual(CONFIG_LIMITS.ratChance, { min: 0, max: 100, default: 3 });
    assert.deepEqual(sanitizeConfig({ ratChance: 250 }), { ratChance: 100 });
    assert.deepEqual(sanitizeConfig({ ratChance: -3 }), { ratChance: 0 });
    assert.deepEqual(sanitizeConfig({ ratChance: 7.6 }), { ratChance: 8 });
    assert.deepEqual(sanitizeConfig({ ratChance: 'many' }), {});
  });
});

describe('rats fuzz', () => {
  // Many rats, every power-up and bombs, six snakes steering at random:
  // after every tick each rat is on the board, alone on its cell (no snake,
  // item, bomb, portal end or other rat), it moved at most one cell and
  // only on its schedule, and the regular items stay within appleCount.
  test('a long random game with rats keeps every rule', () => {
    const dirs = ['up', 'down', 'left', 'right'];
    for (let seed = 1; seed <= 12; seed++) {
      const wrap = seed % 2 === 0;
      const random = seeded(seed);
      const e = createEngine({
        config: {
          gridSize: 16,
          appleCount: 12,
          intermissionMs: 0,
          ratChance: seed % 3 === 0 ? 100 : 50,
          powerUps: true,
          powerUpChance: 40,
          bombsPerMinute: 20,
          corpseApples: true,
          wrapWalls: wrap,
        },
        random: seeded(seed * 7919),
      });
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      for (const id of ids) e.addPlayer(id, id);
      let before = new Map();
      let lastRound = 0;
      let eatenRats = 0;
      for (let i = 0; i < 1500; i++) {
        for (const id of ids) if (random() < 0.3) e.setDirection(id, dirs[Math.floor(random() * 4)]);
        e.tick();
        const s = e.getState();
        eatenRats += s.events.filter((ev) => ev.type === 'eat' && ev.item === 'rat').length;
        if (s.round !== lastRound) {
          before = new Map();
          lastRound = s.round;
        }
        if (s.phase !== 'playing') continue;
        const n = s.gridSize;
        const key = (c) => `${c.x},${c.y}`;
        const taken = new Map(); // cell -> what's on it, besides rats
        const mark = (c, what) => taken.set(key(c), what);
        for (const sn of s.snakes) if (sn.alive) for (const c of sn.segments) mark(c, 'snake');
        for (const a of s.apples) mark(a, 'apple');
        for (const p of s.powerUps) mark(p, 'powerUp');
        for (const b of s.bombs) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mark({ x: b.x + dx, y: b.y + dy }, 'bomb');
        for (const p of s.portals) for (const c of p.ends) mark(c, 'portal');
        for (const r of s.rats) {
          assert.ok(r.x >= 0 && r.y >= 0 && r.x < n && r.y < n, `seed ${seed}: rat off the board`);
          assert.ok(!taken.has(key(r)), `seed ${seed} tick ${s.tick}: rat on a ${taken.get(key(r))} at ${key(r)}`);
          mark(r, 'rat');
          const old = before.get(r.id);
          if (old) {
            let dx = Math.abs(r.x - old.x);
            let dy = Math.abs(r.y - old.y);
            if (wrap) {
              dx = Math.min(dx, n - dx);
              dy = Math.min(dy, n - dy);
            }
            assert.ok(dx + dy <= 1, `seed ${seed} tick ${s.tick}: rat jumped`);
            if (dx + dy === 1) assert.ok(old.moved !== s.tick - 1, `seed ${seed} tick ${s.tick}: rat moved two ticks running`);
            r.moved = dx + dy === 1 ? s.tick : old.moved;
          }
        }
        before = new Map(s.rats.map((r) => [r.id, r]));
        const regular = s.apples.filter((a) => !a.corpse && !a.feast).length + s.powerUps.length + s.rats.length;
        assert.ok(regular <= 12, `seed ${seed}: ${regular} regular items`);
      }
      assert.ok(eatenRats > 0, `seed ${seed}: no rat was ever eaten`);
    }
  });
});
