// /admin control panel. Every action goes over the admin WebSocket, which the
// server only accepts with a valid session cookie (and re-checks per message).

import { STRINGS, fmt } from '/shared/strings.js';
import { playerColor } from '/shared/colors.js';
import { POWER_UPS, WEIGHTED_POWER_UPS, weightKey } from '/shared/powerups.js';
import { FRUITS, FRUIT_CODES, APPLE_FRUIT } from '/shared/fruits.js';
import { HATS } from '/shared/hats.js';
import { BOT_LIMITS, BOT_SKILLS, BOT_SKILL_EMOJI, MAX_RESERVED_BOTS, botWeightKey, reservedNameProblem } from '/shared/bots.js';
import { MAX_NAME_LENGTH } from '/shared/limits.js';
import { cleanName } from '/shared/names.js';
import { SOUND_LIMITS, VOLUME_SLIDERS, soundVolumeKey } from '/shared/sounds.js';

const A = STRINGS.admin;
const $ = (id) => document.getElementById(id);

// parent: the element the slider goes in (default: the Settings category).
// label: shown instead of A[key].
const SLIDERS = [
  { key: 'tickMs', step: 10 },
  { key: 'appleCount', step: 1 },
  { key: 'growthPerApple', step: 1 },
  { key: 'maxPlayers', step: 1 },
  { key: 'gridSize', step: 1 },
  { key: 'countdownMs', step: 500 },
  { key: 'spawnShieldSec', step: 1 },
  { key: 'intermissionMs', step: 500 },
  { key: 'roundTimeLimitSec', step: 15, parent: 'sliders-time' },
  { key: 'targetLength', step: 1, parent: 'sliders-target' },
  { key: 'powerUpChance', step: 5, parent: 'sliders-powerups' },
  { key: 'ratChance', step: 1, parent: 'sliders-creatures' },
  { key: 'chickenChance', step: 1, parent: 'sliders-creatures' },
  { key: 'badgerEverySec', step: 30, parent: 'sliders-creatures' },
  { key: 'badgerLifetimeSec', step: 5, parent: 'sliders-creatures' },
  { key: 'badgerHealth', step: 1, parent: 'sliders-creatures' },
  { key: 'bombsPerMinute', step: 1, parent: 'sliders-bombs' },
  // Server settings, not engine config.
  { key: 'bots', step: 1, parent: 'sliders-bots', kind: 'settings' },
  // One weight per bot skill.
  ...BOT_SKILLS.map((k) => ({ key: botWeightKey(k), step: 1, parent: 'sliders-bot-weights', kind: 'settings', label: `${BOT_SKILL_EMOJI[k]} ${A.botWeights[k]}` })),
  // One weight slider per power-up, generated from the shared list.
  // Sounds: a master volume, then one per sound.
  { key: 'soundVolume', step: 5, parent: 'sliders-sound-master', kind: 'settings' },
  ...VOLUME_SLIDERS.map((n) => ({ key: soundVolumeKey(n), step: 5, parent: 'sliders-sound-volumes', kind: 'settings', label: A.soundNames[n] ?? n })),
  ...WEIGHTED_POWER_UPS.map((p) => ({
    key: weightKey(p.type),
    step: 1,
    parent: 'sliders-weights',
    label: `${p.emoji} ${A.powerUpNames[p.type] ?? p.type}`,
  })),
];
const RESET_STATS = ['wins', 'kills', 'score', 'all'];

// ---- static text ----------------------------------------------------------------
document.title = `${STRINGS.appName} – ${A.title}`;
$('title').textContent = `${STRINGS.appName} – ${A.title}`;
$('logout').textContent = A.logout;
$('h-game').textContent = A.game;
$('btn-restart').textContent = A.restartRound;
$('btn-reset-settings').textContent = A.resetSettings;
$('h-settings').textContent = A.settings;
$('h-display').textContent = A.display;
$('l-side').textContent = A.sidePanel;
$('side-hint').textContent = A.sidePanelAutoHint;
$('side-records-off').textContent = A.sidePanelRecordsOff;
$('l-keyboard').textContent = A.keyboardPlayers;
$('h-rules').textContent = A.rules;
$('rules-hint').textContent = A.rulesHint;
$('h-win').textContent = A.winConditions;
$('win-hint').textContent = A.winHint;
$('l-timeLimitWinner').textContent = A.timeLimitWinner;
$('l-bombMode').textContent = A.bombMode;
$('h-global').textContent = A.globalLeaderboard;
$('l-leaderboardStat').textContent = A.leaderboardStat;
$('l-corpseStyle').textContent = A.corpseStyle;
for (const stat of RESET_STATS) $(`btn-reset-${stat}`).textContent = A.reset[stat];
$('h-powerups').textContent = A.powerUpsTitle;
$('powerups-hint').textContent = A.powerUpsHint;
$('h-weights').textContent = A.weightsTitle;
$('weights-hint').textContent = A.weightsHint;
$('h-effects').textContent = A.effects;
$('h-bots').textContent = A.botsTitle;
$('bots-hint').textContent = A.botsHint;
$('bot-weights-hint').textContent = A.botWeightsHint;
$('effects-hint').textContent = A.effectsHint;
$('h-sounds').textContent = A.soundsTitle;
$('sounds-hint').textContent = A.soundsHint;
$('h-sound-volumes').textContent = A.soundVolumesTitle;
$('sound-volumes-hint').textContent = A.soundVolumesHint;
$('h-creatures').textContent = A.creaturesTitle;
$('creatures-hint').textContent = A.creaturesHint;
$('h-bombs').textContent = A.bombsTitle;
$('bombs-hint').textContent = A.bombsHint;

// Categories: collapsible, and remembered per browser. Storage can be
// missing or blocked; the page works the same without it (all open).
const COLLAPSED_KEY = 'snake-battle.admin.collapsed';
let collapsed = new Set();
try {
  collapsed = new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]'));
} catch {
  /* all open */
}
for (const cat of document.querySelectorAll('details.card')) {
  if (collapsed.has(cat.id)) cat.open = false;
  cat.addEventListener('toggle', () => {
    if (cat.open) collapsed.delete(cat.id);
    else collapsed.add(cat.id);
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* not remembered */
    }
  });
}

// Engine rules go through 'config'; the records and effects toggles are server settings.
const RULE_TOGGLES = {
  corpseApples: 'config',
  displayButtons: 'settings',
  hats: 'settings',
  wrapWalls: 'config',
  timeLimitWin: 'config',
  targetLengthWin: 'config',
  lastPersonWins: 'config',
  powerUps: 'config',
  leaderboard: 'settings',
  botFill: 'settings',
  botLevels: 'settings',
  particles: 'settings',
  screenShake: 'settings',
  snakeAnimations: 'settings',
  killPopups: 'settings',
  sounds: 'settings',
};
for (const [key, kind] of Object.entries(RULE_TOGGLES)) {
  $(`l-${key}`).textContent = A[key];
  $(`t-${key}`).addEventListener('change', (e) => {
    const value = e.target.checked;
    send(kind === 'config' ? { t: 'config', values: { [key]: value } } : { t: 'settings', [key]: value });
  });
}
// Fruits: one checkbox each, plus the "all" / "apple only" shortcuts. Every
// change sends the whole list of ticked ones.
$('h-fruits').textContent = A.fruitsTitle;
$('fruits-hint').textContent = A.fruitsHint;
$('fruits-all').textContent = A.fruitsAll;
$('fruits-apple').textContent = A.fruitsAppleOnly;
const fruitBoxes = new Map(); // code -> checkbox
for (const f of FRUITS) {
  const label = document.createElement('label');
  label.className = 'check';
  label.title = A.fruitNames[f.code] ?? f.code;
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.setAttribute('aria-label', label.title);
  box.addEventListener('change', () => sendFruits(FRUIT_CODES.filter((c) => fruitBoxes.get(c).checked)));
  label.append(box, document.createTextNode(f.emoji));
  $('fruit-grid').append(label);
  fruitBoxes.set(f.code, box);
}
const sendFruits = (fruits) => send({ t: 'settings', fruits });
$('fruits-all').addEventListener('click', () => sendFruits([...FRUIT_CODES]));
$('fruits-apple').addEventListener('click', () => sendFruits([APPLE_FRUIT]));
$('h-players').textContent = A.players;
$('c-name').textContent = A.colName;
$('c-status').textContent = A.colStatus;
$('c-length').textContent = A.colLength;
$('c-kills').textContent = A.colKills;
$('c-source').textContent = A.colSource;
$('c-hat').textContent = A.colHat;
$('no-players').textContent = A.noPlayers;
$('h-links').textContent = A.links;
$('h-words').textContent = A.words;
$('words-hint').textContent = A.wordsHint;
$('word-input').placeholder = A.wordPlaceholder;
$('word-add').textContent = A.addWord;
$('credits').textContent = A.credits;

function fillSelect(select, options) {
  for (const [value, label] of Object.entries(options)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    select.append(opt);
  }
}
fillSelect($('side-panel'), A.sidePanelOptions);
fillSelect($('leaderboard-stat'), A.leaderboardStatOptions);
fillSelect($('s-corpseStyle'), A.corpseStyleOptions);
fillSelect($('c-timeLimitWinner'), A.timeLimitWinnerOptions);
fillSelect($('c-bombMode'), A.bombModeOptions);

// ---- connection -----------------------------------------------------------------
let ws = null;
let latest = null;

function setConnected(ok, text) {
  $('conn-dot').classList.toggle('ok', ok);
  $('conn-text').textContent = text ?? (ok ? A.connected : A.disconnected);
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws/admin`);
  let sessionGone = false;
  ws.onopen = () => setConnected(true);
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.t === 'admin') update(msg);
    else if (msg.t === 'words') renderWords(msg.words);
    else if (msg.t === 'error' && A.wordErrors[msg.code]) $('word-error').textContent = A.wordErrors[msg.code];
    else if (msg.t === 'unauthorized') sessionGone = true;
  };
  ws.onclose = async () => {
    ws = null;
    // A rejected handshake or 'unauthorized' means the session is gone: go log in again.
    const probe = sessionGone ? null : await fetch('/admin/api/info', { cache: 'no-store' }).catch(() => null);
    if (sessionGone || probe?.status === 401) {
      setConnected(false, A.sessionExpired);
      setTimeout(() => location.assign('/admin/login'), 1200);
      return;
    }
    setConnected(false);
    setTimeout(connect, 1000);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// ---- controls -----------------------------------------------------------------
$('btn-pause').addEventListener('click', () => send({ t: latest?.paused ? 'resume' : 'pause' }));
$('btn-restart').addEventListener('click', () => {
  if (confirm(A.confirmRestart)) send({ t: 'restart' });
});
$('btn-reset-settings').addEventListener('click', () => {
  if (confirm(A.confirmResetSettings)) send({ t: 'resetSettings' });
});
$('side-panel').addEventListener('change', (e) => {
  send({ t: 'settings', sidePanel: e.target.value });
  e.target.blur(); // so changes made from /display show up here too
});
$('keyboard').addEventListener('change', (e) => send({ t: 'settings', keyboardPlayers: e.target.checked }));
$('leaderboard-stat').addEventListener('change', (e) => {
  send({ t: 'settings', leaderboardStat: e.target.value });
  e.target.blur();
});
$('s-corpseStyle').addEventListener('change', (e) => {
  send({ t: 'settings', corpseStyle: e.target.value });
  e.target.blur();
});
for (const key of ['timeLimitWinner', 'bombMode']) {
  $(`c-${key}`).addEventListener('change', (e) => {
    send({ t: 'config', values: { [key]: e.target.value } });
    e.target.blur();
  });
}
for (const stat of RESET_STATS) {
  $(`btn-reset-${stat}`).addEventListener('click', () => {
    if (confirm(A.confirmReset[stat])) send({ t: 'resetRecords', stat });
  });
}

const sliderEls = {};
let slidersBuilt = false;

function buildSliders(limits) {
  for (const { key, step, parent = 'sliders', label: text, kind = 'config' } of SLIDERS) {
    const lim = kind === 'settings' ? (BOT_LIMITS[key] ?? SOUND_LIMITS[key]) : limits[key];
    if (!lim) continue;
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const label = document.createElement('label');
    label.htmlFor = `s-${key}`;
    label.textContent = text ?? A[key];
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `s-${key}`;
    input.min = lim.min;
    input.max = lim.max;
    input.step = step;
    const output = document.createElement('output');
    const range = document.createElement('div');
    range.className = 'range';
    range.textContent = `${lim.min} – ${lim.max}`;
    let timer = null;
    input.addEventListener('input', () => {
      output.textContent = input.value;
      clearTimeout(timer);
      const value = Number(input.value);
      timer = setTimeout(() => send(kind === 'settings' ? { t: 'settings', [key]: value } : { t: 'config', values: { [key]: value } }), 80);
    });
    wrap.append(label, input, output, range);
    $(parent).append(wrap);
    sliderEls[key] = { input, output, kind };
    if (key === 'badgerHealth') $(parent).append(badgerNameField());
  }
  slidersBuilt = true;
}

// The badger's boss name: a text field, sent as it's typed (the server
// cleans it and caps it at 20 characters).
function badgerNameField() {
  const label = document.createElement('label');
  label.className = 'field badger-name';
  const text = document.createElement('span');
  text.textContent = A.badgerName;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = 's-badgerName';
  input.maxLength = 20;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.placeholder = A.badgerNamePlaceholder;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => send({ t: 'settings', badgerName: input.value }), 300);
  });
  label.append(text, input);
  return label;
}

// ---- rendering ------------------------------------------------------------------
let lastPlayersKey = '';

function update(msg) {
  latest = msg;
  if (!slidersBuilt) buildSliders(msg.limits);

  $('phase').textContent = (A.phase[msg.phase] ?? msg.phase) + (msg.paused ? A.pausedSuffix : '');
  $('round').textContent = msg.round > 0 ? `${A.round} ${msg.round}` : '';
  $('btn-pause').textContent = msg.paused ? A.resume : A.pause;

  for (const [key, { input, output, kind }] of Object.entries(sliderEls)) {
    // Don't fight the user while they're dragging.
    if (document.activeElement === input) continue;
    const value = kind === 'settings' ? msg.settings[key] : msg.config[key];
    input.value = value;
    output.textContent = value;
  }
  if (document.activeElement !== $('side-panel')) $('side-panel').value = msg.settings.sidePanel;
  const badgerName = $('s-badgerName');
  if (badgerName && document.activeElement !== badgerName) badgerName.value = msg.settings.badgerName ?? '';
  $('keyboard').checked = msg.settings.keyboardPlayers;
  // "Record" with both records toggles off falls back to the scoreboard: say why.
  $('side-records-off').hidden = !(msg.settings.sidePanel === 'records' && !msg.settings.leaderboard);
  if (document.activeElement !== $('leaderboard-stat')) $('leaderboard-stat').value = msg.settings.leaderboardStat;
  if (document.activeElement !== $('s-corpseStyle')) $('s-corpseStyle').value = msg.settings.corpseStyle;
  $('corpse-settings').classList.toggle('off', !msg.config.corpseApples);
  renderReservedBots(msg.settings.reservedBots);
  for (const key of ['timeLimitWinner', 'bombMode']) {
    if (document.activeElement !== $(`c-${key}`)) $(`c-${key}`).value = msg.config[key];
  }
  // The settings of a win condition only matter while it is on.
  $('sliders-time').parentElement.classList.toggle('off', !msg.config.timeLimitWin);
  $('sliders-target').parentElement.classList.toggle('off', !msg.config.targetLengthWin);
  $('powerup-settings').classList.toggle('off', !msg.config.powerUps);
  $('bomb-settings').classList.toggle('off', !msg.config.powerUps); // bombs only spawn with power-ups on
  $('sound-settings').classList.toggle('off', !msg.settings.sounds);
  for (const [key, kind] of Object.entries(RULE_TOGGLES)) {
    $(`t-${key}`).checked = Boolean(kind === 'config' ? msg.config[key] : msg.settings[key]);
  }
  const fruits = new Set(msg.settings.fruits ?? []);
  for (const [code, box] of fruitBoxes) box.checked = fruits.has(code);
  const win = msg.win ?? {};
  const activeLabel = {
    timeLimitWin: () => `${A.timeLimitWin} (${win.timeLimitSec} s, ${A.timeLimitWinnerOptions[win.timeLimitWinner]})`,
    targetLengthWin: () => `${A.targetLength} ${win.targetLength}`,
    powerUps: () => A.powerUpsTitle,
  };
  const active = Object.keys(msg.rules ?? {})
    .filter((k) => msg.rules[k])
    .map((k) => (activeLabel[k] ? activeLabel[k]() : A[k]));
  $('rules-active').textContent = msg.round > 0 ? fmt(A.activeThisRound, { list: active.length ? active.join(', ') : A.noneActive }) : '';
  const counts = msg.recordCounts ?? {};
  for (const stat of ['wins', 'kills', 'score']) $(`btn-reset-${stat}`).disabled = !counts[stat];
  $('btn-reset-all').disabled = !counts.wins && !counts.kills && !counts.score;

  const key = JSON.stringify(msg.players);
  if (key !== lastPlayersKey) {
    lastPlayersKey = key;
    renderPlayers(msg.players);
  }
  updateDirector(msg);
}

function renderPlayers(players) {
  $('no-players').hidden = players.length > 0;
  $('players').replaceChildren(
    ...players.map((p) => {
      const tr = document.createElement('tr');
      const name = document.createElement('td');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = playerColor(p.colorIndex);
      name.append(swatch, document.createTextNode(p.name)); // text node: names come from clients
      if (p.assisted) {
        const mark = document.createElement('span');
        mark.className = 'assisted';
        mark.textContent = ' 🎬';
        mark.title = A.assisted;
        name.append(mark);
      }
      const status = document.createElement('td');
      status.textContent = A.playerStatus[p.status] ?? p.status;
      const length = document.createElement('td');
      length.textContent = p.status === 'queued' ? '–' : String(p.length);
      const kills = document.createElement('td');
      kills.textContent = p.status === 'queued' ? '–' : String(p.kills ?? 0);
      const source = document.createElement('td');
      source.textContent = { keyboard: A.sourceKeyboard, bot: A.sourceBot }[p.source] ?? A.sourcePhone;
      const hat = document.createElement('td');
      const h = HATS.find((x) => x.id === p.hat);
      hat.textContent = h ? h.emoji : '–';
      if (h) hat.title = STRINGS.play.hatNames[h.id] ?? h.id;
      const actions = document.createElement('td');
      const kick = document.createElement('button');
      kick.className = 'danger';
      kick.textContent = A.kick;
      kick.addEventListener('click', () => {
        if (confirm(fmt(A.confirmKick, { name: p.name }))) send({ t: 'kick', id: p.id });
      });
      actions.append(kick);
      tr.append(name, status, length, kills, source, hat, actions);
      return tr;
    }),
  );
}

// ---- Regia: one-shot match controls -----------------------------------------
// Only while a round is being played (not paused); the server checks too.
$('h-director').textContent = A.directorTitle;
$('director-hint').textContent = A.directorHint;
$('h-director-board').textContent = A.directorBoard;
$('h-director-snake').textContent = A.directorSnake;
$('director-snake-hint').textContent = A.directorSnakeHint;
$('l-director-pick').textContent = A.directorPick;
$('btn-remove-badgers').textContent = `🦡 ${A.removeBadgers}`;
$('btn-grow').textContent = A.grow;
$('btn-smite').textContent = A.smite;
$('l-give-powerup').textContent = A.givePowerUp;

const SPAWN_ITEMS = [
  { item: 'apple', emoji: '🍎', name: A.spawnNames.apple },
  { item: 'rat', emoji: '🐀', name: A.spawnNames.rat },
  { item: 'chicken', emoji: '🐔', name: A.spawnNames.chicken },
  { item: 'bomb', emoji: '💣', name: A.spawnNames.bomb },
  { item: 'badger', emoji: '🦡', name: A.spawnNames.badger },
  ...WEIGHTED_POWER_UPS.map((p) => ({ item: p.type, emoji: p.emoji, name: A.powerUpNames[p.type] ?? p.type })),
];

const boardButtons = [];
const snakeButtons = [];
function actionButton(emoji, name, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = emoji;
  b.title = name;
  b.setAttribute('aria-label', name);
  b.addEventListener('click', onClick);
  return b;
}
for (const s of SPAWN_ITEMS) {
  const b = actionButton(s.emoji, s.name, () => send({ t: 'spawn', item: s.item }));
  boardButtons.push(b);
  $('spawn-grid').append(b);
}
for (const p of POWER_UPS) {
  const b = actionButton(p.emoji, A.powerUpNames[p.type] ?? p.type, () => {
    const id = $('director-pick').value;
    if (id) send({ t: 'givePowerUp', id, item: p.type });
  });
  snakeButtons.push(b);
  $('give-grid').append(b);
}
$('btn-remove-badgers').addEventListener('click', () => send({ t: 'removeBadger' }));
$('btn-grow').addEventListener('click', () => {
  const id = $('director-pick').value;
  if (id) send({ t: 'grow', id, amount: 5 });
});
$('btn-smite').addEventListener('click', () => {
  const pick = $('director-pick');
  const name = pick.selectedOptions[0]?.textContent ?? '';
  if (pick.value && confirm(fmt(A.confirmSmite, { name }))) send({ t: 'smite', id: pick.value });
});
snakeButtons.push($('btn-grow'), $('btn-smite'));

let lastPickKey = null;
function updateDirector(msg) {
  const live = msg.phase === 'playing' && !msg.paused;
  const alive = msg.players.filter((p) => p.status === 'alive');
  const pick = $('director-pick');
  const key = JSON.stringify(alive.map((p) => [p.id, p.name]));
  if (key !== lastPickKey) {
    lastPickKey = key;
    const chosen = pick.value;
    if (alive.length) {
      pick.replaceChildren(
        ...alive.map((p) => {
          const o = document.createElement('option');
          o.value = p.id;
          o.textContent = p.name; // textContent: names come from clients
          return o;
        }),
      );
      if (alive.some((p) => p.id === chosen)) pick.value = chosen;
    } else {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = A.noLivingSnake;
      pick.replaceChildren(o);
    }
  }
  pick.disabled = !alive.length;
  for (const b of boardButtons) b.disabled = !live;
  for (const b of snakeButtons) b.disabled = !live || !alive.length;
  $('btn-remove-badgers').disabled = !live || !msg.badgers;
}

// ---- reserved bots ----------------------------------------------------------------
// Names (and hats) bots play under before "Bot N". Every change sends the
// whole list; the server checks it again (same rules) and echoes it back.
$('h-reserved-bots').textContent = A.reservedBotsTitle;
$('reserved-bots-hint').textContent = A.reservedBotsHint;
$('reserved-name').placeholder = A.reservedBotPlaceholder;
$('reserved-name').maxLength = MAX_NAME_LENGTH;
$('reserved-add').textContent = A.reservedBotAdd;
function hatSelect(select, value) {
  const options = [[null, A.reservedBotNoHat], ...HATS.map((h) => [h.id, `${h.emoji} ${STRINGS.play.hatNames[h.id] ?? h.id}`])];
  for (const [id, label] of options) {
    const opt = document.createElement('option');
    opt.value = id ?? '';
    opt.textContent = label;
    select.append(opt);
  }
  select.value = value ?? '';
  return select;
}
hatSelect($('reserved-hat'), null);

let reservedBots = [];
let reservedShown = null; // the list as last drawn (JSON)
const reservedError = (code) => {
  $('reserved-error').textContent = code ? (A.reservedBotErrors[code] ?? '') : '';
};
// Sends `list` if every name is fine; otherwise shows why and returns false.
function sendReserved(list) {
  if (list.length > MAX_RESERVED_BOTS) {
    reservedError('full');
    return false;
  }
  for (let i = 0; i < list.length; i++) {
    const problem = reservedNameProblem(list[i].name, list.slice(0, i).map((b) => b.name));
    if (problem) {
      reservedError(problem);
      return false;
    }
  }
  reservedError(null);
  const clean = list.map((b) => ({ name: cleanName(b.name), hat: b.hat ?? null }));
  send({ t: 'settings', reservedBots: clean });
  // The next change builds on this one, even before the server echoes it.
  reservedBots = clean;
  pending = { text: JSON.stringify(clean), at: performance.now() };
  reservedShown = null;
  return true;
}
// A change sent but not echoed yet: older lists still on their way are ignored.
let pending = null;

function renderReservedBots(list) {
  const incoming = JSON.stringify(list ?? []);
  if (pending) {
    if (incoming !== pending.text && performance.now() - pending.at < 3000) return;
    pending = null;
  }
  reservedBots = list ?? [];
  const text = incoming;
  // Don't redraw under someone typing in it.
  if (text === reservedShown || $('reserved-list').contains(document.activeElement)) return;
  reservedShown = text;
  if (!reservedBots.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = A.reservedBotsEmpty;
    $('reserved-list').replaceChildren(li);
    return;
  }
  $('reserved-list').replaceChildren(
    ...reservedBots.map((b, i) => {
      const li = document.createElement('li');
      const name = document.createElement('input');
      name.type = 'text';
      name.value = b.name;
      name.maxLength = MAX_NAME_LENGTH;
      name.spellcheck = false;
      name.autocomplete = 'off';
      name.setAttribute('aria-label', A.reservedBotPlaceholder);
      name.addEventListener('change', () => {
        const next = reservedBots.map((x, j) => (j === i ? { ...x, name: name.value } : x));
        if (!sendReserved(next)) name.value = b.name;
        reservedShown = null; // redraw from the server's echo
      });
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') name.blur();
      });
      const hat = hatSelect(document.createElement('select'), b.hat);
      hat.addEventListener('change', () => {
        sendReserved(reservedBots.map((x, j) => (j === i ? { ...x, hat: hat.value || null } : x)));
        reservedShown = null;
        hat.blur();
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'danger';
      remove.textContent = '×';
      remove.title = fmt(A.reservedBotRemove, { name: b.name });
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => {
        sendReserved(reservedBots.filter((_, j) => j !== i));
        reservedShown = null;
        remove.blur();
      });
      li.append(name, hat, remove);
      return li;
    }),
  );
}

$('reserved-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const entry = { name: $('reserved-name').value, hat: $('reserved-hat').value || null };
  if (sendReserved([...reservedBots, entry])) {
    $('reserved-name').value = '';
    $('reserved-hat').value = '';
  }
});
$('reserved-name').addEventListener('input', () => reservedError(null));

// ---- banned words -------------------------------------------------------------
$('word-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const word = $('word-input').value.trim();
  if (!word) return;
  $('word-error').textContent = '';
  send({ t: 'addWord', word });
});
$('word-input').addEventListener('input', () => {
  $('word-error').textContent = '';
});

let lastWords = null;

function renderWords(words) {
  // The server sends the list after every change; a grown list means our add worked.
  if (lastWords && words.length > lastWords.length) $('word-input').value = '';
  lastWords = words;
  $('word-count').textContent = fmt(A.wordCount, { n: words.length });
  $('word-list').replaceChildren(
    ...words.map((word) => {
      const li = document.createElement('li');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '×';
      remove.title = fmt(A.removeWord, { word });
      remove.setAttribute('aria-label', remove.title);
      remove.addEventListener('click', () => send({ t: 'removeWord', word }));
      li.append(document.createTextNode(word), remove);
      return li;
    }),
  );
}

async function loadLinks() {
  try {
    const res = await fetch('/admin/api/info', { cache: 'no-store' });
    if (!res.ok) return;
    const info = await res.json();
    const entries = [
      ['/display', info.urls.display],
      ['/play', info.urls.play],
      ['/admin/print', info.urls.print],
    ];
    $('links').replaceChildren(
      ...entries.map(([label, url]) => {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = `${label}: ${url}`;
        return a;
      }),
    );
    const printLink = document.createElement('a');
    printLink.href = '/admin/print';
    printLink.target = '_blank';
    printLink.textContent = A.printPage;
    $('links').append(printLink);
  } catch {
    /* links are a convenience only */
  }
}

setConnected(false);
connect();
loadLinks();
