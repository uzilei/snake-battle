// Entry point: node src/server/index.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from './config.js';
import { createApp } from './app.js';
import { loadWordList } from './profanity.js';
import { loadRecords } from './records.js';
import { loadSettings } from './settings-store.js';
import { EXPO_DEFAULTS } from './expo-defaults.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(ROOT, 'config.json');

const serverConfig = loadServerConfig(configPath);
// The live list is edited from /admin; it is seeded from the starter list on first run.
const wordList = loadWordList(path.join(ROOT, 'banned-words.json'), path.join(ROOT, 'src', 'server', 'banned-words.default.json'));
// Global leaderboard (wins, kills, highest score), kept across restarts.
const records = loadRecords(path.join(ROOT, 'records.json'));
// /admin settings and game config, kept across restarts.
const settings = loadSettings(path.join(ROOT, 'settings.json'));
const { listen } = createApp({ serverConfig, wordList, records, defaults: EXPO_DEFAULTS, savedSettings: settings.initial, saveSettings: settings.save });

// A single bad client must never take the server down.
process.on('uncaughtException', (err) => console.error('[server] uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

try {
  const urls = await listen(serverConfig.port, '0.0.0.0');
  console.log('Snake Battle is running:');
  console.log(`  Display      ${urls.display}`);
  console.log(`  Play         ${urls.play}`);
  console.log(`  Admin        ${urls.admin}`);
  console.log(`  Admin print  ${urls.print}`);
} catch (err) {
  console.error(`[server] could not start on port ${serverConfig.port}: ${err.message}`);
  process.exit(1);
}
