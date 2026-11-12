// /admin settings and game config, kept across restarts in settings.json:
//   { version: 1, config: { tickMs, gridSize, wrapWalls, ... }, settings: { sidePanel, leaderboard, ... } }
// Values are validated when they are applied (see game.js), so a hand-edited
// file can't set anything /admin couldn't. A file that can't be read is kept
// aside as settings.json.bad and the defaults are used.

import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './json-file.js';

export const SETTINGS_VERSION = 1;

/**
 * @returns {{ initial: object | null, save: (snapshot: object) => void }}
 *   `initial` is the saved { config, settings }, or null when there is none.
 */
export function loadSettings(filePath, { log = console.log } = {}) {
  const base = path.basename(filePath);
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const { status, data } = readJsonFile(filePath, { valid: isObject, tag: 'settings', log, fallback: 'using the defaults' });
  if (status === 'ok') log(`[settings] loaded ${base}`);
  return {
    initial: status === 'ok' ? data : null,
    save(snapshot) {
      try {
        writeJsonAtomic(filePath, snapshot);
      } catch (err) {
        log(`[settings] could not save ${base}: ${err.message}`);
      }
    },
  };
}
