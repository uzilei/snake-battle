// /display sounds: which jsfxr presets (sounds/<name>.json) a state update
// plays, and for the phones that play them too, for whom. No DOM or audio,
// so node tests can check it; the audio itself lives in public/display/sfx.js.

export const SOUND_NAMES = Object.freeze([
  'badgerSpawn', 'count', 'death', 'disappear', 'eat', 'eatCreature', 'explosion', 'hit', 'hurt', 'laserFire',
  'moveUp', 'moveDown', 'moveLeft', 'moveRight', 'multikill', 'overkill', 'portal', 'powerUp', 'shoot', 'start',
]);
// A sound whose preset file has another name: sounds/<file>.json.
const SOUND_FILES = Object.freeze({ laserFire: 'laser' });
export const soundFile = (name) => SOUND_FILES[name] ?? name;

// Sounds synthesized live on /display instead of from a preset (see
// public/display/sfx.js), with a volume of their own like the others:
// laserCharge, a whine rising over a laser's whole charge.
export const SYNTH_SOUNDS = Object.freeze(['laserCharge']);
const ALL_SOUNDS = [...SOUND_NAMES, ...SYNTH_SOUNDS];

// Volumes, in percent: a master one, and one per sound on top of it (up to
// 200%, to bring a quiet sound forward). The four turn sounds share one,
// 'move', muted by default: with many snakes they play almost every tick.
// /admin settings, flat like the bot weights: soundVolume, volumeEat,
// volumeMove, ...
export const VOLUME_SLIDERS = Object.freeze([...new Set(ALL_SOUNDS.map((n) => (n.startsWith('move') ? 'move' : n)))]);
// The four turn sounds count as one kind of sound (one volume, and spread
// over a tick together); every other sound is its own.
export const soundGroup = (name) => (name.startsWith('move') ? 'move' : name);
const volumeGroup = soundGroup;
export const soundVolumeKey = (slider) => `volume${slider[0].toUpperCase()}${slider.slice(1)}`;
export const SOUND_LIMITS = Object.freeze({
  soundVolume: Object.freeze({ min: 0, max: 100, default: 100 }),
  ...Object.fromEntries(VOLUME_SLIDERS.map((n) => [soundVolumeKey(n), Object.freeze({ min: 0, max: 200, default: n === 'move' ? 0 : 100 })])),
});
export const SOUND_VOLUME_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(SOUND_LIMITS).map(([k, l]) => [k, l.default])));

// The gain each sound plays at (0 = muted), from the settings.
export function soundGains(settings) {
  const master = (settings.soundVolume ?? 100) / 100;
  return Object.fromEntries(ALL_SOUNDS.map((n) => [n, master * ((settings[soundVolumeKey(volumeGroup(n))] ?? SOUND_LIMITS[soundVolumeKey(volumeGroup(n))].default) / 100)]));
}

const MOVE_SOUNDS = { up: 'moveUp', down: 'moveDown', left: 'moveLeft', right: 'moveRight' };

// What picking up a power-up plays, when it isn't the plain 'powerUp': null
// for the ones with a sound of their own instead (the portal when it opens,
// the gun's shot, the laser's charge whine), so the two don't play at once.
const PICKUP_SOUNDS = Object.freeze({ bomb: 'explosion', portal: null, gun: null, laser: null, feast: 'eatCreature' });

// The countdown number /display shows (3, 2, 1).
const countdownNumber = (s) => Math.max(1, Math.ceil(s.countdownRemainingMs / 1000));

// The sounds for one state message, given the state before it (null at
// first): one entry per thing that happened, so two apples eaten in a tick
// give 'eat' twice (see spreadOverTick). `newTick` is false for a repeat of
// the same tick (e.g. after an /admin change), whose events were already
// played.
export function soundsFor(prev, cur, newTick = true) {
  return taggedSounds(prev, cur, newTick).map((e) => e.name);
}

// The same, each with who it is about, for the phones that play sounds
// (phoneSounds): `ids` null for everyone (the countdown, a badger arriving),
// else the players whose phone plays it, none for some ('disappear').
// laserFire also carries its laser's id (see createPhoneSounds).
function taggedSounds(prev, cur, newTick) {
  const out = [];
  const add = (name, ids = null, extra = {}) => {
    if (name) out.push({ name, ids: ids && [...new Set(ids.filter(Boolean))], ...extra });
  };
  const sameRound = Boolean(prev) && prev.round === cur.round;

  // Countdown: a beep for each number, then the start.
  if (cur.phase === 'countdown') {
    if (!sameRound || prev.phase !== 'countdown' || countdownNumber(prev) !== countdownNumber(cur)) add('count');
  } else if (cur.phase === 'playing' && prev && (!sameRound || prev.phase !== 'playing')) {
    add('start');
  }
  if (!newTick) return out;

  for (const ev of cur.events ?? []) {
    switch (ev.type) {
      case 'eat':
        if (!ev.item) add('eat', [ev.id]);
        else if (ev.item === 'rat' || ev.item === 'chicken') add('eatCreature', [ev.id]);
        break; // a power-up or bomb sounds through its 'pickup'
      case 'pickup': // a bomb's explosion too: the one who set it off
        add(Object.hasOwn(PICKUP_SOUNDS, ev.item) ? PICKUP_SOUNDS[ev.item] : 'powerUp', [ev.id]);
        break;
      case 'shot': add('shoot', [ev.id]); break;
      // Its charge whine is synthesized (sfx.js). Phones: the shooter, and
      // whoever was in its line when it started charging.
      case 'laserFire': add('laserFire', [ev.shooterId], { laserId: ev.id }); break;
      // Whatever stopped it: a wall, a snake, a creature, another projectile.
      // Phones: its shooter and the snakes it hit.
      case 'projectileEnd': add('hit', ev.ids ?? []); break;
      case 'cut': add('hurt', [ev.id, ev.byId]); break;
      case 'badgerHit':
      case 'badgerBite':
        add('hurt', [ev.id]);
        break;
      case 'death': {
        const ids = [ev.id, ev.killerId]; // the victim and the killer
        add('death', ids);
        if (ev.killNo >= 4) add('overkill', ids);
        else if (ev.killNo >= 2) add('multikill', ids);
        break;
      }
      case 'badgerSpawn': add('badgerSpawn'); break;
      case 'badgerKilled': add('explosion', [ev.byId]); break;
      case 'bombExpired':
      case 'badgerGone':
        add('disappear', []);
        break;
    }
  }

  if (sameRound) {
    // Each portal that wasn't there before has opened, for whoever went in
    // (their jump is the tick's teleport into it).
    const had = new Set((prev.portals ?? []).map((p) => p.id));
    for (const p of cur.portals ?? []) {
      if (had.has(p.id)) continue;
      const by = (cur.events ?? []).find((ev) => ev.type === 'teleport' && ev.portalId === p.id);
      add('portal', by ? [by.id] : []);
    }
    // A living snake that now faces another way has turned.
    if (cur.phase === 'playing') {
      for (const s of cur.snakes) {
        if (!s.alive) continue;
        const old = prev.snakes.find((x) => x.id === s.id);
        if (old?.alive && old.dir && s.dir && old.dir !== s.dir) add(MOVE_SOUNDS[s.dir], [s.id]);
      }
    }
  }
  return out;
}

// /play sounds (the phoneSounds setting): for each player, the sounds of a
// state update that are about them (see taggedSounds), and the laser charges
// they hear: their own, and any whose line crosses their body when it starts
// charging. Those also hear it fire, wherever they've gone by then.
// Stateful (it remembers who hears each charging laser), so one per game.
export function createPhoneSounds() {
  let hearers = new Map(); // laser id -> player ids that hear it fire
  return {
    // -> { all: [name] for every phone, players: Map playerId -> { sounds:
    // [name], charges: [{ id, ms }], fired: [laser id] } } (only players
    // with something of their own).
    update(prev, cur, newTick = true) {
      const all = [];
      const players = new Map();
      const of = (id) => {
        if (!players.has(id)) players.set(id, { sounds: [], charges: [], fired: [] });
        return players.get(id);
      };
      if (newTick) {
        for (const ev of cur.events ?? []) {
          if (ev.type !== 'laserCharge') continue;
          const ids = new Set([ev.shooterId]);
          for (const s of cur.snakes ?? []) {
            if (s.alive && s.segments.some((c) => (ev.axis === 'row' ? c.y : c.x) === ev.index)) ids.add(s.id);
          }
          hearers.set(ev.id, ids);
          for (const id of ids) of(id).charges.push({ id: ev.id, ms: ev.chargeMs });
        }
      }
      for (const e of taggedSounds(prev, cur, newTick)) {
        if (e.laserId !== undefined) {
          for (const id of hearers.get(e.laserId) ?? e.ids) {
            of(id).sounds.push(e.name);
            of(id).fired.push(e.laserId);
          }
        } else if (!e.ids) all.push(e.name);
        else for (const id of e.ids) of(id).sounds.push(e.name);
      }
      // Lasers no longer charging (fired, or called off) need no one.
      const charging = new Set((cur.lasers ?? []).map((l) => l.id));
      hearers = new Map([...hearers].filter(([id]) => charging.has(id)));
      return { all, players };
    },
  };
}

// When to play each sound of one tick, in ms from now. Repeats of a kind
// (soundGroup) are spaced evenly over the tick instead of all at once: the
// i-th of n at i * tickMs / n. Every one plays, however many there are.
export function spreadOverTick(names, tickMs) {
  const groups = new Map();
  for (const name of names) {
    const g = soundGroup(name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(name);
  }
  const out = [];
  for (const list of groups.values()) {
    list.forEach((name, i) => out.push({ name, delayMs: (i * tickMs) / list.length }));
  }
  return out;
}
