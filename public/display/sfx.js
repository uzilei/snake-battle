// /display sound player. Each preset in sounds/<name>.json is synthesized
// once with jsfxr (loaded as a classic script: window.jsfxr) into an
// AudioBuffer, then replayed as often as needed.
//
// Browsers keep audio suspended until someone clicks or presses a key on the
// page, so the first such gesture unlocks it; until then `blocked()` is true
// and /display shows a hint.

import { SOUND_NAMES } from '/shared/sounds.js';

let ctx = null;
let master = null;
const presets = new Map(); // name -> jsfxr params
const buffers = new Map(); // name -> AudioBuffer

// Loads the presets (once); missing or bad ones are skipped.
const loaded = Promise.all(SOUND_NAMES.map(async (name) => {
  try {
    const res = await fetch(`/sounds/${name}.json`);
    if (res.ok) presets.set(name, await res.json());
  } catch {
    // no such sound: it stays silent
  }
}));

function context() {
  if (ctx) return ctx;
  const AC = window.AudioContext ?? window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  // A limiter at the end: many sounds landing together would add up past
  // full scale and crackle. It turns the sum down only when it gets that
  // loud (fast attack, high ratio, hard knee), leaving everything else as is.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3; // dB
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003; // s
  limiter.release.value = 0.15; // s
  master.connect(limiter).connect(ctx.destination);
  return ctx;
}

function bufferFor(name) {
  if (buffers.has(name)) return buffers.get(name);
  const params = presets.get(name);
  if (!params || !window.jsfxr) return null;
  let buffer = null;
  try {
    const sfx = new window.jsfxr.SoundEffect(params);
    const data = sfx.getRawBuffer().normalized;
    buffer = ctx.createBuffer(1, data.length, sfx.sampleRate);
    buffer.getChannelData(0).set(data);
  } catch {
    // a preset jsfxr can't render stays silent
  }
  buffers.set(name, buffer);
  return buffer;
}

// Creates the audio context and renders every sound ahead of time, so the
// first time one plays doesn't stall a frame.
let prepared = null;
export function prepare() {
  prepared ??= (async () => {
    if (!context()) return;
    ctx.addEventListener('statechange', () => onChange?.());
    await loaded;
    for (const name of presets.keys()) bufferFor(name);
  })();
  return prepared;
}

// Called whenever audio gets unlocked (or suspended again).
let onChange = null;
export function onStateChange(fn) {
  onChange = fn;
}

// gain: this sound's volume (master included) from /admin; 0 = muted.
// delayMs: when to start it, scheduled on the audio clock (exact, unlike a
// timer), so a tick's repeats can be spread out (see spreadOverTick).
export function play(name, gain = 1, delayMs = 0) {
  if (!ctx || ctx.state !== 'running' || !(gain > 0)) return;
  const buffer = bufferFor(name);
  if (!buffer) return;
  const at = ctx.currentTime + Math.max(0, delayMs) / 1000;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const vol = ctx.createGain();
  vol.gain.value = gain;
  src.connect(vol).connect(master);
  src.start(at);
}

// True while the browser still holds audio back for want of a click.
export const blocked = () => Boolean(ctx) && ctx.state !== 'running';

// Unlocks audio on the first gesture (browsers need one).
function unlock() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}
for (const type of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(type, unlock, { capture: true, passive: true });
