// /play: phone controller. Name prompt, then a full-screen swipe pad in the
// player's color. The server validates everything; this page only sends
// { t: 'join', name, session } and { t: 'dir', dir }.

import { STRINGS, LOCALE, setLocale } from '/shared/strings.js';
import startLocale from '/locale.js';
import { playerColor, contrastText } from '/shared/colors.js';
import { MAX_NAME_LENGTH } from '/shared/limits.js';
import { HATS, validHat } from '/shared/hats.js';
import { cleanName } from '/shared/names.js';

// The language chosen on /admin: the one at load, then whatever the server's
// messages say once joined (switched in place, so the game goes on).
let P;
let E;
setLocale(startLocale);
const $ = (id) => document.getElementById(id);

const SWIPE_PX = 12;
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
const KEYS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', w: 'up', s: 'down', a: 'left', d: 'right' };

// ?new: ignore the saved name and use a per-tab session, so several tabs on
// one laptop act as separate players.
const fresh = new URLSearchParams(location.search).has('new');
const NAME_KEY = 'snakeBattle.name';
const SESSION_KEY = 'snakeBattle.session';
const PAD_KEY = 'snakeBattle.pad';
const HAT_KEY = 'snakeBattle.hat';

// ---- storage (may be unavailable, e.g. private mode) ---------------------------
function load(store, key) {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function save(store, key, value) {
  try {
    store.setItem(key, value);
  } catch {
    /* not persisted, that's fine */
  }
}

// The session token lets the server recognise this device when it rejoins.
// crypto.randomUUID needs a secure context; getRandomValues works over http.
function sessionToken() {
  const store = fresh ? sessionStorage : localStorage;
  let token = load(store, SESSION_KEY);
  if (!token || !/^[A-Za-z0-9_-]{16,64}$/.test(token)) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    token = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    save(store, SESSION_KEY, token);
  }
  return token;
}
const session = sessionToken();

// ---- static text --------------------------------------------------------------
$('name-input').maxLength = MAX_NAME_LENGTH;
function applyText() {
  P = STRINGS.play;
  E = STRINGS.errors;
  document.documentElement.lang = LOCALE;
  document.title = P.title;
  $('title').textContent = P.title;
  $('name-label').textContent = P.namePrompt;
  $('name-input').placeholder = P.namePlaceholder;
  if (!$('join-btn').disabled) $('join-btn').textContent = P.join;
  $('rejoin').textContent = P.rejoin;
  $('swipe-hint').textContent = P.swipeHint;
  $('hat-label').textContent = P.hatPrompt;
  $('gear').setAttribute('aria-label', P.toggleControls);
  for (const b of document.querySelectorAll('.pad .dir')) {
    b.setAttribute('aria-label', P[`dir${b.dataset.dir[0].toUpperCase()}${b.dataset.dir.slice(1)}`]);
  }
  for (const b of document.querySelectorAll('#hats button')) labelHat(b);
}
applyText();

// ---- screens --------------------------------------------------------------------
let name = fresh ? '' : (load(localStorage, NAME_KEY) ?? '');
let me = null; // { id, name, colorIndex }
let status = null;
let lastDir = null; // last direction we sent this round
let lastRound = null;

function show(screen) {
  for (const id of ['screen-name', 'screen-game', 'screen-lost']) $(id).hidden = id !== screen;
}

function showName(error = '') {
  me = null;
  show('screen-name');
  $('join-btn').disabled = false;
  $('join-btn').textContent = P.join;
  $('name-error').textContent = error;
  const input = $('name-input');
  input.value = name;
  input.focus();
  input.select();
}

function showLost(title, detail = '') {
  me = null;
  show('screen-lost');
  $('lost-title').textContent = title;
  $('lost-detail').textContent = detail;
  $('rejoin').disabled = false;
}

function applyColor() {
  const game = $('screen-game');
  game.style.setProperty('--player', playerColor(me.colorIndex));
  game.style.setProperty('--on-player', contrastText(me.colorIndex));
}

function showGame() {
  applyColor();
  $('player-name').textContent = me.name; // textContent: names are user input
  setStatus(false);
  show('screen-game');
  setPad(load(localStorage, PAD_KEY) === '1');
  fitName();
}

// Largest font size at which the name fits on one line.
function fitName() {
  const el = $('player-name');
  if (!el.textContent) return;
  let size = Math.min(innerHeight * 0.22, innerWidth * 0.3, 180);
  el.style.fontSize = `${size}px`;
  while (el.scrollWidth > innerWidth * 0.9 && size > 18) {
    size -= 2;
    el.style.fontSize = `${size}px`;
  }
}
addEventListener('resize', fitName);

function setStatus(paused) {
  const game = $('screen-game');
  game.classList.toggle('dead', status === 'dead');
  let text = '';
  if (paused) text = P.paused;
  else if (status === 'queued') text = P.queued;
  else if (status === 'dead') text = P.dead;
  $('status').textContent = text;
}

// ---- connection -------------------------------------------------------------------
let ws = null;

function connect() {
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws = socket;
  let joined = false;
  let ending = null; // { title, detail } shown when the socket closes, or 'name' for a name error

  const send = (obj) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(obj));

  socket.onopen = () => {
    send({ t: 'hello', role: 'player' });
    send({ t: 'join', name, session, hat });
  };

  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'joined':
        joined = true;
        me = { id: msg.id, name: msg.name, colorIndex: msg.colorIndex };
        name = msg.name;
        if (!fresh) save(localStorage, NAME_KEY, name);
        status = null;
        lastDir = null;
        lastRound = null;
        showGame();
        break;
      case 'error':
        if (!joined) {
          ending = 'name';
          socket.close();
          showName(E[msg.code] ?? E.badMessage);
        }
        break;
      case 'me':
        onMe(msg);
        break;
      case 'kicked':
        ending = { title: E.kicked };
        socket.close();
        break;
      case 'replaced':
        ending = { title: P.connectionLost, detail: P.replaced };
        break;
      default:
        break;
    }
  };

  socket.onclose = () => {
    if (ws === socket) ws = null;
    if (ending === 'name') return;
    if (!joined) return showName(P.cannotConnect);
    const { title, detail } = ending ?? { title: P.connectionLost };
    showLost(title, detail);
  };

  return send;
}

let sendToServer = () => {};

function join() {
  keepAwake(); // must run inside the tap/submit, browsers only start video playback on a user gesture
  $('join-btn').disabled = true;
  $('join-btn').textContent = P.connecting;
  $('rejoin').disabled = true;
  sendToServer = connect();
}

function onMe(msg) {
  if (setLocale(msg.locale)) applyText();
  const p = msg.players?.self;
  if (!me || !p) return;
  // A new round (or our first one) starts from the snake's spawn direction.
  if (msg.round !== lastRound || (p.status === 'alive' && status !== 'alive')) {
    lastRound = msg.round;
    lastDir = p.dir;
  }
  status = p.status;
  // Colors can change between rounds (people get the first ones over bots).
  if (Number.isInteger(p.colorIndex) && p.colorIndex !== me.colorIndex) {
    me.colorIndex = p.colorIndex;
    applyColor();
  }
  setStatus(msg.paused);
}

// ---- hat picker -----------------------------------------------------------------------
// None or one of the hats, remembered on this device and sent with every join.
let hat = validHat(load(localStorage, HAT_KEY));
const hatButtons = [{ id: null }, ...HATS].map((h) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  if (h.id) {
    const img = document.createElement('img');
    img.src = `/twemoji/${h.twemoji}.svg`;
    img.alt = '';
    b.append(img);
  }
  b.addEventListener('click', () => {
    hat = h.id;
    save(localStorage, HAT_KEY, hat ?? '');
    markHat();
  });
  b.dataset.hat = h.id ?? '';
  labelHat(b);
  return b;
});
function labelHat(b) {
  const id = b.dataset.hat;
  b.setAttribute('aria-label', id ? (P.hatNames[id] ?? id) : P.hatNone);
  if (!id) b.textContent = P.hatNone;
}
$('hats').append(...hatButtons);
function markHat() {
  for (const b of hatButtons) b.setAttribute('aria-checked', String(b.dataset.hat === (hat ?? '')));
}
markHat();

// ---- name form ----------------------------------------------------------------------
$('name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = cleanName($('name-input').value); // the server's own rules
  if (!value) {
    $('name-error').textContent = E.nameEmpty;
    return;
  }
  name = value;
  $('name-error').textContent = '';
  join();
});
$('name-input').addEventListener('input', () => {
  $('name-error').textContent = '';
});
$('rejoin').addEventListener('click', join);

// ---- steering ---------------------------------------------------------------------------
function steer(dir) {
  if (!me || status !== 'alive') return;
  // Same rule as the server's input buffer: no repeats, no 180° reversals.
  if (dir === lastDir || dir === OPPOSITE[lastDir]) return;
  lastDir = dir;
  sendToServer({ t: 'dir', dir });
  flash();
}

function flash() {
  const el = $('flash');
  el.classList.remove('on');
  void el.offsetWidth; // restart the animation
  el.classList.add('on');
}

// Swipes anywhere on the game screen. Once the finger has moved SWIPE_PX from
// the origin, the dominant axis wins and the origin jumps to the current point,
// so one continuous drag can chain several turns.
let swipe = null; // { pointerId, x, y }
const game = $('screen-game');

game.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.no-swipe') || swipe) return;
  swipe = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  game.setPointerCapture?.(e.pointerId);
});
game.addEventListener('pointermove', (e) => {
  if (!swipe || e.pointerId !== swipe.pointerId) return;
  const dx = e.clientX - swipe.x;
  const dy = e.clientY - swipe.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
  steer(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up');
  swipe.x = e.clientX;
  swipe.y = e.clientY;
});
const endSwipe = (e) => {
  if (swipe && e.pointerId === swipe.pointerId) swipe = null;
};
game.addEventListener('pointerup', endSwipe);
game.addEventListener('pointercancel', endSwipe);

// Block scrolling, pull-to-refresh and pinch/double-tap zoom while playing.
for (const type of ['touchstart', 'touchmove']) {
  document.addEventListener(
    type,
    (e) => {
      if (!game.hidden && !e.target.closest('.gear')) e.preventDefault();
    },
    { passive: false },
  );
}
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('dblclick', (e) => e.preventDefault());
game.addEventListener('contextmenu', (e) => e.preventDefault());

// On-screen buttons, toggled by the gear.
for (const b of document.querySelectorAll('.pad .dir')) {
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    steer(b.dataset.dir);
  });
}
function setPad(visible) {
  $('pad').hidden = !visible;
  $('gear').setAttribute('aria-pressed', String(visible));
  game.classList.toggle('with-pad', visible);
  fitName();
}
$('gear').addEventListener('click', () => {
  const visible = $('pad').hidden;
  save(localStorage, PAD_KEY, visible ? '1' : '0');
  setPad(visible);
});

// Keyboard too, handy when testing with several tabs on a laptop.
addEventListener('keydown', (e) => {
  const dir = KEYS[e.key] ?? KEYS[e.key.toLowerCase?.()];
  if (!dir || game.hidden) return;
  e.preventDefault();
  steer(dir);
});

// ---- keep the screen awake ------------------------------------------------------------------
// NoSleep (served from node_modules) uses the Wake Lock API where it exists.
// That API needs https, so over plain http on the LAN it falls back to playing
// a tiny looping video, which phones treat as "something is playing". It stays
// on from the first Gioca until the page closes, so the screen doesn't lock
// between rounds or on the connection-lost screen.
const noSleep = typeof window.NoSleep === 'function' ? new window.NoSleep() : null;
// The clip carries a silent audio track (an old iOS workaround). Muting it
// keeps the player's music playing and keeps this page free of audio.
if (noSleep?.noSleepVideo) {
  noSleep.noSleepVideo.muted = true;
  noSleep.noSleepVideo.setAttribute('muted', '');
}

function keepAwake() {
  if (!noSleep) return;
  try {
    noSleep.enable()?.catch?.(() => {});
  } catch {
    /* not supported here: the screen may lock, that's all */
  }
}
document.addEventListener('visibilitychange', () => {
  // Browsers pause the video (or drop the lock) while hidden; resume on return.
  // A muted video may restart without a new tap.
  if (document.visibilityState === 'visible' && noSleep?.isEnabled) keepAwake();
});

showName();
