// Persistent records: the global leaderboard, three stats per player name.
//   wins:  total rounds won
//   kills: total kills across all rounds
//   score: the best length (segment count) each name ever reached
// Names are grouped with nameKey: case-sensitive, so "Marco" and "marco" are
// separate entries.
//
// createRecords() is in-memory; loadRecords() adds a JSON file behind it.

import fs from 'node:fs';
import path from 'node:path';
import { nameKey } from './names.js';
import { MAX_NAME_LENGTH } from '../shared/limits.js';

export const RECORD_STATS = Object.freeze(['wins', 'kills', 'score']);

export const RECORD_LIMITS = Object.freeze({
  shown: 10, // top N per stat on /display
  maxNames: 5000, // entries kept per stat; the weakest are dropped beyond this
});

const FILE_VERSION = 2;

const validName = (n) => typeof n === 'string' && n.length > 0 && [...n].length <= MAX_NAME_LENGTH;
const validCount = (n) => Number.isInteger(n) && n > 0 && n < 1e9;
const validTime = (t) => Number.isFinite(t) && t >= 0;

// Per stat: the field holding the number. For every stat, a higher value
// ranks first; on a tie, whoever got there first (older `at`) stays ahead.
const VALUE = Object.freeze({ wins: 'wins', kills: 'kills', score: 'length' });
const ranking = (field) => (a, b) => b[field] - a[field] || a.at - b.at;

/**
 * @param {object} [data] { version: 2, wins: [{ name, wins, at }], kills: [{ name, kills, at }],
 *   score: [{ name, length, at }] }
 * @param {object} [opts]
 * @param {(data) => void} [opts.save] called with the full data after every change
 * @param {() => number} [opts.now]
 */
export function createRecords(data = {}, { save = () => {}, now = Date.now } = {}) {
  // Map, not a plain object: "__proto__" or "constructor" are valid names.
  const stats = Object.fromEntries(RECORD_STATS.map((s) => [s, new Map()])); // stat -> nameKey -> entry

  for (const stat of RECORD_STATS) {
    const field = VALUE[stat];
    for (const e of Array.isArray(data[stat]) ? data[stat] : []) {
      if (!e || !validName(e.name) || !validCount(e[field]) || !validTime(e.at)) continue;
      const key = nameKey(e.name);
      const existing = stats[stat].get(key);
      // A name listed twice keeps its best (only possible in hand-edited files).
      if (!existing || e[field] > existing[field]) stats[stat].set(key, { name: e.name, [field]: e[field], at: e.at });
    }
  }

  const snapshot = () => ({
    version: FILE_VERSION,
    ...Object.fromEntries(RECORD_STATS.map((s) => [s, [...stats[s].values()].map((e) => ({ ...e }))])),
  });
  const persist = () => save(snapshot());

  // Keeps each stat at most maxNames entries by dropping the weakest one.
  function trim(stat, keepKey) {
    const map = stats[stat];
    if (map.size <= RECORD_LIMITS.maxNames) return;
    const order = ranking(VALUE[stat]);
    let weakest = null;
    for (const [k, e] of map) if (k !== keepKey && (!weakest || order(e, weakest[1]) > 0)) weakest = [k, e];
    if (weakest) map.delete(weakest[0]);
  }

  // Adds `amount` to a counter stat (wins, kills).
  function addTo(stat, name, amount, at) {
    const field = VALUE[stat];
    const key = nameKey(name);
    const total = (stats[stat].get(key)?.[field] ?? 0) + amount;
    stats[stat].set(key, { name, [field]: total, at });
    trim(stat, key);
  }

  // Keeps a name's best length; returns whether it improved.
  function improveScore(name, length, at) {
    const key = nameKey(name);
    const existing = stats.score.get(key);
    if (existing && existing.length >= length) return false;
    stats.score.set(key, { name, length, at });
    trim('score', key);
    return true;
  }

  /**
   * Records the outcome of one round with a single save.
   * @param {object} round
   * @param {string|null} [round.winner] winner's name
   * @param {Array<{ name: string, kills: number }>} [round.kills] kills this round
   * @param {Array<{ name: string, length: number }>} [round.lengths] best length this round
   * @returns {boolean} whether anything changed
   */
  function recordRound({ winner = null, kills = [], lengths = [] } = {}) {
    const at = now();
    let changed = false;
    if (winner !== null && validName(winner)) {
      addTo('wins', winner, 1, at);
      changed = true;
    }
    for (const { name, kills: n } of kills) {
      if (!validName(name) || !validCount(n)) continue;
      addTo('kills', name, n, at);
      changed = true;
    }
    for (const { name, length } of lengths) {
      if (validName(name) && validCount(length) && improveScore(name, length, at)) changed = true;
    }
    if (changed) persist();
    return changed;
  }

  /** Empties one stat, or all of them with 'all'. Returns false for an unknown stat. */
  function reset(stat) {
    const which = stat === 'all' ? RECORD_STATS : RECORD_STATS.includes(stat) ? [stat] : null;
    if (!which) return false;
    for (const s of which) stats[s].clear();
    persist();
    return true;
  }

  const counts = () => Object.fromEntries(RECORD_STATS.map((s) => [s, stats[s].size]));

  // What /display shows: the top N of each stat.
  const top = () =>
    Object.fromEntries(
      RECORD_STATS.map((s) => {
        const field = VALUE[s];
        const list = [...stats[s].values()].sort(ranking(field)).slice(0, RECORD_LIMITS.shown);
        return [s, list.map((e) => ({ name: e.name, value: e[field] }))];
      }),
    );

  return { recordRound, reset, top, counts, snapshot };
}

/**
 * Records backed by `filePath`. A file that can't be parsed is kept aside as
 * `<file>.bad` instead of being overwritten, and the records start empty.
 */
export function loadRecords(filePath, { log = console.log, now } = {}) {
  const base = path.basename(filePath);
  let data = {};
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
      else throw new Error('not a JSON object');
    } catch (err) {
      log(`[records] could not read ${base} (${err.message}), keeping it as ${base}.bad and starting empty`);
      try {
        fs.renameSync(filePath, `${filePath}.bad`);
      } catch {
        /* nothing else to do */
      }
    }
  }
  const save = (snapshot) => {
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(snapshot, null, 2)}\n`);
      fs.renameSync(tmp, filePath);
    } catch (err) {
      log(`[records] could not save ${base}: ${err.message}`);
    }
  };
  return createRecords(data, { save, now });
}
