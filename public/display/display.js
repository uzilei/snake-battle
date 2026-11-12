// /display: renders the server state and feeds two local keyboard players
// (WASD and arrow keys) into the same input path as phones.

import { STRINGS, fmt } from '/shared/strings.js';
import { playerColor } from '/shared/colors.js';
import { snakePath, pointAt, subPath } from '/shared/snake-path.js';

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
$('join-step3').replaceChildren(STRINGS.join.step3, document.createElement('br'), STRINGS.join.browser);
$('keyboard-hint').textContent = T.keyboardHint;
$('wins-title').textContent = T.winsTitle;
$('fame-title').textContent = T.fameTitle;
$('wins-empty').textContent = T.noRecords;
$('fame-empty').textContent = T.noRecords;
$('connection').textContent = T.disconnected;

// ---- assets -------------------------------------------------------------------
// Item sprites (Twemoji SVGs, served locally), loaded once.
function loadImage(src) {
  const entry = { img: new Image(), ready: false };
  entry.img.onload = () => (entry.ready = true);
  entry.img.src = src;
  return entry;
}
const ITEM_IMAGES = { apple: loadImage('/twemoji/1f34e.svg') }; // 🍎

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
    if (msg.t === 'state') onState(msg); else if (msg.t === 'joinInfo') {
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

// ← / → side panel buttons. The server checks the requested mode is one it
// currently offers (and that the admin toggle is on).
for (const [id, side] of [['nav-prev', 'prev'], ['nav-next', 'next']]) {
  $(id).addEventListener('click', (e) => {
    const target = latest?.sideNav?.[side];
    if (target) send({ t: 'sidePanel', mode: target.mode });
    e.currentTarget.blur(); // a stray Space/Enter from keyboard players must not click it again
  });
}

// The cursor shows while the mouse moves and hides after a few idle seconds.
const CURSOR_IDLE_MS = 3000;
let cursorTimer = null;
window.addEventListener('mousemove', () => {
  document.body.classList.remove('idle');
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => document.body.classList.add('idle'), CURSOR_IDLE_MS);
});
document.body.classList.add('idle');

// Double-click toggles fullscreen (handy when setting up the monitor).
window.addEventListener('dblclick', (e) => {
  if (e.target.closest?.('button')) return; // fast clicks on the buttons

  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => {});
});

// ---- rendering ------------------------------------------------------------------------
// Everything on the board is procedural except item sprites (Twemoji). Movement
// is interpolated: the board is drawn one tick behind, sliding each snake from
// its previous tick to the latest one over tickMs (see /shared/snake-path.js).
const canvas = $('board');
const ctx = canvas.getContext('2d');
let dpr = window.devicePixelRatio || 1;

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  dirty = true;
}
window.addEventListener('resize', resizeCanvas);

const FADE_MS = 700; // dead snakes fade out over this long
const RING_MS = 450;
const SHAKE_MS = 350;
const EAT_AT = 0.6; // fraction of a tick after which the head has covered an eaten apple
const MAX_PARTICLES = 700;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Slightly darker shade of a #rrggbb color, for the stripes.
const darkCache = new Map();
function darker(hex, amount = 0.28) {
  if (!darkCache.has(hex)) {
    const c = [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - amount)));
    darkCache.set(hex, `rgb(${c.join(',')})`);
  }
  return darkCache.get(hex);
}

// Background: dark board with a subtle grid, cached until the size changes.
let gridLayer = null;
let gridLayerKey = '';
function background(size, n) {
  const key = `${size}:${n}`;
  if (key === gridLayerKey) return gridLayer;
  gridLayerKey = key;
  gridLayer = document.createElement('canvas');
  gridLayer.width = gridLayer.height = size;
  const g = gridLayer.getContext('2d');
  g.fillStyle = '#0a0f1e';
  g.fillRect(0, 0, size, size);
  const cell = size / n;
  const w = Math.max(1, Math.round(dpr));
  g.fillStyle = 'rgba(140, 160, 220, 0.09)';
  for (let i = 1; i < n; i++) {
    const p = Math.round(i * cell - w / 2);
    g.fillRect(p, 0, w, size);
    g.fillRect(0, p, size, w);
  }
  g.strokeStyle = 'rgba(140, 160, 220, 0.25)';
  g.lineWidth = 2 * w;
  g.strokeRect(w, w, size - 2 * w, size - 2 * w);
  return gridLayer;
}

// ---- items ----
// Item type -> sprite rasterized once per cell size (redrawing the SVG every
// frame is slow with hundreds of corpse apples). Only apples exist today;
// other item types add an entry to ITEM_IMAGES and a type in boardItems().
const spriteCache = new Map(); // `${type}:${px}` -> canvas
function sprite(type, px) {
  const entry = ITEM_IMAGES[type];
  if (!entry?.ready) return null;
  const key = `${type}:${px}`;
  if (!spriteCache.has(key)) {
    if (spriteCache.size > 8) spriteCache.clear(); // old cell sizes
    const c = document.createElement('canvas');
    c.width = c.height = px;
    c.getContext('2d').drawImage(entry.img, 0, 0, px, px);
    spriteCache.set(key, c);
  }
  return spriteCache.get(key);
}

function boardItems(state, now) {
  const items = state.apples.map((a) => ({ type: 'apple', x: a.x, y: a.y }));
  // An eaten apple stays until the (interpolated) head has reached it.
  for (const e of eaten) if (now < e.until) items.push({ type: 'apple', x: e.x, y: e.y });
  return items;
}

function drawItems(items, cell) {
  const px = Math.max(1, Math.round(cell * 0.84));
  const off = (cell - px) / 2;
  for (const it of items) {
    const img = sprite(it.type, px);
    if (img) ctx.drawImage(img, Math.round(it.x * cell + off), Math.round(it.y * cell + off));
    else {
      ctx.fillStyle = '#e53935';
      ctx.beginPath();
      ctx.arc((it.x + 0.5) * cell, (it.y + 0.5) * cell, cell * 0.38, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---- snakes ----
// Per-snake look. Hook for per-snake effects (power-ups, later): they adjust
// these fields; drawSnake only reads them.
function snakeLook(s, now) {
  const color = playerColor(s.colorIndex);
  const look = { color, dark: darker(color), alpha: 1, width: 0.7, headScale: 1.22 };
  if (!s.alive) {
    const at = diedAt.get(s.id);
    look.alpha = at === undefined ? 0 : 1 - (now - at) / FADE_MS;
  }
  return look;
}

const DIR_VECTORS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

function tracePath(chains, u0, u1, cell) {
  for (const chain of chains) {
    const pts = subPath(chain, u0, u1);
    if (!pts) continue;
    ctx.moveTo((pts[0].x + 0.5) * cell, (pts[0].y + 0.5) * cell);
    if (pts.length === 1) ctx.lineTo((pts[0].x + 0.5) * cell + 0.01, (pts[0].y + 0.5) * cell); // a dot
    for (let i = 1; i < pts.length; i++) ctx.lineTo((pts[i].x + 0.5) * cell, (pts[i].y + 0.5) * cell);
  }
}

// Every copy of position u (two near the edges while wrapping), in cells.
function pointsAt(chains, u) {
  const out = [];
  for (const chain of chains) if (u >= chain[0].u && u <= chain[chain.length - 1].u) out.push(pointAt(chain, u));
  return out;
}

function disc(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// Draws one snake; returns where its head is (in px) for the name label.
function drawSnake(s, prev, t, cell, n, now) {
  const look = snakeLook(s, now);
  if (look.alpha <= 0 || !s.segments.length) return null;
  const path = snakePath(s, s.alive ? prev : null, t, n);
  const { chains, front, back, segU } = path;
  const width = cell * look.width;
  ctx.save();
  ctx.globalAlpha = clamp(look.alpha, 0, 1);
  ctx.lineJoin = 'round';
  ctx.lineWidth = width;

  // Body in the base color...
  ctx.lineCap = 'round';
  ctx.strokeStyle = look.color;
  ctx.beginPath();
  tracePath(chains, front, back, cell);
  ctx.stroke();

  // ...then every other segment in the darker shade. Stripes belong to the
  // segments (counted from the head), so they travel with the body.
  ctx.lineCap = 'butt';
  ctx.strokeStyle = look.dark;
  ctx.beginPath();
  for (let j = 1; j < segU.length; j += 2) {
    const lo = Math.max(front, segU[j] - 0.5);
    const hi = Math.min(back, segU[j] + 0.5);
    if (lo < hi) tracePath(chains, lo, hi, cell);
  }
  ctx.stroke();
  ctx.fillStyle = look.dark;
  if (segU.length > 1 && (segU.length - 1) % 2 === 1) {
    for (const p of pointsAt(chains, back)) disc((p.x + 0.5) * cell, (p.y + 0.5) * cell, width / 2); // round tail tip
  }

  // Head: a bit wider than the body, eyes looking where it's going.
  const d = DIR_VECTORS[s.dir] ?? [1, 0];
  const side = [-d[1], d[0]];
  const headR = (width / 2) * look.headScale;
  const eyeR = cell * 0.13;
  let label = null;
  for (const p of pointsAt(chains, front)) {
    const hx = (p.x + 0.5) * cell;
    const hy = (p.y + 0.5) * cell;
    ctx.fillStyle = look.color;
    disc(hx, hy, headR);
    const cx = hx + d[0] * cell * 0.12;
    const cy = hy + d[1] * cell * 0.12;
    for (const k of [-1, 1]) {
      const ex = cx + side[0] * k * cell * 0.2;
      const ey = cy + side[1] * k * cell * 0.2;
      ctx.fillStyle = '#ffffff';
      disc(ex, ey, eyeR);
      ctx.lineWidth = Math.max(1, cell * 0.025); // rim, so eyes show on light snakes too
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.45)';
      ctx.stroke();
      ctx.fillStyle = '#111111';
      disc(ex + d[0] * eyeR * 0.45, ey + d[1] * eyeR * 0.45, eyeR * 0.55);
    }
    // While wrapping, label the copy that's on the board.
    const onBoard = p.x >= -0.5 && p.y >= -0.5 && p.x <= n - 0.5 && p.y <= n - 0.5;
    if (!label || onBoard) label = { x: hx, y: hy, r: headR };
  }
  ctx.restore();
  return label;
}

// ---- names ----
const truncCache = new Map();
function truncate(name, maxWidth, font) {
  const key = `${font}|${maxWidth}|${name}`;
  if (truncCache.has(key)) return truncCache.get(key);
  if (truncCache.size > 500) truncCache.clear();
  let text = name;
  if (ctx.measureText(text).width > maxWidth) {
    const chars = [...name];
    while (chars.length > 1 && ctx.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop();
    text = `${chars.join('').trimEnd()}…`;
  }
  truncCache.set(key, text);
  return text;
}

function drawNames(labels, cell, size) {
  if (!labels.length) return;
  const fontPx = Math.round(clamp(cell * 0.42, 12 * dpr, 20 * dpr));
  const font = `700 ${fontPx}px system-ui, "Segoe UI", Roboto, sans-serif`;
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(2, 3 * dpr);
  ctx.strokeStyle = 'rgba(4, 6, 12, 0.9)';
  ctx.fillStyle = '#ffffff';
  const maxWidth = Math.max(cell * 5, 90 * dpr);
  for (const l of labels) {
    const text = truncate(l.name, maxWidth, font);
    const half = ctx.measureText(text).width / 2 + 3 * dpr;
    const x = clamp(l.x, half, size - half); // keep names on screen at the edges
    const gap = l.r + fontPx * 0.62;
    // Above the head when there's no room below (the bottom row, or a head
    // that's mid-way through a wrap at the bottom edge).
    const y = l.y + gap + fontPx / 2 > size ? l.y - gap : l.y + gap;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }
  ctx.restore();
}

// ---- effects (each behind an /admin toggle) ----
const particles = []; // { x, y, vx, vy, born, life, r, color } in cells / seconds
const rings = []; // { x, y, color, start }
let shakeStart = -Infinity;

function burst(s, now) {
  const color = playerColor(s.colorIndex);
  const colors = [color, darker(color), '#ffffff'];
  const add = (c, count, speed) => {
    for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.35 + Math.random() * 0.65);
      particles.push({
        x: c.x + 0.5,
        y: c.y + 0.5,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        born: now,
        life: 450 + Math.random() * 450,
        r: 0.08 + Math.random() * 0.12,
        color: colors[i % colors.length],
      });
    }
  };
  add(s.segments[0], 26, 9); // big burst at the head
  const step = Math.max(1, Math.ceil(s.segments.length / 30));
  for (let i = 1; i < s.segments.length; i += step) add(s.segments[i], 2, 3);
}

function drawEffects(cell, now, dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    const e = (now - r.start) / RING_MS;
    if (e >= 1) {
      rings.splice(i, 1);
      continue;
    }
    const ease = 1 - (1 - e) ** 3;
    ctx.globalAlpha = 1 - e;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = cell * 0.14 * (1 - e) + dpr;
    ctx.beginPath();
    ctx.arc((r.x + 0.5) * cell, (r.y + 0.5) * cell, cell * (0.3 + 0.95 * ease), 0, Math.PI * 2);
    ctx.stroke();
  }
  const drag = 0.06 ** dt; // velocity left after dt seconds
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    const e = (now - p.born) / p.life;
    if (e >= 1) {
      particles.splice(i, 1);
      continue;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.vx *= drag;
    p.vy *= drag;
    ctx.globalAlpha = 1 - e * e;
    ctx.fillStyle = p.color;
    disc(p.x * cell, p.y * cell, p.r * cell * (1 - 0.5 * e));
  }
  ctx.globalAlpha = 1;
}

let shaking = false;
function applyShake(now) {
  const e = (now - shakeStart) / SHAKE_MS;
  if (e >= 0 && e < 1) {
    const amp = canvas.clientWidth * 0.009 * (1 - e) ** 2;
    canvas.style.transform = `translate(${(Math.random() * 2 - 1) * amp}px, ${(Math.random() * 2 - 1) * amp}px)`;
    shaking = true;
  } else if (shaking) {
    canvas.style.transform = '';
    shaking = false;
  }
}

// ---- tick bookkeeping ----
// The same tick can arrive more than once (admin actions also broadcast), so
// a tick is identified by round + tick number and handled only once.
let tickKey = '';
let tickAt = 0; // when the latest tick arrived
let prevSnakes = new Map(); // id -> snake one tick before the latest
const diedAt = new Map(); // id -> when it died (for the fade)
let eaten = []; // { x, y, color, until }

function onState(msg) {
  const s = msg.state;
  const key = `${s.round}:${s.tick}`;
  if (key !== tickKey) {
    const now = performance.now();
    const sameRound = latest?.state.round === s.round;
    prevSnakes = sameRound ? new Map(latest.state.snakes.map((x) => [x.id, x])) : new Map();
    if (!sameRound) {
      diedAt.clear();
      eaten = [];
    }
    tickKey = key;
    tickAt = now;
    const fx = msg.effects ?? {};
    for (const ev of s.events ?? []) {
      if (ev.type === 'eat') {
        const snake = s.snakes.find((x) => x.id === ev.id);
        eaten.push({ x: ev.x, y: ev.y, color: snake ? playerColor(snake.colorIndex) : '#ffffff', until: now + msg.tickMs * EAT_AT });
      } else if (ev.type === 'death') {
        diedAt.set(ev.id, now);
        const snake = s.snakes.find((x) => x.id === ev.id);
        if (fx.deathParticles && snake) burst(snake, now);
      } else if (ev.type === 'headOn') {
        if (fx.screenShake) shakeStart = now;
      }
    }
  }
  latest = msg;
  dirty = true;
}

function drawBoard(msg, now, dt) {
  const { state } = msg;
  const size = canvas.width;
  const n = state.gridSize;
  const cell = size / n;
  ctx.drawImage(background(size, n), 0, 0);

  // Eaten apples whose head has arrived: start their ring.
  for (const e of eaten) {
    if (now >= e.until && !e.done) {
      e.done = true;
      if (msg.effects?.appleRings) rings.push({ x: e.x, y: e.y, color: e.color, start: now });
    }
  }
  eaten = eaten.filter((e) => !e.done);
  drawItems(boardItems(state, now), cell);

  const t = msg.tickMs > 0 ? clamp((now - tickAt) / msg.tickMs, 0, 1) : 1;
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  const labels = [];
  // Fading dead snakes first, so the living are drawn on top.
  for (const s of state.snakes) if (!s.alive) drawSnake(s, null, 1, cell, n, now);
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const head = drawSnake(s, prevSnakes.get(s.id), t, cell, n, now);
    if (head) labels.push({ ...head, name: names.get(s.id) ?? '' });
  }
  drawEffects(cell, now, dt);
  drawNames(labels, cell, size);
  applyShake(now);
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
  // Past 8 players, two columns filled top to bottom (rank order reads down
  // the left column, then the right one).
  const twoCol = players.length > 8;
  list.classList.toggle('two-col', twoCol);
  list.style.setProperty('--rows', twoCol ? Math.ceil(players.length / 2) : players.length);
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

let lastFrame = performance.now();

function updateSideNav(msg) {
  document.body.classList.toggle('mouse', Boolean(msg.displayButtons));
  const nav = msg.sideNav;
  const shown = Boolean(nav && (nav.prev || nav.next));
  $('side-nav').classList.toggle('hidden', !shown);
  $('side').classList.toggle('with-nav', shown);
  for (const [id, side, template] of [['nav-prev', 'prev', T.panelPrev], ['nav-next', 'next', T.panelNext]]) {
    const target = nav?.[side];
    $(id).classList.toggle('hidden', !target);
    if (target) $(id).textContent = fmt(template, { name: T.panelNames[target.panel] ?? target.panel });
  }
}

function render(now) {
  requestAnimationFrame(render);
  const dt = clamp((now - lastFrame) / 1000, 0, 0.1);
  lastFrame = now;
  if (!latest) return;
  // The board is redrawn every frame (movement and effects are animated);
  // the HTML side column only when a new message arrived.
  drawBoard(latest, now, dt);
  if (!dirty) return;
  dirty = false;
  const { state } = latest;
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
  updateSideNav(latest);
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
