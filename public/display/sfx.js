// /display sound player. Each preset in sounds/<name>.json is synthesized
// once with jsfxr (loaded as a classic script: window.jsfxr) into an
// AudioBuffer, then replayed as often as needed.
//
// Browsers keep audio suspended until someone clicks or presses a key on the
// page, so the first such gesture unlocks it; until then `blocked()` is true
// and /display shows a hint.

import { SOUND_NAMES, soundFile } from '/shared/sounds.js';

let ctx = null;
let master = null;
const presets = new Map(); // name -> jsfxr params
const buffers = new Map(); // name -> AudioBuffer

// Loads the presets (once); missing or bad ones are skipped.
const loaded = Promise.all(SOUND_NAMES.map(async (name) => {
  try {
    const res = await fetch(`/sounds/${soundFile(name)}.json`);
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

// A laser's charge: a whine whose pitch rises from low to high over exactly
// `ms`, so it peaks the moment the beam fires. `from` (0-1): how far into
// the rise to start (a /display that joins, or resumes, mid-charge).
// Returns a handle whose stop() fades it out quickly (a charge called off);
// left alone it ends by itself at the top. Through the master gain and the
// limiter like every other sound.
const WHINE_HZ = [180, 1900];
const NO_WHINE = { stop() {} };
export function whine(gain, ms, from = 0) {
  if (!ctx || ctx.state !== 'running' || !(gain > 0) || !(ms > 0)) return NO_WHINE;
  const now = ctx.currentTime;
  const end = now + ms / 1000;
  const [lo, hi] = WHINE_HZ;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(lo + (hi - lo) * Math.min(1, Math.max(0, from)), now);
  osc.frequency.linearRampToValueAtTime(hi, end);
  // A second, slightly detuned voice for a buzzier charge-up.
  const osc2 = ctx.createOscillator();
  osc2.type = 'square';
  osc2.frequency.setValueAtTime((lo + (hi - lo) * from) * 1.01, now);
  osc2.frequency.linearRampToValueAtTime(hi * 1.01, end);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 3200;
  const vol = ctx.createGain();
  const peak = 0.16 * gain;
  vol.gain.setValueAtTime(0.0001, now);
  vol.gain.exponentialRampToValueAtTime(peak * 0.5, now + 0.04);
  vol.gain.linearRampToValueAtTime(peak, end); // louder as it charges
  vol.gain.linearRampToValueAtTime(0.0001, end + 0.03);
  osc.connect(filter);
  osc2.connect(filter);
  filter.connect(vol).connect(master);
  osc.start(now);
  osc2.start(now);
  osc.stop(end + 0.05);
  osc2.stop(end + 0.05);
  let stopped = false;
  return {
    stop() {
      if (stopped || !ctx) return;
      stopped = true;
      const t = ctx.currentTime;
      if (t >= end) return;
      vol.gain.cancelScheduledValues(t);
      vol.gain.setValueAtTime(vol.gain.value, t);
      vol.gain.linearRampToValueAtTime(0.0001, t + 0.06);
      osc.stop(t + 0.08);
      osc2.stop(t + 0.08);
    },
  };
}

// True while the browser still holds audio back for want of a click.
export const blocked = () => Boolean(ctx) && ctx.state !== 'running';

// Unlocks audio on the first gesture (browsers need one).
function unlock() {
  if (ctx && ctx.state !== 'running') ctx.resume().catch(() => {});
}
for (const type of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(type, unlock, { capture: true, passive: true });
