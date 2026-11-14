import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { jsfxr } from 'jsfxr';
import { SOUND_NAMES, soundsFor, spreadOverTick, soundGroup } from '../src/shared/sounds.js';

const snake = (id, dir, alive = true) => ({ id, dir, alive, segments: [{ x: 1, y: 1 }] });
const state = (over = {}) => ({ round: 1, tick: 5, phase: 'playing', events: [], snakes: [], portals: [], ...over });
const sounds = (prev, cur, newTick) => soundsFor(prev, cur, newTick).sort();

test('every sound has a preset in sounds/ that jsfxr renders', () => {
  for (const name of SOUND_NAMES) {
    const file = new URL(`../sounds/${name}.json`, import.meta.url);
    assert.ok(existsSync(file), name);
    const sfx = new jsfxr.SoundEffect(JSON.parse(readFileSync(file, 'utf8')));
    const { normalized } = sfx.getRawBuffer();
    assert.ok(normalized.length > 0 && normalized.length < sfx.sampleRate * 5, `${name}: ${normalized.length} samples`);
    assert.ok(normalized.some((v) => v !== 0), `${name} is silent`);
  }
});

test('countdown beeps once per number, then the round starts', () => {
  const cd = (ms, tick) => state({ phase: 'countdown', countdownRemainingMs: ms, tick });
  assert.deepEqual(sounds(state({ round: 0, phase: 'intermission' }), cd(3000, 0)), ['count']);
  assert.deepEqual(sounds(cd(3000, 0), cd(2900, 1)), []);
  assert.deepEqual(sounds(cd(2050, 9), cd(1950, 10)), ['count']);
  assert.deepEqual(sounds(cd(50, 29), state({ tick: 30 })), ['start']);
  assert.deepEqual(sounds(state(), state({ tick: 6 })), []);
  // No countdown at all: the start still plays.
  assert.deepEqual(sounds(state({ round: 1, phase: 'intermission' }), state({ round: 2 })), ['start']);
  // Not on the very first message (a /display that just connected mid-round).
  assert.deepEqual(sounds(null, state()), []);
});

test('each event maps to its sound', () => {
  const cases = [
    [{ type: 'eat', id: 'a', x: 1, y: 1 }, ['eat']],
    [{ type: 'eat', id: 'a', x: 1, y: 1, magnet: true }, ['eat']],
    [{ type: 'eat', id: 'a', x: 1, y: 1, item: 'rat' }, ['eatCreature']],
    [{ type: 'eat', id: 'a', x: 1, y: 1, item: 'chicken' }, ['eatCreature']],
    [{ type: 'eat', id: 'a', x: 1, y: 1, item: 'golden' }, []],
    [{ type: 'pickup', id: 'a', item: 'golden' }, ['powerUp']],
    [{ type: 'pickup', id: 'a', item: 'bomb' }, ['explosion']],
    [{ type: 'pickup', id: 'a', item: 'portal' }, []], // it sounds when the portal opens
    [{ type: 'shot', id: 'a' }, ['shoot']],
    [{ type: 'projectileEnd', x: 1, y: 1 }, []],
    [{ type: 'projectileEnd', x: 1, y: 1, hit: true }, ['hit']],
    [{ type: 'cut', id: 'a', byId: 'b' }, ['hurt']],
    [{ type: 'badgerHit', id: 'a', badgerId: 1, hp: 2 }, ['hurt']],
    [{ type: 'badgerBite', id: 'a' }, ['hurt']],
    [{ type: 'death', id: 'a', killerId: null }, ['death']],
    [{ type: 'death', id: 'a', killerId: 'b', killNo: 1 }, ['death']],
    [{ type: 'death', id: 'a', killerId: 'b', killNo: 2 }, ['death', 'multikill']],
    [{ type: 'death', id: 'a', killerId: 'b', killNo: 3 }, ['death', 'multikill']],
    [{ type: 'death', id: 'a', killerId: 'b', killNo: 4 }, ['death', 'overkill']],
    [{ type: 'death', id: 'a', killerId: 'b', killNo: 5 }, ['death', 'overkill']],
    [{ type: 'badgerSpawn', badgerId: 1 }, ['badgerSpawn']],
    [{ type: 'badgerKilled', badgerId: 1 }, ['explosion']],
    [{ type: 'badgerGone', badgerId: 1 }, ['disappear']],
    [{ type: 'bombExpired', x: 1, y: 1 }, ['disappear']],
    [{ type: 'teleport', id: 'a', portalId: 3 }, []],
  ];
  for (const [ev, want] of cases) assert.deepEqual(sounds(state(), state({ tick: 6, events: [ev] })), want, JSON.stringify(ev));
});

test('a repeated tick does not replay its events', () => {
  const cur = state({ events: [{ type: 'shot', id: 'a' }] });
  assert.deepEqual(sounds(state({ tick: 4 }), cur, true), ['shoot']);
  assert.deepEqual(sounds(cur, cur, false), []);
});

test('several of one sound in a tick are all kept, in order', () => {
  const events = [
    { type: 'eat', id: 'a', x: 1, y: 1 },
    { type: 'shot', id: 'c' },
    { type: 'eat', id: 'b', x: 2, y: 2 },
    { type: 'death', id: 'd', killerId: 'a', killNo: 2 },
    { type: 'death', id: 'e', killerId: 'b', killNo: 4 },
  ];
  assert.deepEqual(soundsFor(state(), state({ tick: 6, events })), ['eat', 'shoot', 'eat', 'death', 'multikill', 'death', 'overkill']);
});

test('a portal pickup and the portal it opens sound once', () => {
  const portal = { id: 7, ends: [{ x: 1, y: 1 }, { x: 5, y: 5 }] };
  const cur = state({ tick: 6, portals: [portal], events: [{ type: 'pickup', id: 'a', item: 'portal' }, { type: 'teleport', id: 'a', portalId: 7 }] });
  assert.deepEqual(soundsFor(state(), cur), ['portal']);
});

test('the four turn sounds are one kind; every other sound its own', () => {
  for (const dir of ['Up', 'Down', 'Left', 'Right']) assert.equal(soundGroup(`move${dir}`), 'move');
  assert.equal(soundGroup('eat'), 'eat');
  assert.equal(soundGroup('eatCreature'), 'eatCreature');
});

describe('spreadOverTick', () => {
  const at = (list) => list.map(({ name, delayMs }) => `${name}@${delayMs}`);

  test('a single sound of each kind plays at once', () => {
    assert.deepEqual(at(spreadOverTick(['eat', 'shoot', 'death'], 200)), ['eat@0', 'shoot@0', 'death@0']);
  });

  test('repeats of a kind are spaced evenly over the whole tick', () => {
    assert.deepEqual(at(spreadOverTick(['eat', 'eat'], 200)), ['eat@0', 'eat@100']);
    assert.deepEqual(at(spreadOverTick(['hit', 'eat', 'hit', 'hit', 'eat'], 300)), ['hit@0', 'hit@100', 'hit@200', 'eat@0', 'eat@150']);
  });

  test('the turn sounds share one spread, each keeping its own direction', () => {
    assert.deepEqual(at(spreadOverTick(['moveUp', 'moveLeft', 'eat', 'moveUp', 'moveDown'], 200)), ['moveUp@0', 'moveLeft@50', 'moveUp@100', 'moveDown@150', 'eat@0']);
  });

  test('every repeat plays, however many: none are dropped', () => {
    const list = spreadOverTick(Array(20).fill('moveUp'), 200);
    assert.equal(list.length, 20);
    assert.deepEqual(list.map((x) => x.delayMs), Array.from({ length: 20 }, (_, i) => i * 10));
  });

  test('nothing in, nothing out', () => {
    assert.deepEqual(spreadOverTick([], 200), []);
  });
});

test('a new portal plays the portal sound', () => {
  const portal = { id: 7, ends: [{ x: 1, y: 1 }, { x: 5, y: 5 }] };
  assert.deepEqual(sounds(state(), state({ tick: 6, portals: [portal] })), ['portal']);
  assert.deepEqual(sounds(state({ portals: [portal] }), state({ tick: 6, portals: [portal] })), []);
});

test('turning plays the move sound of the new direction', () => {
  const prev = state({ snakes: [snake('a', 'right'), snake('b', 'up'), snake('c', 'left'), snake('d', 'down', false)] });
  const cur = state({ tick: 6, snakes: [snake('a', 'up'), snake('b', 'up'), snake('c', 'down'), snake('d', 'left', false)] });
  assert.deepEqual(sounds(prev, cur), ['moveDown', 'moveUp']);
  for (const dir of ['up', 'down', 'left', 'right']) {
    const from = dir === 'up' || dir === 'down' ? 'left' : 'up';
    const name = `move${dir[0].toUpperCase()}${dir.slice(1)}`;
    assert.deepEqual(sounds(state({ snakes: [snake('a', from)] }), state({ tick: 6, snakes: [snake('a', dir)] })), [name]);
  }
  // A new round's snakes face wherever they spawned: no turn.
  assert.deepEqual(sounds(state({ round: 1, phase: 'intermission', snakes: [snake('a', 'up')] }), state({ round: 2, phase: 'countdown', countdownRemainingMs: 3000, snakes: [snake('a', 'left')] })), ['count']);
});
