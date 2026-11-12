// /admin control panel. Every action goes over the admin WebSocket, which the
// server only accepts with a valid session cookie (and re-checks per message).

import { STRINGS, fmt } from '/shared/strings.js';
import { playerColor } from '/shared/colors.js';

const A = STRINGS.admin;
const $ = (id) => document.getElementById(id);

// parent: the element the slider goes in (default: the Settings card).
const SLIDERS = [
  { key: 'tickMs', step: 10 },
  { key: 'appleCount', step: 1 },
  { key: 'growthPerApple', step: 1 },
  { key: 'maxPlayers', step: 1 },
  { key: 'gridSize', step: 1 },
  { key: 'countdownMs', step: 500 },
  { key: 'intermissionMs', step: 500 },
  { key: 'roundTimeLimitSec', step: 15, parent: 'sliders-time' },
  { key: 'targetLength', step: 1, parent: 'sliders-target' },
];
const RESET_STATS = ['wins', 'kills', 'score', 'all'];

// ---- static text ----------------------------------------------------------------
document.title = `${STRINGS.appName} – ${A.title}`;
$('title').textContent = `${STRINGS.appName} – ${A.title}`;
$('logout').textContent = A.logout;
$('h-game').textContent = A.game;
$('btn-restart').textContent = A.restartRound;
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
$('h-global').textContent = A.globalLeaderboard;
$('l-leaderboardStat').textContent = A.leaderboardStat;
for (const stat of RESET_STATS) $(`btn-reset-${stat}`).textContent = A.reset[stat];
$('h-effects').textContent = A.effects;
$('effects-hint').textContent = A.effectsHint;

// Engine rules go through 'config'; the records and effects toggles are server settings.
const RULE_TOGGLES = {
  corpseApples: 'config',
  displayButtons: 'settings',
  wrapWalls: 'config',
  timeLimitWin: 'config',
  targetLengthWin: 'config',
  leaderboard: 'settings',
  deathParticles: 'settings',
  appleRings: 'settings',
  screenShake: 'settings',
};
for (const [key, kind] of Object.entries(RULE_TOGGLES)) {
  $(`l-${key}`).textContent = A[key];
  $(`t-${key}`).addEventListener('change', (e) => {
    const value = e.target.checked;
    send(kind === 'config' ? { t: 'config', values: { [key]: value } } : { t: 'settings', [key]: value });
  });
}
$('h-players').textContent = A.players;
$('c-name').textContent = A.colName;
$('c-status').textContent = A.colStatus;
$('c-length').textContent = A.colLength;
$('c-kills').textContent = A.colKills;
$('c-source').textContent = A.colSource;
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
fillSelect($('c-timeLimitWinner'), A.timeLimitWinnerOptions);

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
$('side-panel').addEventListener('change', (e) => {
  send({ t: 'settings', sidePanel: e.target.value });
  e.target.blur(); // so changes made from /display show up here too
});
$('keyboard').addEventListener('change', (e) => send({ t: 'settings', keyboardPlayers: e.target.checked }));
$('leaderboard-stat').addEventListener('change', (e) => {
  send({ t: 'settings', leaderboardStat: e.target.value });
  e.target.blur();
});
$('c-timeLimitWinner').addEventListener('change', (e) => {
  send({ t: 'config', values: { timeLimitWinner: e.target.value } });
  e.target.blur();
});
for (const stat of RESET_STATS) {
  $(`btn-reset-${stat}`).addEventListener('click', () => {
    if (confirm(A.confirmReset[stat])) send({ t: 'resetRecords', stat });
  });
}

const sliderEls = {};
let slidersBuilt = false;

function buildSliders(limits) {
  for (const { key, step, parent = 'sliders' } of SLIDERS) {
    const lim = limits[key];
    if (!lim) continue;
    const wrap = document.createElement('div');
    wrap.className = 'slider';
    const label = document.createElement('label');
    label.htmlFor = `s-${key}`;
    label.textContent = A[key];
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
      timer = setTimeout(() => send({ t: 'config', values: { [key]: Number(input.value) } }), 80);
    });
    wrap.append(label, input, output, range);
    $(parent).append(wrap);
    sliderEls[key] = { input, output };
  }
  slidersBuilt = true;
}

// ---- rendering ------------------------------------------------------------------
let lastPlayersKey = '';

function update(msg) {
  latest = msg;
  if (!slidersBuilt) buildSliders(msg.limits);

  $('phase').textContent = (A.phase[msg.phase] ?? msg.phase) + (msg.paused ? A.pausedSuffix : '');
  $('round').textContent = msg.round > 0 ? `${A.round} ${msg.round}` : '';
  $('btn-pause').textContent = msg.paused ? A.resume : A.pause;

  for (const [key, { input, output }] of Object.entries(sliderEls)) {
    // Don't fight the user while they're dragging.
    if (document.activeElement === input) continue;
    input.value = msg.config[key];
    output.textContent = msg.config[key];
  }
  if (document.activeElement !== $('side-panel')) $('side-panel').value = msg.settings.sidePanel;
  $('keyboard').checked = msg.settings.keyboardPlayers;
  // "Record" with both records toggles off falls back to the scoreboard: say why.
  $('side-records-off').hidden = !(msg.settings.sidePanel === 'records' && !msg.settings.leaderboard);
  if (document.activeElement !== $('leaderboard-stat')) $('leaderboard-stat').value = msg.settings.leaderboardStat;
  if (document.activeElement !== $('c-timeLimitWinner')) $('c-timeLimitWinner').value = msg.config.timeLimitWinner;
  // The settings of a win condition only matter while it is on.
  $('sliders-time').parentElement.classList.toggle('off', !msg.config.timeLimitWin);
  $('sliders-target').parentElement.classList.toggle('off', !msg.config.targetLengthWin);
  for (const [key, kind] of Object.entries(RULE_TOGGLES)) {
    $(`t-${key}`).checked = Boolean(kind === 'config' ? msg.config[key] : msg.settings[key]);
  }
  const win = msg.win ?? {};
  const activeLabel = {
    timeLimitWin: () => `${A.timeLimitWin} (${win.timeLimitSec} s, ${A.timeLimitWinnerOptions[win.timeLimitWinner]})`,
    targetLengthWin: () => `${A.targetLength} ${win.targetLength}`,
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
      const status = document.createElement('td');
      status.textContent = A.playerStatus[p.status] ?? p.status;
      const length = document.createElement('td');
      length.textContent = p.status === 'queued' ? '–' : String(p.length);
      const kills = document.createElement('td');
      kills.textContent = p.status === 'queued' ? '–' : String(p.kills ?? 0);
      const source = document.createElement('td');
      source.textContent = p.source === 'keyboard' ? A.sourceKeyboard : A.sourcePhone;
      const actions = document.createElement('td');
      const kick = document.createElement('button');
      kick.className = 'danger';
      kick.textContent = A.kick;
      kick.addEventListener('click', () => {
        if (confirm(fmt(A.confirmKick, { name: p.name }))) send({ t: 'kick', id: p.id });
      });
      actions.append(kick);
      tr.append(name, status, length, kills, source, actions);
      return tr;
    }),
  );
}

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
