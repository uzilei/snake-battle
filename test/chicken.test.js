// The chicken: rare food that runs off when a snake comes close. Calm and
// alerted movement, fleeing, eating (growth and the feast), projectiles,
// the badger, freeze, spawning and a long randomized run. Board positions
// are set by hand through engine._debug.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine, sanitizeConfig, CONFIG_LIMITS } from '../src/engine.js';
import { CHICKEN_RULES } from '../src/shared/chicken.js';
import { POWER_UP_RULES } from '../src/shared/powerups.js';

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
// first, dir]) and an empty board. Tick 1 starts the round. tickMs 200, so
// the 1 s calm-down is 5 ticks.
function setup(snakes, config = {}, seed = 42) {
  const engine = createEngine({
    config: { gridSize: 20, appleCount: 0, intermissionMs: 0, ratChance: 0, chickenChance: 0, spawnShieldSec: 0, badgerEverySec: 0, tickMs: 200, ...config },
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
// appleCount = the items on the board, so the next tick neither trims them
// nor spawns new ones (until something is eaten).
function fill(e) {
  const s = e.getState();
  e.updateConfig({ appleCount: s.apples.length + s.powerUps.length + s.rats.length + s.chickens.length });
}
const chickens = (e) => e.getState().chickens.map((c) => [c.x, c.y]);
const snake = (e, id) => e.getState().snakes.find((s) => s.id === id);
const events = (e, type) => e.getState().events.filter((ev) => ev.type === type);
const feastApples = (e) => e.getState().apples.filter((a) => a.feast);
const steps = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

describe('chicken settings', () => {
  test('a whole percentage, default low, 0 = off', () => {
    assert.deepEqual(CONFIG_LIMITS.chickenChance, { min: 0, max: 100, default: 2 });
    assert.deepEqual(sanitizeConfig({ chickenChance: 250 }), { chickenChance: 100 });
    assert.deepEqual(sanitizeConfig({ chickenChance: -3 }), { chickenChance: 0 });
    assert.deepEqual(sanitizeConfig({ chickenChance: 7.6 }), { chickenChance: 8 });
    assert.deepEqual(sanitizeConfig({ chickenChance: 'many' }), {});
  });
});

describe('chicken movement', () => {
  test('calm, it runs like a rat: one cell every second tick', () => {
    const e = setup(far);
    e._debug.addChicken([5, 10], 'right');
    const seen = [];
    for (let i = 0; i < 6; i++) {
      fill(e);
      e.tick();
      seen.push(chickens(e)[0][0]);
      assert.equal(e.getState().chickens[0].alerted, false);
    }
    assert.deepEqual(seen, [6, 6, 7, 7, 8, 8]);
  });

  test('a head within 2 steps alerts it: it moves at once and every tick, and calms down 1 s after', () => {
    // 'a' is held 2 steps below the chicken on the first tick (heading away),
    // then far off.
    const e = setup({ a: [[[10, 12], [9, 12], [8, 12]], 'down'], ...far });
    e._debug.addChicken([10, 10], 'right', { moveAt: NEVER });
    fill(e);
    e._debug.setSnake('a', [[15, 3], [14, 3], [13, 3]], 'up');
    e.tick();
    assert.deepEqual(chickens(e), [[10, 10]]); // calm and in no hurry
    const moved = [];
    const alerted = [];
    let at = { x: 10, y: 10 };
    for (let i = 0; i < 10; i++) {
      if (i === 0) e._debug.setSnake('a', [[10, 12], [9, 12], [8, 12]], 'down');
      else e._debug.setSnake('a', [[15, 3], [14, 3], [13, 3]], 'up');
      for (const id of ['y', 'z']) e._debug.setSnake(id, ...far[id]); // the bystanders stay put
      fill(e);
      e.tick();
      const c = e.getState().chickens[0];
      moved.push(steps(c, at));
      alerted.push(c.alerted);
      if (i === 0) assert.ok(steps(c, { x: 10, y: 12 }) > 2, 'it went away from the head');
      at = c;
    }
    // Alerted on the first tick and for 1 s (5 ticks) after: a move every
    // tick. Calm again on the 6th, back to every second tick.
    assert.deepEqual(alerted, [true, true, true, true, true, false, false, false, false, false]);
    assert.deepEqual(moved, [1, 1, 1, 1, 1, 1, 0, 1, 0, 1]);
  });

  test('alerted, it flees 80% of the time: the free way that ends furthest from the nearest head', () => {
    // Facing down, towards the head 2 below; left and right are taken. A
    // flee goes up (3 steps from the head), a plain move down (1 step).
    let up = 0;
    let down = 0;
    const trials = 400;
    for (let seed = 1; seed <= trials; seed++) {
      const e = setup({ a: [[[10, 12], [11, 12], [12, 12]], 'down'], ...far }, {}, seed);
      e._debug.setApples([[9, 10], [11, 10]]);
      e._debug.addChicken([10, 10], 'down');
      fill(e);
      e.tick();
      const [[x, y]] = chickens(e);
      assert.equal(x, 10);
      if (y === 9) up++;
      else if (y === 11) down++;
    }
    assert.equal(up + down, trials);
    assert.equal(CHICKEN_RULES.fleeChance, 0.8);
    assert.ok(up / trials > 0.72 && up / trials < 0.88, `fled ${up} of ${trials}`);
  });

  test('with two heads near, it flees from the nearer one', () => {
    // Heads at (10,12) (2 steps) and (13,10) (3 steps). From (10,10): up
    // ends 3 from the nearest head, left 3, right 2, down 1.
    for (let seed = 1; seed <= 60; seed++) {
      const e = setup({ a: [[[10, 12], [9, 12], [8, 12]], 'down'], b: [[[13, 10], [14, 10], [15, 10]], 'up'], ...far }, {}, seed);
      e._debug.addChicken([10, 10], 'down');
      fill(e);
      e.tick();
      const [[x, y]] = chickens(e);
      // A flee: up or left. A plain move: down (it faces down).
      assert.ok((x === 10 && y === 9) || (x === 9 && y === 10) || (x === 10 && y === 11), `seed ${seed}: ${x},${y}`);
    }
  });

  test('freeze slows it: calm a cell every 4 ticks, alerted every 2', () => {
    const e = setup(far);
    e._debug.addChicken([5, 10], 'right');
    e._debug.setEffect('y', 'freeze', 3000);
    const seen = [];
    for (let i = 0; i < 8; i++) {
      fill(e);
      e.tick();
      seen.push(chickens(e)[0][0]);
    }
    assert.deepEqual(seen, [6, 6, 6, 6, 7, 7, 7, 7]);
    assert.equal(e.getState().chickens[0].stepTicks, 4);
    assert.equal(e.getState().creaturesFrozen, true);

    // Alerted under freeze: a head held 2 steps behind it, every tick.
    const a = setup({ a: [[[3, 10], [3, 11], [3, 12]], 'up'], ...far });
    a._debug.setEffect('y', 'freeze', 3000);
    // A corridor to the right: apples above and below row 10.
    const walls = [];
    for (let x = 5; x <= 12; x++) walls.push([x, 9], [x, 11]);
    a._debug.setApples(walls);
    a._debug.addChicken([5, 10], 'right');
    const xs = [];
    for (let i = 0; i < 6; i++) {
      const [[cx]] = chickens(a);
      a._debug.setSnake('a', [[cx - 2, 10], [cx - 2, 11], [cx - 2, 12]], 'up');
      fill(a);
      a.tick();
      assert.equal(a.getState().chickens[0].alerted, true);
      xs.push(chickens(a)[0][0]);
    }
    assert.deepEqual(xs, [6, 6, 7, 7, 8, 8]);
  });
});

describe('catching chickens', () => {
  // The chicken at (6,5), boxed in by apples above, below and to the right;
  // a's head at (5,5) heading right, into its cell.
  function boxed(config = {}) {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, config);
    e._debug.setApples([[6, 4], [6, 6], [7, 5]]);
    e._debug.addChicken([6, 5], 'up');
    fill(e);
    return e;
  }

  test(`eaten: ${CHICKEN_RULES.growthMultiplier} x growthPerApple and a feast round the eater`, () => {
    const e = boxed({ growthPerApple: 2 });
    e.tick();
    assert.deepEqual(chickens(e), []);
    assert.equal(snake(e, 'a').pendingGrowth, 2 * CHICKEN_RULES.growthMultiplier);
    const [ev] = events(e, 'eat');
    assert.deepEqual([ev.id, ev.x, ev.y, ev.item], ['a', 6, 5, 'chicken']);
    const feast = feastApples(e);
    assert.equal(feast.length, POWER_UP_RULES.feastApples);
    // The nearest free cells to the head: none further than 3 steps.
    for (const c of feast) assert.ok(steps(c, { x: 6, y: 5 }) <= 3, `feast apple at ${c.x},${c.y}`);
    assert.deepEqual(events(e, 'pickup'), []);
  });

  test('cornered, it is caught', () => {
    // In the corner with the cell below taken: the only way out is towards
    // the head, into the cell it is entering.
    const e = setup({ a: [[[2, 0], [3, 0], [4, 0]], 'left'], ...far });
    e._debug.setApples([[0, 1]]);
    e._debug.addChicken([0, 0], 'left');
    fill(e);
    e.tick();
    assert.deepEqual(chickens(e), []);
    assert.equal(events(e, 'eat')[0].item, 'chicken');
    assert.equal(snake(e, 'a').pendingGrowth, CHICKEN_RULES.growthMultiplier);
  });

  test('running into the cell a head is entering, or off it, it is caught', () => {
    // Into: from (6,6) the only free way is up, to (6,5).
    const into = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    into._debug.setApples([[6, 7], [5, 6], [7, 6]]);
    into._debug.addChicken([6, 6], 'up');
    fill(into);
    into.tick();
    assert.deepEqual(chickens(into), []);
    assert.equal(events(into, 'eat')[0].item, 'chicken');

    // Off: from (6,5) the only free way is down, as the head enters (6,5).
    const off = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    off._debug.setApples([[6, 4], [7, 5]]);
    off._debug.addChicken([6, 5], 'up');
    fill(off);
    off.tick();
    assert.deepEqual(chickens(off), []);
    assert.equal(events(off, 'eat')[0].item, 'chicken');
  });

  test('a ghost catches it too', () => {
    const e = boxed();
    e._debug.setEffect('a', 'ghost', 3000);
    e.tick();
    assert.deepEqual(chickens(e), []);
    assert.equal(snake(e, 'a').pendingGrowth, CHICKEN_RULES.growthMultiplier);
  });

  test('the magnet does not pull it', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far });
    e._debug.setEffect('a', 'magnet', 5000);
    e._debug.setApples([[6, 8], [5, 9], [7, 9]]);
    e._debug.addChicken([6, 9], 'down', { moveAt: NEVER }); // 4 steps from the new head: calm
    fill(e);
    e.tick();
    assert.deepEqual(chickens(e), [[6, 9]]);
  });
});

describe('chickens, projectiles and the badger', () => {
  test('a projectile kills it: nobody grows or scores, and the feast lands where it died', () => {
    const e = setup(far);
    e._debug.addProjectile([5, 10], 'right', 'y');
    e._debug.addChicken([7, 10], 'up', { moveAt: NEVER });
    fill(e);
    e.tick(); // two cells: (6,10), then (7,10)
    const s = e.getState();
    assert.deepEqual([s.chickens, s.projectiles], [[], []]);
    assert.ok(events(e, 'projectileEnd').some((ev) => ev.hit && ev.x === 7 && ev.y === 10));
    assert.ok(s.players.every((p) => p.kills === 0));
    assert.ok(s.snakes.every((sn) => sn.pendingGrowth === 0));
    const feast = feastApples(e);
    assert.equal(feast.length, POWER_UP_RULES.feastApples);
    assert.ok(feast.some((c) => c.x === 7 && c.y === 10));
    for (const c of feast) assert.ok(steps(c, { x: 7, y: 10 }) <= 2, `feast apple at ${c.x},${c.y}`);
  });

  test('a gun fired right next to it kills it too', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { powerUps: true, bombsPerMinute: 0 });
    e._debug.setApples([[7, 4], [7, 6], [8, 5]]);
    e._debug.addPowerUps([[6, 5, 'gun']]);
    e._debug.addChicken([7, 5], 'up'); // alerted, but boxed in
    fill(e);
    e.tick();
    assert.deepEqual(chickens(e), []);
    assert.equal(feastApples(e).length, POWER_UP_RULES.feastApples);
  });

  test('the badger kills it like a rat: no feast', () => {
    const e = setup(far);
    e._debug.addChicken([10, 10], 'up', { moveAt: NEVER });
    e._debug.setBadger([10, 10], { moveAt: NEVER });
    fill(e);
    e.tick();
    assert.deepEqual(chickens(e), []);
    assert.deepEqual(events(e, 'chickenCaught').map((ev) => [ev.x, ev.y]), [[10, 10]]);
    assert.deepEqual(feastApples(e), []);
    assert.ok(e.getState().snakes.every((sn) => sn.pendingGrowth === 0));
  });
});

describe('chicken spawning', () => {
  test('at 100% every new apple is a chicken; they count toward appleCount; the rat is rolled first', () => {
    const e = setup({ a: [[[5, 5], [4, 5], [3, 5]], 'right'], ...far }, { chickenChance: 100, appleCount: 4 });
    e.restartRound();
    let s = e.getState();
    assert.deepEqual([s.chickens.length, s.apples.length, s.rats.length], [4, 0, 0]);
    e.updateConfig({ appleCount: 2 });
    e.tick();
    assert.equal(e.getState().chickens.length, 2);

    const both = setup(far, { chickenChance: 100, ratChance: 100, appleCount: 3 });
    both.tick();
    s = both.getState();
    assert.deepEqual([s.rats.length, s.chickens.length], [3, 0]);
  });

  test('at 0% no chicken ever appears', () => {
    const e = createEngine({ config: { gridSize: 12, appleCount: 10, intermissionMs: 0, ratChance: 30, chickenChance: 0, wrapWalls: true }, random: seeded(5) });
    e.addPlayer('a', 'a');
    e.addPlayer('b', 'b');
    for (let i = 0; i < 300; i++) {
      e.tick();
      assert.deepEqual(e.getState().chickens, []);
    }
  });
});

describe('chicken fuzz', () => {
  // Many chickens and rats, every power-up, bombs and the badger, six snakes
  // steering at random: after every tick each chicken is on the board,
  // alone on its cell (no snake, item, bomb, portal end, rat or other
  // chicken), outside the active badger, it moved at most one cell, and
  // the regular items stay within appleCount. Every chicken eaten grows
  // the eater by 25 x growthPerApple.
  test('a long random game with chickens keeps every rule', () => {
    const dirs = ['up', 'down', 'left', 'right'];
    for (let seed = 1; seed <= 12; seed++) {
      const wrap = seed % 2 === 0;
      const random = seeded(seed);
      const e = createEngine({
        config: {
          gridSize: 16,
          appleCount: 12,
          intermissionMs: 0,
          ratChance: 20,
          chickenChance: seed % 3 === 0 ? 100 : 50,
          powerUps: true,
          powerUpChance: 40,
          bombsPerMinute: 20,
          corpseApples: true,
          wrapWalls: wrap,
          badgerEverySec: 30,
          badgerLifetimeSec: 10,
          spawnShieldSec: 0,
          tickMs: 100,
        },
        random: seeded(seed * 7919),
      });
      const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
      for (const id of ids) e.addPlayer(id, id);
      let before = new Map();
      let growthBefore = new Map();
      let lastRound = 0;
      let eaten = 0;
      let alerted = 0;
      for (let i = 0; i < 1500; i++) {
        for (const id of ids) if (random() < 0.3) e.setDirection(id, dirs[Math.floor(random() * 4)]);
        e.tick();
        const s = e.getState();
        if (s.round !== lastRound) {
          before = new Map();
          growthBefore = new Map();
          lastRound = s.round;
        }
        const ate = s.events.filter((ev) => ev.type === 'eat' && ev.item === 'chicken');
        eaten += ate.length;
        if (s.phase !== 'playing') continue;
        const n = s.gridSize;
        const key = (c) => `${c.x},${c.y}`;
        const taken = new Map(); // cell -> what's on it
        const mark = (c, what) => taken.set(key(c), what);
        for (const sn of s.snakes) if (sn.alive) for (const c of sn.segments) mark(c, 'snake');
        for (const a of s.apples) mark(a, 'apple');
        for (const p of s.powerUps) mark(p, 'powerUp');
        for (const r of s.rats) mark(r, 'rat');
        for (const b of s.bombs) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mark({ x: b.x + dx, y: b.y + dy }, 'bomb');
        for (const p of s.portals) for (const c of p.ends) mark(c, 'portal');
        const b = s.badger;
        for (const c of s.chickens) {
          const where = `seed ${seed} tick ${s.tick} at ${key(c)}`;
          assert.ok(c.x >= 0 && c.y >= 0 && c.x < n && c.y < n, `${where}: off the board`);
          assert.ok(!taken.has(key(c)), `${where}: on a ${taken.get(key(c))}`);
          if (b && b.warningMs <= 0) assert.ok(!(Math.abs(c.x - b.x) <= 2 && Math.abs(c.y - b.y) <= 1), `${where}: inside the badger`);
          mark(c, 'chicken');
          if (c.alerted) alerted++;
          const old = before.get(c.id);
          if (old) {
            let dx = Math.abs(c.x - old.x);
            let dy = Math.abs(c.y - old.y);
            if (wrap) {
              dx = Math.min(dx, n - dx);
              dy = Math.min(dy, n - dy);
            }
            assert.ok(dx + dy <= 1, `${where}: jumped`);
          }
        }
        // A chicken eaten by a snake that ate nothing else this tick: its
        // pending growth went up by exactly 25 (growthPerApple 1), less the
        // one cell it grew if it moved.
        for (const ev of ate) {
          const sn = s.snakes.find((x) => x.id === ev.id);
          const others = s.events.filter((x) => x.type === 'eat' && x.id === ev.id).length;
          if (!sn?.alive || others !== 1 || !growthBefore.has(ev.id)) continue;
          const grew = sn.pendingGrowth - growthBefore.get(ev.id);
          assert.ok(grew === CHICKEN_RULES.growthMultiplier || grew === CHICKEN_RULES.growthMultiplier - 1 || grew === CHICKEN_RULES.growthMultiplier - 2, `seed ${seed} tick ${s.tick}: grew ${grew}`);
        }
        before = new Map(s.chickens.map((c) => [c.id, c]));
        growthBefore = new Map(s.snakes.filter((x) => x.alive).map((x) => [x.id, x.pendingGrowth]));
        const regular = s.apples.filter((a) => !a.corpse && !a.feast).length + s.powerUps.length + s.rats.length + s.chickens.length;
        assert.ok(regular <= 12, `seed ${seed}: ${regular} regular items`);
      }
      assert.ok(eaten > 0, `seed ${seed}: no chicken was ever eaten`);
      assert.ok(alerted > 0, `seed ${seed}: no chicken was ever alerted`);
    }
  });
});
