// Persistent records: wins per player name (leaderboard) and the longest
// snakes ever (hall of fame). Names are grouped with nameKey: case-sensitive,
// so "Marco" and "marco" are separate entries.
//
// createRecords() is in-memory; loadRecords() adds a JSON file behind it.

import fs from 'node:fs';
import path from 'node:path';
import { nameKey } from './names.js';
import { MAX_NAME_LENGTH } from '../shared/limits.js';

export const RECORD_LIMITS = Object.freeze({
  leaderboardShown: 10,
  hallOfFameSize: 5,
  maxNames: 5000, // leaderboard entries kept; the weakest are dropped beyond this
});

const validName = (n) => typeof n === 'string' && n.length > 0 && [...n].length <= MAX_NAME_LENGTH;
const validCount = (n) => Number.isInteger(n) && n > 0 && n < 1e9;
const validTime = (t) => Number.isFinite(t) && t >= 0;

// Leaderboard order: more wins first; on a tie, whoever got there first.
const byWins = (a, b) => b.wins - a.wins || a.at - b.at;
// Hall of fame order: longer first; on a tie, the older record stays ahead.
const byLength = (a, b) => b.length - a.length || a.at - b.at;

/**
 * @param {object} [data] { leaderboard: [{ name, wins, at }], hallOfFame: [{ name, length, at }] }
 * @param {object} [opts]
 * @param {(data) => void} [opts.save] called with the full data after every change
 * @param {() => number} [opts.now]
 */
export function createRecords(data = {}, { save = () => {}, now = Date.now } = {}) {
  // Map, not a plain object: "__proto__" or "constructor" are valid names.
  const wins = new Map(); // nameKey -> { name, wins, at }
  for (const e of Array.isArray(data.leaderboard) ? data.leaderboard : []) {
    if (e && validName(e.name) && validCount(e.wins) && validTime(e.at)) {
      wins.set(nameKey(e.name), { name: e.name, wins: e.wins, at: e.at });
    }
  }
  let fame = [];
  for (const e of Array.isArray(data.hallOfFame) ? data.hallOfFame : []) {
    if (e && validName(e.name) && validCount(e.length) && validTime(e.at)) fame = withLength(fame, e);
  }

  // Inserts a result, keeping only each name's best and the top N overall.
  function withLength(list, entry) {
    const key = nameKey(entry.name);
    const existing = list.find((e) => nameKey(e.name) === key);
    if (existing && existing.length >= entry.length) return list;
    const next = list.filter((e) => e !== existing);
    next.push({ name: entry.name, length: entry.length, at: entry.at });
    return next.sort(byLength).slice(0, RECORD_LIMITS.hallOfFameSize);
  }

  const snapshot = () => ({
    leaderboard: [...wins.values()].map((e) => ({ ...e })),
    hallOfFame: fame.map((e) => ({ ...e })),
  });
  const persist = () => save(snapshot());

  function addWinTo(name, at) {
    const key = nameKey(name);
    const entry = wins.get(key) ?? { name, wins: 0, at };
    wins.delete(key); // re-inserted below, so the newest names are last
    wins.set(key, { name, wins: entry.wins + 1, at });
    if (wins.size > RECORD_LIMITS.maxNames) {
      let weakest = null;
      for (const [k, e] of wins) if (k !== key && (!weakest || e.wins < weakest[1].wins)) weakest = [k, e];
      if (weakest) wins.delete(weakest[0]);
    }
  }

  /**
   * Records the outcome of one round with a single save.
   * @param {object} round
   * @param {string|null} [round.winner] winner's name, if wins are being counted
   * @param {Array<{ name: string, length: number }>} [round.lengths] for the hall of fame
   * @returns {boolean} whether anything changed
   */
  function recordRound({ winner = null, lengths = [] } = {}) {
    const at = now();
    let changed = false;
    if (winner !== null && validName(winner)) {
      addWinTo(winner, at);
      changed = true;
    }
    for (const { name, length } of lengths) {
      if (!validName(name) || !validCount(length)) continue;
      const next = withLength(fame, { name, length, at });
      if (next !== fame) {
        fame = next;
        changed = true;
      }
    }
    if (changed) persist();
    return changed;
  }

  function resetHallOfFame() {
    fame = [];
    persist();
  }

  // What /display shows.
  const top = () => ({
    leaderboard: [...wins.values()]
      .sort(byWins)
      .slice(0, RECORD_LIMITS.leaderboardShown)
      .map((e) => ({ name: e.name, wins: e.wins })),
    hallOfFame: fame.map((e) => ({ ...e })),
  });

  return { recordRound, resetHallOfFame, top, snapshot };
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
