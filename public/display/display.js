// /display: renders the server state and feeds two local keyboard players
// (WASD and arrow keys) into the same input path as phones.

import { STRINGS, fmt } from '/shared/strings.js';
import { playerColor } from '/shared/colors.js';
import { snakePath, pointAt, subPath, smoothSubPath, travelDirAt } from '/shared/snake-path.js';
import { POWER_UPS, POWER_UP_RULES } from '/shared/powerups.js';
import { RAT_RULES } from '/shared/rats.js';
import { CHICKEN_RULES } from '/shared/chicken.js';
import { BADGER_RULES, badgerLabel } from '/shared/badger.js';
import { FRUIT_CODES } from '/shared/fruits.js';
import { HATS } from '/shared/hats.js';
import { BOT_SKILL_TWEMOJI, BOT_SKILL_EMOJI } from '/shared/bots.js';
import { soundsFor, spreadOverTick } from '/shared/sounds.js';
import * as sfx from './sfx.js';

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
$('sound-hint').textContent = T.soundHint;

// ---- assets -------------------------------------------------------------------
// Item sprites (Twemoji SVGs, served locally), loaded once.
function loadImage(src) {
  const entry = { img: new Image(), ready: false };
  entry.img.onload = () => (entry.ready = true);
  entry.img.src = src;
  return entry;
}
// Plain apples are drawn as one of the fruits /admin has on (see
// src/shared/fruits.js), picked at random for each apple when it appears and
// kept until it's eaten. Purely visual: every one is a normal apple.
const ITEM_IMAGES = {
  apple: loadImage('/twemoji/1f34e.svg'), // 🍎
  ...Object.fromEntries(FRUIT_CODES.map((code) => [`fruit-${code}`, loadImage(`/twemoji/${code}.svg`)])),
  ...Object.fromEntries(POWER_UPS.map((p) => [p.type, loadImage(`/twemoji/${p.twemoji}.svg`)])),
  rat: loadImage(`/twemoji/${RAT_RULES.twemoji}.svg`),
  mouse: loadImage(`/twemoji/${RAT_RULES.mouseTwemoji}.svg`),
  chicken: loadImage(`/twemoji/${CHICKEN_RULES.twemoji}.svg`),
  alert: loadImage(`/twemoji/${CHICKEN_RULES.alertTwemoji}.svg`),
  badger: loadImage(`/twemoji/${BADGER_RULES.twemoji}.svg`),
  warning: loadImage(`/twemoji/${BADGER_RULES.warningTwemoji}.svg`),
  ...Object.fromEntries(HATS.map((h) => [`hat-${h.id}`, loadImage(`/twemoji/${h.twemoji}.svg`)])),
  // A bot's skill, by its name: 🐣 / ⚔️ / ☠️.
  ...Object.fromEntries(Object.entries(BOT_SKILL_TWEMOJI).map(([k, code]) => [`skill-${k}`, loadImage(`/twemoji/${code}.svg`)])),
};
// A random fruit out of the ones in use (only 🍎 when none is).
function randomFruit(enabled) {
  const list = Array.isArray(enabled) ? enabled.filter((c) => FRUIT_CODES.includes(c)) : FRUIT_CODES;
  return list.length ? `fruit-${list[Math.floor(Math.random() * list.length)]}` : 'apple';
}
// The fruit of the plain apple at a cell (one that arrived in a repeated
// tick message gets its random fruit here, the first time it's drawn).
function fruitAt(a) {
  const k = `${a.x},${a.y}`;
  if (!fruits.has(k)) fruits.set(k, randomFruit(latest?.fruits));
  return fruits.get(k);
}
// Whether the fruit or power-up of `kind` ('apple', or the power-up type) at
// a cell is drawn mirrored: picked at random when it appears, kept until it's
// eaten (like its fruit). Creatures face where they go instead.
const itemKey = (kind, x, y) => `${kind}:${x},${y}`;
function flipAt(kind, x, y) {
  const k = itemKey(kind, x, y);
  if (!flips.has(k)) flips.set(k, Math.random() < 0.5);
  return flips.get(k);
}
// 🐀 or 🐁, fixed per rat (a hash of its id, so it never changes mid-run).
const ratSprite = (id) => ((Math.imul(Number(id) | 0, 0x9e3779b1) >>> 16) & 1 ? 'mouse' : 'rat');

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

// Background: a checkerboard of two subtle dark shades, cached until the size
// changes.
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
  g.fillStyle = '#0f162b';
  // Whole-pixel edges, so neighbouring squares meet without seams.
  const edge = (i) => Math.round((i * size) / n);
  for (let y = 0; y < n; y++) {
    for (let x = y % 2; x < n; x += 2) g.fillRect(edge(x), edge(y), edge(x + 1) - edge(x), edge(y + 1) - edge(y));
  }
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
    if (spriteCache.size > 400) spriteCache.clear(); // old cell sizes (about 40 sprites per size)
    const c = document.createElement('canvas');
    c.width = c.height = px;
    c.getContext('2d').drawImage(entry.img, 0, 0, px, px);
    spriteCache.set(key, c);
  }
  return spriteCache.get(key);
}

// The same sprite with a color laid over it (only where the sprite is),
// cached alongside the plain ones under `tint`.
function tintedSprite(type, px, tint, fill) {
  const plain = sprite(type, px);
  if (!plain) return null;
  const key = `${type}:${px}:${tint}`;
  if (!spriteCache.has(key)) {
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');
    g.drawImage(plain, 0, 0);
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = fill;
    g.fillRect(0, 0, px, px);
    spriteCache.set(key, c);
  }
  return spriteCache.get(key);
}
// Icy blue, like a frozen snake (creatures slowed by freeze).
const frozenSprite = (type, px) => tintedSprite(type, px, 'frozen', 'rgba(159, 228, 255, 0.55)');
const creatureSprite = (type, px, frozen) => (frozen ? frozenSprite(type, px) : sprite(type, px));

// Time left on something the server counts down, as of now (the state is
// one tick old by the end of the tick).
const remainingNow = (ms, now) => Math.max(0, ms - (now - tickAt));

function boardItems(state, now) {
  const items = state.apples.map((a) => ({ type: 'apple', sprite: fruitAt(a), x: a.x, y: a.y, flip: flipAt('apple', a.x, a.y) }));
  for (const p of state.powerUps ?? []) items.push({ type: p.type, x: p.x, y: p.y, power: true, flip: flipAt(p.type, p.x, p.y) });
  // A bomb is one big sprite over its whole block, centered on (x, y).
  for (const b of state.bombs ?? []) {
    items.push({ type: 'bomb', x: b.x, y: b.y, size: POWER_UP_RULES.bombSize, power: true, remainingMs: remainingNow(b.remainingMs, now), flip: flipAt('bomb', b.x, b.y) });
  }
  // An eaten item stays until the (interpolated) head has reached it.
  for (const e of eaten) if (now < e.until) items.push({ type: e.item ?? 'apple', sprite: e.sprite, x: e.x, y: e.y, power: Boolean(e.item), flip: e.flip });
  return items;
}

function drawItems(items, cell, now) {
  for (const it of items) {
    const span = cell * (it.size ?? 1); // the item's whole block, in pixels
    const px = Math.max(1, Math.round(span * 0.84));
    let scale = 1;
    let alpha = 1;
    // A bomb blinks during its last seconds.
    if (it.type === 'bomb' && it.remainingMs !== undefined && it.remainingMs < POWER_UP_RULES.bombBlinkMs) {
      alpha = blinkAlpha(now);
    }
    if (it.power) {
      // Power-ups pulse gently (each a little out of step).
      scale = 1 + 0.09 * Math.sin(now / 190 + it.x * 1.7 + it.y);
      const cx = (it.x + 0.5) * cell;
      const cy = (it.y + 0.5) * cell;
      if (it.type === 'bomb') {
        // Danger, like the badger: a pulsing red outline round its block.
        ctx.save();
        ctx.globalAlpha = alpha;
        dangerOutline(cx, cy, span, span, cell, now);
        ctx.restore();
      } else {
        // The others sit on a soft glow, so they stand out from apples.
        const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, span * 0.8);
        glow.addColorStop(0, 'rgba(255, 240, 170, 0.32)');
        glow.addColorStop(1, 'rgba(255, 240, 170, 0)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx - span * 0.8, cy - span * 0.8, span * 1.6, span * 1.6);
      }
    }
    const size = px * scale;
    const x = (it.x + 0.5) * cell - size / 2;
    const y = (it.y + 0.5) * cell - size / 2;
    const img = sprite(it.sprite ?? it.type, px);
    ctx.globalAlpha = alpha;
    if (img && it.flip) {
      // Mirrored round its own center.
      ctx.save();
      ctx.translate(x + size / 2, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, -size / 2, y, size, size);
      ctx.restore();
    } else if (img) ctx.drawImage(img, x, y, size, size);
    else {
      ctx.fillStyle = it.type === 'apple' ? '#e53935' : '#ffd54a';
      disc((it.x + 0.5) * cell, (it.y + 0.5) * cell, span * 0.38 * scale);
    }
    ctx.globalAlpha = 1;
  }
}

// ---- portals ----
// Both ends drawn as swirling rings in a hue of their own, joined by a faint
// dashed line so the pair reads as one; they fade out during their last
// seconds. A closing pair (run out, a snake still on its way through) is
// drawn dim and still until it goes; one a snake is in fades only to that
// dim level, so closing doesn't flash it back in.
const PORTAL_CLOSING_ALPHA = 0.35;
function drawPortals(portals, cell, now, state) {
  for (const p of portals) {
    const left = remainingNow(p.remainingMs, now);
    const fade = Math.min(1, left / POWER_UP_RULES.portalFadeMs);
    const alpha = p.closing ? PORTAL_CLOSING_ALPHA : spansPortal(p, state) ? Math.max(fade, PORTAL_CLOSING_ALPHA) : fade;
    if (alpha <= 0) continue;
    const hue = (p.id * 137.5) % 360;
    const color = (a) => `hsla(${hue}, 90%, 65%, ${a})`;
    const ends = p.ends.map((c) => ({ x: (c.x + 0.5) * cell, y: (c.y + 0.5) * cell }));
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
    for (const c of ends) {
      // Two-way: both ends look the same.
      const spin = p.closing ? 0 : now / 400;
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
    }
    ctx.restore();
  }
}

// Whether a snake is split across the pair: a segment on one end, the next
// one beside the other end (as the engine decides when to close it).
function spansPortal(p, state) {
  const n = state.gridSize;
  const wrap = state.rules?.wrapWalls;
  const near = (a, b) => {
    let dx = Math.abs(a.x - b.x);
    let dy = Math.abs(a.y - b.y);
    if (wrap) {
      dx = Math.min(dx, n - dx);
      dy = Math.min(dy, n - dy);
    }
    return dx + dy === 1;
  };
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const segs = s.segments;
    for (let i = 0; i + 1 < segs.length; i++) {
      const k = p.ends.findIndex((c) => c.x === segs[i].x && c.y === segs[i].y);
      if (k !== -1 && !near(segs[i + 1], segs[i]) && near(segs[i + 1], p.ends[1 - k])) return true;
    }
  }
  return false;
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

// Clips to the body's exact shape: a line with round joins and caps is the
// union of a rectangle per straight piece and a circle at every point. All
// pieces wind the same way, so the nonzero rule fills their union.
function clipToBody(chains, u0, u1, cell, r, extra = []) {
  ctx.beginPath();
  for (const c of extra) {
    ctx.moveTo(c.x + c.r, c.y);
    ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  }
  for (const chain of chains) {
    const pts = subPath(chain, u0, u1);
    if (!pts) continue;
    const px = pts.map((q) => ({ x: (q.x + 0.5) * cell, y: (q.y + 0.5) * cell }));
    for (let i = 1; i < px.length; i++) {
      const a = px[i - 1];
      const b = px[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const nx = (-(b.y - a.y) / len) * r;
      const ny = ((b.x - a.x) / len) * r;
      ctx.moveTo(a.x - nx, a.y - ny);
      ctx.lineTo(b.x - nx, b.y - ny);
      ctx.lineTo(b.x + nx, b.y + ny);
      ctx.lineTo(a.x + nx, a.y + ny);
      ctx.closePath();
    }
    for (const q of px) {
      ctx.moveTo(q.x + r, q.y);
      ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
    }
  }
  ctx.clip();
}

// How far a stripe band reaches either side of its path, in cells: enough to
// cover the outside of a bend, short of the next leg of a tight zigzag.
const STRIPE_REACH = 0.6;

function disc(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

// Draws one snake; returns where its head is (in px) for the name label.
// `anim` is the snake's animation state, or null when the animations are
// off; `frame` is what they react to: { dt, tickMs, food, heads }.
// `hat`: the hat id it wears, or null.
function drawSnake(s, prev, t, cell, n, now, anim = null, frame = null, hat = null) {
  const look = snakeLook(s, now);
  if (look.alpha <= 0 || !s.segments.length) return null;
  const path = snakePath(s, s.alive ? prev : null, t, n);
  const { chains, front, back, segU } = path;
  const width = cell * look.width;
  // The snake's speed in cells per second: golden moves 2 cells a tick, a
  // frozen snake only every second tick.
  const cellsPerSec = frame?.tickMs > 0 ? (1000 / frame.tickMs) * (s.effect?.type === 'golden' ? 2 : 1) * (s.frozen ? 0.5 : 1) : 5;
  const bumps = anim && s.alive ? swallowBumps(anim, chains, front, back, width, cell, now, BUMP_SPEED * cellsPerSec) : [];
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
  ctx.fillStyle = look.color;
  for (const b of bumps) disc(b.x, b.y, b.r);

  // ...then every other segment in the darker shade. Stripes belong to the
  // segments (counted from the head), so they travel with the body. Each is
  // a band along the rounded path, square to it, so it turns through bends,
  // clipped to the body so nothing shows past its outline.
  ctx.save();
  clipToBody(chains, front, back, cell, width / 2, bumps);
  ctx.lineCap = 'butt';
  ctx.lineWidth = cell * STRIPE_REACH * 2;
  ctx.strokeStyle = look.dark;
  ctx.beginPath();
  for (let j = 1; j < segU.length; j += 2) {
    const lo = Math.max(front, segU[j] - 0.5);
    const hi = Math.min(back, segU[j] + 0.5);
    if (lo >= hi) continue;
    for (const chain of chains) {
      const pts = smoothSubPath(chain, lo, hi);
      if (!pts || pts.length < 2) continue;
      ctx.moveTo((pts[0].x + 0.5) * cell, (pts[0].y + 0.5) * cell);
      for (let i = 1; i < pts.length; i++) ctx.lineTo((pts[i].x + 0.5) * cell, (pts[i].y + 0.5) * cell);
    }
  }
  ctx.stroke();
  ctx.fillStyle = look.dark;
  if (segU.length > 1 && (segU.length - 1) % 2 === 1) {
    for (const p of pointsAt(chains, back)) disc((p.x + 0.5) * cell, (p.y + 0.5) * cell, width / 2); // round tail tip
  }
  ctx.restore();

  // Head: a bit wider than the body, with big eyes.
  const d = DIR_VECTORS[s.dir] ?? [1, 0];
  const headR = (width / 2) * look.headScale;
  // Every copy of the head (two while wrapping). The one on the board gets
  // the name label, and the animated eyes look out from it.
  const heads = pointsAt(chains, front).map((p) => ({
    x: (p.x + 0.5) * cell,
    y: (p.y + 0.5) * cell,
    onBoard: p.x >= -0.5 && p.y >= -0.5 && p.x <= n - 0.5 && p.y <= n - 0.5,
  }));
  let label = null;
  for (const h of heads) if (!label || h.onBoard) label = { x: h.x, y: h.y, r: headR };
  const travel = travelDirAt(chains, front);
  // Without the animations the same face is drawn, just still: eyes ahead.
  const pose = !label ? null : anim ? facePose(s, anim, label, travel, cell, now, frame) : stillPose(travel ?? { x: d[0], y: d[1] });
  for (const { x: hx, y: hy } of heads) {
    drawFace(hx, hy, pose, look, headR, cell);
    if (hat && s.alive) drawHat(hx, hy, pose.angle, hat, headR);
    // Shield: a ring around the head.
    if (look.ring) {
      ctx.lineWidth = Math.max(1.5, cell * 0.08);
      ctx.strokeStyle = `rgba(140, 220, 255, ${0.7 + 0.25 * Math.sin(now / 160)})`;
      ctx.beginPath();
      ctx.arc(hx, hy, headR * 1.55, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.restore();
  return label;
}

// ---- snake animations (an /admin toggle, on by default) ----
// Purely cosmetic, worked out from what /display already gets: eyes that
// blink and look at nearby food or snakes, a tongue that flicks out now and
// then, a mouth that opens when food is straight ahead, and a bump that runs
// down the body after each bite. Every snake has its own random timers, so
// they don't blink or lick in step.
const BLINK_MS = 150;
const WINK_MS = 400; // after a kill: one eye shuts, stays shut a moment, opens
const BLINK_EVERY_MS = [2000, 6000];
const TONGUE_MS = 300;
const TONGUE_EVERY_MS = [2500, 7000];
const LOOK_RANGE = 4; // cells: the eyes follow food or a head this close
const MOUTH_RANGE = 3; // cells: the mouth opens for food this far straight ahead
const BUMP_SPEED = 2; // times the snake's own current speed, whatever its length
const FINE_DETAIL_PX = 14; // smaller cells skip nostrils, fangs and the tongue's fork

const between = ([lo, hi]) => lo + Math.random() * (hi - lo);
const anims = new Map(); // snake id -> its animation state
function animOf(id, now) {
  let a = anims.get(id);
  if (!a) {
    a = {
      blinkAt: now + between([300, BLINK_EVERY_MS[1]]),
      blinkStart: -Infinity,
      winkStart: -Infinity,
      winkSide: 1, // which eye winks: -1 or 1
      tongueAt: now + between([800, TONGUE_EVERY_MS[1]]),
      tongueStart: -Infinity,
      look: null, // where the pupils point: a vector of length <= 1, in screen space
      heading: null, // the angle the face points at, in radians
      mouth: 0, // 0 closed .. 1 wide open
      bumps: [], // { start, size }: swallowed food on its way to the tail
      head: null, // head center in cells as last drawn, for the others' eyes
    };
    anims.set(id, a);
  }
  return a;
}

// Each bite's bump, as circles (px) drawn into the body. A bump starts at
// the head once the food has visibly gone in, swells, runs down the body
// and shrinks away at the tail. Its place is counted in segments from the
// head (front + offset), so it travels with the body as that slides.
// speed: segments per second. It's added up frame by frame (b.off), so a
// change of speed (golden, freeze) never makes a bump jump.
function swallowBumps(anim, chains, front, back, width, cell, now, speed) {
  const len = back - front;
  const out = [];
  for (const b of anim.bumps) {
    if (now < b.start) continue; // not swallowed yet
    b.off = (b.off ?? 0) + ((now - Math.max(b.start, b.at ?? b.start)) / 1000) * speed;
    b.at = now;
  }
  anim.bumps = anim.bumps.filter((b) => (b.off ?? 0) <= len + 0.5);
  for (const b of anim.bumps) {
    if (now < b.start) continue;
    const off = b.off;
    const swell = clamp(Math.min(off / 0.8, (len + 0.5 - off) / 1.2), 0, 1);
    const r = (width / 2) * (1 + 0.4 * b.size * swell);
    for (const p of pointsAt(chains, Math.min(back, front + off))) out.push({ x: (p.x + 0.5) * cell, y: (p.y + 0.5) * cell, r });
  }
  return out;
}

// Moves `from` toward `to` by the share an exponential ease with time
// constant tau (ms) covers in dt (ms).
const ease = (from, to, dt, tau) => from + (to - from) * (1 - Math.exp(-dt / Math.max(1, tau)));

// Updates a snake's timers and smoothed values for this frame and returns
// how its face looks. headPx: the head on the board, in px. travel: the grid
// step the head is moving along (null when it isn't moving).
function facePose(s, a, headPx, travel, cell, now, frame) {
  const dtMs = frame.dt * 1000;
  const v = DIR_VECTORS[s.dir] ?? [1, 0];
  if (!s.alive) {
    a.head = null;
    a.bumps = [];
    return { angle: a.heading ?? Math.atan2(v[1], v[0]), look: a.look ?? { x: 0, y: 0 }, blink: 0, wink: 0, winkSide: 1, tongue: -1, mouth: 0, dead: true };
  }
  const head = { x: headPx.x / cell - 0.5, y: headPx.y / cell - 0.5 };
  a.head = head;

  // Heading: along the leg the head is on. A turn eases in over about the
  // first 30% of the tick (95% of the way after 3 time constants), so the
  // head snaps round instead of sweeping through the whole tick.
  const dir = travel ?? { x: v[0], y: v[1] };
  const target = Math.atan2(dir.y, dir.x);
  if (a.heading === null) a.heading = target;
  else {
    const diff = Math.atan2(Math.sin(target - a.heading), Math.cos(target - a.heading)); // the short way round
    a.heading = ease(a.heading, a.heading + diff, dtMs, frame.tickMs * 0.1);
  }

  // Eyes: the nearest food or other head within reach, otherwise ahead.
  let best = null;
  let bestD = LOOK_RANGE;
  const consider = (p) => {
    const dist = Math.hypot(p.x - head.x, p.y - head.y);
    if (dist > 0.3 && dist <= bestD) {
      best = p;
      bestD = dist;
    }
  };
  for (const f of frame.food) consider(f);
  for (const [id, h] of frame.heads) if (id !== s.id) consider(h);
  const want = best
    ? { x: (best.x - head.x) / bestD, y: (best.y - head.y) / bestD }
    : { x: Math.cos(a.heading) * 0.6, y: Math.sin(a.heading) * 0.6 };
  a.look ??= want;
  a.look = { x: ease(a.look.x, want.x, dtMs, 70), y: ease(a.look.y, want.y, dtMs, 70) };

  // Mouth: wide open while food is up to MOUTH_RANGE cells straight ahead in
  // its lane; it shuts once the food is gone (eaten) or out of line.
  let open = 0;
  for (const f of frame.food) {
    const rx = f.x - head.x;
    const ry = f.y - head.y;
    const ahead = rx * dir.x + ry * dir.y;
    if (ahead > 0.05 && ahead <= MOUTH_RANGE + 0.3 && Math.abs(rx * dir.y - ry * dir.x) < 0.55) open = 1;
  }
  a.mouth = ease(a.mouth, open, dtMs, open ? 55 : 35);

  // Blinks and tongue flicks, each on its own random timer.
  if (now >= a.blinkAt) {
    a.blinkStart = now;
    a.blinkAt = now + between(BLINK_EVERY_MS);
  }
  if (now >= a.tongueAt) {
    if (a.mouth < 0.1) a.tongueStart = now; // not while the mouth is open
    a.tongueAt = now + between(TONGUE_EVERY_MS);
  }
  const sinceBlink = now - a.blinkStart;
  const sinceWink = now - a.winkStart;
  const sinceTongue = now - a.tongueStart;
  return {
    angle: a.heading,
    look: a.look,
    blink: sinceBlink < BLINK_MS ? Math.sin((Math.PI * sinceBlink) / BLINK_MS) : 0,
    tongue: sinceTongue < TONGUE_MS ? sinceTongue / TONGUE_MS : -1,
    mouth: a.mouth < 0.01 ? 0 : a.mouth,
    // Shuts in the first 20%, stays shut, opens in the last 20%.
    wink: sinceWink >= 0 && sinceWink < WINK_MS ? clamp(Math.min(sinceWink, WINK_MS - sinceWink) / (WINK_MS * 0.2), 0, 1) : 0,
    winkSide: a.winkSide,
    dead: false,
  };
}

// The face with the animations off: big eyes looking ahead, nothing moving.
function stillPose(dir) {
  const angle = Math.atan2(dir.y, dir.x);
  return { angle, look: { x: Math.cos(angle) * 0.6, y: Math.sin(angle) * 0.6 }, blink: 0, wink: 0, winkSide: 1, tongue: -1, mouth: 0, dead: false };
}

// The head at (hx, hy) px, drawn in the head's own frame: +x is
// where it faces, +y its right.
function drawFace(hx, hy, pose, look, headR, cell) {
  const fine = cell >= FINE_DETAIL_PX;
  const m = pose.mouth;
  ctx.save();
  ctx.translate(hx, hy);
  ctx.rotate(pose.angle);

  // Tongue, under the head: flicks out and back in, wagging fast.
  if (pose.tongue >= 0) {
    const out = Math.sin(Math.PI * pose.tongue);
    const base = headR * 0.6;
    const len = headR * 0.4 + cell * 0.42 * out; // from inside the head to the tip
    ctx.save();
    ctx.translate(base, 0);
    ctx.rotate(Math.sin(pose.tongue * Math.PI * 6) * 0.4 * out);
    ctx.strokeStyle = '#e53950';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(1, cell * 0.07);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len, 0);
    if (fine) {
      const fork = cell * 0.13 * out;
      ctx.moveTo(len + fork * Math.cos(0.6), -fork * Math.sin(0.6));
      ctx.lineTo(len, 0);
      ctx.lineTo(len + fork * Math.cos(0.6), fork * Math.sin(0.6));
    }
    ctx.stroke();
    ctx.restore();
  }

  ctx.fillStyle = look.color;
  disc(0, 0, headR);

  // Open mouth, a goofy ":D": a big half-disc jutting out of the front of
  // the head, rimmed in the body color and dark inside. Its flat edge (the
  // upper jaw) sits across the head, and the fangs hang from it.
  if (m > 0) {
    const x0 = headR * 0.52; // the flat edge, a little in front of the eyes
    const r = headR * 0.95 * m;
    const rim = Math.max(1, headR * 0.16);
    const half = (radius) => {
      ctx.beginPath();
      ctx.moveTo(x0, -radius);
      ctx.arc(x0, 0, radius, -Math.PI / 2, Math.PI / 2);
      ctx.closePath();
      ctx.fill();
    };
    ctx.fillStyle = look.color;
    half(r + rim);
    ctx.fillStyle = darker(look.color, 0.55);
    half(r);
    if (fine) {
      ctx.fillStyle = '#ffffff';
      for (const k of [-1, 1]) {
        const y = k * r * 0.5;
        ctx.beginPath();
        ctx.moveTo(x0, y - r * 0.13);
        ctx.lineTo(x0 + r * 0.3, y);
        ctx.lineTo(x0, y + r * 0.13);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  // Nostrils, fading out as the mouth opens.
  if (fine && m < 0.25) {
    ctx.save();
    ctx.globalAlpha *= 1 - m * 4;
    ctx.fillStyle = look.dark;
    for (const k of [-1, 1]) disc(headR * 0.66, k * headR * 0.27, Math.max(0.8, headR * 0.075));
    ctx.restore();
  }

  // Eyes: big, on top of the head and poking out past its sides.
  const eyeR = headR * 0.46;
  // The look vector, turned into the head's frame.
  const cos = Math.cos(-pose.angle);
  const sin = Math.sin(-pose.angle);
  const lx = pose.look.x * cos - pose.look.y * sin;
  const ly = pose.look.x * sin + pose.look.y * cos;
  for (const k of [-1, 1]) {
    const ex = -headR * 0.12;
    const ey = k * headR * 0.66;
    ctx.fillStyle = '#ffffff';
    disc(ex, ey, eyeR);
    if (pose.dead) {
      // X eyes.
      const a = eyeR * 0.5;
      ctx.strokeStyle = '#111111';
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, eyeR * 0.3);
      ctx.beginPath();
      ctx.moveTo(ex - a, ey - a);
      ctx.lineTo(ex + a, ey + a);
      ctx.moveTo(ex + a, ey - a);
      ctx.lineTo(ex - a, ey + a);
      ctx.stroke();
    } else {
      ctx.fillStyle = '#111111';
      disc(ex + lx * eyeR * 0.4, ey + ly * eyeR * 0.4, eyeR * 0.55);
      const shut = Math.max(pose.blink, k === pose.winkSide ? pose.wink : 0);
      if (shut > 0) {
        // Eyelids in the darker body color, closing from the front and back.
        ctx.save();
        ctx.beginPath();
        ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
        ctx.clip();
        ctx.fillStyle = look.dark;
        const lid = eyeR * shut * 1.02;
        ctx.fillRect(ex - eyeR, ey - eyeR, lid, eyeR * 2);
        ctx.fillRect(ex + eyeR - lid, ey - eyeR, lid, eyeR * 2);
        ctx.restore();
      }
    }
    ctx.lineWidth = Math.max(1, cell * 0.1);
    ctx.strokeStyle = look.dark;
    ctx.beginPath();
    ctx.arc(ex, ey, eyeR, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// A hat on the head at (hx, hy) px: its top points back toward the tail
// (upright when the snake goes down), turning with the face (same eased
// angle), sized to the head.
const HAT_SIZE = 2.5; // hat width, in head radii
const HAT_BACK = 1.5; // how far behind the head's center the hat sits, in head radii (negative: toward the face)
function drawHat(hx, hy, angle, hat, headR) {
  const px = Math.max(4, Math.round(headR * HAT_SIZE));
  const img = sprite(`hat-${hat}`, px);
  if (!img) return;
  const back = headR * HAT_BACK;
  ctx.save();
  // Moved along the heading first, so the offset doesn't depend on which way
  // the sprite is turned below.
  ctx.translate(hx - Math.cos(angle) * back, hy - Math.sin(angle) * back);
  ctx.rotate(angle - Math.PI / 2);
  ctx.drawImage(img, -px / 2, -px / 2, px, px);
  ctx.restore();
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
    // A bot's skill emoji goes in front of its name; the two are centered together.
    const icon = l.skill ? ITEM_IMAGES[`skill-${l.skill}`] : null;
    const iconW = icon?.ready ? Math.round(fontPx * 1.15) : 0;
    const iconGap = iconW ? Math.round(fontPx * 0.25) : 0;
    const text = truncate(l.name, maxWidth - iconW - iconGap, font);
    const textW = ctx.measureText(text).width;
    const half = (iconW + iconGap + textW) / 2 + 3 * dpr;
    const x = clamp(l.x, half, size - half); // keep names on screen at the edges
    const gap = l.r + fontPx * 0.62;
    // Above the head when there's no room below (the bottom row, or a head
    // that's mid-way through a wrap at the bottom edge).
    const y = l.y + gap + fontPx / 2 > size ? l.y - gap : l.y + gap;
    const tx = x + (iconW + iconGap) / 2; // the text's center
    if (iconW) ctx.drawImage(icon.img, tx - textW / 2 - iconGap - iconW, y - iconW / 2, iconW, iconW);
    ctx.strokeText(text, tx, y);
    ctx.fillText(text, tx, y);
  }
  ctx.restore();
}

// ---- effects (each behind an /admin toggle) ----
const particles = []; // { x, y, vx, vy, born, life, r, color } in cells / seconds
const rings = []; // { x, y, color, start, ms?, r0?, r1?, width? } (sizes in cells)
const flashes = []; // { x, y, w, h, start, ms }: a white flash over a w x h block of cells centered on (x, y)
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
  for (let i = flashes.length - 1; i >= 0; i--) {
    const f = flashes[i];
    const e = (now - f.start) / f.ms;
    if (e >= 1) {
      flashes.splice(i, 1);
      continue;
    }
    const hw = (f.w / 2) * cell;
    const hh = (f.h / 2) * cell;
    ctx.globalAlpha = 0.85 * (1 - e) ** 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((f.x + 0.5) * cell - hw, (f.y + 0.5) * cell - hh, hw * 2, hh * 2);
  }
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    const e = (now - r.start) / (r.ms ?? RING_MS);
    if (e >= 1) {
      rings.splice(i, 1);
      continue;
    }
    if (e < 0) continue; // starts a moment later
    const ease = 1 - (1 - e) ** 3;
    const r0 = r.r0 ?? 0.3;
    const r1 = r.r1 ?? 1.25;
    ctx.globalAlpha = 1 - e;
    ctx.strokeStyle = r.color;
    ctx.lineWidth = cell * (r.width ?? 0.14) * (1 - e) + dpr;
    ctx.beginPath();
    ctx.arc((r.x + 0.5) * cell, (r.y + 0.5) * cell, cell * (r0 + (r1 - r0) * ease), 0, Math.PI * 2);
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
    if (p.star) star(p.x * cell, p.y * cell, p.r * cell * (1 - 0.3 * e) * (0.75 + 0.25 * Math.sin((now - p.born) / 40)), p.spin + (now - p.born) / 300);
    else disc(p.x * cell, p.y * cell, p.r * cell * (1 - 0.5 * e));
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

// ---- kill popups (an /admin toggle) ----
// "KILL!", "DOUBLE KILL!!"... over the head of a snake killed by another,
// tilted, popping in with a burst, then floating up and fading. The more
// kills the killer has this round, the bigger and hotter it gets.
const KILL_POPUP_MS = 1500;
const KILL_TIERS = ['#ffffff', '#ffe066', '#ffa726', '#ff5252', '#e040fb']; // fill per kill number
// Killing the leader in kills or length, first blood or a projectile kill
// (the death's takedown) adds a second text below, with the same tilt, that
// drops instead of rising.
const TAKEDOWN_FILL = { streak: '#4de3ff', mvp: '#ffd700', firstBlood: '#ff3344', hit: '#ff9100' };
const TAKEDOWN_DELAY_MS = 140; // lands just after the KILL!
const killPopups = []; // { x, y, n, text, color, start, tilt, end, takedown? }

function killText(n) {
  const names = STRINGS.display.killPopups;
  return n <= names.length ? names[n - 1] : fmt(STRINGS.display.killPopupMore, { n });
}

function addKillPopup(x, y, n, color, now, takedown = null) {
  // Kills close together: the older popups nearby make way, fading out fast
  // (before this kill's own texts go in, so they don't).
  for (const p of killPopups) {
    if (Math.abs(p.x - x) < 5 && Math.abs(p.y - y) < 3) p.end = Math.min(p.end, now + 200);
  }
  const side = Math.random() < 0.5 ? -1 : 1;
  const tilt = side * (0.08 + Math.random() * 0.12);
  killPopups.push({ x, y, n, text: killText(n), color, start: now, tilt, end: now + KILL_POPUP_MS });
  if (takedown && TAKEDOWN_FILL[takedown]) {
    const start = now + TAKEDOWN_DELAY_MS;
    killPopups.push({ x, y, n: 2, text: STRINGS.display.takedowns[takedown], color, start, tilt, end: start + KILL_POPUP_MS, takedown });
    // Its own burst, falling.
    const fill = TAKEDOWN_FILL[takedown];
    for (let i = 0; i < 26 && particles.length < MAX_PARTICLES; i++) {
      const a = Math.PI * (0.15 + Math.random() * 0.7); // downward fan
      const v = 4 + Math.random() * 5;
      particles.push({
        x: x + 0.5, y: y + 1, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: start,
        life: 700 + Math.random() * 500, r: 0.12 + Math.random() * 0.12, color: i % 2 ? fill : '#ffffff', star: true, spin: Math.random() * Math.PI,
      });
    }
    rings.push({ x, y, color: fill, start, ms: 600, r0: 0.5, r1: 2.6, width: 0.2 });
  }
  const hot = KILL_TIERS[Math.min(n, KILL_TIERS.length) - 1];
  const colors = ['#ffd54f', '#ffffff', color, hot];
  const tier = Math.min(n, 6);
  // Gold stars and confetti in the killer's color, more and faster each kill.
  for (let i = 0, count = 14 + 8 * tier; i < count && particles.length < MAX_PARTICLES; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = (5 + tier) * (0.35 + Math.random() * 0.65);
    particles.push({
      x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 1.5, born: now,
      life: 600 + Math.random() * 500, r: 0.1 + Math.random() * 0.12 + 0.02 * tier, color: colors[i % colors.length],
      star: i % 3 !== 2, spin: Math.random() * Math.PI,
    });
  }
  rings.push({ x, y, color: hot, start: now, ms: 520, r0: 0.4, r1: 1.4 + 0.35 * tier, width: 0.18 });
  if (n >= 2) rings.push({ x, y, color: color, start: now + 90, ms: 520, r0: 0.3, r1: 1 + 0.3 * tier, width: 0.12 });
}

const easeOutBack = (e) => 1 + 2.7 * (e - 1) ** 3 + 1.7 * (e - 1) ** 2;

function drawKillPopups(cell, size, now) {
  for (let i = killPopups.length - 1; i >= 0; i--) {
    const p = killPopups[i];
    const e = (now - p.start) / KILL_POPUP_MS;
    if (now >= p.end) {
      killPopups.splice(i, 1);
      continue;
    }
    if (e < 0) continue; // a takedown text, not in yet
    const tier = Math.min(p.n, 6);
    // Readable on any board: at least 2% of the board, half a cell otherwise.
    const fontPx = Math.round(Math.max(cell * 0.53, size * 0.02) * (1 + 0.22 * (tier - 1)));
    const font = `900 ${fontPx}px system-ui, "Segoe UI", Roboto, sans-serif`;
    const pop = easeOutBack(clamp(e / 0.16, 0, 1)); // 0 -> 1, overshooting
    const fade = Math.min(e < 0.65 ? 1 : 1 - (e - 0.65) / 0.35, (p.end - now) / 200); // making way: gone in 200 ms
    const rise = cell * 0.9 * (1 - (1 - e) ** 2); // up, or down for a takedown
    ctx.save();
    ctx.font = font;
    const w = ctx.measureText(p.text).width;
    const pad = fontPx * 0.4;
    const x = clamp((p.x + 0.5) * cell, w / 2 + pad, size - w / 2 - pad);
    const head = (p.y + 0.5) * cell;
    const y = clamp(p.takedown ? head + cell * 0.8 + rise : head - cell * 0.6 - rise, fontPx, size - fontPx);
    ctx.translate(x, y);
    // From 3 kills on it shakes a little as it lands.
    const wobble = tier >= 3 || p.takedown ? Math.sin((now - p.start) / 28) * 0.06 * (1 - clamp(e / 0.35, 0, 1)) : 0;
    ctx.rotate(p.tilt + wobble);
    ctx.scale(pop, pop);
    ctx.globalAlpha = clamp(fade, 0, 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    // A sticker: dark edge, the killer's color, then the fill.
    ctx.lineWidth = fontPx * 0.32;
    ctx.strokeStyle = 'rgba(4, 6, 12, 0.92)';
    ctx.strokeText(p.text, 0, 0);
    ctx.lineWidth = fontPx * 0.14;
    ctx.strokeStyle = p.color;
    ctx.strokeText(p.text, 0, 0);
    const fill = p.takedown
      ? TAKEDOWN_FILL[p.takedown]
      : p.n > KILL_TIERS.length ? `hsl(${((now - p.start) / 4) % 360}, 100%, 70%)` : KILL_TIERS[p.n - 1];
    if (tier >= 3 || p.takedown) {
      ctx.shadowColor = fill;
      ctx.shadowBlur = fontPx * 0.5;
    }
    ctx.fillStyle = fill;
    ctx.fillText(p.text, 0, 0);
    ctx.restore();
  }
}

// ---- tick bookkeeping ----
// The same tick can arrive more than once (admin actions also broadcast), so
// a tick is identified by round + tick number and handled only once.
let tickKey = '';
let tickAt = 0; // when the latest tick arrived
// id -> { snake, at, ms, chain? }: the snake before its latest move, sliding
// from it to the latest over `ms` from `at`. A frozen snake moves every
// second tick, so its slide spans both ticks instead of stopping and
// starting. A move that arrives before the slide is over (the freeze just
// ended) doesn't jump: `chain` { snake, p } is the unfinished slide (from
// chain.snake, p done), and the same `ms` covers the rest of it and then the
// new move, at one steady speed.
let prevSnakes = new Map();

// Where a slide is at `now`: the snake to draw (its segments), the one it
// slides from and how far (0..1); `done` is the progress of its latest move.
function slideAt(slide, cur, now) {
  if (!slide) return { shown: cur, from: null, t: 1, done: 1 };
  const f = slide.ms > 0 ? clamp((now - slide.at) / slide.ms, 0, 1) : 1;
  const c = slide.chain;
  if (!c) return { shown: cur, from: slide.snake, t: f, done: f };
  const a = (1 - c.p) / (2 - c.p); // the share of `ms` that finishes the old slide
  if (f < a) return { shown: { ...cur, segments: slide.snake.segments }, from: c.snake, t: c.p + (f / a) * (1 - c.p), done: 0 };
  const t = (f - a) / (1 - a);
  return { shown: cur, from: slide.snake, t, done: t };
}
let prevProjectiles = new Map(); // id -> projectile one tick before the latest
const diedAt = new Map(); // id -> when it died (for the fade)
let eaten = []; // { x, y, color, until, item?, sprite? }
let flights = []; // { x, y, id, color, start, sprite }: apples a magnet is pulling into a mouth
let fruits = new Map(); // "x,y" -> which fruit sprite the plain apple there is drawn as
let flips = new Map(); // itemKey -> whether that fruit or power-up is drawn mirrored
// Rats slide from cell to cell over the moveEveryTicks ticks a step takes.
// facing: 1 = as the emoji is drawn (left), -1 = mirrored (right).
let rats = new Map(); // id -> { from, to, start, ms, facing }
// Chickens slide the same way; alertSince: when its ❗ popped up (null: calm).
let chickens = new Map(); // id -> { from, to, start, ms, facing, alertSince }
// Rats and chickens sliding into the mouth that ate them; sprite: what to draw.
let eatenRats = []; // { from, to, start, ms, facing, color, sprite }
// Badgers slide like rats, a cell every moveEveryTicks ticks. Usually one,
// more when /admin adds them.
let badgerAnims = new Map(); // id -> { id, from, to, start, ms, facing }
// The last scissors hit on the badger: when, and the HP it left (/display
// flashes it white and fades the lost health-bar segment). null: none yet.
let badgerHit = null; // { id, at, hp }
const FLIGHT_MS = 200;

// Small bright sparks, e.g. where a projectile ends.
function sparks(x, y, now, count, colors) {
  for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 6 * (0.35 + Math.random() * 0.65);
    particles.push({ x: x + 0.5, y: y + 0.5, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: now, life: 300 + Math.random() * 300, r: 0.05 + Math.random() * 0.07, color: colors[i % colors.length] });
  }
}

// A bomb going off, centered on cell (x, y): a big fiery burst thrown out
// from the whole w x h block (the bomb's by default), a white flash on the
// block and a shockwave.
function explosion(x, y, now, w = POWER_UP_RULES.bombSize, h = w) {
  const reach = Math.max(w, h) / 2;
  const count = Math.round(120 * Math.sqrt((w * h) / POWER_UP_RULES.bombSize ** 2));
  const colors = ['#ff3d00', '#ff6d00', '#ff9100', '#ffc400', '#ffea00', '#d50000', '#ffffff'];
  for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
    const px = x + 0.5 + (Math.random() * 2 - 1) * (w / 2);
    const py = y + 0.5 + (Math.random() * 2 - 1) * (h / 2);
    // Outward from the center, a little scattered.
    const a = Math.atan2(py - y - 0.5, px - x - 0.5) + (Math.random() - 0.5) * 1.2;
    const v = 8 + Math.random() * 14;
    particles.push({ x: px, y: py, vx: Math.cos(a) * v, vy: Math.sin(a) * v, born: now, life: 650 + Math.random() * 650, r: 0.12 + Math.random() * 0.22, color: colors[i % colors.length] });
  }
  flashes.push({ x, y, w, h, start: now, ms: 220 });
  rings.push({ x, y, color: '#fff3c4', start: now, ms: 620, r0: reach, r1: reach + 2.6, width: 0.4 });
  rings.push({ x, y, color: '#ff7043', start: now + 90, ms: 650, r0: reach, r1: reach + 2, width: 0.25 });
}

// A handful of small twinkling stars thrown up around a head (a kill).
function sparkle(c, now) {
  const colors = ['#fff8c4', '#ffe066', '#ffffff', '#ffd23f'];
  for (let i = 0; i < 12 && particles.length < MAX_PARTICLES; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 1.2 + Math.random() * 2.2;
    const d = 0.35 + Math.random() * 0.35;
    particles.push({ x: c.x + 0.5 + Math.cos(a) * d, y: c.y + 0.5 + Math.sin(a) * d, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.8, born: now, life: 500 + Math.random() * 350, r: 0.12 + Math.random() * 0.12, color: colors[i % colors.length], star: true, spin: Math.random() * Math.PI });
  }
}

// A four-pointed star of radius r at (x, y) px, turned by `angle`.
function star(x, y, r, angle) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = angle + (i * Math.PI) / 4;
    const d = i % 2 ? r * 0.32 : r;
    ctx.lineTo(x + Math.cos(a) * d, y + Math.sin(a) * d);
  }
  ctx.closePath();
  ctx.fill();
}

// A bomb that ran out: a small grey puff of smoke. sx, sy stretch it for a
// block that isn't a bomb's (1 = a bomb's size).
function fizzle(x, y, now, sx = 1, sy = 1) {
  const colors = ['#9e9e9e', '#bdbdbd', '#757575', '#e0e0e0'];
  const count = Math.round(18 * sx * sy);
  for (let i = 0; i < count && particles.length < MAX_PARTICLES; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 1.5 + Math.random() * 2.5;
    particles.push({ x: x + 0.5 + Math.cos(a) * 0.4 * sx, y: y + 0.5 + Math.sin(a) * 0.4 * sy, vx: Math.cos(a) * v * sx, vy: Math.sin(a) * v * sy - 1, born: now, life: 550 + Math.random() * 400, r: 0.12 + Math.random() * 0.16, color: colors[i % colors.length] });
  }
  const s = Math.max(sx, sy);
  rings.push({ x, y, color: 'rgba(200, 200, 200, 0.8)', start: now, ms: 500, r0: 0.6 * s, r1: 1.7 * s, width: 0.1 });
}

// A snake that got a kill winks, with a little sparkle by its head.
function wink(snake, now) {
  const a = animOf(snake.id, now);
  a.winkStart = now;
  a.winkSide = Math.random() < 0.5 ? -1 : 1;
  sparkle(snake.segments[0], now);
}

// Sounds for this message (when /admin has them on). The audio is set up
// the first time they're on; the hint shows while the browser still waits
// for a click to allow it.
function playSounds(msg, newTick) {
  const on = Boolean(msg.effects?.sounds);
  if (on) {
    sfx.prepare();
    // Muted ones are left out first, so they don't take a slot in the spread.
    const gain = (name) => msg.soundGains?.[name] ?? 1;
    const names = soundsFor(latest?.state ?? null, msg.state, newTick).filter((name) => gain(name) > 0);
    for (const { name, delayMs } of spreadOverTick(names, msg.tickMs ?? 0)) sfx.play(name, gain(name), delayMs);
  }
  $('sound-hint').classList.toggle('hidden', !on || !sfx.blocked());
}
sfx.onStateChange(() => $('sound-hint').classList.toggle('hidden', !latest?.effects?.sounds || !sfx.blocked()));

function onState(msg) {
  const s = msg.state;
  const key = `${s.round}:${s.tick}`;
  playSounds(msg, key !== tickKey);
  if (key !== tickKey) {
    const now = performance.now();
    const sameRound = latest?.state.round === s.round;
    const before = prevSnakes;
    prevSnakes = new Map();
    if (sameRound) {
      for (const old of latest.state.snakes) {
        const cur = s.snakes.find((x) => x.id === old.id);
        if (!cur) continue;
        const moved = cur.segments[0]?.x !== old.segments[0]?.x || cur.segments[0]?.y !== old.segments[0]?.y;
        if (!moved) {
          // Frozen, sitting this tick out: carry on with the slide it's in.
          if (cur.frozen && before.has(old.id)) prevSnakes.set(old.id, before.get(old.id));
          continue;
        }
        // Frozen snakes sit out odd ticks (as in the engine).
        const skipsNext = cur.frozen && (s.tick + 1) % 2 === 1;
        const entry = { snake: old, at: now, ms: msg.tickMs * (skipsNext ? 2 : 1) };
        const last = before.get(old.id);
        if (last) {
          const { done } = slideAt(last, old, now);
          if (done < 1) entry.chain = { snake: last.snake, p: done };
        }
        prevSnakes.set(old.id, entry);
      }
    }
    prevProjectiles = sameRound ? new Map((latest.state.projectiles ?? []).map((x) => [x.id, x])) : new Map();
    if (!sameRound) {
      diedAt.clear();
      eaten = [];
      flights = [];
      rats = new Map();
      chickens = new Map();
      eatenRats = [];
      badgerAnims = new Map();
      anims.clear();
    }
    for (const id of anims.keys()) if (!s.snakes.some((x) => x.id === id)) anims.delete(id);
    // Each plain apple keeps its fruit; a new one gets a random one.
    const oldFruits = sameRound ? fruits : new Map();
    fruits = new Map();
    for (const a of s.apples) {
      const k = `${a.x},${a.y}`;
      fruits.set(k, oldFruits.get(k) ?? randomFruit(msg.fruits));
    }
    // Each fruit and power-up keeps its mirroring; a new one gets a random one.
    const oldFlips = sameRound ? flips : new Map();
    flips = new Map();
    const keepFlip = (kind, x, y) => {
      const k = itemKey(kind, x, y);
      flips.set(k, oldFlips.get(k) ?? Math.random() < 0.5);
    };
    for (const a of s.apples) keepFlip('apple', a.x, a.y);
    for (const p of s.powerUps ?? []) keepFlip(p.type, p.x, p.y);
    for (const b of s.bombs ?? []) keepFlip('bomb', b.x, b.y);
    const oldRats = rats;
    rats = new Map();
    for (const r of s.rats ?? []) {
      const old = oldRats.get(r.id);
      if (!old) rats.set(r.id, { from: r, to: r, start: now, ms: 1, facing: r.dir === 'right' ? -1 : 1 });
      else if (old.to.x === r.x && old.to.y === r.y) rats.set(r.id, old);
      else rats.set(r.id, ratStep(old, r, s.gridSize, now, msg.tickMs * (r.stepTicks ?? RAT_RULES.moveEveryTicks)));
    }
    const oldChickens = chickens;
    chickens = new Map();
    for (const c of s.chickens ?? []) {
      const old = oldChickens.get(c.id);
      let anim;
      if (!old) anim = { from: c, to: c, start: now, ms: 1, facing: c.dir === 'right' ? -1 : 1 };
      else if (old.to.x === c.x && old.to.y === c.y) anim = { ...old };
      else anim = ratStep(old, c, s.gridSize, now, msg.tickMs * (c.stepTicks ?? CHICKEN_RULES.moveEveryTicks));
      anim.alertSince = c.alerted ? (old?.alertSince ?? now) : null;
      chickens.set(c.id, anim);
    }
    // Where each badger was drawn until now (for its burst or puff if it's gone).
    const oldBadgers = badgerAnims;
    const badgerDrawnAt = (ev) => {
      const old = oldBadgers.get(ev.badgerId);
      return old ? ratAt(old, now) : ev;
    };
    badgerAnims = new Map();
    for (const b of s.badgers ?? (s.badger ? [s.badger] : [])) {
      const old = oldBadgers.get(b.id);
      let anim;
      if (!old) anim = { id: b.id, from: { x: b.x, y: b.y }, to: { x: b.x, y: b.y }, start: now, ms: 1, facing: b.dir === 'right' ? -1 : 1 };
      else if (old.to.x !== b.x || old.to.y !== b.y) {
        const dx = b.x - old.to.x;
        const facing = dx > 0 ? -1 : dx < 0 ? 1 : old.facing;
        anim = { id: b.id, from: ratAt(old, now), to: { x: b.x, y: b.y }, start: now, ms: Math.max(1, msg.tickMs * (b.stepTicks ?? BADGER_RULES.moveEveryTicks)), facing };
      } else anim = old;
      badgerAnims.set(b.id, anim);
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
        // A swallow bump, once the food has visibly gone in (a bomb isn't food).
        if (fx.snakeAnimations && ev.item !== 'bomb') {
          const start = now + (ev.magnet ? FLIGHT_MS : msg.tickMs * EAT_AT);
          animOf(ev.id, now).bumps.push({ start, size: ev.item === 'chicken' ? 1.8 : ev.item === 'rat' ? 1.5 : ev.item ? 1.2 : 1 });
        }
        // A bomb goes off at once (its x, y is the block's center).
        const fruit = ev.item ? undefined : oldFruits.get(`${ev.x},${ev.y}`);
        const flip = oldFlips.get(itemKey(ev.item ?? 'apple', ev.x, ev.y));
        if (ev.magnet) flights.push({ x: ev.x, y: ev.y, id: ev.id, color: colorOf(ev.id), start: now, sprite: fruit, flip });
        else if (ev.item === 'rat') {
          // It slides on from wherever it was drawn into the head's cell.
          const old = oldRats.get(ev.ratId);
          if (old) eatenRats.push({ ...ratStep(old, ev, s.gridSize, now, msg.tickMs * EAT_AT), color: colorOf(ev.id), sprite: ratSprite(ev.ratId) });
        } else if (ev.item === 'chicken') {
          const old = oldChickens.get(ev.chickenId);
          if (old) eatenRats.push({ ...ratStep(old, ev, s.gridSize, now, msg.tickMs * EAT_AT), color: colorOf(ev.id), sprite: 'chicken' });
        } else if (ev.item !== 'bomb') eaten.push({ x: ev.x, y: ev.y, color: colorOf(ev.id), until: now + msg.tickMs * EAT_AT, item: ev.item, sprite: fruit, flip });
        if (ev.item === 'bomb') {
          if (fx.screenShake) shakeStart = now;
          if (fx.particles) explosion(ev.x, ev.y, now);
        }
      } else if (ev.type === 'bombExpired') {
        if (fx.particles && ev.x !== undefined) fizzle(ev.x, ev.y, now);
      } else if (ev.type === 'badgerGone') {
        // Its lifetime ran out: it has faded, and goes in a puff the size of its block.
        const at = badgerDrawnAt(ev);
        if (fx.particles) fizzle(at.x, at.y, now, BADGER_RULES.width / POWER_UP_RULES.bombSize, BADGER_RULES.height / POWER_UP_RULES.bombSize);
      } else if (ev.type === 'badgerKilled') {
        // Shot: a bomb's burst, the size of its block. The shooter winks.
        const at = badgerDrawnAt(ev);
        if (fx.particles) explosion(at.x, at.y, now, BADGER_RULES.width, BADGER_RULES.height);
        if (fx.screenShake) shakeStart = now;
        const shooter = ev.byId && s.snakes.find((x) => x.id === ev.byId);
        if (fx.snakeAnimations && shooter?.alive) wink(shooter, now);
        // A credited kill: its popup over the badger's middle, like a snake's.
        if (fx.killPopups && ev.killNo) addKillPopup(Math.floor(at.x), Math.floor(at.y), ev.killNo, colorOf(ev.byId), now, ev.takedown ?? null);
      } else if (ev.type === 'badgerHit') {
        // A scissors hit: it flashes white, a segment of its bar goes.
        if (ev.badgerId !== undefined) badgerHit = { id: ev.badgerId, at: now, hp: ev.hp };
        if (fx.particles) sparks(ev.x, ev.y, now, 16, ['#ffffff', '#e0e0e0', '#ff5252']);
        if (fx.screenShake) shakeStart = now;
      } else if (ev.type === 'badgerBite') {
        if (fx.screenShake) shakeStart = now;
      } else if (ev.type === 'ratCaught') {
        if (fx.particles) sparks(ev.x, ev.y, now, 14, ['#bdbdbd', '#9e9e9e', '#ff5252']);
      } else if (ev.type === 'chickenDied') {
        // Shot or caught by the badger: a poof of feathers (a feast power-up takes its place).
        if (fx.particles) sparks(ev.x, ev.y, now, 16, ['#ffffff', '#ffe0b2', '#ff5252']);
      } else if (ev.type === 'projectileEnd') {
        if (fx.particles) sparks(ev.x, ev.y, now, ev.hit ? 22 : 10, ['#fffde7', '#ffe082', '#ffb74d']);
        if (ev.hit && fx.screenShake) shakeStart = now;
      } else if (ev.type === 'shieldPop') {
        const snake = s.snakes.find((x) => x.id === ev.id);
        if (snake && fx.particles) rings.push({ x: snake.segments[0].x, y: snake.segments[0].y, color: '#8cdcff', start: now });
        if (fx.screenShake) shakeStart = now;
      } else if (ev.type === 'cut') {
        if (fx.screenShake) shakeStart = now;
      } else if (ev.type === 'death') {
        diedAt.set(ev.id, now);
        const snake = s.snakes.find((x) => x.id === ev.id);
        if (fx.particles && snake) burst(snake, now);
        if (fx.screenShake) shakeStart = now; // every death, however it happened
        if (fx.killPopups && snake && ev.killNo) {
          const head = snake.segments[0];
          addKillPopup(head.x, head.y, ev.killNo, colorOf(ev.killerId), now, ev.takedown ?? null);
        }
        // The killer winks, with a little sparkle by its head.
        const killer = ev.killerId && s.snakes.find((x) => x.id === ev.killerId);
        if (fx.snakeAnimations && killer?.alive) wink(killer, now);
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
  // A canvas with no size (e.g. mid-resize, or a hidden window) can't be
  // drawn to: skip the frame.
  if (size <= 0 || canvas.height <= 0) return;
  const n = state.gridSize;
  const cell = size / n;
  ctx.drawImage(background(size, n), 0, 0);

  // Eaten apples whose head has arrived: start their ring.
  for (const e of eaten) {
    if (now >= e.until && !e.done) {
      e.done = true;
      if (msg.effects?.particles) rings.push({ x: e.x, y: e.y, color: e.color, start: now });
    }
  }
  eaten = eaten.filter((e) => !e.done);
  drawPortals(state.portals ?? [], cell, now, state);
  const items = boardItems(state, now);
  drawItems(items, cell, now);
  const frozen = Boolean(state.creaturesFrozen);
  drawRats(cell, n, now, msg.effects, frozen);
  const badgers = state.badgers ?? (state.badger ? [state.badger] : []);
  for (const b of badgers) drawBadger(b, cell, now, frozen);

  // What the snake faces react to: food (not bombs) as drawn right now, and
  // the other heads where they were last drawn.
  const animate = Boolean(msg.effects?.snakeAnimations);
  let frame = null;
  if (animate) {
    const food = items.filter((it) => it.type !== 'bomb');
    for (const r of rats.values()) food.push(ratAt(r, now));
    for (const c of chickens.values()) food.push(ratAt(c, now));
    for (const r of eatenRats) food.push(ratAt(r, now));
    const heads = new Map();
    for (const [id, a] of anims) if (a.head) heads.set(id, a.head);
    frame = { dt, tickMs: msg.tickMs, food, heads };
  }
  const animFor = (snake) => (animate ? animOf(snake.id, now) : null);

  const t = msg.tickMs > 0 ? clamp((now - tickAt) / msg.tickMs, 0, 1) : 1;
  const names = new Map(state.players.map((p) => [p.id, p.name]));
  const labels = [];
  const badges = [];
  const heads = new Map(); // id -> head center in pixels
  // Fading dead snakes first, so the living are drawn on top.
  for (const s of state.snakes) if (!s.alive) drawSnake(s, null, 1, cell, n, now, animFor(s), frame);
  for (const s of state.snakes) {
    if (!s.alive) continue;
    const { shown, from, t: st } = slideAt(prevSnakes.get(s.id), s, now);
    const head = drawSnake(shown, from, st, cell, n, now, animFor(s), frame, msg.hats?.[s.id] ?? null);
    if (head) labels.push({ ...head, name: names.get(s.id) ?? '', skill: msg.botSkills?.[s.id] ?? null });
    if (head) heads.set(s.id, head);
    if (head && s.effect) badges.push({ ...head, effect: s.effect });
  }
  drawProjectiles(state.projectiles ?? [], t, cell);
  drawFlights(heads, cell, n, now, msg.effects);
  drawEffects(cell, now, dt);
  drawEffectBadges(badges, cell, now);
  drawNames(labels, cell, size);
  drawKillPopups(cell, size, now);
  for (const b of badgers) drawBadgerHud(b, badgerLabel(msg.badgerName, b.n, badgers.length), cell, size, now);
  applyShake(now);
}

// ---- rats ----
// Where a rat sliding from -> to is drawn at `now`, in cells.
function ratAt(r, now) {
  const k = clamp((now - r.start) / r.ms, 0, 1);
  return { x: r.from.x + (r.to.x - r.from.x) * k, y: r.from.y + (r.to.y - r.from.y) * k };
}

// A rat drawn as `old` heading for cell `to` from now on, over `ms`. It
// carries on from where it is drawn; across a wrapping edge it comes in from
// just off the board instead. Moving right mirrors it, left draws it as is,
// up or down keeps the way it faced.
function ratStep(old, to, n, now, ms) {
  let dx = to.x - old.to.x;
  let dy = to.y - old.to.y;
  const wrapped = Math.abs(dx) > n / 2 || Math.abs(dy) > n / 2;
  if (Math.abs(dx) > n / 2) dx -= Math.sign(dx) * n;
  if (Math.abs(dy) > n / 2) dy -= Math.sign(dy) * n;
  const from = wrapped ? { x: to.x - dx, y: to.y - dy } : ratAt(old, now);
  const facing = dx > 0 ? -1 : dx < 0 ? 1 : old.facing;
  return { from, to: { x: to.x, y: to.y }, start: now, ms: Math.max(1, ms), facing };
}

// A rat or a chicken (type: its sprite), unrotated, mirrored when facing
// right, on a soft green glow.
function drawRat(x, y, facing, cell, n, type, frozen) {
  const px = Math.max(1, Math.round(cell * 0.9));
  const img = creatureSprite(type, px, frozen);
  // Partly off one edge (wrapping in): also drawn on the other side.
  const xs = [x, ...(x < 0 ? [x + n] : x > n - 1 ? [x - n] : [])];
  const ys = [y, ...(y < 0 ? [y + n] : y > n - 1 ? [y - n] : [])];
  for (const ax of xs) {
    for (const ay of ys) {
      ctx.save();
      ctx.translate((ax + 0.5) * cell, (ay + 0.5) * cell);
      // A soft green glow: food (where the badger's red means danger).
      const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, cell * 0.8);
      glow.addColorStop(0, 'rgba(110, 255, 140, 0.24)');
      glow.addColorStop(1, 'rgba(110, 255, 140, 0)');
      ctx.fillStyle = glow;
      ctx.fillRect(-cell * 0.8, -cell * 0.8, cell * 1.6, cell * 1.6);
      if (img) {
        ctx.scale(facing, 1);
        ctx.drawImage(img, -px / 2, -px / 2, px, px);
      } else {
        ctx.fillStyle = '#9e9e9e';
        disc(0, 0, cell * 0.36);
      }
      ctx.restore();
    }
  }
}

// A chicken's ❗ while it's alerted: it pops up above it, bobs a little,
// and stays on the board on the top row.
function drawAlert(x, y, since, cell, now) {
  const k = clamp((now - since) / 220, 0, 1);
  const pop = k < 1 ? 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2 : 1; // ease out, overshooting a little
  const size = cell * 0.62 * pop;
  const px = Math.max(1, Math.round(cell * 0.62));
  const img = sprite('alert', px);
  if (!img || size <= 0) return;
  const cx = (x + 0.5) * cell;
  const bob = Math.sin(now / 110) * cell * 0.06;
  const cy = Math.max(size / 2, (y + 0.5) * cell - cell * 0.8 + bob);
  ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
}

function drawRats(cell, n, now, fx, frozen) {
  for (const [id, r] of rats) {
    const at = ratAt(r, now);
    drawRat(at.x, at.y, r.facing, cell, n, ratSprite(id), frozen);
  }
  for (const c of chickens.values()) {
    const at = ratAt(c, now);
    drawRat(at.x, at.y, c.facing, cell, n, 'chicken', frozen);
  }
  for (const c of chickens.values()) {
    if (c.alertSince === null) continue;
    const at = ratAt(c, now);
    drawAlert(at.x, at.y, c.alertSince, cell, now);
  }
  eatenRats = eatenRats.filter((r) => {
    if (now >= r.start + r.ms) {
      if (fx?.particles) rings.push({ x: r.to.x, y: r.to.y, color: r.color, start: now });
      return false;
    }
    const at = ratAt(r, now);
    drawRat(at.x, at.y, r.facing, cell, n, r.sprite, frozen);
    return true;
  });
}

// ---- the honey badger ----
// One big 🦡 over its whole block, never rotated, mirrored when heading
// right (the emoji faces left). Red means danger: during its warning the
// block gets a dashed, pulsing red outline with ⚠️ in the middle; once
// active, a glowing red outline pulses round it, and it blinks during its
// last seconds, like a bomb.
const BADGER_ART_TOP = 0.68; // where the badger's middle is in the emoji's square, from the top (it sits low)

function blockPath(x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}

// Something deadly (the badger, a bomb): a faint red fill and a glowing,
// pulsing red line just outside its w x h block centered on (cx, cy).
function dangerOutline(cx, cy, w, h, cell, now) {
  const pulse = 0.5 + 0.5 * Math.sin(now / 150);
  const pad = cell * 0.08;
  ctx.save();
  blockPath(cx - w / 2 - pad, cy - h / 2 - pad, w + 2 * pad, h + 2 * pad, cell * 0.35);
  ctx.fillStyle = `rgba(255, 30, 30, ${0.1 + 0.08 * pulse})`;
  ctx.fill();
  ctx.shadowColor = 'rgba(255, 30, 30, 0.95)';
  ctx.shadowBlur = cell * (0.35 + 0.45 * pulse);
  ctx.lineWidth = Math.max(2, cell * (0.1 + 0.06 * pulse));
  ctx.strokeStyle = `rgb(255, ${Math.round(40 + 70 * pulse)}, ${Math.round(40 + 30 * pulse)})`;
  ctx.stroke();
  ctx.restore();
}

// On and off, for something about to go.
const blinkAlpha = (now) => (Math.floor(now / 140) % 2 === 0 ? 1 : 0.25);

function drawBadger(b, cell, now, frozen) {
  const badgerAnim = badgerAnims.get(b.id);
  if (!badgerAnim) return;
  const at = ratAt(badgerAnim, now);
  const w = b.width * cell;
  const h = b.height * cell;
  const cx = (at.x + 0.5) * cell;
  const cy = (at.y + 0.5) * cell;
  const pulse = 0.5 + 0.5 * Math.sin(now / 150);
  const pad = cell * 0.08;
  ctx.save();
  if (b.warningMs > 0) {
    ctx.globalAlpha = 0.45 + 0.55 * pulse;
    blockPath(cx - w / 2 + pad, cy - h / 2 + pad, w - 2 * pad, h - 2 * pad, cell * 0.3);
    ctx.fillStyle = 'rgba(255, 40, 40, 0.14)';
    ctx.fill();
    ctx.setLineDash([cell * 0.4, cell * 0.22]);
    ctx.lineDashOffset = -now / 40; // the dashes crawl round
    ctx.lineWidth = Math.max(2, cell * 0.13);
    ctx.strokeStyle = '#ff2b2b';
    ctx.stroke();
    ctx.setLineDash([]);
    const px = Math.max(1, Math.round(h * 0.62));
    const img = sprite('warning', px);
    const size = px * (1 + 0.1 * pulse);
    ctx.globalAlpha = 1;
    if (img) ctx.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    ctx.restore();
    return;
  }
  if (remainingNow(b.remainingMs, now) < BADGER_RULES.blinkMs) ctx.globalAlpha = blinkAlpha(now);
  dangerOutline(cx, cy, w, h, cell, now);
  const px = Math.max(1, Math.round(w * 0.98));
  const img = creatureSprite('badger', px, frozen);
  ctx.translate(cx, cy);
  if (img) {
    ctx.scale(badgerAnim.facing, 1);
    ctx.drawImage(img, -px / 2, -px * BADGER_ART_TOP, px, px);
    const flash = badgerHit?.id === b.id ? 1 - (now - badgerHit.at) / BADGER_RULES.hitFlashMs : 0;
    const white = flash > 0 && tintedSprite('badger', px, 'hit', '#ffffff');
    if (white) {
      ctx.globalAlpha *= flash;
      ctx.drawImage(white, -px / 2, -px * BADGER_ART_TOP, px, px);
    }
  } else {
    ctx.fillStyle = '#5d4037';
    ctx.fillRect(-w / 2 + pad, -h / 2 + pad, w - 2 * pad, h - 2 * pad);
  }
  ctx.restore();
}

// Over the badger, like a boss: its health bar (once active, not during
// the warning) just above its block, and its name (set on /admin, warning
// included) above the bar, in big bold text with a thick red outline. With
// no room above, both go below the block instead (bar first). They blink
// along with the badger.
function drawBadgerHud(b, name, cell, size, now) {
  const badgerAnim = badgerAnims.get(b.id);
  if (!badgerAnim) return;
  const showBar = b.warningMs <= 0 && b.maxHp > 0;
  if (!name && !showBar) return;
  const at = ratAt(badgerAnim, now);
  const h = b.height * cell;
  const cx = (at.x + 0.5) * cell;
  const cy = (at.y + 0.5) * cell;
  let font = Math.max(12, Math.round(cell * 0.95));
  ctx.save();
  const setFont = () => (ctx.font = `900 ${font}px system-ui, "Segoe UI", Arial, sans-serif`);
  setFont();
  // A long name on a small board: shrink it to fit 90% of the width.
  const wide = name ? ctx.measureText(name).width + font * 0.4 : 0;
  if (wide > size * 0.9) {
    font = Math.max(8, Math.floor((font * size * 0.9) / wide));
    setFont();
  }
  const gap = cell * 0.2;
  const barH = Math.max(6, cell * 0.42);
  const barW = b.width * cell * 0.92;
  // Laid out away from the block: the bar (if shown), then the name.
  const need = (showBar ? gap + barH : 0) + (name ? gap + font : 0);
  const above = cy - h / 2 - need >= 0;
  const side = above ? -1 : 1;
  let edge = cy + (side * h) / 2; // where the next thing starts, moving away from the block
  if (b.warningMs <= 0 && remainingNow(b.remainingMs, now) < BADGER_RULES.blinkMs) ctx.globalAlpha = blinkAlpha(now);
  if (showBar) {
    edge += side * gap;
    drawHealthBar(b, cx - barW / 2, above ? edge - barH : edge, barW, barH, now);
    edge += side * barH;
  }
  if (!name) {
    ctx.restore();
    return;
  }
  ctx.textAlign = 'center';
  ctx.lineJoin = 'round';
  ctx.textBaseline = above ? 'bottom' : 'top';
  const y = edge + side * gap;
  const half = ctx.measureText(name).width / 2 + font * 0.2;
  const x = clamp(cx, half, size - half);
  ctx.lineWidth = Math.max(3, font * 0.28);
  ctx.strokeStyle = '#d50000';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = font * 0.3;
  ctx.strokeText(name, x, y);
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#fff8e1';
  ctx.fillText(name, x, y);
  ctx.restore();
}

// The badger's health bar at (x, y), w x h: a dark frame, one segment per
// HP, red where it has health left. A segment lost to the last hit stays,
// fading from white, for a moment.
const HIT_FADE_MS = 500;
function drawHealthBar(b, x, y, w, h, now) {
  const pad = Math.max(1.5, h * 0.18);
  const r = h * 0.3;
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
  ctx.shadowBlur = h * 0.6;
  blockPath(x, y, w, h, r);
  ctx.fillStyle = '#1a0d0d';
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.lineWidth = Math.max(1.5, h * 0.12);
  ctx.strokeStyle = '#000000';
  ctx.stroke();
  const n = b.maxHp;
  const sep = Math.max(1, h * 0.12);
  const segW = (w - 2 * pad - sep * (n - 1)) / n;
  const segH = h - 2 * pad;
  const hit = badgerHit?.id === b.id ? badgerHit : null;
  const fade = hit ? 1 - (now - hit.at) / HIT_FADE_MS : 0;
  for (let i = 0; i < n; i++) {
    const sx = x + pad + i * (segW + sep);
    const sy = y + pad;
    if (i < b.hp) {
      const g = ctx.createLinearGradient(0, sy, 0, sy + segH);
      g.addColorStop(0, '#ff6b6b');
      g.addColorStop(0.5, '#e01b1b');
      g.addColorStop(1, '#8e0000');
      ctx.fillStyle = g;
    } else if (fade > 0 && i === hit.hp) {
      ctx.fillStyle = `rgba(255, 255, 255, ${fade})`; // just lost
    } else {
      ctx.fillStyle = 'rgba(80, 20, 20, 0.6)'; // empty
    }
    ctx.fillRect(sx, sy, segW, segH);
  }
  ctx.restore();
}

// Magnet: each pulled apple flies from where it was into the (moving) mouth,
// speeding up and shrinking as it goes.
function drawFlights(heads, cell, n, now, fx) {
  flights = flights.filter((f) => {
    const head = heads.get(f.id);
    const e = (now - f.start) / FLIGHT_MS;
    if (!head || e >= 1) {
      if (head && fx?.particles) rings.push({ x: head.x / cell - 0.5, y: head.y / cell - 0.5, color: f.color, start: now });
      return false;
    }
    let tx = head.x / cell - 0.5;
    let ty = head.y / cell - 0.5;
    // Across a wrapping edge: fly the short way, off the edge.
    if (tx - f.x > n / 2) tx -= n;
    else if (f.x - tx > n / 2) tx += n;
    if (ty - f.y > n / 2) ty -= n;
    else if (f.y - ty > n / 2) ty += n;
    const k = e * e; // ease in: it gets sucked in
    const scale = 1 - 0.65 * k;
    ctx.save();
    ctx.translate((f.x + (tx - f.x) * k + 0.5) * cell, (f.y + (ty - f.y) * k + 0.5) * cell);
    ctx.scale(scale, scale);
    drawItems([{ type: 'apple', sprite: f.sprite, x: -0.5, y: -0.5, flip: f.flip }], cell, now);
    ctx.restore();
    return true;
  });
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
    const reason =
      s.endReason === 'time'
        ? T.timeUp
        : s.endReason === 'target'
          ? fmt(T.targetReached, { n: s.win.targetLength })
          : s.endReason === 'lastPerson'
            ? T.lastPerson
            : '';
    const sub = reason ? `${reason} ${next}` : next;
    if (winner) return setOverlay({ title: fmt(T.winner, { name: winner.name }), sub, banner: playerColor(winner.colorIndex), dim: true });
    return setOverlay({ title: T.draw, sub, dim: true });
  }
  setOverlay();
}

const STATUS_ORDER = { alive: 0, dead: 1, queued: 2 };

// hats: playerId -> hat id (null when the hats toggle is off).
const KILL_ICON = '/twemoji/1f3af.svg'; // 🎯: kills, in the scoreboard
function updateLeaderboard(state, hats, botSkills) {
  $('lb-round').textContent = state.round > 0 ? fmt(T.round, { n: state.round }) : '';
  const players = [...state.players].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.length - a.length || Number(a.bot) - Number(b.bot) || a.name.localeCompare(b.name),
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
      // The name (cut short if it must be) and, after it, their hat.
      const line = document.createElement('span');
      line.className = 'name-line';
      const text = document.createElement('span');
      text.className = 'name-text';
      // A bot: its skill's emoji (🤖 if unknown). textContent: names come from clients.
      text.textContent = p.bot ? `${BOT_SKILL_EMOJI[botSkills?.[p.id]] ?? '🤖'} ${p.name}` : p.name;
      line.append(text);
      const hat = HATS.find((h) => h.id === hats?.[p.id]);
      if (hat) {
        const img = document.createElement('img');
        img.className = 'hat';
        img.src = `/twemoji/${hat.twemoji}.svg`;
        img.alt = hat.emoji;
        line.append(img);
      }
      name.append(line);
      const status = document.createElement('span');
      status.className = 'status';
      status.textContent = T[p.status] ?? '';
      name.append(status);
      const kills = document.createElement('span');
      kills.className = 'kills';
      if (p.status !== 'queued') {
        const icon = document.createElement('img');
        icon.className = 'kill-icon';
        icon.src = KILL_ICON;
        icon.alt = '🎯';
        icon.title = T.killsIcon;
        kills.append(icon, String(p.kills ?? 0));
      }
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
    const key = JSON.stringify([state.round, state.players, $('side').className, latest.keyboardPlayers, innerHeight, latest.hats]);
    if (key !== lastSideKey) {
      lastSideKey = key;
      updateLeaderboard(state, latest.hats, latest.botSkills);
    }
  } else lastSideKey = '';
}

resizeCanvas();
connect();
requestAnimationFrame(render);
