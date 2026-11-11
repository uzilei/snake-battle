// Banned-word filter for player names, plus a small JSON-file store so /admin
// can edit the list live.
//
// Matching is case-insensitive and catches simple substitutions
// (0/o, 1/i, 3/e, 4/a, 5/s), accents, repeated letters ("caaazzo") and
// separators ("c.a.z.z.o"). Entries of up to SHORT_WORD letters only match a
// whole word, so "ass" doesn't block "Massimo"; longer entries match anywhere.

import fs from 'node:fs';
import path from 'node:path';

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
 * first time. Changes are written back to `filePath`.
 */
export function loadWordList(filePath, defaultsPath, log = console.log) {
  let words = [];
  try {
    if (!fs.existsSync(filePath)) {
      fs.copyFileSync(defaultsPath, filePath);
      log(`[words] created ${path.basename(filePath)} from the starter list`);
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (Array.isArray(parsed)) words = parsed;
    else log(`[words] ${path.basename(filePath)} is not a JSON array, starting empty`);
  } catch (err) {
    log(`[words] could not read ${path.basename(filePath)}: ${err.message}`);
  }
  const save = (list) => {
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
      fs.renameSync(tmp, filePath);
    } catch (err) {
      log(`[words] could not save ${path.basename(filePath)}: ${err.message}`);
    }
  };
  return createWordList(words, { save });
}
