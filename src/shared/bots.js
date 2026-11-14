// Computer players: the /admin settings' limits and their names. Shared by
// the server and /admin.

import { STRINGS, fmt } from './strings.js';
import { cleanName } from './names.js';
import { HAT_IDS } from './hats.js';

export const BOT_LIMITS = Object.freeze({
  bots: Object.freeze({ min: 0, max: 24, default: 0 }), // 0 = no bots
  // How likely a new bot is to get each skill (relative weights). The
  // defaults give every bot skill 2.
  botWeight1: Object.freeze({ min: 0, max: 10, default: 0 }),
  botWeight2: Object.freeze({ min: 0, max: 10, default: 1 }),
  botWeight3: Object.freeze({ min: 0, max: 10, default: 0 }),
});

export const BOT_SKILLS = Object.freeze([1, 2, 3]);
export const botWeightKey = (skill) => `botWeight${skill}`;
// Drawn by a bot's name on /display: 🐣 learner, ⚔️ fighter, ☠️ deadly.
export const BOT_SKILL_TWEMOJI = Object.freeze({ 1: '1f423', 2: '2694', 3: '2620' });
export const BOT_SKILL_EMOJI = Object.freeze({ 1: '🐣', 2: '⚔️', 3: '☠️' });

// A skill for a new bot, by the /admin weights (all 0: each as likely).
export function pickBotSkill(settings, random = Math.random) {
  const weights = BOT_SKILLS.map((k) => settings[botWeightKey(k)] ?? 0);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return BOT_SKILLS[Math.floor(random() * BOT_SKILLS.length)];
  let r = random() * total;
  for (let i = 0; i < BOT_SKILLS.length; i++) {
    r -= weights[i];
    if (r < 0) return BOT_SKILLS[i];
  }
  return BOT_SKILLS[weights.findLastIndex((w) => w > 0)];
}

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

// Reserved bots: names (and hats) set on /admin that bots play under before
// any "Bot N". Each name is cleaned like a player's and must be visible, not
// look like "Bot N", and differ from the others in the list (compared like
// player names: case-sensitive, NFC). hat: one of the hats, or null.
export const MAX_RESERVED_BOTS = 50;
const reservedKey = (name) => name.normalize('NFC');

// Why `raw` can't be the name of a reserved bot next to `others` (names
// already in the list), or null: 'empty' | 'botName' | 'duplicate'.
export function reservedNameProblem(raw, others = []) {
  const name = cleanName(raw);
  if (!name) return 'empty';
  if (BOT_NAME_PATTERN.test(name)) return 'botName';
  const key = reservedKey(name);
  return others.some((o) => reservedKey(cleanName(o)) === key) ? 'duplicate' : null;
}

// Whether `list` is a valid reserved bot list ({ name, hat } entries).
export function validReservedBots(list) {
  if (!Array.isArray(list) || list.length > MAX_RESERVED_BOTS) return false;
  const names = [];
  for (const b of list) {
    if (!b || typeof b !== 'object' || Array.isArray(b)) return false;
    if (typeof b.name !== 'string' || b.name.length > 200) return false;
    if (!(b.hat === null || b.hat === undefined || HAT_IDS.includes(b.hat))) return false;
    if (reservedNameProblem(b.name, names)) return false;
    names.push(b.name);
  }
  return true;
}

// A valid list as it is stored: cleaned names, hat null when none.
export const normalizeReservedBots = (list) => list.map((b) => ({ name: cleanName(b.name), hat: b.hat ?? null }));
