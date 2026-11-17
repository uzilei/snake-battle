// The laser power-up: charge, timing, what the beam hits and how it credits.
// Board positions are set by hand through engine._debug.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.js';
import { POWER_UP_RULES } from '../src/shared/powerups.js';

const CHARGE = POWER_UP_RULES.laserChargeTicks;

// Starts a round with the snakes placed exactly (id -> [segments, dir]), on
// a 20x20 board with no apples, rats or chickens.
function setup(snakes, config = {}) {
  const e = createEngine({ config: { gridSize: 20, appleCount: 0, intermissionMs: 0, ratChance: 0, chickenChance: 0, ...config }, random: () => 0.5 });
  for (const id of Object.keys(snakes)) e.addPlayer(id, id);
  e.tick();
  e._debug.setApples([]);
  for (const [id, [segments, dir]] of Object.entries(snakes)) e._debug.setSnake(id, segments, dir);
  return e;
}
const player = (e, id) => e.getState().players.find((p) => p.id === id);
const snake = (e, id) => e.getState().snakes.find((s) => s.id === id);
const events = (e, type) => e.getState().events.filter((ev) => ev.type === type);

// `a` gets a laser from the Regia (as if eaten) on the next tick, then the
// charge runs until one tick is left: the next tick fires it.
function chargeUp(e, id = 'a') {
  assert.ok(e.command({ kind: 'powerUp', id, item: 'laser' }));
  for (let i = 0; i < CHARGE; i++) e.tick();
  assert.equal(e.getState().lasers.length, 1);
  assert.equal(e.getState().lasers[0].ticksLeft, 1);
}

// The shooter runs along row 5 (its own line), the rest wait far below.
const shooter = { a: [[[5, 5], [4, 5], [3, 5]], 'right'] };
const bystanders = {
  b: [[[2, 15], [1, 15], [0, 15]], 'right'],
  c: [[[2, 17], [1, 17], [0, 17]], 'right'],
};

describe('laser: aim and charge', () => {
  test('picked up moving left or right: the row through the pickup cell', () => {
    const e = setup({ ...shooter, ...bystanders });
    e._debug.addPowerUps([[6, 5, 'laser']]);
    e.tick();
    const [laser] = e.getState().lasers;
    assert.deepEqual({ axis: laser.axis, index: laser.index, shooterId: laser.shooterId }, { axis: 'row', index: 5, shooterId: 'a' });
    const [ev] = events(e, 'laserCharge');
    assert.deepEqual(ev, { type: 'laserCharge', id: laser.id, shooterId: 'a', axis: 'row', index: 5, chargeMs: CHARGE * e.config.tickMs });
    // It grows the snake like an apple.
    e.tick();
    assert.equal(snake(e, 'a').segments.length, 4);
  });

  test('picked up moving up or down: the column through the pickup cell', () => {
    const e = setup({ a: [[[7, 9], [7, 10], [7, 11]], 'up'], ...bystanders });
    e._debug.addPowerUps([[7, 8, 'laser']]);
    e.tick();
    const [laser] = e.getState().lasers;
    assert.deepEqual([laser.axis, laser.index], ['col', 7]);
  });

  test('fires after exactly laserChargeTicks ticks, and only then', () => {
    const e = setup({ ...shooter, ...bystanders });
    e.command({ kind: 'powerUp', id: 'a', item: 'laser' });
    e.tick(); // picked up
    for (let i = 1; i < CHARGE; i++) {
      e.tick();
      assert.equal(events(e, 'laserFire').length, 0, `tick ${i}`);
      assert.equal(e.getState().lasers[0].ticksLeft, CHARGE - i);
    }
    e.tick();
    assert.deepEqual(events(e, 'laserFire').map(({ axis, index }) => [axis, index]), [['row', 5]]);
    assert.equal(e.getState().lasers.length, 0);
  });
});

describe('laser: what the beam hits', () => {
  test('a head on the line dies, the shooter gets the kill; the shooter is immune to its own beam', () => {
    const e = setup({ ...shooter, ...bystanders });
    chargeUp(e);
    e._debug.setSnake('b', [[13, 4], [13, 3], [13, 2]], 'down'); // moves onto (13,5)
    e.tick();
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'a').kills, 1);
    assert.equal(player(e, 'a').status, 'alive'); // its head is on row 5 too
    assert.equal(snake(e, 'a').segments[0].y, 5);
    const [death] = events(e, 'death');
    assert.deepEqual([death.id, death.killerId, death.how], ['b', 'a', 'hit']);
  });

  test('cut at the segment on the line nearest the head; the rest becomes apples', () => {
    const e = setup({ ...shooter, ...bystanders }, { corpseApples: true });
    chargeUp(e);
    // After its move: (12,8) (12,7) (12,6) [12,5] (12,4) (13,4) [13,5] (13,6):
    // on row 5 at indexes 3 and 6. Cut at 3.
    e._debug.setSnake('b', [[12, 7], [12, 6], [12, 5], [12, 4], [13, 4], [13, 5], [13, 6], [13, 7]], 'down');
    e.tick();
    assert.equal(player(e, 'b').status, 'alive');
    assert.deepEqual(snake(e, 'b').segments.map((c) => [c.x, c.y]), [[12, 8], [12, 7], [12, 6]]);
    assert.deepEqual(events(e, 'cut'), [{ type: 'cut', id: 'b', byId: 'a' }]);
    assert.equal(player(e, 'a').kills, 0); // a cut it survives is no kill
    const corpses = e.getState().apples.filter((a) => a.corpse);
    assert.equal(corpses.length, 5);
    assert.ok(corpses.every((c) => c.from === 3 && c.len === 8));
  });

  test('a cut leaving fewer than 3 segments kills, with credit', () => {
    const e = setup({ ...shooter, ...bystanders });
    chargeUp(e);
    e._debug.setSnake('b', [[12, 6], [12, 5], [12, 4], [12, 3], [12, 2]], 'down'); // index 2 on row 5 after the move
    e.tick();
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'a').kills, 1);
    assert.equal(events(e, 'death')[0].how, 'hit');
  });

  test('a ghost is not hit; a shield pops instead', () => {
    const e = setup({ ...shooter, ...bystanders });
    chargeUp(e);
    e._debug.setSnake('b', [[10, 4], [10, 3], [10, 2]], 'down');
    e._debug.setEffect('b', 'ghost', 3000);
    e._debug.setSnake('c', [[14, 4], [14, 3], [14, 2]], 'down');
    e._debug.setEffect('c', 'shield', 3000);
    e.tick();
    assert.equal(player(e, 'b').status, 'alive');
    assert.equal(player(e, 'c').status, 'alive');
    assert.deepEqual(events(e, 'shieldPop').map((ev) => ev.id), ['c']);
    assert.equal(snake(e, 'c').segments.length, 3);
    assert.equal(snake(e, 'c').effect.type, 'ghost');
  });

  test('the badger is killed with credit to the shooter', () => {
    const e = setup({ ...shooter, ...bystanders });
    chargeUp(e);
    e._debug.setBadger([12, 7], { moveAt: Infinity, turnAt: Infinity }); // rows 6-8: not on the line
    e._debug.addBadger([16, 6], { moveAt: Infinity, turnAt: Infinity }); // rows 5-7: on it
    e.tick();
    const killed = events(e, 'badgerKilled');
    assert.equal(killed.length, 1);
    assert.deepEqual([killed[0].x, killed[0].y, killed[0].byId, killed[0].how], [16, 6, 'a', 'hit']);
    assert.equal(e.getState().badgers.length, 1);
    assert.equal(player(e, 'a').kills, 1);
  });

  test('rats and chickens on the line die; a chicken leaves its feast', () => {
    const e = setup({ ...shooter, ...bystanders }, { appleCount: 3 }); // room for the three creatures
    chargeUp(e);
    e._debug.setApples([]); // just the creatures
    e._debug.addRat([14, 5], 'up', { moveAt: Infinity });
    e._debug.addChicken([17, 5], 'up', { moveAt: Infinity });
    e._debug.addRat([14, 9], 'up', { moveAt: Infinity }); // off the line
    e.tick();
    const s = e.getState();
    assert.deepEqual(s.rats.map((r) => [r.x, r.y]), [[14, 9]]);
    assert.equal(s.chickens.length, 0);
    assert.deepEqual(s.powerUps.map((p) => [p.x, p.y, p.type]), [[17, 5, 'feast']]);
    assert.equal(events(e, 'chickenDied').length, 1);
  });

  test('items and bombs are untouched', () => {
    const e = setup({ ...shooter, ...bystanders }, { powerUps: true, powerUpChance: 0, bombsPerMinute: 0 });
    chargeUp(e);
    e.updateConfig({ appleCount: 1 }); // room for the power-up
    e._debug.addPowerUps([[15, 5, 'ghost']]);
    e._debug.setBombs([[17, 5]]);
    e.tick();
    assert.equal(e.getState().powerUps.length, 1);
    assert.equal(e.getState().bombs.length, 1);
  });
});

describe('laser: several, cancelled, orphaned', () => {
  test('several lasers charge and fire on their own', () => {
    const e = setup({ ...shooter, b: [[[14, 12], [14, 13], [14, 14]], 'up'], c: [[[2, 17], [1, 17], [0, 17]], 'right'] });
    e.command({ kind: 'powerUp', id: 'a', item: 'laser' });
    e.command({ kind: 'powerUp', id: 'b', item: 'laser' });
    e.tick();
    assert.deepEqual(e.getState().lasers.map((l) => [l.shooterId, l.axis, l.index]), [['a', 'row', 5], ['b', 'col', 14]]);
    for (let i = 1; i < CHARGE; i++) e.tick();
    // After the moves a is on (13,5) (12,5) (11,5): clear of column 14. b's
    // head is on (14,5): on a's row.
    e._debug.setSnake('a', [[12, 5], [11, 5], [10, 5]], 'right');
    e._debug.setSnake('b', [[14, 6], [14, 7], [14, 8]], 'up');
    e.tick();
    assert.deepEqual(events(e, 'laserFire').map((ev) => ev.shooterId), ['a', 'b']);
    assert.equal(player(e, 'a').status, 'alive');
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(player(e, 'a').kills, 1);
  });

  test('both shooters on each other’s line: both die, each the other’s kill', () => {
    const e = setup({ ...shooter, b: [[[14, 12], [14, 13], [14, 14]], 'up'], c: [[[2, 17], [1, 17], [0, 17]], 'right'] });
    e.command({ kind: 'powerUp', id: 'a', item: 'laser' });
    e.command({ kind: 'powerUp', id: 'b', item: 'laser' });
    e.tick();
    for (let i = 1; i < CHARGE; i++) e.tick();
    e._debug.setSnake('a', [[14, 4], [14, 3], [14, 2]], 'down'); // head (14,5): on both lines
    e._debug.setSnake('b', [[13, 5], [12, 5], [11, 5]], 'up'); // head (13,4), body on row 5
    e.tick();
    assert.equal(player(e, 'a').status, 'dead'); // b's column
    assert.equal(player(e, 'b').status, 'dead'); // a's row, at index 1: too short to cut
    assert.equal(player(e, 'a').kills, 1);
    assert.equal(player(e, 'b').kills, 1);
  });

  test('a shooter that dies mid-charge still fires, and still gets the kill', () => {
    const e = setup({ ...shooter, ...bystanders });
    e.command({ kind: 'powerUp', id: 'a', item: 'laser' });
    e.tick();
    e.command({ kind: 'smite', id: 'a' });
    for (let i = 1; i < CHARGE; i++) e.tick();
    assert.equal(player(e, 'a').status, 'dead');
    e._debug.setSnake('b', [[10, 4], [10, 3], [10, 2]], 'down');
    e.tick();
    assert.equal(events(e, 'laserFire').length, 1);
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(events(e, 'death').find((d) => d.id === 'b').killerId, 'a');
  });

  test('a shooter that left: the beam still fires, nobody gets the kill', () => {
    const e = setup({ ...shooter, ...bystanders });
    chargeUp(e);
    e.removePlayer('a');
    e._debug.setSnake('b', [[10, 4], [10, 3], [10, 2]], 'down');
    e.tick();
    assert.equal(player(e, 'b').status, 'dead');
    assert.equal(events(e, 'death')[0].killerId, null);
  });

  test('cancelled when the round ends: no fire', () => {
    const e = setup({ ...shooter, b: [[[2, 15], [1, 15], [0, 15]], 'right'] });
    e.command({ kind: 'powerUp', id: 'a', item: 'laser' });
    e.tick();
    e.command({ kind: 'smite', id: 'b' }); // a is the last one alive: the round ends
    e.tick();
    assert.equal(e.getState().phase, 'intermission');
    assert.equal(e.getState().lasers.length, 0);
  });

  test('cancelled when the round restarts', () => {
    const e = setup({ ...shooter, ...bystanders });
    chargeUp(e);
    e.restartRound();
    assert.equal(e.getState().lasers.length, 0);
    for (let i = 0; i < CHARGE + 1; i++) {
      e.tick();
      assert.equal(events(e, 'laserFire').length, 0);
    }
  });
});
