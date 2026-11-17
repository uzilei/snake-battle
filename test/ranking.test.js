import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { roundPlaces, compareRound } from '../src/shared/ranking.js';
import { createGame } from '../src/server/game.js';

const pl = (id, status, length, extra = {}) => ({ id, name: id, status, length, kills: 0, bot: false, ...extra });
const places = (players, winnerId) => Object.fromEntries(roundPlaces(players, winnerId));

describe('round places', () => {
  test('alive before dead, then longer first; queued players get no place', () => {
    const players = [pl('a', 'dead', 9), pl('b', 'alive', 4), pl('c', 'dead', 12), pl('q', 'queued', 0)];
    assert.deepEqual(places(players, 'b'), { b: 1, c: 2, a: 3 });
  });

  test('the winner is first even when not the longest', () => {
    const players = [pl('long', 'alive', 30), pl('killer', 'alive', 8)];
    assert.deepEqual(places(players, 'killer'), { killer: 1, long: 2 });
  });

  test('same status and length share a place; the next place skips ahead', () => {
    const players = [pl('w', 'alive', 10), pl('x', 'dead', 6), pl('y', 'dead', 6), pl('z', 'dead', 3)];
    assert.deepEqual(places(players, 'w'), { w: 1, x: 2, y: 2, z: 4 });
  });

  test('a draw: no winner, the top shares first place', () => {
    const players = [pl('a', 'dead', 5), pl('b', 'dead', 5)];
    assert.deepEqual(places(players, null), { a: 1, b: 1 });
  });

  test('bots are ranked like the scoreboard shows them (people first among equals)', () => {
    const players = [pl('bot', 'dead', 7, { bot: true }), pl('anna', 'dead', 7)];
    assert.deepEqual([...players].sort(compareRound).map((p) => p.id), ['anna', 'bot']);
  });
});

describe('round card on /play', () => {
  function twoPhones() {
    const game = createGame({ log: () => {} });
    const phones = ['Anna', 'Luca'].map((name, i) => {
      const sent = [];
      const conn = game.connect({ send: (m) => sent.push(m), close: () => {} });
      const send = (o) => conn.message(JSON.stringify(o));
      send({ t: 'hello', role: 'player' });
      send({ t: 'join', name, session: `session-${i}-abcdefghijklmnop` });
      return { last: () => sent.filter((m) => m.t === 'me').at(-1) };
    });
    game.tickOnce(); // the round starts
    game.engine._debug.setSnake('p1', [[29, 5], [28, 5], [27, 5]], 'right'); // into the wall
    game.engine._debug.setSnake('p2', [[8, 15], [7, 15], [6, 15], [5, 15], [4, 15], [3, 15]], 'right');
    game.tickOnce();
    assert.equal(game.engine.getState().phase, 'intermission');
    return phones;
  }

  test('between rounds each phone gets its place, length and kills', () => {
    const [anna, luca] = twoPhones();
    assert.deepEqual(anna.last().players.self.card, { place: 2, length: 3, kills: 0 });
    assert.deepEqual(luca.last().players.self.card, { place: 1, length: 6, kills: 0 });
  });

  test('the places are fixed when the round ends: someone leaving during the break moves nobody up', () => {
    const game = createGame({ log: () => {} });
    game.engine.updateConfig({ intermissionMs: 3000 });
    const phones = ['Anna', 'Luca', 'Mia'].map((name, i) => {
      const sent = [];
      const conn = game.connect({ send: (m) => sent.push(m), close: () => {} });
      const send = (o) => conn.message(JSON.stringify(o));
      send({ t: 'hello', role: 'player' });
      send({ t: 'join', name, session: `session-${i}-abcdefghijklmnop` });
      return { conn, last: () => sent.filter((m) => m.t === 'me').at(-1) };
    });
    game.tickOnce();
    game.engine._debug.setSnake('p1', [[29, 5], [28, 5], [27, 5]], 'right'); // into the wall
    game.engine._debug.setSnake('p2', [[8, 15], [7, 15], [6, 15], [5, 15], [4, 15], [3, 15]], 'right');
    game.engine._debug.setSnake('p3', [[29, 9], [28, 9], [27, 9], [26, 9]], 'right'); // into the wall, longer
    game.tickOnce();
    assert.equal(game.engine.getState().phase, 'intermission');
    const anna = phones[0];
    assert.equal(anna.last().players.self.card.place, 3);
    phones[2].conn.disconnect(); // Mia (2nd) leaves
    game.engine.removePlayer('p3');
    game.tickOnce();
    assert.equal(game.engine.getState().phase, 'intermission');
    assert.equal(anna.last().players.self.card.place, 3);
  });

  test('no card while a round is on', () => {
    const game = createGame({ log: () => {} });
    const sent = [];
    const conn = game.connect({ send: (m) => sent.push(m), close: () => {} });
    conn.message(JSON.stringify({ t: 'hello', role: 'player' }));
    conn.message(JSON.stringify({ t: 'join', name: 'Anna', session: 'session-0-abcdefghijklmnop' }));
    game.tickOnce();
    assert.equal(game.engine.getState().phase, 'playing');
    assert.equal(sent.filter((m) => m.t === 'me').at(-1).players.self.card, undefined);
  });
});
