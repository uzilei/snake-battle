// Banned-word filter for player names, plus a small JSON-file store so /admin
// can edit the list live.
//
// Matching is case-insensitive and catches simple substitutions
// (0/o, 1/i, 3/e, 4/a, 5/s), accents, repeated letters ("caaazzo") and
// separators ("c.a.z.z.o"). Entries of up to SHORT_WORD letters only match a
// whole word, so "ass" doesn't block "Massimo"; longer entries match anywhere.

import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './json-file.js';

const SUBSTITUTIONS = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's' };
const SHORT_WORD = 3;
export const WORD_LIMITS = Object.freeze({ minLetters: 2, maxLength: 30, maxWords: 2000 });

const collapse = (s) => s.replace(/(.)\1+/g, '$1');

// Lowercase, strip accents, apply substitutions. Returns the letter-only tokens.
function tokens(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[01345]/g, (d) => SUBSTITUTIONS[d])
    .split(/[^a-z]+/)
    .filter(Boolean);
}

// The canonical form of a list entry ('' if it has no letters): all letters
// joined, repeated letters collapsed.
export function normalizeWord(word) {
  return collapse(tokens(word).join(''));
}

/** @param {string[]} words */
export function createWordList(words = [], { save = () => {} } = {}) {
  const list = new Map(); // normalized -> word as entered (lowercased)
  for (const w of words) {
    if (typeof w !== 'string') continue;
    const n = normalizeWord(w);
    if (n.length >= WORD_LIMITS.minLetters && !list.has(n)) list.set(n, w.trim().toLowerCase());
  }

  function matches(name) {
    const parts = tokens(name).map(collapse);
    const joined = collapse(parts.join(''));
    for (const n of list.keys()) {
      if (n.length <= SHORT_WORD ? parts.includes(n) : joined.includes(n)) return true;
    }
    return false;
  }

  function persist() {
    save(words_());
  }

  function words_() {
    return [...list.values()].sort((a, b) => a.localeCompare(b, 'it'));
  }

  // Returns { ok } or { ok: false, reason: 'invalid' | 'exists' | 'tooMany' }.
  function add(raw) {
    if (typeof raw !== 'string' || raw.trim().length > WORD_LIMITS.maxLength) return { ok: false, reason: 'invalid' };
    const n = normalizeWord(raw);
    if (n.length < WORD_LIMITS.minLetters) return { ok: false, reason: 'invalid' };
    if (list.has(n)) return { ok: false, reason: 'exists' };
    if (list.size >= WORD_LIMITS.maxWords) return { ok: false, reason: 'tooMany' };
    list.set(n, raw.trim().toLowerCase());
    persist();
    return { ok: true };
  }

  function remove(raw) {
    if (typeof raw !== 'string') return false;
    if (!list.delete(normalizeWord(raw))) return false;
    persist();
    return true;
  }

  return { matches, add, remove, words: words_ };
}

/**
 * Loads the live word list from `filePath`, seeding it from `defaultsPath` the
 * first time, or when the file is empty or unreadable (the bad file is kept
 * aside as `<file>.bad`, so the filter is never silently off). Changes are
 * written back to `filePath` atomically.
 */
export function loadWordList(filePath, defaultsPath, log = console.log) {
  const base = path.basename(filePath);
  const live = readJsonFile(filePath, { valid: Array.isArray, tag: 'words', log, fallback: 'using the starter list' });
  let words = live.data ?? [];
  const save = (list) => {
    try {
      writeJsonAtomic(filePath, list);
    } catch (err) {
      log(`[words] could not save ${base}: ${err.message}`);
    }
  };
  if (live.status !== 'ok') {
    try {
      words = JSON.parse(fs.readFileSync(defaultsPath, 'utf8'));
      if (!Array.isArray(words)) throw new Error('not a JSON array');
      save(words);
      if (live.status === 'missing') log(`[words] created ${base} from the starter list`);
    } catch (err) {
      log(`[words] could not read the starter list: ${err.message}`);
      words = [];
    }
  }
  return createWordList(words, { save });
}
