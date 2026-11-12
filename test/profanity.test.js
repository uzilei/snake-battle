import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWordList, loadWordList, normalizeWord } from '../src/server/profanity.js';

const DEFAULTS = path.resolve(import.meta.dirname, '..', 'src', 'server', 'banned-words.default.json');

describe('banned word matching', () => {
  const list = createWordList(['cazzo', 'stronzo', 'fuck', 'ass']);

  test('case-insensitive, with digit substitutions', () => {
    for (const name of ['CAZZO', 'Cazzo99', 'c4zz0', 'str0nz0', 'StR0NZ0', 'fvck'.replace('v', 'u'), 'FUCK']) {
      assert.equal(list.matches(name), true, name);
    }
  });

  test('catches separators, accents and repeated letters', () => {
    for (const name of ['c.a.z.z.o', 'c a z z o', 'càzzò', 'caaazzzooo', 'f_u_c_k']) {
      assert.equal(list.matches(name), true, name);
    }
  });

  test('short words only match as a whole word', () => {
    assert.equal(list.matches('Massimo'), false);
    assert.equal(list.matches('Cassandra'), false);
    assert.equal(list.matches('ass'), true);
    assert.equal(list.matches('big 455'), true);
  });

  test('ordinary names pass', () => {
    for (const name of ['Anna', 'Luca', 'Giorgia', 'Mattia 3B', 'Sofia', 'Alessandro']) {
      assert.equal(list.matches(name), false, name);
    }
  });

  test('the starter list is valid and does not block common names', () => {
    const words = JSON.parse(fs.readFileSync(DEFAULTS, 'utf8'));
    assert.ok(Array.isArray(words) && words.length > 10);
    const starter = createWordList(words);
    assert.equal(starter.words().length, words.length); // no duplicates or invalid entries
    for (const name of ['Massimo', 'Alessandro', 'Francesca', 'Annalisa', 'Nicolò', 'Cassandra', 'Matteo', 'Sebastiano', 'Cosimo', 'Tiziana']) {
      assert.equal(starter.matches(name), false, name);
    }
    assert.equal(starter.matches('Fr0c10'), true);
    assert.equal(starter.matches('Stronzo'), false); // plain swearing is allowed
  });
});

describe('banned word list editing', () => {
  test('add, remove and validation', () => {
    const saved = [];
    const list = createWordList(['merda'], { save: (w) => saved.push(w) });
    assert.deepEqual(list.add('Pirla'), { ok: true });
    assert.deepEqual(list.add('p1rla'), { ok: false, reason: 'exists' });
    assert.deepEqual(list.add('x'), { ok: false, reason: 'invalid' });
    assert.deepEqual(list.add('1234'.repeat(10)), { ok: false, reason: 'invalid' });
    assert.deepEqual(list.add({}), { ok: false, reason: 'invalid' });
    assert.deepEqual(list.words(), ['merda', 'pirla']);
    assert.equal(list.remove('PIRLA'), true);
    assert.equal(list.remove('nope'), false);
    assert.deepEqual(saved, [['merda', 'pirla'], ['merda']]);
  });

  test('normalizeWord', () => {
    assert.equal(normalizeWord(' C4ZZ0 '), 'cazo');
    assert.equal(normalizeWord('!!'), '');
  });

  test('the file store seeds from the starter list and saves changes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-words-'));
    try {
      const file = path.join(dir, 'banned-words.json');
      const list = loadWordList(file, DEFAULTS, () => {});
      assert.ok(fs.existsSync(file));
      list.add('pirla');
      const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.ok(onDisk.includes('pirla'));
      // A reload sees the change.
      assert.equal(loadWordList(file, DEFAULTS, () => {}).matches('Pirla'), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt file does not crash the server', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-words-'));
    try {
      const file = path.join(dir, 'banned-words.json');
      fs.writeFileSync(file, '{not json');
      const logs = [];
      const list = loadWordList(file, DEFAULTS, (m) => logs.push(m));
      assert.deepEqual(list.words(), []);
      assert.equal(logs.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
