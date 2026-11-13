// Computer players: the /admin settings' limits and their names. Shared by
// the server and /admin.

import { STRINGS, fmt } from './strings.js';

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
