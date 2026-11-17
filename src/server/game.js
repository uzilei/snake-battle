// Game controller: owns the engine, runs the tick loop, tracks which client
// owns which player, and validates every incoming message.
//
// Transport-agnostic: a client is { send(obj), close(code, reason) } plus a
// role. The WebSocket wiring lives in app.js.

import { createEngine, createDefaultConfig, CONFIG_LIMITS, CONFIG_TOGGLES, CONFIG_CHOICES, PHASES } from '../engine.js';
import { DEFAULT_LOCALE, LOCALES, stringsFor } from '../shared/strings.js';
import { createWordList } from './profanity.js';
import { MAX_NAME_LENGTH } from '../shared/limits.js';
import { nameKey } from './names.js';
import { createRecords, RECORD_STATS } from './records.js';
import { SETTINGS_VERSION } from './settings-store.js';
import { FRUIT_CODES } from '../shared/fruits.js';
import { validHat, HAT_IDS } from '../shared/hats.js';
import { cleanName } from '../shared/names.js';
import { SOUND_LIMITS, SOUND_VOLUME_DEFAULTS, soundGains } from '../shared/sounds.js';
import { BOT_HIDDEN_SKILL, BOT_LIMITS, BOT_NAME_PATTERN, BOT_SKILLS, MAX_SNAKES, botName, botTarget, botWeightKey, pickBotSkill, validReservedBots, normalizeReservedBots } from '../shared/bots.js';
import { createBotBrain, queueBotMoves } from '../bot-brain.js';
import { roundPlaces } from '../shared/ranking.js';
import { WEIGHTED_POWER_UPS, weightKey } from '../shared/powerups.js';

// 'leaderboard' is the live scoreboard; 'records' is the global leaderboard
// (most wins, most kills, highest score), shown only when it is enabled.
export const SIDE_PANEL_MODES = Object.freeze(['auto', 'leaderboard', 'records', 'join']);
// Which global leaderboard stat /display shows; 'auto' cycles through them.
export const LEADERBOARD_STATS = Object.freeze(['auto', ...RECORD_STATS]);
const RESET_TARGETS = Object.freeze([...RECORD_STATS, 'all']);
// Cosmetic /display effects: applied live, no effect on the game itself.
// Each with its default: the snake animations (eyes, blinking, tongue, mouth,
// swallow bumps) are on unless the admin turns them off.
const EFFECT_DEFAULTS = Object.freeze({ particles: false, screenShake: false, snakeAnimations: true, killPopups: false, sounds: false });
export const EFFECT_SETTINGS = Object.freeze(Object.keys(EFFECT_DEFAULTS));
// How /display draws corpse apples: as fruit, or as gray remains of the
// snake's body. Purely visual.
export const CORPSE_STYLES = Object.freeze(['fruit', 'remains']);
export const KEYBOARD_SLOTS = Object.freeze(['wasd', 'arrows']);
const SELF = 'self';
export { MAX_NAME_LENGTH, nameKey };
const SESSION_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
// The honey badger's boss name on /display ('' = none).
export const MAX_BADGER_NAME_LENGTH = 20;
const MAX_MESSAGES_PER_SECOND = 40;

// Strips control/format characters, blank-looking characters and extra
// whitespace and caps the length; '' (rejected as empty) when nothing
// visible is left. The same function runs on /play before joining.
export const sanitizeName = cleanName;

// Which side column panel /display shows. The records panel only exists when
// the global leaderboard is enabled; it replaces the scoreboard
// (or, in auto mode, the join panel) between rounds, when nobody is playing.
export function resolveSidePanel(mode, state, recordsOn = false) {
  const betweenRounds = state.phase === PHASES.INTERMISSION || state.phase === PHASES.WAITING;
  if (mode === 'join') return 'join';
  if (mode === 'records') return recordsOn ? 'records' : 'leaderboard';
  if (mode === 'leaderboard') return recordsOn && betweenRounds ? 'records' : 'leaderboard';
  if (state.players.filter((p) => !p.bot).length < 2) return 'join'; // bots don't count
  if (state.phase === PHASES.INTERMISSION) return recordsOn ? 'records' : 'join';
  return 'leaderboard';
}

const isBoolean = (v) => typeof v === 'boolean';
const inLimits = ({ min, max }) => (v) => Number.isInteger(v) && v >= min && v <= max;
// Every /admin setting and what it accepts.
const SETTING_RULES = Object.freeze({
  sidePanel: (v) => SIDE_PANEL_MODES.includes(v),
  keyboardPlayers: isBoolean,
  leaderboard: isBoolean,
  leaderboardStat: (v) => LEADERBOARD_STATS.includes(v),
  displayButtons: isBoolean,
  hats: isBoolean,
  corpseStyle: (v) => CORPSE_STYLES.includes(v),
  locale: (v) => LOCALES.includes(v),
  bots: inLimits(BOT_LIMITS.bots),
  botFill: isBoolean,
  botLevels: isBoolean,
  reservedBots: validReservedBots,
  ...Object.fromEntries(BOT_SKILLS.map((k) => [botWeightKey(k), inLimits(BOT_LIMITS[botWeightKey(k)])])),
  ...Object.fromEntries(EFFECT_SETTINGS.map((k) => [k, isBoolean])),
  ...Object.fromEntries(Object.entries(SOUND_LIMITS).map(([k, l]) => [k, inLimits(l)])),
  badgerName: (v) => typeof v === 'string' && v.length <= 200,
  // The fruits apples may be drawn as: any subset of the list, no repeats.
  fruits: (v) => Array.isArray(v) && v.length <= FRUIT_CODES.length && new Set(v).size === v.length && v.every((c) => FRUIT_CODES.includes(c)),
});

// Accepted values stored in a canonical form: fruits in list order, so the
// saved file doesn't change with the order they were ticked in.
const SETTING_NORMALIZE = Object.freeze({
  fruits: (v) => FRUIT_CODES.filter((c) => v.includes(c)),
  // Cleaned like a player name; nothing visible left means no name.
  badgerName: (v) => cleanName(v, MAX_BADGER_NAME_LENGTH),
  reservedBots: normalizeReservedBots,
});
const normalized = (key, value) => (SETTING_NORMALIZE[key] ? SETTING_NORMALIZE[key](value) : value);

// The known settings in `partial` (own keys only), or null if any is invalid.
function validSettingsOrNull(partial) {
  const out = {};
  for (const [key, ok] of Object.entries(SETTING_RULES)) {
    if (!Object.hasOwn(partial, key)) continue;
    if (!ok(partial[key])) return null;
    out[key] = normalized(key, partial[key]);
  }
  return out;
}

// Like validSettingsOrNull, but skips invalid values (for a saved file).
function pickValidSettings(partial) {
  const out = {};
  if (!partial || typeof partial !== 'object') return out;
  for (const [key, ok] of Object.entries(SETTING_RULES)) {
    if (Object.hasOwn(partial, key) && ok(partial[key])) out[key] = normalized(key, partial[key]);
  }
  return out;
}

// Order of the manual modes when cycling them from /display (← and →).
const SIDE_PANEL_RING = Object.freeze(['leaderboard', 'join', 'records']);

/**
 * The ← / → buttons on /display, for a manual side panel mode: each side
 * names the mode it switches to and the panel that will actually appear.
 * A side is null when it wouldn't change what's on screen, and only one is
 * kept when both would show the same panel. Null in auto mode.
 */
export function sidePanelNav(mode, state, recordsOn = false) {
  const i = SIDE_PANEL_RING.indexOf(mode);
  if (i < 0) return null;
  const current = resolveSidePanel(mode, state, recordsOn);
  const side = (m) => {
    const panel = resolveSidePanel(m, state, recordsOn);
    return panel === current ? null : { mode: m, panel };
  };
  let prev = side(SIDE_PANEL_RING[(i + SIDE_PANEL_RING.length - 1) % SIDE_PANEL_RING.length]);
  let next = side(SIDE_PANEL_RING[(i + 1) % SIDE_PANEL_RING.length]);
  if (prev && next && prev.panel === next.panel) {
    // Keep the side whose mode is that panel (e.g. "leaderboard", not a
    // "records" mode that falls back to the scoreboard).
    if (prev.mode === prev.panel) next = null;
    else prev = null;
  }
  return { prev, next };
}

// What each "reset" button on /admin puts back to its default: the values
// of one category (card) of the page, or of one group inside it (the
// power-up weights). Not in any: the language (it stays, as with the full
// reset) and the reserved bot names (a list people typed, not a setting).
// Only the full reset touches those.
export const RESET_GROUPS = Object.freeze({
  settings: { config: ['tickMs', 'appleCount', 'growthPerApple', 'maxPlayers', 'gridSize', 'countdownMs', 'spawnShieldSec', 'intermissionMs'] },
  display: { settings: ['sidePanel', 'keyboardPlayers', 'displayButtons', 'hats', ...EFFECT_SETTINGS.filter((k) => k !== 'sounds'), 'fruits'] },
  sounds: { settings: ['sounds', ...Object.keys(SOUND_LIMITS)] },
  rules: {
    config: ['corpseApples', 'wrapWalls', 'timeLimitWin', 'roundTimeLimitSec', 'timeLimitWinner', 'targetLengthWin', 'targetLength', 'lastPersonWins'],
    settings: ['corpseStyle'],
  },
  powerUps: { config: ['powerUps', 'powerUpChance', ...WEIGHTED_POWER_UPS.map((p) => weightKey(p.type))] },
  powerUpWeights: { config: WEIGHTED_POWER_UPS.map((p) => weightKey(p.type)) },
  creatures: { config: ['ratChance', 'chickenChance', 'badgerEverySec', 'badgerLifetimeSec', 'badgerHealth', 'bombsPerMinute', 'bombMode'], settings: ['badgerName'] },
  bots: { settings: ['bots', 'botFill', 'botLevels', ...BOT_SKILLS.map(botWeightKey)] },
  global: { settings: ['leaderboard', 'leaderboardStat'] },
});

// The /admin settings that aren't engine config, as they are on a fresh start.
const defaultSettings = () => ({
  sidePanel: 'auto',
  keyboardPlayers: false,
  leaderboard: false, // global leaderboard: recorded and shown on /display
  leaderboardStat: 'auto', // applies immediately, like sidePanel
  displayButtons: false, // mouse cursor and side panel buttons on /display
  hats: true, // /display draws the hats players picked on /play
  corpseStyle: 'fruit', // how /display draws corpse apples (CORPSE_STYLES)
  locale: DEFAULT_LOCALE, // language of every page (LOCALES)
  badgerName: '', // drawn under the honey badger, like a boss name
  bots: BOT_LIMITS.bots.default, // computer players (0 = none)
  botFill: false, // bots only fill up to `bots`, making room for people
  reservedBots: [], // { name, hat }: names bots play under before "Bot N"
  botLevels: true, // /display shows each bot's skill emoji (off: 🤖 for all)
  // Skill weights for new bots (botWeight1..3).
  ...Object.fromEntries(BOT_SKILLS.map((k) => [botWeightKey(k), BOT_LIMITS[botWeightKey(k)].default])),
  ...EFFECT_DEFAULTS,
  ...SOUND_VOLUME_DEFAULTS, // 100%: master, and each sound
  fruits: [...FRUIT_CODES], // every fruit in use
});

export function createGame({
  random = Math.random,
  log = console.log,
  joinInfo = {},
  wordList = createWordList(),
  records = createRecords(),
  defaults = null, // { config, settings } on top of the neutral defaults: the fresh start and what a reset goes back to
  savedSettings = null, // { config, settings } from settings.json, applied at startup
  saveSettings = () => {}, // called with { version, config, settings } after every change
} = {}) {
  const config = createDefaultConfig();
  const engine = createEngine({ config, random });
  const brain = createBotBrain({ random, onError: (err) => log(`[bots] think failed: ${err.stack ?? err}`) });
  const settings = defaultSettings();
  // The neutral defaults with `defaults` on top, each value validated like
  // an /admin change.
  // The defaults a reset goes back to: the neutral ones with `defaults` on top.
  const defaultConfigValues = () => ({ ...createDefaultConfig(), ...defaults?.config });
  const defaultSettingValues = () => ({ ...defaultSettings(), ...pickValidSettings(defaults?.settings) });
  function applyDefaults() {
    engine.updateConfig(defaultConfigValues());
    Object.assign(settings, defaultSettingValues());
  }
  applyDefaults();

  // Restore what /admin set before the last restart. Every value goes through
  // the same validation as an /admin message; anything invalid is skipped.
  if (savedSettings) {
    const accepted = engine.updateConfig(savedSettings.config);
    const valid = pickValidSettings(savedSettings.settings);
    Object.assign(settings, valid);
    // Saved before the skill weights: its one skill becomes the only weight.
    const oldSkill = savedSettings.settings?.botSkill;
    if (BOT_SKILLS.includes(oldSkill) && !BOT_SKILLS.some((k) => botWeightKey(k) in valid)) {
      for (const k of BOT_SKILLS) settings[botWeightKey(k)] = k === oldSkill ? 1 : 0;
    }
    log(`[settings] restored ${Object.keys(accepted).length} config values and ${Object.keys(valid).length} settings`);
  }
  const settingsSnapshot = () => ({ version: SETTINGS_VERSION, config: { ...config }, settings: structuredClone(settings) });
  let lastSaved = JSON.stringify(settingsSnapshot());
  // Saves only when something actually changed.
  function persistSettings() {
    const snapshot = settingsSnapshot();
    const text = JSON.stringify(snapshot);
    if (text === lastSaved) return;
    lastSaved = text;
    try {
      saveSettings(snapshot);
    } catch (err) {
      log(`[settings] could not save: ${err.message}`);
    }
  }
  // Cached: recomputed only when the records change.
  let recordsView = records.top();
  let recordCounts = records.counts();
  const refreshRecords = () => {
    recordsView = records.top();
    recordCounts = records.counts();
  };
  let paused = false;
  let nextPlayerNumber = 1;
  let timer = null;

  const clients = new Set();
  const owners = new Map(); // playerId -> { client, slot, source, session }

  // ---- outgoing ------------------------------------------------------------

  function safeSend(client, msg) {
    try {
      client.send(msg);
    } catch (err) {
      log(`[game] send failed: ${err.message}`);
    }
  }

  const recordsOn = () => settings.leaderboard;

  const sideNav = (state) => (settings.displayButtons ? sidePanelNav(settings.sidePanel, state, recordsOn()) : null);

  function displayMessage(state) {
    return {
      t: 'state',
      state,
      paused,
      sidePanel: resolveSidePanel(settings.sidePanel, state, recordsOn()),
      keyboardPlayers: settings.keyboardPlayers,
      displayButtons: settings.displayButtons,
      sideNav: sideNav(state),
      tickMs: config.tickMs, // for smooth movement between ticks
      effects: Object.fromEntries(EFFECT_SETTINGS.map((k) => [k, settings[k]])),
      soundGains: settings.sounds ? soundGains(settings) : null, // sound name -> gain (master included)
      fruits: settings.fruits, // codes new apples are drawn as (none: all 🍎)
      corpseStyle: settings.corpseStyle,
      locale: settings.locale,
      hats: settings.hats ? hatsOf(state) : null, // playerId -> hat id, for players wearing one
      // bot id -> 1-3, or BOT_HIDDEN_SKILL for all of them when the levels are hidden
      botSkills: Object.fromEntries([...bots].map(([id, b]) => [id, settings.botLevels ? b.skill : BOT_HIDDEN_SKILL])),
      badgerName: settings.badgerName || null,
      records: settings.leaderboard ? recordsView : null, // { wins, kills, score }: top 10 each
      leaderboardStat: settings.leaderboardStat,
      localPlayers: null, // filled per client
    };
  }

  function adminMessage(state) {
    return {
      t: 'admin',
      phase: state.phase,
      round: state.round,
      paused,
      config: { ...config },
      limits: CONFIG_LIMITS,
      toggles: Object.keys(CONFIG_TOGGLES),
      choices: CONFIG_CHOICES,
      rules: state.rules, // the rules of the round in progress
      win: state.win, // and the numbers behind its win conditions
      settings: structuredClone(settings),
      recordCounts, // entries per stat, for the reset buttons
      players: state.players.map((p) => ({
        ...p,
        source: owners.get(p.id)?.source ?? 'unknown',
        hat: owners.get(p.id)?.hat ?? null,
        assisted: track.round === state.round && track.assisted.has(p.id),
      })),
      badgers: state.badgers.length,
      joinInfo,
    };
  }

  function hatsOf(state) {
    const out = {};
    for (const p of state.players) {
      const hat = owners.get(p.id)?.hat;
      if (hat) out[p.id] = hat;
    }
    return out;
  }

  // places: the round card's ranking (roundCardPlaces), or null for none.
  function localPlayersOf(client, state, places = null) {
    const out = {};
    for (const [slot, id] of client.owned) {
      const p = state.players.find((x) => x.id === id);
      if (!p) continue;
      const snake = state.snakes.find((x) => x.id === id);
      out[slot] = { id, name: p.name, colorIndex: p.colorIndex, status: p.status, dir: snake?.dir ?? null };
      // Between rounds, for those who played it: how their round went.
      if (places?.has(id)) out[slot].card = { place: places.get(id), length: p.length, kills: p.kills };
    }
    return out;
  }

  // The round card's places, while it shows: during the intermission. Taken once as the round ends and kept for the whole
  // break, so someone leaving (or the bots being refreshed) moves nobody up.
  let cardPlaces = { round: null, places: null };
  function roundCardPlaces(state) {
    if (state.phase !== PHASES.INTERMISSION) return null;
    if (cardPlaces.round !== state.round) cardPlaces = { round: state.round, places: roundPlaces(state.players, state.winnerId) };
    return cardPlaces.places;
  }

  function broadcast() {
    const state = engine.getState();
    const display = displayMessage(state);
    const admin = adminMessage(state);
    const places = roundCardPlaces(state);
    for (const c of clients) {
      if (c.role === 'display') safeSend(c, { ...display, localPlayers: localPlayersOf(c, state) });
      else if (c.role === 'admin') safeSend(c, admin);
      else if (c.role === 'player') safeSend(c, { t: 'me', locale: settings.locale, phase: state.phase, round: state.round, paused, players: localPlayersOf(c, state, places) });
    }
  }

  // ---- tick loop -------------------------------------------------------------

  // ---- records ------------------------------------------------------------------
  // Whether a round counts for the global leaderboard is decided when it
  // starts, so toggling it mid-round applies from the next round.
  // assisted: ids of players given help from /admin this round (see handleAdmin).
  let track = { round: 0, counting: false, best: new Map(), assisted: new Set(), done: true };

  function commitRound(winnerId) {
    if (track.done) return;
    track.done = true;
    if (!track.counting) return;
    try {
      const played = [...track.best.entries()];
      const changed = records.recordRound({
        winner: winnerId ? (track.best.get(winnerId)?.name ?? null) : null, // null for a bot (not tracked)
        kills: played.map(([, { name, kills }]) => ({ name, kills })),
        // An assisted snake's length (grown or powered up from /admin) isn't a record.
        lengths: played.filter(([id]) => !track.assisted.has(id)).map(([, { name, length }]) => ({ name, length })),
      });
      if (changed) refreshRecords();
    } catch (err) {
      log(`[records] could not record round ${track.round}: ${err.message}`);
    }
  }

  // Called after every tick and around an admin restart.
  function observeRound() {
    const state = engine.getState();
    if (state.round !== track.round) {
      commitRound(null); // a round abandoned by a restart: lengths and kills count, no win
      track = {
        round: state.round,
        counting: settings.leaderboard,
        best: new Map(), // playerId -> { name, length, kills }, kept for players who leave mid-round
        assisted: new Set(),
        done: false,
      };
    }
    if (track.done) return;
    for (const p of state.players) {
      if (p.status === 'queued' || p.bot) continue; // bots are never recorded
      const best = track.best.get(p.id);
      track.best.set(p.id, {
        name: p.name,
        length: Math.max(best?.length ?? 0, p.length),
        kills: Math.max(best?.kills ?? 0, p.kills), // kills only grow during a round
      });
    }
    if (state.phase === PHASES.INTERMISSION || state.phase === PHASES.WAITING) commitRound(state.winnerId);
  }

  // ---- bots -------------------------------------------------------------------
  // Computer players: engine players with { bot: true }, owned by no client.
  // They join and leave only between rounds (or at a restart); the brain
  // steers them right before each tick.
  const bots = new Map(); // playerId -> { n: 1, 2... in joining order, skill: 1-3, reserved: playing a reserved profile }
  let nextBotId = 1;
  const thinkStats = { samples: [] }; // ms per think, last TICK_WINDOW

  // A shuffled copy of `list` (Fisher-Yates, with the game's random).
  function shuffled(list) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }

  // `now`: whatever the phase (right before a restart, which respawns
  // everyone; a bot added mid-round would only be queued).
  // Every round the bots are refreshed: they all leave and the right number
  // join again. They take reserved profiles first (a random pick of them,
  // skipping any whose name a person is using), then Bot 1, Bot 2..., each
  // of those with a newly picked hat.
  function syncBots({ now = false } = {}) {
    const state = engine.getState();
    // During the intermission only on its last tick, so the winner (maybe a
    // bot) stays on the scoreboard until then.
    const lastBreak = state.phase === PHASES.INTERMISSION && state.intermissionRemainingMs <= config.tickMs;
    if (!now && state.phase !== PHASES.WAITING && !lastBreak) return;
    const people = state.players.filter((p) => !p.bot).length;
    const target = botTarget(settings, people);
    if (!target && !bots.size) return;
    for (const id of [...bots.keys()]) removeOwnedPlayer(id);
    const taken = new Set(state.players.filter((p) => !p.bot).map((p) => nameKey(p.name)));
    const profiles = shuffled(settings.reservedBots.filter((b) => !taken.has(nameKey(b.name))));
    let generic = 0;
    for (let n = 1; n <= target; n++) {
      const id = `b${nextBotId++}`;
      const profile = profiles[n - 1] ?? null;
      const name = profile ? profile.name : botName(++generic);
      if (!engine.addPlayer(id, name, { bot: true }).ok) break;
      bots.set(id, { n, skill: pickBotSkill(settings, random), reserved: Boolean(profile) });
      // A reserved profile's hat; otherwise a random hat, or none, kept while it stays.
      const choices = [null, ...HAT_IDS];
      const hat = profile ? profile.hat : choices[Math.floor(random() * choices.length)];
      owners.set(id, { client: null, slot: null, source: 'bot', session: null, hat });
    }
    log(`[bots] ${bots.size} this round`);
  }

  // A "Bot N" leaves before a reserved one, the lowest-numbered first (the
  // next round renumbers them).
  function removeBot() {
    const [id] = [...bots].sort((a, b) => a[1].reserved - b[1].reserved || a[1].n - b[1].n)[0];
    removeOwnedPlayer(id);
    log(`[bots] ${id} left to make room`);
  }

  // A person joining a board that already has 24 snakes: a bot leaves at
  // once (even mid-round) and the person takes its place and color.
  function makeRoomForPerson() {
    const people = engine.getState().players.filter((p) => !p.bot).length;
    if (people >= config.maxPlayers) return; // they won't get in anyway
    if (bots.size && bots.size + people + 1 > MAX_SNAKES) removeBot();
  }

  function steerBots() {
    if (!bots.size) return;
    const started = performance.now();
    const skills = new Map([...bots].map(([id, b]) => [id, b.skill]));
    const dirs = brain.think(engine.getState(), [...bots.keys()], { skills, bombMode: config.bombMode });
    queueBotMoves(engine.setDirection, dirs, brain.secondMoves());
    thinkStats.samples.push(performance.now() - started);
    if (thinkStats.samples.length > TICK_WINDOW) thinkStats.samples.shift();
  }

  function tickOnce() {
    if (!paused) {
      try {
        syncBots();
        steerBots();
      } catch (err) {
        // The bots must never stop the game itself.
        log(`[bots] failed: ${err.stack ?? err}`);
      }
      engine.tick();
      observeRound();
    }
    broadcast();
  }

  // Tick timing for /health: intervals between the last TICK_WINDOW loop runs.
  const TICK_WINDOW = 100;
  const tickStats = { count: 0, last: null, intervals: [], errors: 0 };
  function recordTick() {
    const now = performance.now();
    if (tickStats.last !== null) {
      tickStats.intervals.push(now - tickStats.last);
      if (tickStats.intervals.length > TICK_WINDOW) tickStats.intervals.shift();
    }
    tickStats.last = now;
    tickStats.count++;
  }

  function health() {
    const state = engine.getState();
    const iv = tickStats.intervals;
    const round1 = (n) => Math.round(n * 10) / 10;
    const mean = iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : null;
    const think = thinkStats.samples;
    return {
      phase: state.phase,
      round: state.round,
      paused,
      players: state.players.filter((p) => !p.bot).length, // people only
      bots: {
        count: bots.size,
        thinkMeanMs: think.length ? round1(think.reduce((a, b) => a + b, 0) / think.length) : null,
        thinkMaxMs: think.length ? round1(Math.max(...think)) : null,
      },
      alive: state.players.filter((p) => p.status === 'alive').length,
      connections: clients.size,
      tick: {
        configuredMs: config.tickMs,
        count: tickStats.count,
        meanMs: mean === null ? null : round1(mean),
        maxMs: iv.length ? round1(Math.max(...iv)) : null,
        ticksPerSec: mean ? round1(1000 / mean) : null,
        sinceLastMs: tickStats.last === null ? null : Math.round(performance.now() - tickStats.last),
        errors: tickStats.errors,
      },
    };
  }

  function start() {
    if (timer) return;
    let next = Date.now() + config.tickMs;
    const loop = () => {
      recordTick();
      try {
        tickOnce();
      } catch (err) {
        tickStats.errors++;
        log(`[game] tick failed: ${err.stack ?? err}`);
      }
      // config.tickMs is read every tick, so speed changes apply at once.
      next = Math.max(next + config.tickMs, Date.now());
      timer = setTimeout(loop, next - Date.now());
    };
    timer = setTimeout(loop, config.tickMs);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  // ---- players ---------------------------------------------------------------

  function addOwnedPlayer(client, slot, name, source, session = null, hat = null) {
    if (client.owned.has(slot)) return { ok: true, already: true };
    makeRoomForPerson();
    const id = `p${nextPlayerNumber++}`;
    const result = engine.addPlayer(id, name);
    if (!result.ok) return result;
    client.owned.set(slot, id);
    owners.set(id, { client, slot, source, session, hat });
    log(`[game] ${id} joined (${source}${slot === SELF ? '' : ` ${slot}`})`);
    return { ok: true, id, name, colorIndex: result.colorIndex };
  }

  function removeOwnedPlayer(id) {
    const owner = owners.get(id);
    if (owner) {
      owner.client?.owned.delete(owner.slot);
      owners.delete(id);
    }
    bots.delete(id); // a kicked bot (the next sync may bring one back)
    return engine.removePlayer(id);
  }

  function kick(id) {
    const owner = owners.get(id);
    if (!removeOwnedPlayer(id)) return false;
    if (owner?.client) safeSend(owner.client, { t: 'kicked', slot: owner.slot });
    log(`[game] ${id} kicked by admin`);
    return true;
  }

  // Phone name rules. Returns an error code, or null if the name is fine.
  // `ownId` is excluded from the uniqueness check (a reconnecting player).
  function nameProblem(name, ownId) {
    if (!name) return 'nameEmpty';
    if (BOT_NAME_PATTERN.test(name)) return 'nameTaken'; // reserved for bots
    if (wordList.matches(name)) return 'nameProfane';
    const key = nameKey(name);
    const taken = engine.getState().players.some((p) => p.id !== ownId && nameKey(p.name) === key);
    return taken ? 'nameTaken' : null;
  }

  // The phone player that belongs to this session token, if any.
  function playerOfSession(session) {
    if (!session) return null;
    for (const [id, o] of owners) if (o.session === session) return id;
    return null;
  }

  // A device rejoining (e.g. after its wifi dropped before the server noticed)
  // replaces its old player instead of being told its own name is taken.
  function replaceStale(id) {
    const old = owners.get(id);
    removeOwnedPlayer(id);
    if (!old) return;
    safeSend(old.client, { t: 'replaced' });
    try {
      old.client.close(4000, 'replaced');
    } catch {
      /* already closed */
    }
    log(`[game] ${id} replaced by a new connection from the same device`);
  }

  function joinPhone(client, msg) {
    if (client.owned.has(SELF)) return; // already playing on this connection
    const name = sanitizeName(msg.name);
    const session = typeof msg.session === 'string' && SESSION_PATTERN.test(msg.session) ? msg.session : null;
    const previous = playerOfSession(session);
    const problem = nameProblem(name, previous);
    if (problem) return safeSend(client, { t: 'error', code: problem, slot: SELF });
    if (previous) replaceStale(previous);
    const result = addOwnedPlayer(client, SELF, name, 'phone', session, validHat(msg.hat)); // unknown hat: none
    if (!result.ok) return safeSend(client, { t: 'error', code: result.reason === 'full' ? 'full' : 'badMessage', slot: SELF });
    safeSend(client, { t: 'joined', slot: SELF, id: result.id, name: result.name, colorIndex: result.colorIndex });
    broadcast();
  }

  function sendWords(client) {
    safeSend(client, { t: 'words', words: wordList.words() });
  }

  function broadcastWords() {
    for (const c of clients) if (c.role === 'admin') sendWords(c);
  }

  // ---- incoming --------------------------------------------------------------

  function slotFor(client, msg) {
    if (client.role === 'display') return KEYBOARD_SLOTS.includes(msg.slot) ? msg.slot : null;
    if (client.role === 'player') return SELF;
    return null;
  }

  function handlePublic(client, msg) {
    switch (msg.t) {
      case 'hello': {
        // Role is chosen once; display and player are the only public roles.
        if (client.helloDone) return;
        if (msg.role === 'display' || msg.role === 'player') client.role = msg.role;
        client.helloDone = true;
        if (client.role === 'display') safeSend(client, { t: 'joinInfo', joinInfo });
        broadcast();
        return;
      }
      case 'join': {
        const slot = slotFor(client, msg);
        if (!slot) return badMessage(client);
        if (slot === SELF) return joinPhone(client, msg);
        if (!settings.keyboardPlayers) return safeSend(client, { t: 'error', code: 'keyboardDisabled' });
        // In the language of the moment: the name stays as it was when they joined.
        const T = stringsFor(settings.locale).display;
        const name = slot === 'wasd' ? T.keyboardWasd : T.keyboardArrows;
        const result = addOwnedPlayer(client, slot, name, 'keyboard');
        if (!result.ok) return safeSend(client, { t: 'error', code: result.reason === 'full' ? 'full' : 'badMessage', slot });
        if (!result.already) safeSend(client, { t: 'joined', slot, id: result.id, name, colorIndex: result.colorIndex });
        broadcast();
        return;
      }
      case 'dir': {
        const slot = slotFor(client, msg);
        const id = slot && client.owned.get(slot);
        if (!id) return; // not your player: ignore silently
        engine.setDirection(id, msg.dir); // engine validates the direction itself
        return;
      }
      case 'leave': {
        const slot = slotFor(client, msg);
        const id = slot && client.owned.get(slot);
        if (id) {
          removeOwnedPlayer(id);
          broadcast();
        }
        return;
      }
      case 'sidePanel': {
        // Only to a mode the ← / → buttons currently offer.
        if (client.role !== 'display') return badMessage(client);
        const nav = sideNav(engine.getState());
        if (!nav || typeof msg.mode !== 'string' || ![nav.prev?.mode, nav.next?.mode].includes(msg.mode)) {
          return badMessage(client);
        }
        settings.sidePanel = msg.mode;
        log(`[display] side panel -> ${msg.mode}`);
        persistSettings();
        broadcast();
        return;
      }
      default:
        return badMessage(client);
    }
  }

  function handleAdmin(client, msg) {
    switch (msg.t) {
      case 'config': {
        if (!msg.values || typeof msg.values !== 'object' || Array.isArray(msg.values)) return badMessage(client);
        const accepted = engine.updateConfig(msg.values); // clamps and drops unknown keys
        if (Object.keys(accepted).length) log(`[admin] config ${JSON.stringify(accepted)}`);
        break;
      }
      case 'pause':
        paused = true;
        break;
      case 'resume':
        paused = false;
        break;
      case 'restart':
        observeRound(); // capture the lengths reached so far
        syncBots({ now: true }); // a restart is between rounds too
        engine.restartRound();
        observeRound();
        log('[admin] round restarted');
        break;
      case 'kick':
        if (typeof msg.id !== 'string' || !kick(msg.id)) return badMessage(client);
        break;
      case 'settings': {
        const changes = validSettingsOrNull(msg); // all or nothing
        if (!changes) return badMessage(client);
        Object.assign(settings, changes);
        if (changes.keyboardPlayers === false) kickKeyboardPlayers();
        break;
      }
      // Every config value and setting back to its default, applied like any
      // other /admin change: live values at once, round rules (and the grid
      // size) from the next round. Records, banned words, the server config
      // and sessions are not settings, so they're left alone.
      case 'resetSettings': {
        const { locale } = settings; // the language isn't a game setting: it stays
        applyDefaults();
        settings.locale = locale;
        kickKeyboardPlayers(); // keyboard players are off by default
        log('[admin] all settings reset to defaults');
        break;
      }
      // One category of /admin (or the power-up weights) back to its
      // defaults, the same ones the full reset uses.
      case 'resetCategory': {
        if (typeof msg.category !== 'string' || !Object.hasOwn(RESET_GROUPS, msg.category)) return badMessage(client);
        const group = RESET_GROUPS[msg.category];
        const config = defaultConfigValues();
        const values = defaultSettingValues();
        engine.updateConfig(Object.fromEntries((group.config ?? []).map((k) => [k, config[k]])));
        for (const k of group.settings ?? []) settings[k] = structuredClone(values[k]);
        if (!settings.keyboardPlayers) kickKeyboardPlayers();
        log(`[admin] ${msg.category} reset to defaults`);
        break;
      }
      case 'resetRecords':
        if (!RESET_TARGETS.includes(msg.stat) || !records.reset(msg.stat)) return badMessage(client);
        refreshRecords();
        log(`[admin] records reset: ${msg.stat}`);
        break;
      case 'addWord': {
        const result = wordList.add(msg.word);
        if (!result.ok) return safeSend(client, { t: 'error', code: `word_${result.reason}` });
        log('[admin] banned word added');
        return broadcastWords();
      }
      case 'removeWord':
        if (!wordList.remove(msg.word)) return badMessage(client);
        log('[admin] banned word removed');
        return broadcastWords();
      // Regia: one-shot match controls, applied on the next tick (see the
      // engine's command()). Giving a snake length or a power-up marks it
      // assisted for the round: its length then isn't a score record.
      case 'spawn':
      case 'removeBadger':
      case 'grow':
      case 'givePowerUp':
      case 'smite': {
        const kind = msg.t === 'givePowerUp' ? 'powerUp' : msg.t;
        if (paused || !engine.command({ kind, item: msg.item, id: msg.id, amount: msg.amount })) return badMessage(client);
        if (kind === 'grow' || kind === 'powerUp') track.assisted.add(msg.id);
        log(`[admin] ${msg.t}${typeof msg.item === 'string' ? ` ${msg.item}` : ''}${typeof msg.id === 'string' ? ` -> ${msg.id}` : ''}`);
        return broadcast();
      }
      default:
        return badMessage(client);
    }
    persistSettings();
    broadcast();
  }

  function kickKeyboardPlayers() {
    for (const [id, o] of [...owners]) if (o.source === 'keyboard') kick(id);
  }

  function badMessage(client) {
    safeSend(client, { t: 'error', code: 'badMessage' });
  }

  // Rate limit per client: excess messages in a one-second window are dropped.
  function allow(client) {
    const now = Date.now();
    if (now - client.windowStart >= 1000) {
      client.windowStart = now;
      client.windowCount = 0;
    }
    return ++client.windowCount <= MAX_MESSAGES_PER_SECOND;
  }

  /**
   * Registers a connection.
   * @param {object} io { send(obj), close(code, reason) }
   * @param {object} [opts]
   * @param {boolean} [opts.admin] admin connection (already authenticated at handshake)
   * @param {() => boolean} [opts.isAuthorized] re-checked on every admin message
   */
  function connect(io, { admin = false, isAuthorized = () => false } = {}) {
    const client = {
      send: io.send,
      close: io.close,
      role: admin ? 'admin' : 'player',
      helloDone: admin,
      owned: new Map(), // slot -> playerId
      windowStart: 0,
      windowCount: 0,
    };
    clients.add(client);
    if (admin) {
      safeSend(client, adminMessage(engine.getState()));
      sendWords(client);
    }

    return {
      message(raw) {
        try {
          if (!allow(client)) return;
          if (admin && !isAuthorized()) {
            safeSend(client, { t: 'unauthorized' });
            client.close(4401, 'unauthorized');
            return;
          }
          let msg;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return badMessage(client);
          }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return badMessage(client);
          if (admin) handleAdmin(client, msg);
          else handlePublic(client, msg);
        } catch (err) {
          log(`[game] message handling failed: ${err.stack ?? err}`);
        }
      },
      disconnect() {
        clients.delete(client);
        let removed = false;
        for (const id of [...client.owned.values()]) removed = removeOwnedPlayer(id) || removed;
        if (removed) broadcast();
      },
    };
  }

  return { engine, config, settings, wordList, records, connect, start, stop, tickOnce, health, isPaused: () => paused };
}
