import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGame } from '../src/server/game.js';
import { loadSettings } from '../src/server/settings-store.js';
import { loadRecords } from '../src/server/records.js';
import { loadWordList } from '../src/server/profanity.js';
import { createDefaultConfig } from '../src/engine.js';

const quiet = () => {};
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snake-settings-')), 'settings.json');

function admin(game) {
  const conn = game.connect({ send: () => {}, close: () => {} }, { admin: true, isAuthorized: () => true });
  return (obj) => conn.message(JSON.stringify(obj));
}

// A game backed by `file`, as index.js wires it.
function gameOn(file, log = quiet) {
  const store = loadSettings(file, { log });
  return createGame({ log: quiet, savedSettings: store.initial, saveSettings: store.save });
}

const CHANGES = {
  config: { tickMs: 120, gridSize: 40, appleCount: 7, wrapWalls: true, corpseApples: true, timeLimitWin: true, roundTimeLimitSec: 90, timeLimitWinner: 'kills', targetLengthWin: true, targetLength: 25, powerUps: true, powerUpChance: 60, bombsPerMinute: 9, weightGolden: 0, weightGun: 7, weightShield: 10 },
  settings: { sidePanel: 'records', keyboardPlayers: true, leaderboard: true, leaderboardStat: 'kills', displayButtons: true, deathParticles: true, appleRings: true, screenShake: true },
};

// The non-config settings on a fresh start.
const DEFAULT_SETTINGS = { sidePanel: 'auto', keyboardPlayers: false, leaderboard: false, leaderboardStat: 'auto', displayButtons: false, deathParticles: false, appleRings: false, screenShake: false };

describe('reset all settings to defaults', () => {
  // A data folder like the real one: settings, records, banned words and the
  // server config, each a real file.
  function expoFolder() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-reset-'));
    const file = (name) => path.join(dir, name);
    fs.writeFileSync(file('records.json'), JSON.stringify({ version: 2, wins: [{ name: 'Ada', wins: 3, at: 1700000000000 }], kills: [{ name: 'Bo', kills: 5, at: 1700000000000 }], score: [{ name: 'Cy', length: 40, at: 1700000000000 }] }));
    fs.writeFileSync(file('banned-words.json'), JSON.stringify(['parolaccia']));
    fs.writeFileSync(file('starter.json'), JSON.stringify([]));
    fs.writeFileSync(file('config.json'), JSON.stringify({ port: 3000, adminPassword: 'not-a-real-one' }));
    const store = loadSettings(file('settings.json'), { log: quiet });
    const game = createGame({
      log: quiet,
      records: loadRecords(file('records.json'), { log: quiet }),
      wordList: loadWordList(file('banned-words.json'), file('starter.json'), quiet),
      savedSettings: store.initial,
      saveSettings: store.save,
    });
    return { game, file };
  }

  test('every config value and setting goes back to its default, and settings.json is saved', () => {
    const { game, file } = expoFolder();
    const send = admin(game);
    send({ t: 'config', values: CHANGES.config });
    send({ t: 'settings', ...CHANGES.settings });
    send({ t: 'resetSettings' });
    assert.deepEqual(game.config, createDefaultConfig());
    assert.deepEqual(game.settings, DEFAULT_SETTINGS);
    // Saved: a restart comes back with the defaults too.
    const saved = JSON.parse(fs.readFileSync(file('settings.json'), 'utf8'));
    assert.deepEqual(saved.config, createDefaultConfig());
    assert.deepEqual(saved.settings, DEFAULT_SETTINGS);
    const restarted = createGame({ log: quiet, savedSettings: loadSettings(file('settings.json'), { log: quiet }).initial });
    assert.deepEqual(restarted.config, createDefaultConfig());
    assert.deepEqual(restarted.settings, DEFAULT_SETTINGS);
  });

  test('records, banned words and config.json are not touched', () => {
    const { game, file } = expoFolder();
    const untouched = ['records.json', 'banned-words.json', 'config.json'];
    const before = Object.fromEntries(untouched.map((f) => [f, fs.readFileSync(file(f), 'utf8')]));
    const send = admin(game);
    send({ t: 'config', values: CHANGES.config });
    send({ t: 'settings', ...CHANGES.settings });
    send({ t: 'resetSettings' });
    for (const f of untouched) assert.equal(fs.readFileSync(file(f), 'utf8'), before[f], f);
    assert.deepEqual(game.wordList.words(), ['parolaccia']);
    assert.equal(game.records.counts().wins, 1);
  });

  test('live values apply at once; round rules and the grid size from the next round', () => {
    const { game } = expoFolder();
    const send = admin(game);
    send({ t: 'config', values: { wrapWalls: true, powerUps: true, gridSize: 40, tickMs: 300 } });
    game.engine.addPlayer('a', 'A');
    game.engine.addPlayer('b', 'B');
    game.tickOnce(); // the round starts with those rules
    send({ t: 'resetSettings' });
    let state = game.engine.getState();
    assert.equal(game.config.tickMs, createDefaultConfig().tickMs); // live
    assert.equal(state.gridSize, 40); // this round keeps its board...
    assert.equal(state.rules.wrapWalls, true); // ...and its rules
    assert.equal(state.rules.powerUps, true);
    game.engine.restartRound();
    state = game.engine.getState();
    assert.equal(state.gridSize, createDefaultConfig().gridSize);
    assert.equal(state.rules.wrapWalls, false);
    assert.equal(state.rules.powerUps, false);
  });

  test('keyboard players are removed (they are off by default); a pause is not a setting and stays', () => {
    const { game } = expoFolder();
    const send = admin(game);
    send({ t: 'settings', keyboardPlayers: true });
    const display = game.connect({ send: () => {}, close: () => {} });
    display.message(JSON.stringify({ t: 'hello', role: 'display' }));
    display.message(JSON.stringify({ t: 'join', slot: 'wasd' }));
    assert.equal(game.engine.getState().players.length, 1);
    send({ t: 'pause' });
    send({ t: 'resetSettings' });
    assert.equal(game.engine.getState().players.length, 0);
    assert.equal(game.isPaused(), true);
  });

  test('only an admin can reset', () => {
    const { game } = expoFolder();
    admin(game)({ t: 'config', values: { appleCount: 9 } });
    const phone = game.connect({ send: () => {}, close: () => {} });
    phone.message(JSON.stringify({ t: 'resetSettings' }));
    assert.equal(game.config.appleCount, 9);
  });
});

describe('settings persistence', () => {
  test('every /admin config value and setting survives a restart', () => {
    const file = tmpFile();
    const send = admin(gameOn(file));
    send({ t: 'config', values: CHANGES.config });
    send({ t: 'settings', ...CHANGES.settings });

    const restarted = gameOn(file);
    for (const [k, v] of Object.entries(CHANGES.config)) assert.equal(restarted.config[k], v, k);
    assert.deepEqual(restarted.settings, CHANGES.settings);
    // The rules of the first round come from the restored config.
    restarted.engine.addPlayer('a', 'A');
    restarted.engine.addPlayer('b', 'B');
    restarted.tickOnce();
    const state = restarted.engine.getState();
    assert.equal(state.gridSize, 40);
    assert.equal(state.rules.wrapWalls, true);
    assert.equal(state.rules.powerUps, true);
    assert.deepEqual(state.win, { timeLimitSec: 90, timeLimitWinner: 'kills', targetLength: 25 });
  });

  test('a side panel switched from the /display buttons is saved too', () => {
    const file = tmpFile();
    const game = gameOn(file);
    admin(game)({ t: 'settings', displayButtons: true, sidePanel: 'leaderboard' });
    const display = game.connect({ send: () => {}, close: () => {} });
    display.message(JSON.stringify({ t: 'hello', role: 'display' }));
    display.message(JSON.stringify({ t: 'sidePanel', mode: 'join' }));
    assert.equal(gameOn(file).settings.sidePanel, 'join');
  });

  test('with no file, the defaults apply and nothing is written until something changes', () => {
    const file = tmpFile();
    const game = gameOn(file);
    assert.deepEqual(game.config, createDefaultConfig());
    assert.equal(game.settings.leaderboard, false);
    admin(game)({ t: 'pause' }); // not a setting
    assert.equal(fs.existsSync(file), false);
    admin(game)({ t: 'settings', leaderboard: true });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  });

  test('pause is not persisted: a restart never comes back paused', () => {
    const file = tmpFile();
    const send = admin(gameOn(file));
    send({ t: 'settings', leaderboard: true });
    send({ t: 'pause' });
    assert.equal(gameOn(file).isPaused(), false);
  });

  test('an invalid /admin message changes and saves nothing (all or nothing)', () => {
    const file = tmpFile();
    const send = admin(gameOn(file));
    send({ t: 'settings', leaderboard: true, sidePanel: 'nonsense' });
    assert.equal(fs.existsSync(file), false);
    assert.equal(gameOn(file).settings.leaderboard, false);
  });

  test('a hand-edited file can only set what /admin could: values are validated and clamped', () => {
    const file = tmpFile();
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        config: { tickMs: 1, gridSize: 9999, wrapWalls: 'yes', timeLimitWinner: 'random', unknown: 5, __proto__: { x: 1 } },
        settings: { sidePanel: 'nonsense', leaderboard: true, keyboardPlayers: 1, extra: true },
      }),
    );
    const game = gameOn(file);
    const defaults = createDefaultConfig();
    assert.equal(game.config.tickMs, 80); // clamped to the minimum
    assert.equal(game.config.gridSize, 80); // clamped to the maximum
    assert.equal(game.config.wrapWalls, defaults.wrapWalls);
    assert.equal(game.config.timeLimitWinner, defaults.timeLimitWinner);
    assert.equal(Object.hasOwn(game.config, 'unknown'), false);
    assert.equal(game.settings.sidePanel, 'auto');
    assert.equal(game.settings.leaderboard, true);
    assert.equal(game.settings.keyboardPlayers, false);
    assert.equal(Object.hasOwn(game.settings, 'extra'), false);
  });

  test('a corrupt, empty or wrong-shaped file is kept aside and the defaults apply', () => {
    for (const contents of ['{ broken', '', '[]', 'null']) {
      const file = tmpFile();
      fs.writeFileSync(file, contents);
      const logs = [];
      const game = gameOn(file, (m) => logs.push(m));
      assert.deepEqual(game.config, createDefaultConfig(), JSON.stringify(contents));
      assert.equal(game.settings.leaderboard, false);
      assert.equal(fs.readFileSync(`${file}.bad`, 'utf8'), contents);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /using the defaults/);
      // The next change writes a valid file again.
      admin(game)({ t: 'settings', leaderboard: true });
      assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).settings.leaderboard, true);
    }
  });

  test('a failing save is logged and does not throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-settings-'));
    const logs = [];
    const game = gameOn(path.join(dir, 'missing-dir', 'settings.json'), (m) => logs.push(m));
    assert.doesNotThrow(() => admin(game)({ t: 'settings', leaderboard: true }));
    assert.equal(game.settings.leaderboard, true);
    assert.equal(logs.length, 1);
  });
});
