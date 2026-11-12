import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGame } from '../src/server/game.js';
import { loadSettings } from '../src/server/settings-store.js';
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
