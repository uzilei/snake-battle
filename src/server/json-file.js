// Crash-safe JSON files for the server's persistent stores (records,
// banned words).
//
// Writes go to `<file>.tmp`, are flushed to disk, then renamed over the real
// file, so a kill or power cut mid-write leaves either the old or the new
// file, never a half-written one. A file that can't be parsed at startup is
// moved aside as `<file>.bad` (or `.bad-<time>` if that exists already) rather
// than overwritten, so nothing is lost.

import fs from 'node:fs';
import path from 'node:path';

/** Writes `data` as JSON to `filePath` atomically. Throws on failure. */
export function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, `${JSON.stringify(data, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

// Moves an unreadable file aside without replacing an earlier backup.
function keepAside(filePath) {
  let target = `${filePath}.bad`;
  if (fs.existsSync(target)) target = `${filePath}.bad-${Date.now()}`;
  fs.renameSync(filePath, target);
  return path.basename(target);
}

/**
 * Reads a JSON file at startup.
 * @param {string} filePath
 * @param {object} opts
 * @param {(value) => boolean} opts.valid whether the parsed value has the right shape
 * @param {string} opts.tag log prefix, e.g. 'records'
 * @param {Function} opts.log
 * @param {string} opts.fallback what happens instead, for the log line
 * @returns {{ status: 'missing' | 'ok' | 'bad', data?: any }}
 *   'bad': the file was empty, unparsable or the wrong shape, and was moved aside.
 */
export function readJsonFile(filePath, { valid, tag, log, fallback }) {
  const base = path.basename(filePath);
  if (!fs.existsSync(filePath)) return { status: 'missing' };
  let problem;
  try {
    // A file hand-edited with Windows Notepad may start with a byte order mark.
    const text = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) problem = 'empty file';
    else {
      const data = JSON.parse(text);
      if (valid(data)) return { status: 'ok', data };
      problem = 'unexpected contents';
    }
  } catch (err) {
    problem = err.message;
  }
  try {
    log(`[${tag}] could not read ${base} (${problem}), kept it as ${keepAside(filePath)}, ${fallback}`);
  } catch (err) {
    log(`[${tag}] could not read ${base} (${problem}) or move it aside (${err.message}), ${fallback}`);
  }
  return { status: 'bad' };
}
