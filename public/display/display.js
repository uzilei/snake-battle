// /display: renders the server state and feeds two local keyboard players
// (WASD and arrow keys) into the same input path as phones.

import { STRINGS, fmt } from '/shared/strings.js';
import { playerColor } from '/shared/colors.js';

const T = STRINGS.display;
const $ = (id) => document.getElementById(id);

// ---- static text --------------------------------------------------------------
document.title = T.title;
$('lb-title').textContent = T.scoreboard;
$('lb-empty').textContent = T.noPlayers;
$('join-title').textContent = STRINGS.join.title;
$('join-step1-title').textContent = STRINGS.join.step1Title;
$('join-step1-text').textContent = STRINGS.join.step1Text;
$('join-step2-title').textContent = STRINGS.join.step2Title;
$('join-step2-text').textContent = STRINGS.join.step2Text;
$('join-step3').textContent = STRINGS.join.step3;
$('keyboard-hint').textContent = T.keyboardHint;
$('wins-title').textContent = T.winsTitle;
$('fame-title').textContent = T.fameTitle;
$('wins-empty').textContent = T.noRecords;
$('fame-empty').textContent = T.noRecords;
$('connection').textContent = T.disconnected;

// ---- assets -------------------------------------------------------------------
const appleImg = new Image();
appleImg.src = '/twemoji/1f34e.svg'; // 🍎
let appleReady = false;
appleImg.onload = () => (appleReady = true);

// ---- state ------------------------------------------------------------------------
let latest = null; // last 'state' message
let ws = null;
let dirty = true;

// ---- connection -------------------------------------------------------------------
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    $('connection').classList.add('hidden');
    ws.send(JSON.stringify({ t: 'hello', role: 'display' }));
  };
  ws.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.t === 'state') {
      latest = msg;
      dirty = true;
    } else if (msg.t === 'joinInfo') {
      showJoinInfo(msg.joinInfo);
    }
  };
  ws.onclose = () => {
    $('connection').classList.remove('hidden');
    ws = null;
    setTimeout(connect, 1000);
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function showJoinInfo(info) {
  $('join-ssid').textContent = info.ssid ? fmt(STRINGS.join.wifiName, { ssid: info.ssid }) : '';
  $('join-wifipass').textContent = info.wifiPassword ? fmt(STRINGS.join.wifiPassword, { password: info.wifiPassword }) : '';
  $('join-url').textContent = info.playUrl ? fmt(STRINGS.join.gameUrl, { url: info.playUrl }) : '';
  // Bust the cache in case the server restarted with different settings.
  const v = Date.now();
  $('qr-wifi').src = `/qr/wifi.svg?v=${v}`;
  $('qr-play').src = `/qr/play.svg?v=${v}`;
}

// ---- keyboard players --------------------------------------------------------------
const KEYS = {
  KeyW: ['wasd', 'up'],
  KeyA: ['wasd', 'left'],
  KeyS: ['wasd', 'down'],
  KeyD: ['wasd', 'right'],
  ArrowUp: ['arrows', 'up'],
  ArrowLeft: ['arrows', 'left'],
  ArrowDown: ['arrows', 'down'],
  ArrowRight: ['arrows', 'right'],
};
const lastJoinAttempt = { wasd: 0, arrows: 0 };

window.addEventListener('keydown', (e) => {
  const mapping = KEYS[e.code];
  if (!mapping) return;
  e.preventDefault();
  if (!latest?.keyboardPlayers) return;
  const [slot, dir] = mapping;
  if (latest.localPlayers?.[slot]) {
    send({ t: 'dir', slot, dir });
  } else if (!e.repeat && Date.now() - lastJoinAttempt[slot] > 1000) {
    // First key press of a key set joins that keyboard player.
    lastJoinAttempt[slot] = Date.now();
    send({ t: 'join', slot });
  }
});

// Double-click toggles fullscreen (handy when setting up the monitor).
window.addEventListener('dblclick', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

// ---- rendering ------------------------------------------------------------------------
const canvas = $('board');
const ctx = canvas.getContext('2d');

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  dirty = true;
}
window.addEventListener('resize', resizeCanvas);

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

function drawBoard(state) {
  const size = canvas.width;
  const n = state.gridSize;
  const cell = size / n;

  ctx.fillStyle = '#0b1020';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#0e1428';
  for (let y = 0; y < n; y++) {
    for (let x = (y % 2); x < n; x += 2) ctx.fillRect(x * cell, y * cell, cell, cell);
  }

  // Apples
  for (const a of state.apples) {
    const pad = cell * 0.08;
    if (appleReady) ctx.drawImage(appleImg, a.x * cell + pad, a.y * cell + pad, cell - 2 * pad, cell - 2 * pad);
    else {
      ctx.fillStyle = '#e53935';
      ctx.beginPath();
      ctx.arc((a.x + 0.5) * cell, (a.y + 0.5) * cell, cell * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Dead snakes first so living ones are drawn on top. When dead snakes turn
  // into apples, their bodies are not drawn at all.
  const corpses = state.rules?.corpseApples;
  const snakes = [...state.snakes].filter((s) => s.alive || !corpses).sort((a, b) => Number(a.alive) - Number(b.alive));
  for (const s of snakes) drawSnake(s, cell, n);
}

// Fills the joint between cell c and its neighbour in direction (dx, dy),
// covering half a cell on c's side.
function halfBridge(c, dx, dy, cell, inset) {
  const cx = (c.x + 0.5) * cell;
  const cy = (c.y + 0.5) * cell;
  if (dy === 0) ctx.fillRect(dx > 0 ? cx : cx - cell / 2, c.y * cell + inset, cell / 2, cell - 2 * inset);
  else ctx.fillRect(c.x * cell + inset, dy > 0 ? cy : cy - cell / 2, cell - 2 * inset, cell / 2);
}

function drawSnake(s, cell, n) {
  const color = playerColor(s.colorIndex);
  ctx.globalAlpha = s.alive ? 1 : 0.22;
  ctx.fillStyle = color;
  const inset = cell * 0.12;
  const segs = s.segments;

  for (let i = segs.length - 1; i >= 0; i--) {
    const c = segs[i];
    roundRect(c.x * cell + inset, c.y * cell + inset, cell - 2 * inset, cell - 2 * inset, cell * 0.28);
    // Bridge to the next segment so the body reads as one continuous shape.
    // Across a wrapped edge the two halves run off opposite sides of the board.
    const prev = segs[i - 1];
    if (prev) {
      let dx = prev.x - c.x;
      let dy = prev.y - c.y;
      if (Math.abs(dx) > 1) dx = -Math.sign(dx);
      if (Math.abs(dy) > 1) dy = -Math.sign(dy);
      if (Math.abs(dx) + Math.abs(dy) === 1) {
        halfBridge(c, dx, dy, cell, inset);
        halfBridge(prev, -dx, -dy, cell, inset);
      }
    }
  }

  // Head: slightly larger, with eyes looking where the snake is going.
  const head = segs[0];
  if (head) {
    const hx = head.x * cell;
    const hy = head.y * cell;
    roundRect(hx + inset * 0.4, hy + inset * 0.4, cell - inset * 0.8, cell - inset * 0.8, cell * 0.32);
    const d = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[s.dir] ?? [1, 0];
    const cx = hx + cell / 2 + d[0] * cell * 0.14;
    const cy = hy + cell / 2 + d[1] * cell * 0.14;
    const side = [-d[1], d[0]];
    const eyeR = cell * 0.13;
    for (const k of [-1, 1]) {
      const ex = cx + side[0] * k * cell * 0.2;
      const ey = cy + side[1] * k * cell * 0.2;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#111111';
      ctx.beginPath();
      ctx.arc(ex + d[0] * eyeR * 0.4, ey + d[1] * eyeR * 0.4, eyeR * 0.55, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

function setOverlay({ title = '', sub = '', banner = null, countdown = false, dim = false } = {}) {
  const overlay = $('overlay');
  const t = $('overlay-title');
  overlay.classList.toggle('hidden', !title && !sub);
  overlay.classList.toggle('dim', dim);
  t.textContent = title;
  t.classList.toggle('banner', Boolean(banner));
  t.classList.toggle('countdown', countdown);
  t.style.background = banner ?? '';
  $('overlay-sub').textContent = sub;
}

function updateOverlay(msg) {
  const s = msg.state;
  if (msg.paused) return setOverlay({ title: T.paused, dim: true });
  if (s.phase === 'waiting') return setOverlay({ title: T.waiting, sub: T.waitingHint, dim: true });
  if (s.phase === 'countdown') {
    return setOverlay({ title: String(Math.max(1, Math.ceil(s.countdownRemainingMs / 1000))), countdown: true });
  }
  if (s.phase === 'intermission') {
    const winner = s.players.find((p) => p.id === s.winnerId);
    const sub = fmt(T.nextRound, { s: Math.max(1, Math.ceil(s.intermissionRemainingMs / 1000)) });
    if (winner) return setOverlay({ title: fmt(T.winner, { name: winner.name }), sub, banner: playerColor(winner.colorIndex), dim: true });
    return setOverlay({ title: T.draw, sub, dim: true });
  }
  setOverlay();
}

const STATUS_ORDER = { alive: 0, dead: 1, queued: 2 };

function updateLeaderboard(state) {
  $('lb-round').textContent = state.round > 0 ? fmt(T.round, { n: state.round }) : '';
  const players = [...state.players].sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.length - a.length || a.name.localeCompare(b.name),
  );
  const list = $('lb-list');
  list.classList.toggle('compact', players.length > 8);
  list.replaceChildren(
    ...players.map((p) => {
      const li = document.createElement('li');
      li.className = p.status;
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = playerColor(p.colorIndex);
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = p.name; // textContent: names come from clients
      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = T[p.status] ?? '';
      name.append(status);
      const length = document.createElement('span');
      length.className = 'length';
      length.textContent = p.status === 'queued' ? '–' : String(p.length);
      li.append(swatch, name, length);
      return li;
    }),
  );
  $('lb-empty').classList.toggle('hidden', players.length > 0);
}

function recordRow(rank, name, extra, value) {
  const li = document.createElement('li');
  const r = document.createElement('span');
  r.className = 'rank';
  r.textContent = String(rank);
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name; // textContent: names come from clients
  li.append(r, n);
  if (extra !== null) {
    const e = document.createElement('span');
    e.className = 'when';
    e.textContent = extra;
    li.append(e);
  }
  const v = document.createElement('span');
  v.className = 'value';
  v.textContent = value;
  li.append(v);
  return li;
}

const fameTime = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function updateRecords(records) {
  const { leaderboard, hallOfFame } = records ?? {};
  $('wins-block').classList.toggle('hidden', !leaderboard);
  $('fame-block').classList.toggle('hidden', !hallOfFame);
  if (leaderboard) {
    $('wins-list').replaceChildren(
      ...leaderboard.map((e, i) => recordRow(i + 1, e.name, null, e.wins === 1 ? T.winsOne : fmt(T.winsMany, { n: e.wins }))),
    );
    $('wins-empty').classList.toggle('hidden', leaderboard.length > 0);
  }
  if (hallOfFame) {
    $('fame-list').replaceChildren(...hallOfFame.map((e, i) => recordRow(i + 1, e.name, fameTime.format(e.at), String(e.length))));
    $('fame-empty').classList.toggle('hidden', hallOfFame.length > 0);
  }
}

let lastSideKey = '';
let lastRecordsKey = '';

function render() {
  requestAnimationFrame(render);
  if (!dirty || !latest) return;
  dirty = false;
  const { state } = latest;
  drawBoard(state);
  updateOverlay(latest);
  const panel = latest.sidePanel;
  const showJoin = panel === 'join';
  $('join').classList.toggle('hidden', !showJoin);
  $('records').classList.toggle('hidden', panel !== 'records');
  $('leaderboard').classList.toggle('hidden', panel !== 'leaderboard');
  if (panel === 'records') {
    const key = JSON.stringify(latest.records);
    if (key !== lastRecordsKey) {
      lastRecordsKey = key;
      updateRecords(latest.records);
    }
  } else lastRecordsKey = '';
  $('keyboard-hint').classList.toggle('hidden', !latest.keyboardPlayers);
  if (panel === 'leaderboard') {
    // Avoid rebuilding the list when nothing visible changed.
    const key = JSON.stringify([state.round, state.players]);
    if (key !== lastSideKey) {
      lastSideKey = key;
      updateLeaderboard(state);
    }
  } else lastSideKey = '';
}

resizeCanvas();
connect();
requestAnimationFrame(render);
