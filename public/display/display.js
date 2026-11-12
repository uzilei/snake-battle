// /display: renders the server state and feeds two local keyboard players
// (WASD and arrow keys) into the same input path as phones.

import { STRINGS, fmt } from '/shared/strings.js';
import { playerColor } from '/shared/colors.js';
import { snakePath, pointAt, subPath } from '/shared/snake-path.js';
import { POWER_UPS, POWER_UP_RULES } from '/shared/powerups.js';

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
$('rec-kicker').textContent = T.recordsTitle;
$('rec-empty').textContent = T.noRecords;
$('connection').textContent = T.disconnected;

// ---- assets -------------------------------------------------------------------
// Item sprites (Twemoji SVGs, served locally), loaded once.
function loadImage(src) {
  const entry = { img: new Image(), ready: false };
  entry.img.onload = () => (entry.ready = true);
  entry.img.src = src;
  return entry;
}
const ITEM_IMAGES = {
  apple: loadImage('/twemoji/1f34e.svg'), // 🍎
  ...Object.fromEntries(POWER_UPS.map((p) => [p.type, loadImage(`/twemoji/${p.twemoji}.svg`)])),
};

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
// Item type -> sprite rasterized once per size (redrawing the SVG every frame
// is slow with hundreds of corpse apples). Power-ups pulse by scaling the
// cached sprite when drawing, so the cache only holds a few sizes per type.
const spriteCache = new Map(); // `${type}:${px}` -> canvas
function sprite(type, px) {
  const entry = ITEM_IMAGES[type];
  if (!entry?.ready) return null;
  const key = `${type}:${px}`;
  if (!spriteCache.has(key)) {
    if (spriteCache.size > 64) spriteCache.clear(); // old cell sizes
    const c = document.createElement('canvas');
    c.width = c.height = px;
    c.getContext('2d').drawImage(entry.img, 0, 0, px, px);
    spriteCache.set(key, c);
  }
  return spriteCache.get(key);
}

// Time left on something the server counts down, as of now (the state is
// one tick old by the end of the tick).
const remainingNow = (ms, now) => Math.max(0, ms - (now - tickAt));

function boardItems(state, now) {
  const items = state.apples.map((a) => ({ type: 'apple', x: a.x, y: a.y }));
  for (const p of state.powerUps ?? []) items.push({ type: p.type, x: p.x, y: p.y, power: true });
  for (const b of state.bombs ?? []) items.push({ type: 'bomb', x: b.x, y: b.y, power: true, remainingMs: remainingNow(b.remainingMs, now) });
  // An eaten item stays until the (interpolated) head has reached it.
  for (const e of eaten) if (now < e.until) items.push({ type: e.item ?? 'apple', x: e.x, y: e.y, power: Boolean(e.item) });
  return items;
}

function drawItems(items, cell, now) {
  const px = Math.max(1, Math.round(cell * 0.84));
  for (const it of items) {
    let scale = 1;
    let alpha = 1;
    if (it.power) {
      // Power-ups pulse gently (each a little out of step) and sit on a soft
      // glow, so they stand out from apples.
      scale = 1 + 0.09 * Math.sin(now / 190 + it.x * 1.7 + it.y);
      const cx = (it.x + 0.5) * cell;
      const cy = (it.y + 0.5) * cell;
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, cell * 0.8);
      // The bomb emoji is nearly black: it gets a light disc and a red glow.
      glow.addColorStop(0, it.type === 'bomb' ? 'rgba(255, 110, 80, 0.75)' : 'rgba(255, 240, 170, 0.32)');
      glow.addColorStop(1, it.type === 'bomb' ? 'rgba(255, 80, 60, 0)' : 'rgba(255, 240, 170, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(cx - cell * 0.8, cy - cell * 0.8, cell * 1.6, cell * 1.6);
      if (it.type === 'bomb') {
        ctx.fillStyle = 'rgba(255, 235, 225, 0.55)';
        disc(cx, cy, cell * 0.36);
      }
    }
    // A bomb blinks during its last seconds.
    if (it.type === 'bomb' && it.remainingMs !== undefined && it.remainingMs < POWER_UP_RULES.bombBlinkMs) {
      alpha = Math.floor(now / 140) % 2 === 0 ? 1 : 0.25;
    }
    const size = px * scale;
    const x = (it.x + 0.5) * cell - size / 2;
    const y = (it.y + 0.5) * cell - size / 2;
    const img = sprite(it.type, px);
    ctx.globalAlpha = alpha;
    if (img) ctx.drawImage(img, x, y, size, size);
    else {
      ctx.fillStyle = it.type === 'apple' ? '#e53935' : '#ffd54a';
      disc((it.x + 0.5) * cell, (it.y + 0.5) * cell, cell * 0.38 * scale);
    }
    ctx.globalAlpha = 1;
  }
}

// ---- portals ----
// Both ends drawn as swirling rings in a hue of their own, joined by a faint
// dashed line so the pair reads as one; they fade out during their last
// seconds.
function drawPortals(portals, cell, now) {
  for (const p of portals) {
    const left = remainingNow(p.remainingMs, now);
    const alpha = Math.min(1, left / POWER_UP_RULES.portalFadeMs);
    if (alpha <= 0) continue;
    const hue = (p.id * 137.5) % 360;
    const color = (a) => `hsla(${hue}, 90%, 65%, ${a})`;
    const ends = [p.entrance, p.exit].map((c) => ({ x: (c.x + 0.5) * cell, y: (c.y + 0.5) * cell }));
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.setLineDash([cell * 0.2, cell * 0.25]);
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.strokeStyle = color(0.22);
    ctx.beginPath();
    ctx.moveTo(ends[0].x, ends[0].y);
    ctx.lineTo(ends[1].x, ends[1].y);
    ctx.stroke();
    ctx.setLineDash([]);
    ends.forEach((c, i) => {
      // The entrance swirls one way, the exit the other.
      const spin = (now / 400) * (i === 0 ? 1 : -1);
      const glow = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, cell * 0.7);
      glow.addColorStop(0, color(0.55));
      glow.addColorStop(1, color(0));
      ctx.fillStyle = glow;
      ctx.fillRect(c.x - cell * 0.7, c.y - cell * 0.7, cell * 1.4, cell * 1.4);
      ctx.lineWidth = Math.max(1.5, cell * 0.09);
      for (let k = 0; k < 3; k++) {
        ctx.strokeStyle = color(0.95 - k * 0.25);
        ctx.beginPath();
        ctx.arc(c.x, c.y, cell * (0.44 - k * 0.12), spin + k * 2.1, spin + k * 2.1 + Math.PI * 1.25);
        ctx.stroke();
      }
    });
    ctx.restore();
  }
}

// ---- projectiles ----
// A bright bullet with a short fading trail, slid between ticks like the
// snakes (2 cells per tick).
function drawProjectiles(list, t, cell) {
  for (const p of list) {
    const d = DIR_VECTORS[p.dir] ?? [0, 0];
    const prev = prevProjectiles.get(p.id);
    // A new one starts where it was fired: two cells back along its path.
    const from = prev ?? { x: p.x - d[0] * 2, y: p.y - d[1] * 2 };
    const x = (from.x + (p.x - from.x) * t + 0.5) * cell;
    const y = (from.y + (p.y - from.y) * t + 0.5) * cell;
    const tail = { x: x - d[0] * cell * 1.3, y: y - d[1] * cell * 1.3 };
    const trail = ctx.createLinearGradient(tail.x, tail.y, x, y);
    trail.addColorStop(0, 'rgba(255, 220, 120, 0)');
    trail.addColorStop(1, 'rgba(255, 240, 180, 0.85)');
    ctx.strokeStyle = trail;
    ctx.lineCap = 'round';
    ctx.lineWidth = cell * 0.18;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    ctx.save();
    ctx.shadowColor = '#ffe082';
    ctx.shadowBlur = cell * 0.6;
    ctx.fillStyle = '#fffde7';
    disc(x, y, cell * 0.16);
    ctx.restore();
  }
}

// ---- snakes ----
// #rrggbb mixed toward another #rrggbb (for the frozen tint).
const mixCache = new Map();
function mix(hex, other, amount) {
  const key = `${hex}${other}${amount}`;
  if (!mixCache.has(key)) {
    const ch = (h, i) => parseInt(h.slice(i, i + 2), 16);
    const c = [1, 3, 5].map((i) => Math.round(ch(hex, i) * (1 - amount) + ch(other, i) * amount));
    mixCache.set(key, `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`);
  }
  return mixCache.get(key);
}

// Per-snake look: power-up effects adjust these fields; drawSnake only
// reads them.
function snakeLook(s, now) {
  let color = playerColor(s.colorIndex);
  if (s.frozen) color = mix(color, '#9fe4ff', 0.55); // slowed by someone's freeze
  const look = { color, dark: darker(color), alpha: 1, width: 0.7, headScale: 1.22, glow: null, ring: false, magnet: false };
  const effect = s.alive ? s.effect?.type : null;
  if (effect === 'ghost') look.alpha = 0.4;
  if (effect === 'golden') look.glow = '#ffd54a';
  if (effect === 'shield') look.ring = true;
  if (effect === 'magnet') look.magnet = true;
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

  // Magnet: a faint circle showing how far it pulls.
  if (look.magnet) {
    for (const p of pointsAt(chains, front)) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      const r = cell * (POWER_UP_RULES.magnetRadius + 0.5);
      const g = ctx.createRadialGradient((p.x + 0.5) * cell, (p.y + 0.5) * cell, r * 0.3, (p.x + 0.5) * cell, (p.y + 0.5) * cell, r);
      g.addColorStop(0, 'rgba(255, 82, 82, 0)');
      g.addColorStop(1, 'rgba(255, 82, 82, 0.22)');
      ctx.fillStyle = g;
      disc((p.x + 0.5) * cell, (p.y + 0.5) * cell, r);
      ctx.setLineDash([cell * 0.25, cell * 0.25]);
      ctx.lineDashOffset = -now / 60; // the dashes flow inward
      ctx.lineWidth = Math.max(1, cell * 0.05);
      ctx.strokeStyle = 'rgba(255, 120, 120, 0.55)';
      ctx.stroke();
      ctx.restore();
    }
  }

  // Golden: glows.
  if (look.glow) {
    ctx.shadowColor = look.glow;
    ctx.shadowBlur = cell * (0.8 + 0.25 * Math.sin(now / 120));
  }

  // Body in the base color...
  ctx.lineCap = 'round';
  ctx.strokeStyle = look.color;
  ctx.beginPath();
  tracePath(chains, front, back, cell);
  ctx.stroke();
  ctx.shadowBlur = 0;

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
    // Shield: a ring around the head.
    if (look.ring) {
      ctx.lineWidth = Math.max(1.5, cell * 0.08);
      ctx.strokeStyle = `rgba(140, 220, 255, ${0.7 + 0.25 * Math.sin(now / 160)})`;
      ctx.beginPath();
      ctx.arc(hx, hy, headR * 1.55, 0, Math.PI * 2);
      ctx.stroke();
    }
    // While wrapping, label the copy that's on the board.
    const onBoard = p.x >= -0.5 && p.y >= -0.5 && p.x <= n - 0.5 && p.y <= n - 0.5;
    if (!label || onBoard) label = { x: hx, y: hy, r: headR };
  }
  ctx.restore();
  return label;
}

// The active timed effect: its icon in a small dark badge by the head, with
// a ring that empties as the time runs out.
function drawEffectBadges(badges, cell, now) {
  const r = Math.max(9 * dpr, cell * 0.38);
  const px = Math.max(1, Math.round(r * 1.3));
  for (const b of badges) {
    const left = remainingNow(b.effect.remainingMs, now) / b.effect.durationMs;
    const x = b.x + b.r * 1.15 + r * 0.6;
    const y = b.y - b.r * 1.15 - r * 0.6;
    ctx.fillStyle = 'rgba(4, 6, 12, 0.78)';
    disc(x, y, r);
    ctx.lineWidth = Math.max(2, r * 0.22);
    ctx.lineCap = 'round';
    ctx.strokeStyle = left < 0.25 ? '#ff8a80' : '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.86, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * clamp(left, 0, 1));
    ctx.stroke();
    const img = sprite(b.effect.type, px);
    if (img) ctx.drawImage(img, x - px / 2, y - px / 2);
  }
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
let prevProjectiles = new Map(); // id -> projectile one tick before the latest
const diedAt = new Map(); // id -> when it died (for the fade)
let eaten = []; // { x, y, color, until, item? }

// Small bright sparks, e.g. where a projectile ends.
function sparks(x, y, now, count, colors) {
  for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 6 * (0.35 + Math.random() * 0.65);
    particles.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: now, life: 300 + Math.random() * 300, r: 0.05 + Math.random() * 0.07, color: colors[i % colors.length] });
  }
}

function onState(msg) {
  const s = msg.state;
  const key = `${s.round}:${s.tick}`;
  if (key !== tickKey) {
    const now = performance.now();
    const sameRound = latest?.state.round === s.round;
    prevSnakes = sameRound ? new Map(latest.state.snakes.map((x) => [x.id, x])) : new Map();
    prevProjectiles = sameRound ? new Map((latest.state.projectiles ?? []).map((x) => [x.id, x])) : new Map();
    if (!sameRound) {
      diedAt.clear();
      eaten = [];
    }
    tickKey = key;
    tickAt = now;
    const fx = msg.effects ?? {};
    const colorOf = (id) => {
      const snake = s.snakes.find((x) => x.id === id);
      return snake ? playerColor(snake.colorIndex) : '#ffffff';
    };
    for (const ev of s.events ?? []) {
      if (ev.type === 'eat') {
        eaten.push({ x: ev.x, y: ev.y, color: colorOf(ev.id), until: now + msg.tickMs * EAT_AT, item: ev.item });
        if (ev.item === 'bomb') {
          if (fx.screenShake) shakeStart = now;
          if (fx.deathParticles) sparks(ev.x, ev.y, now, 24, ['#ff7043', '#ffca28', '#5d4037']);
        }
      } else if (ev.type === 'projectileEnd') {
        if (fx.deathParticles) sparks(ev.x, ev.y, now, ev.hit ? 22 : 10, ['#fffde7', '#ffe082', '#ffb74d']);
        if (ev.hit && fx.screenShake) shakeStart = now;
      } else if (ev.type === 'shieldPop') {
        const snake = s.snakes.find((x) => x.id === ev.id);
        if (snake && fx.appleRings) rings.push({ x: snake.segments[0].x, y: snake.segments[0].y, color: '#8cdcff', start: now });
        if (fx.screenShake) shakeStart = now;
      } else if (ev.type === 'cut') {
        if (fx.screenShake) shakeStart = now;
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
  drawPortals(state.portals ?? [], cell, now);
  drawItems(boardItems(state, now), cell, now);

  const t = msg.tickMs > 0 ? clamp((now - tickAt) / msg.tickMs, 0, 1) : 1;
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  const labels = [];
  const badges = [];
  // Fading dead snakes first, so the living are drawn on top.
  for (const s of state.snakes) if (!s.alive) drawSnake(s, null, 1, cell, n, now);
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const head = drawSnake(s, prevSnakes.get(s.id), t, cell, n, now);
    if (head) labels.push({ ...head, name: names.get(s.id) ?? '' });
    if (head && s.effect) badges.push({ ...head, effect: s.effect });
  }
  drawProjectiles(state.projectiles ?? [], t, cell);
  drawEffects(cell, now, dt);
  drawEffectBadges(badges, cell, now);
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
    const next = fmt(T.nextRound, { s: Math.max(1, Math.ceil(s.intermissionRemainingMs / 1000)) });
    // Say why the round ended when it wasn't the last snake standing.
    const reason = s.endReason === 'time' ? T.timeUp : s.endReason === 'target' ? fmt(T.targetReached, { n: s.win.targetLength }) : '';
    const sub = reason ? `${reason} ${next}` : next;
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
      const kills = document.createElement('span');
      kills.className = 'kills';
      kills.textContent = p.status === 'queued' ? '' : fmt(T.killsShort, { n: p.kills ?? 0 });
      const length = document.createElement('span');
      length.className = 'length';
      length.textContent = p.status === 'queued' ? '–' : String(p.length);
      li.append(swatch, name, kills, length);
      return li;
    }),
  );
  $('lb-empty').classList.toggle('hidden', players.length > 0);
  fitLeaderboard(list, players.length);
}

// The first layout whose rows all fit: one column, then two columns filled
// top to bottom (rank order reads down the left column, then the right one),
// then two tighter columns. The room left depends on the player count, the
// time / target strip and the ← / → buttons, so it is measured.
const LIST_LAYOUTS = [[], ['two-col'], ['two-col', 'tight']];
function fitLeaderboard(list, count) {
  for (const layout of LIST_LAYOUTS) {
    list.classList.remove('two-col', 'tight');
    list.classList.add(...layout);
    list.style.setProperty('--rows', layout.length ? Math.ceil(count / 2) : count);
    if (list.scrollHeight <= list.clientHeight + 1) return;
  }
}

function recordRow(rank, name, value) {
  const li = document.createElement('li');
  const r = document.createElement('span');
  r.className = 'rank';
  r.textContent = String(rank);
  const n = document.createElement('span');
  n.className = 'name';
  n.textContent = name; // textContent: names come from clients
  const v = document.createElement('span');
  v.className = 'value';
  v.textContent = value;
  li.append(r, n, v);
  return li;
}

// ---- global leaderboard: one stat at a time ----
const STATS = ['wins', 'kills', 'score'];
const STAT_PAGE_MS = 10000; // auto mode: each stat stays this long
const statValue = {
  wins: (n) => (n === 1 ? T.winsOne : fmt(T.winsMany, { n })),
  kills: (n) => (n === 1 ? T.killsOne : fmt(T.killsMany, { n })),
  score: (n) => fmt(T.scoreValue, { n }),
};
// Auto rotation: the next stat every STAT_PAGE_MS while the panel is up, and
// also each time it comes back (between rounds it may show only a few
// seconds, so every intermission moves on to the next stat).
let autoIndex = -1;
let pageStart = 0;
function advanceAuto(now, appearing) {
  if (autoIndex < 0 || appearing || now - pageStart >= STAT_PAGE_MS) {
    autoIndex = (autoIndex + 1) % STATS.length;
    pageStart = now;
  }
}

// The stat on screen: the admin's choice, or the auto rotation.
function currentStat(msg) {
  return STATS.includes(msg.leaderboardStat) ? msg.leaderboardStat : STATS[autoIndex];
}

function updateRecords(records, stat, auto, animate) {
  const list = records?.[stat] ?? [];
  $('rec-title').textContent = T.stats[stat];
  $('rec-list').replaceChildren(...list.map((e, i) => recordRow(i + 1, e.name, statValue[stat](e.value))));
  $('rec-empty').classList.toggle('hidden', list.length > 0);
  // Page indicator, only while rotating.
  $('rec-dots').classList.toggle('hidden', !auto);
  $('rec-dots').replaceChildren(
    ...STATS.map((s) => {
      const dot = document.createElement('span');
      dot.className = s === stat ? 'dot on' : 'dot';
      return dot;
    }),
  );
  if (animate) {
    // Restart the fade-in on the new page.
    for (const id of ['rec-body', 'rec-title']) {
      const el = $(id);
      el.classList.remove('enter');
      void el.offsetWidth;
      el.classList.add('enter');
    }
  }
}

// Time limit and target length, above whichever panel is showing.
function formatTime(ms) {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function updateRoundInfo(state) {
  const running = state.phase === 'playing' || state.phase === 'countdown';
  const timed = running && state.rules?.timeLimitWin && state.timeRemainingMs !== null;
  const target = running && state.rules?.targetLengthWin;
  $('round-info').classList.toggle('hidden', !timed && !target);
  $('side').classList.toggle('with-info', timed || target);
  $('ri-time').classList.toggle('hidden', !timed);
  $('ri-target').classList.toggle('hidden', !target);
  if (timed) {
    $('ri-time').textContent = fmt(T.timeLeft, { t: formatTime(state.timeRemainingMs) });
    // Flash during the last 10 seconds.
    $('ri-time').classList.toggle('urgent', state.phase === 'playing' && state.timeRemainingMs <= 10000);
  }
  if (target) $('ri-target').textContent = fmt(T.target, { n: state.win.targetLength });
}

let lastSideKey = '';
let lastRecordsKey = '';
let lastStat = null;

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
  // The records page also turns on its own (auto mode), not only on messages.
  if (latest.sidePanel === 'records') {
    if (latest.leaderboardStat === 'auto') advanceAuto(now, !lastRecordsKey);
    const stat = currentStat(latest);
    const key = JSON.stringify([latest.records, stat, latest.leaderboardStat]);
    if (key !== lastRecordsKey) {
      updateRecords(latest.records, stat, latest.leaderboardStat === 'auto', lastStat !== null && stat !== lastStat);
      lastRecordsKey = key;
      lastStat = stat;
    }
  } else {
    lastRecordsKey = '';
    lastStat = null;
  }
  if (!dirty) return;
  dirty = false;
  const { state } = latest;
  updateOverlay(latest);
  updateRoundInfo(state);
  const panel = latest.sidePanel;
  const showJoin = panel === 'join';
  $('join').classList.toggle('hidden', !showJoin);
  $('records').classList.toggle('hidden', panel !== 'records');
  $('leaderboard').classList.toggle('hidden', panel !== 'leaderboard');
  $('keyboard-hint').classList.toggle('hidden', !latest.keyboardPlayers);
  updateSideNav(latest);
  if (panel === 'leaderboard') {
    // Avoid rebuilding the list when nothing visible changed. The side
    // column's classes and the window size change the room it has.
    const key = JSON.stringify([state.round, state.players, $('side').className, latest.keyboardPlayers, innerHeight]);
    if (key !== lastSideKey) {
      lastSideKey = key;
      updateLeaderboard(state);
    }
  } else lastSideKey = '';
}

resizeCanvas();
connect();
requestAnimationFrame(render);
