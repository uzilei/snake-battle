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

const names = (list) => list.map((e) => [e.name, e.value]);

describe('wins', () => {
  test('wins add up per name; a different case is a different player', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ winner: 'Marco' });
    r.recordRound({ winner: 'Marco' });
    r.recordRound({ winner: 'marco' });
    assert.deepEqual(names(r.top().wins), [['Marco', 2], ['marco', 1]]);
  });

  test('top 10 only, ties broken by who got there first', () => {
    const r = createRecords({}, { now: clock() });
    for (let i = 0; i < 12; i++) r.recordRound({ winner: `P${i}` });
    r.recordRound({ winner: 'P11' });
    const top = r.top().wins;
    assert.equal(top.length, RECORD_LIMITS.shown);
    assert.deepEqual(top[0], { name: 'P11', value: 2 });
    assert.equal(top[1].name, 'P0');
    assert.equal(top[9].name, 'P8');
  });

  test('names like __proto__ are ordinary entries', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ winner: '__proto__' });
    r.recordRound({ winner: 'constructor' });
    assert.deepEqual(r.top().wins.map((e) => e.name), ['__proto__', 'constructor']);
  });

  test('a round with nothing to record changes nothing', () => {
    let saves = 0;
    const r = createRecords({}, { save: () => saves++ });
    assert.equal(r.recordRound({ winner: null, kills: [{ name: 'A', kills: 0 }] }), false);
    assert.equal(saves, 0);
  });
});

describe('kills', () => {
  test('kills add up across rounds; zero-kill rounds are ignored', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ kills: [{ name: 'Anna', kills: 2 }, { name: 'Luca', kills: 1 }, { name: 'Bea', kills: 0 }] });
    r.recordRound({ kills: [{ name: 'Luca', kills: 3 }] });
    assert.deepEqual(names(r.top().kills), [['Luca', 4], ['Anna', 2]]);
  });

  test('invalid counts are skipped', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ kills: [{ name: 'A', kills: -1 }, { name: 'B', kills: 1.5 }, { name: '', kills: 2 }] });
    assert.deepEqual(r.top().kills, []);
  });
});

describe('highest score', () => {
  test('one entry per name: its best length ever', () => {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ lengths: [{ name: 'Anna', length: 9 }, { name: 'Luca', length: 12 }] });
    r.recordRound({ lengths: [{ name: 'Anna', length: 5 }] }); // worse: ignored
    r.recordRound({ lengths: [{ name: 'Anna', length: 20 }, { name: 'anna', length: 4 }] });
    assert.deepEqual(names(r.top().score), [['Anna', 20], ['Luca', 12], ['anna', 4]]);
  });

  test('top 10 of every name, older record first on a tie', () => {
    const r = createRecords({}, { now: clock() });
    for (let i = 0; i < 15; i++) r.recordRound({ lengths: [{ name: `P${i}`, length: 3 + (i % 5) }] });
    const top = r.top().score;
    assert.equal(top.length, 10);
    assert.deepEqual(top.slice(0, 3), [{ name: 'P4', value: 7 }, { name: 'P9', value: 7 }, { name: 'P14', value: 7 }]);
    assert.equal(r.counts().score, 15); // every name is kept, not only the top
  });
});

describe('resets', () => {
  function filled() {
    const r = createRecords({}, { now: clock() });
    r.recordRound({ winner: 'Anna', kills: [{ name: 'Anna', kills: 1 }], lengths: [{ name: 'Anna', length: 9 }] });
    return r;
  }

  test('each stat resets on its own', () => {
    for (const stat of ['wins', 'kills', 'score']) {
      const r = filled();
      assert.equal(r.reset(stat), true);
      for (const other of ['wins', 'kills', 'score']) assert.equal(r.counts()[other], other === stat ? 0 : 1, `${stat}/${other}`);
    }
  });

  test('"all" empties everything; unknown stats are refused', () => {
    const r = filled();
    assert.equal(r.reset('hallOfFame'), false);
    assert.deepEqual(r.counts(), { wins: 1, kills: 1, score: 1 });
    assert.equal(r.reset('all'), true);
    assert.deepEqual(r.counts(), { wins: 0, kills: 0, score: 0 });
  });
});

describe('records file', () => {
  const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snake-records-')), 'records.json');

  test('survives a restart', () => {
    const file = tmpFile();
    const r = loadRecords(file, { log: () => {}, now: clock() });
    r.recordRound({ winner: 'Anna', kills: [{ name: 'Anna', kills: 2 }], lengths: [{ name: 'Anna', length: 9 }] });
    const again = loadRecords(file, { log: () => {} });
    assert.deepEqual(again.top(), {
      wins: [{ name: 'Anna', value: 1 }],
      kills: [{ name: 'Anna', value: 2 }],
      score: [{ name: 'Anna', value: 9 }],
    });
  });

  test('a corrupt file is kept aside, not overwritten', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '{ not json');
    const logs = [];
    const r = loadRecords(file, { log: (m) => logs.push(m) });
    assert.deepEqual(r.top(), { wins: [], kills: [], score: [] });
    assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), '{ not json');
    assert.equal(logs.length, 1);
  });

  test('an empty or wrong-shaped file is kept aside too', () => {
    for (const contents of ['', '\n', '[1, 2]', 'null']) {
      const file = tmpFile();
      fs.writeFileSync(file, contents);
      const r = loadRecords(file, { log: () => {} });
      assert.deepEqual(r.counts(), { wins: 0, kills: 0, score: 0 });
      assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), contents, JSON.stringify(contents));
      assert.equal(fs.existsSync(file), false);
    }
  });

  test('a write interrupted before the rename leaves the old file intact', () => {
    const file = tmpFile();
    const r = loadRecords(file, { log: () => {}, now: clock() });
    r.recordRound({ winner: 'Anna' });
    // What a kill mid-write leaves behind: a half-written temp file.
    fs.writeFileSync(`${file}.tmp`, '{"version": 2, "wins": [{"na');
    const again = loadRecords(file, { log: () => {}, now: clock() });
    assert.deepEqual(again.top().wins, [{ name: 'Anna', value: 1 }]);
    again.recordRound({ winner: 'Anna' }); // the next save replaces the stale temp file
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).wins[0].wins, 2);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  });

  test('a file saved with a byte order mark (Windows Notepad) still loads', () => {
    const file = tmpFile();
    fs.writeFileSync(file, '﻿{"version":2,"wins":[{"name":"Anna","wins":3,"at":1}]}');
    const r = loadRecords(file, { log: () => {} });
    assert.deepEqual(r.top().wins, [{ name: 'Anna', value: 3 }]);
    assert.equal(fs.existsSync(`${file}.bad`), false);
  });

  test('invalid entries are dropped on load', () => {
    const r = createRecords({
      version: 2,
      wins: [{ name: 'Ok', wins: 2, at: 1 }, { name: '', wins: 1, at: 1 }, { name: 'Bad', wins: -1, at: 1 }, null],
      kills: [{ name: 'K', kills: 'many', at: 1 }],
      score: [{ name: 'Ok', length: 4, at: 1 }, { name: 'X'.repeat(40), length: 9, at: 1 }, { name: 'Y', length: 'long', at: 1 }],
    });
    assert.deepEqual(names(r.top().wins), [['Ok', 2]]);
    assert.deepEqual(r.top().kills, []);
    assert.deepEqual(names(r.top().score), [['Ok', 4]]);
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
