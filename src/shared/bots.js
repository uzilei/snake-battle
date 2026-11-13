// Computer players: the /admin settings' limits and their names. Shared by
// the server and /admin.

import { STRINGS, fmt } from './strings.js';

export const BOT_LIMITS = Object.freeze({
  bots: Object.freeze({ min: 0, max: 24, default: 0 }), // 0 = no bots
  botSkill: Object.freeze({ min: 1, max: 3, default: 2 }),
});

// Bots and players together never go past this many (the player colors):
// a person joining a full board makes a bot leave at once, and between
// rounds bots only fill up to the bot count, as in fill mode.
export const MAX_SNAKES = 24;

// "Bot 3". A person can't pick a name like this, so a name that looks like
// a bot's always is one.
export const botName = (n) => fmt(STRINGS.botName, { n });
export const BOT_NAME_PATTERN = /^\s*bot\s*\d+\s*$/i;

// How many bots should be playing, given the setting and the number of
// people (playing or waiting).
export function botTarget({ bots, botFill }, people) {
  const fill = botFill || bots + people > MAX_SNAKES;
  return fill ? Math.max(0, bots - people) : bots;
}
