// /play sounds (the phoneSounds setting): which sounds each player's phone
// plays, and that only phones that asked for them get any.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createPhoneSounds } from '../src/shared/sounds.js';
import { createGame } from '../src/server/game.js';

const snake = (id, cells, dir = 'right', alive = true) => ({ id, alive, dir, segments: cells.map(([x, y]) => ({ x, y })) });
const state = (over = {}) => ({ round: 1, phase: 'playing', tick: 1, events: [], snakes: [], portals: [], lasers: [], ...over });
const a = snake('a', [[5, 5], [4, 5]]);
const b = snake('b', [[5, 9], [4, 9]]);

// One update from `prev` to a state with these events: -> { all, a: [...], b: [...] }.
function heard(events, { prev = state({ snakes: [a, b] }), cur = {}, phones = createPhoneSounds() } = {}) {
  const out = phones.update(prev, state({ snakes: [a, b], events, ...cur }));
  return { all: out.all, a: out.players.get('a')?.sounds ?? [], b: out.players.get('b')?.sounds ?? [], out };
}

describe('phone sounds: who hears what', () => {
  test('the countdown, the start and a badger arriving: every phone', () => {
    assert.deepEqual(heard([], { prev: state({ phase: 'countdown', countdownRemainingMs: 1500 }), cur: { phase: 'countdown', countdownRemainingMs: 900 } }).all, ['count']);
    assert.deepEqual(heard([], { prev: state({ phase: 'countdown', countdownRemainingMs: 100 }) }).all, ['start']);
    assert.deepEqual(heard([{ type: 'badgerSpawn', badgerId: 1, x: 1, y: 1 }]).all, ['badgerSpawn']);
  });

  test('a bomb or badger disappearing: no phone', () => {
    const h = heard([{ type: 'bombExpired', x: 1, y: 1 }, { type: 'badgerGone', badgerId: 1, x: 1, y: 1 }]);
    assert.deepEqual([h.all, h.a, h.b], [[], [], []]);
  });

  test('eating, power-ups and shots: only the snake that did it', () => {
    const h = heard([
      { type: 'eat', id: 'a', x: 6, y: 5 },
      { type: 'eat', id: 'a', x: 6, y: 5, item: 'rat' },
      { type: 'pickup', id: 'a', item: 'shield' },
      { type: 'pickup', id: 'a', item: 'feast' },
      { type: 'shot', id: 'a', x: 5, y: 5, dir: 'right' },
    ]);
    assert.deepEqual(h.a, ['eat', 'eatCreature', 'powerUp', 'eatCreature', 'shoot']);
    assert.deepEqual([h.all, h.b], [[], []]);
  });

  test('an explosion: whoever set it off (a bomb picked up, the badger killed)', () => {
    let h = heard([{ type: 'pickup', id: 'b', item: 'bomb' }]);
    assert.deepEqual([h.a, h.b], [[], ['explosion']]);
    h = heard([{ type: 'badgerKilled', badgerId: 1, x: 1, y: 1, byId: 'a' }]);
    assert.deepEqual([h.a, h.b], [['explosion'], []]);
    h = heard([{ type: 'badgerKilled', badgerId: 1, x: 1, y: 1, byId: null }]); // killed by nobody's doing
    assert.deepEqual([h.all, h.a, h.b], [[], [], []]);
  });

  test('a death (and a multikill): the snake that died and its killer', () => {
    const h = heard([{ type: 'death', id: 'b', killerId: 'a', killNo: 2 }]);
    assert.deepEqual(h.a, ['death', 'multikill']);
    assert.deepEqual(h.b, ['death', 'multikill']);
    assert.deepEqual(heard([{ type: 'death', id: 'b', killerId: null }]).a, []); // a wall: only b
  });

  test('hurt: the snake cut and the one cutting it; a badger bite only the bitten', () => {
    let h = heard([{ type: 'cut', id: 'b', byId: 'a' }]);
    assert.deepEqual([h.a, h.b], [['hurt'], ['hurt']]);
    h = heard([{ type: 'badgerBite', id: 'a', index: 1 }]);
    assert.deepEqual([h.a, h.b], [['hurt'], []]);
  });

  test('a stopped projectile: its shooter and whoever it hit', () => {
    let h = heard([{ type: 'projectileEnd', x: 1, y: 1, hit: true, ids: ['a', 'b'] }]);
    assert.deepEqual([h.a, h.b], [['hit'], ['hit']]);
    h = heard([{ type: 'projectileEnd', x: 1, y: 1, ids: ['a'] }]);
    assert.deepEqual([h.a, h.b], [['hit'], []]);
  });

  test('a portal: only the snake that opened it, not every later jump', () => {
    const portal = { id: 7, ends: [{ x: 1, y: 1 }, { x: 9, y: 9 }], remainingMs: 1000 };
    let h = heard([{ type: 'teleport', id: 'a', portalId: 7 }], { cur: { portals: [portal] } });
    assert.deepEqual([h.a, h.b], [['portal'], []]);
    h = heard([{ type: 'teleport', id: 'b', portalId: 7 }], { prev: state({ snakes: [a, b], portals: [portal] }), cur: { portals: [portal] } });
    assert.deepEqual(h.b, []);
  });

  test('turns: only the snake that turned', () => {
    const h = heard([], { cur: { snakes: [{ ...a, dir: 'up' }, b] } });
    assert.deepEqual([h.a, h.b], [['moveUp'], []]);
  });

  test('the same tick again (newTick false) plays none of its events', () => {
    const phones = createPhoneSounds();
    const prev = state({ snakes: [a, b] });
    const cur = state({ snakes: [a, b], events: [{ type: 'eat', id: 'a', x: 6, y: 5 }] });
    assert.equal(phones.update(prev, cur, false).players.size, 0);
  });
});

describe('phone sounds: lasers', () => {
  const charge = { type: 'laserCharge', id: 30, shooterId: 'a', axis: 'row', index: 9, chargeMs: 400 };
  const laser = { id: 30, shooterId: 'a', axis: 'row', index: 9, ticksLeft: 3, chargeTicks: 4 };
  const c = snake('c', [[2, 14], [2, 13]]);

  test('the charge: its shooter, and the snakes with a segment in its line', () => {
    const phones = createPhoneSounds();
    const out = phones.update(state({ snakes: [a, b, c] }), state({ snakes: [a, b, c], events: [charge], lasers: [laser] }));
    assert.deepEqual(out.players.get('a').charges, [{ id: 30, ms: 400 }]);
    assert.deepEqual(out.players.get('b').charges, [{ id: 30, ms: 400 }]); // b is on row 9
    assert.equal(out.players.has('c'), false);
  });

  test('the shot: everyone who heard the charge, even after leaving the line', () => {
    const phones = createPhoneSounds();
    phones.update(state({ snakes: [a, b, c] }), state({ snakes: [a, b, c], events: [charge], lasers: [laser] }));
    const away = snake('b', [[5, 12], [5, 11]], 'down'); // b got off row 9 meanwhile
    const before = state({ snakes: [a, away, c], lasers: [laser] });
    const fired = state({ snakes: [a, away, c], events: [{ type: 'laserFire', id: 30, shooterId: 'a', axis: 'row', index: 9 }] });
    const out = phones.update(before, fired);
    assert.deepEqual(out.players.get('a'), { sounds: ['laserFire'], charges: [], fired: [30] });
    assert.deepEqual(out.players.get('b'), { sounds: ['laserFire'], charges: [], fired: [30] });
    assert.equal(out.players.has('c'), false);
  });

  test('a shot whose charge it never saw: the shooter alone', () => {
    const out = createPhoneSounds().update(state({ snakes: [a, b] }), state({ snakes: [a, b], events: [{ type: 'laserFire', id: 31, shooterId: 'a', axis: 'col', index: 3 }] }));
    assert.deepEqual([...out.players.keys()], ['a']);
  });
});

describe('phone sounds on /play', () => {
  function setup({ phoneSounds = true } = {}) {
    const game = createGame({ log: () => {} });
    const admin = game.connect({ send: () => {}, close: () => {} }, { admin: true, isAuthorized: () => true });
    const setting = (values) => admin.message(JSON.stringify({ t: 'settings', ...values }));
    if (!phoneSounds) setting({ phoneSounds: false }); // on by default
    game.tickOnce(); // the lobby, before anyone joins
    const phones = [['Anna', true], ['Luca', true], ['Mia', 'yes']].map(([name, sounds], i) => {
      const sent = [];
      const conn = game.connect({ send: (m) => sent.push(m), close: () => {} });
      conn.message(JSON.stringify({ t: 'hello', role: 'player' }));
      conn.message(JSON.stringify({ t: 'join', name, session: `session-${i}-abcdefghijklmnop`, sounds }));
      return { last: () => sent.filter((m) => m.t === 'me').at(-1) };
    });
    return { game, setting, phones };
  }

  test('phones that asked get the sounds for everyone, and their own; the rest nothing', () => {
    const { game, phones: [anna, luca, mia] } = setup();
    game.tickOnce(); // the round starts
    assert.equal(game.engine.getState().phase, 'playing');
    assert.ok(anna.last().sounds.names.includes('start'));
    assert.ok(luca.last().sounds.names.includes('start'));
    assert.equal(mia.last().sounds, undefined); // 'yes' is not a yes
    game.engine._debug.setSnake('p1', [[10, 5], [9, 5], [8, 5]], 'right');
    game.engine._debug.setSnake('p2', [[10, 15], [9, 15], [8, 15]], 'right');
    game.engine._debug.setSnake('p3', [[10, 25], [9, 25], [8, 25]], 'right');
    game.tickOnce();
    game.engine.setDirection('p1', 'down');
    game.tickOnce();
    assert.deepEqual(anna.last().sounds.names, ['moveDown']);
    assert.equal(anna.last().sounds.gains.moveDown, 0); // /admin's volumes: turns are muted by default
    assert.equal(luca.last().sounds, undefined); // nothing of Luca's this tick
  });

  test('with phoneSounds off on /admin, no phone gets any', () => {
    const { game, phones } = setup({ phoneSounds: false });
    game.tickOnce();
    for (const p of phones) assert.equal(p.last().sounds, undefined);
  });

  test('a repeat of the same tick (a pause, an /admin change) plays nothing again', () => {
    const { game, setting, phones: [anna] } = setup();
    game.tickOnce();
    setting({ soundVolume: 50 }); // broadcasts the same tick again
    assert.equal(anna.last().sounds, undefined);
  });

  test('vibration follows /admin (on by default)', () => {
    const { game, setting, phones: [anna] } = setup();
    game.tickOnce();
    assert.equal(anna.last().vibrate, true);
    setting({ phoneVibration: false });
    assert.equal(anna.last().vibrate, false);
  });
});
