import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecords, loadRecords, RECORD_LIMITS } from '../src/server/records.js';

function clock(start = 1000) {
  let t = start;
  return () => t++;
}

describe('leaderboard', () => {
  test('wins add up per name; a different case is a different player', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ winner: 'Marco' });
    r.recordRound({ winner: 'Marco' });
    r.recordRound({ winner: 'marco' });
    assert.deepEqual(r.top().leaderboard, [
      { name: 'Marco', wins: 2 },
      { name: 'marco', wins: 1 },
    ]);
  });

  test('top 10 only, ties broken by who got there first', () => {
    const r = createRecords({}, { now: clock() });
    for (let i = 0; i < 12; i++) r.recordRound({ winner: `P${i}` });
    r.recordRound({ winner: 'P11' });
    const top = r.top().leaderboard;
    assert.equal(top.length, RECORD_LIMITS.leaderboardShown);
    assert.deepEqual(top[0], { name: 'P11', wins: 2 });
    assert.equal(top[1].name, 'P0');
    assert.equal(top[9].name, 'P8');
  });

  test('names like __proto__ are ordinary entries', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ winner: '__proto__' });
    r.recordRound({ winner: 'constructor' });
    assert.deepEqual(r.top().leaderboard.map((e) => e.name), ['__proto__', 'constructor']);
  });

  test('no winner (a draw or a solo round) changes nothing', () => {
    let saves = 0;
    const r = createRecords({}, { save: () => saves++ });
    assert.equal(r.recordRound({ winner: null }), false);
    assert.equal(saves, 0);
  });
});

describe('hall of fame', () => {
  test('top 5 by length, older record first on a tie', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ lengths: [{ name: 'A', length: 10 }, { name: 'B', length: 7 }] });
    r.recordRound({ lengths: [{ name: 'C', length: 12 }, { name: 'D', length: 7 }] });
    r.recordRound({ lengths: [{ name: 'E', length: 3 }, { name: 'F', length: 4 }, { name: 'G', length: 2 }] });
    assert.deepEqual(r.top().hallOfFame.map((e) => [e.name, e.length]), [
      ['C', 12],
      ['A', 10],
      ['B', 7],
      ['D', 7],
      ['F', 4],
    ]);
  });

  test('each name keeps only its best result', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ lengths: [{ name: 'Anna', length: 9 }] });
    r.recordRound({ lengths: [{ name: 'Anna', length: 5 }] }); // worse: ignored
    for (let i = 0; i < 4; i++) r.recordRound({ lengths: [{ name: 'Anna', length: 20 + i }] });
    r.recordRound({ lengths: [{ name: 'anna', length: 4 }] }); // another player
    const fame = r.top().hallOfFame;
    assert.deepEqual(fame.map((e) => [e.name, e.length]), [['Anna', 23], ['anna', 4]]);
  });

  test('the time of the record is stored', () => {
    const r = createRecords({}, { now: () => 1_700_000_000_000 });
    r.recordRound({ lengths: [{ name: 'Anna', length: 9 }] });
    assert.equal(r.top().hallOfFame[0].at, 1_700_000_000_000);
  });

  test('reset empties it and leaves the leaderboard alone', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ winner: 'Anna', lengths: [{ name: 'Anna', length: 9 }] });
    r.resetHallOfFame();
    assert.deepEqual(r.top().hallOfFame, []);
    assert.equal(r.top().leaderboard.length, 1);
  });
});

describe('records file', () => {
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snake-records-')), 'records.json');

  test('survives a restart', () => {
    const file = tmpFile();
    const r = loadRecords(file, { log: () => {}, now: clock() });
    r.recordRound({ winner: 'Anna', lengths: [{ name: 'Anna', length: 9 }] });
    const again = loadRecords(file, { log: () => {} });
    assert.deepEqual(again.top().leaderboard, [{ name: 'Anna', wins: 1 }]);
    assert.equal(again.top().hallOfFame[0].length, 9);
  });

  test('a corrupt file is kept aside, not overwritten', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ not json');
    const logs = [];
    const r = loadRecords(file, { log: (m) => logs.push(m) });
    assert.deepEqual(r.top(), { leaderboard: [], hallOfFame: [] });
    assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '{ not json');
    assert.equal(logs.length, 1);
  });

  test('invalid entries are dropped on load', () => {
    const r = createRecords({
      leaderboard: [{ name: 'Ok', wins: 2, at: 1 }, { name: '', wins: 1, at: 1 }, { name: 'Bad', wins: -1, at: 1 }, null],
      hallOfFame: [{ name: 'Ok', length: 4, at: 1 }, { name: 'X'.repeat(40), length: 9, at: 1 }, { name: 'Y', length: 'long', at: 1 }],
    });
    assert.deepEqual(r.top().leaderboard, [{ name: 'Ok', wins: 2 }]);
    assert.deepEqual(r.top().hallOfFame.map((e) => e.name), ['Ok']);
  });

  test('a failing save does not throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-records-'));
    const file = path.join(dir, 'missing-dir', 'records.json');
    const logs = [];
    const r = loadRecords(file, { log: (m) => logs.push(m) });
    assert.doesNotThrow(() => r.recordRound({ winner: 'Anna' }));
    assert.equal(logs.length, 1);
  });
});
