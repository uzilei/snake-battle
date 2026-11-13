// Player name cleaning, shared so /play applies exactly the check the server
// enforces (the server runs it again on every join: never trust the client).

import { MAX_NAME_LENGTH } from './limits.js';

// Characters that draw nothing but aren't control characters, so they'd slip
// through as a "name": Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), the
// blank Braille pattern (U+2800), the Mongolian vowel separator (U+180E),
// the typographic spaces and zero-width marks U+2000-U+200F, and the narrow,
// mathematical and ideographic spaces (U+202F, U+205F, U+3000), plus the
// zero-width no-break space (U+FEFF).
const BLANKS = /[ᅟᅠㅤﾠ⠀᠎ -‏  　﻿]/gu;

// At least one letter, number, symbol or punctuation mark.
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

/**
 * A name as it will be shown: control/format and blank characters removed,
 * whitespace collapsed, capped at `max` characters. '' when nothing
 * visible is left (the caller rejects it as an empty name).
 */
export function cleanName(raw, max = MAX_NAME_LENGTH) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/[\p{C}]/gu, '')
    .replace(BLANKS, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = [...cleaned].slice(0, max).join('').trim();
  return VISIBLE.test(capped) ? capped : '';
}
