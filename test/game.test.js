import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, sanitizeName, resolveSidePanel, sidePanelNav } from '../src/server/game.js';
import { createWordList } from '../src/server/profanity.js';
import { SOUND_NAMES } from '../src/shared/sounds.js';
import { createRecords } from '../src/server/records.js';
import { wifiPayload, detectLanIp } from '../src/server/network.js';
import { passwordMatches, parseCookies, createLoginLimiter, createSessionStore } from '../src/server/auth.js';
import { FRUIT_CODES } from '../src/shared/fruits.js';
import { HAT_IDS } from '../src/shared/hats.js';

function fakeClient(game, opts) {
  const sent = [];
  const closed = [];
  const conn = game.connect({ send: (m) => sent.push(m), close: (c) => closed.push(c) }, opts);
  return {
    sent,
    closed,
    conn,
    send: (obj) => conn.message(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    last: (t) => sent.filter((m) => m.t === t).at(-1),
  };
}

const quiet = () => {};

describe('game controller', () => {
  test('a phone joins once and owns exactly one player', () => {
    const game = createGame({ log: quiet });
    const phone = fakeClient(game);
    phone.send({ t: 'hello', role: 'player' });
    phone.send({ t: 'join', name: 'Anna' });
    phone.send({ t: 'join', name: 'Anna again' });
    const players = game.engine.getState().players;
    assert.equal(players.length, 1);
    assert.equal(players[0].name, 'Anna');
    assert.equal(phone.last('joined').colorIndex, 0);
  });

  test('a client can only steer its own snake', () => {
    const game = createGame({ log: quiet });
    const a = fakeClient(game);
    const b = fakeClient(game);
    a.send({ t: 'join', name: 'A' });
    b.send({ t: 'join', name: 'B' });
    game.tickOnce(); // round starts
    const idA = a.last('joined').id;
    const before = game.engine.getState().snakes.find((s) => s.id === idA).dir;
    const turn = before === 'up' || before === 'down' ? 'left' : 'up';
    // b tries to steer a's snake by naming its id: ignored, b has no slot for it
    b.send({ t: 'dir', dir: turn, id: idA, slot: idA });
    game.tickOnce();
    assert.equal(game.engine.getState().snakes.find((s) => s.id === idA).dir, before);
  });

  test('garbage messages never throw and get an error reply', () => {
    const game = createGame({ log: quiet });
    const c = fakeClient(game);
    for (const raw of ['not json', '[]', 'null', '42', '{"t":5}', '{"t":"nope"}', '{"t":"join","name":{"x":1}}', '{"t":"dir","dir":"__proto__"}']) {
      assert.doesNotThrow(() => c.send(raw));
    }
    assert.ok(c.sent.some((m) => m.t === 'error' && m.code === 'badMessage'));
  });

  test('names are sanitized, capped at 16 characters, and empty ones rejected', () => {
    assert.equal(sanitizeName('  Mario\u0000‮  Rossi  '), 'Mario Rossi');
    assert.equal(sanitizeName('x'.repeat(50)).length, 16);
    assert.equal(sanitizeName('Mariagrazia Bian'), 'Mariagrazia Bian');
    assert.equal(sanitizeName(123), '');
    const game = createGame({ log: quiet });
    const c = fakeClient(game);
    c.send({ t: 'join', name: '\u0007  \u0007' });
    assert.equal(c.last('error').code, 'nameEmpty');
    assert.equal(game.engine.getState().players.length, 0);
  });

  // Characters that draw nothing: alone, mixed with spaces, or around a real
  // name (where they are simply removed).
  const BLANK_CHARS = ['\u115F', '\u1160', '\u3164', '\uFFA0', '\u2800', '\u180E', '\u202F', '\u205F', '\u3000', '\uFEFF'];
  for (let c = 0x2000; c <= 0x200f; c++) BLANK_CHARS.push(String.fromCodePoint(c));

  test('names made only of blank-looking characters are empty', () => {
    for (const ch of BLANK_CHARS) {
      const hex = ch.codePointAt(0).toString(16);
      for (const raw of [ch, ch.repeat(5), ` ${ch} `, `${ch} ${ch}\t${ch}`, `  ${ch}${ch}  `]) {
        assert.equal(sanitizeName(raw), '', `U+${hex} in ${JSON.stringify(raw)}`);
      }
      assert.equal(sanitizeName(`${ch}Ada${ch}`), 'Ada', `U+${hex} around a name`);
    }
    assert.equal(sanitizeName(BLANK_CHARS.join(' ')), '');
  });

  test('a name needs a letter, number, symbol or punctuation mark', () => {
    assert.equal(sanitizeName('\u0301\u0301'), ''); // combining accents only
    for (const ok of ['Ada', '7', '★', '!', '😀', 'é', '李']) assert.equal(sanitizeName(ok), ok);
    assert.equal(sanitizeName('\u3164 Bo'), 'Bo');
  });

  test('a blank name is rejected on join with nameEmpty, for every blank character', () => {
    const game = createGame({ log: quiet });
    for (const ch of BLANK_CHARS) {
      const c = fakeClient(game);
      c.send({ t: 'hello', role: 'player' });
      c.send({ t: 'join', name: ` ${ch}${ch} ` });
      assert.equal(c.last('error')?.code, 'nameEmpty', `U+${ch.codePointAt(0).toString(16)}`);
    }
    assert.equal(game.engine.getState().players.length, 0);
  });

  test('keyboard players need the admin toggle and a display role', () => {
    const game = createGame({ log: quiet });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    display.send({ t: 'join', slot: 'wasd' });
    assert.equal(display.last('error').code, 'keyboardDisabled');
    assert.equal(game.engine.getState().players.length, 0);

    game.settings.keyboardPlayers = true;
    display.send({ t: 'join', slot: 'wasd' });
    display.send({ t: 'join', slot: 'arrows' });
    display.send({ t: 'join', slot: 'numpad' });
    assert.equal(game.engine.getState().players.length, 2);

    // A phone can't create keyboard players.
    const phone = fakeClient(game);
    phone.send({ t: 'hello', role: 'player' });
    phone.send({ t: 'join', slot: 'wasd', name: 'P' });
    assert.equal(game.engine.getState().players.length, 3); // joined as its own phone player only
  });

  test('turning keyboard players off removes them', () => {
    const game = createGame({ log: quiet });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    admin.send({ t: 'settings', keyboardPlayers: true });
    display.send({ t: 'join', slot: 'wasd' });
    assert.equal(game.engine.getState().players.length, 1);
    admin.send({ t: 'settings', keyboardPlayers: false });
    assert.equal(game.engine.getState().players.length, 0);
  });

  test('disconnecting removes the client’s players', () => {
    const game = createGame({ log: quiet });
    const c = fakeClient(game);
    c.send({ t: 'join', name: 'Z' });
    c.conn.disconnect();
    assert.equal(game.engine.getState().players.length, 0);
  });

  test('a role is set once: a phone cannot later become a display', () => {
    const game = createGame({ log: quiet });
    game.settings.keyboardPlayers = true;
    const c = fakeClient(game);
    c.send({ t: 'hello', role: 'player' });
    c.send({ t: 'hello', role: 'display' });
    c.send({ t: 'join', slot: 'wasd', name: 'Pippo' });
    assert.equal(game.engine.getState().players.length, 1);
    assert.equal(game.engine.getState().players[0].name, 'Pippo'); // a phone player, not a keyboard one
  });

  test('admin config is clamped server-side', () => {
    const game = createGame({ log: quiet });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    admin.send({ t: 'config', values: { tickMs: 1, appleCount: 999, gridSize: '50', evil: 1 } });
    assert.equal(game.config.tickMs, 50);
    assert.equal(game.config.appleCount, 30);
    assert.equal(game.config.gridSize, 30); // string ignored
    assert.equal(Object.hasOwn(game.config, 'evil'), false);
  });

  test('pause stops the engine, resume restarts it', () => {
    const game = createGame({ log: quiet });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    admin.send({ t: 'pause' });
    game.tickOnce();
    assert.equal(game.engine.getState().tick, 0);
    assert.equal(admin.last('admin').paused, true);
    admin.send({ t: 'resume' });
    game.tickOnce();
    assert.equal(game.engine.getState().tick, 1);
  });

  test('kick removes the player and tells its owner', () => {
    const game = createGame({ log: quiet });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    const phone = fakeClient(game);
    phone.send({ t: 'join', name: 'K' });
    admin.send({ t: 'kick', id: phone.last('joined').id });
    assert.equal(game.engine.getState().players.length, 0);
    assert.ok(phone.last('kicked'));
  });

  test('admin messages without a valid session are rejected', () => {
    const game = createGame({ log: quiet });
    let valid = true;
    const admin = fakeClient(game, { admin: true, isAuthorized: () => valid });
    valid = false; // e.g. session expired or logged out elsewhere
    admin.send({ t: 'pause' });
    assert.equal(game.isPaused(), false);
    assert.ok(admin.last('unauthorized'));
    assert.deepEqual(admin.closed, [4401]);
  });

  test('public clients cannot send admin commands', () => {
    const game = createGame({ log: quiet });
    const c = fakeClient(game);
    c.send({ t: 'pause' });
    c.send({ t: 'config', values: { tickMs: 300 } });
    assert.equal(game.isPaused(), false);
    assert.equal(game.config.tickMs, 200);
  });

  test('messages beyond the per-second limit are dropped', () => {
    const game = createGame({ log: quiet });
    const c = fakeClient(game);
    for (let i = 0; i < 100; i++) c.send('{"t":"nope"}');
    assert.equal(c.sent.filter((m) => m.t === 'error').length, 40);
  });
});

describe('phone players', () => {
  const SESSION_A = 'a'.repeat(32);
  const SESSION_B = 'b'.repeat(32);

  test('banned words in names are rejected', () => {
    const game = createGame({ log: quiet, wordList: createWordList(['cazzo']) });
    const c = fakeClient(game);
    c.send({ t: 'join', name: 'C4zz0ne' });
    assert.equal(c.last('error').code, 'nameProfane');
    assert.equal(game.engine.getState().players.length, 0);
    c.send({ t: 'join', name: 'Carlo' });
    assert.equal(c.last('joined').name, 'Carlo');
  });

  test('names are unique among connected players, case-sensitively', () => {
    const game = createGame({ log: quiet });
    const a = fakeClient(game);
    const b = fakeClient(game);
    const c = fakeClient(game);
    a.send({ t: 'join', name: 'Marco', session: SESSION_A });
    b.send({ t: 'join', name: '  Marco ', session: SESSION_B });
    assert.equal(b.last('error').code, 'nameTaken');
    c.send({ t: 'join', name: 'marco', session: 'session-c-abcdefghijklmnop' });
    assert.equal(c.last('joined').name, 'marco'); // different case: a different player
    // Once Marco leaves, the name is free again.
    a.conn.disconnect();
    b.send({ t: 'join', name: 'Marco', session: SESSION_B });
    assert.equal(b.last('joined').name, 'Marco');
  });

  test('the same accented name typed two ways is still taken', () => {
    const game = createGame({ log: quiet });
    const a = fakeClient(game);
    const b = fakeClient(game);
    a.send({ t: 'join', name: 'Nicolò', session: SESSION_A }); // ò as one character
    b.send({ t: 'join', name: 'Nicolò', session: SESSION_B }); // o + combining grave
    assert.equal(b.last('error').code, 'nameTaken');
  });

  test('a reconnecting device keeps its name and replaces its stale player', () => {
    const game = createGame({ log: quiet });
    const old = fakeClient(game);
    old.send({ t: 'join', name: 'Luca', session: SESSION_A });
    const oldColor = old.last('joined').colorIndex;
    // Same device, new socket, before the server noticed the old one died.
    const again = fakeClient(game);
    again.send({ t: 'join', name: 'luca', session: SESSION_A });
    const players = game.engine.getState().players;
    assert.equal(players.length, 1);
    assert.equal(players[0].name, 'luca');
    assert.equal(again.last('joined').colorIndex, oldColor); // color was released and reused
    assert.ok(old.last('replaced'));
    assert.deepEqual(old.closed, [4000]);
    // The old socket closing later doesn't remove the new player.
    old.conn.disconnect();
    assert.equal(game.engine.getState().players.length, 1);
  });

  test('a session token only matches its own player', () => {
    const game = createGame({ log: quiet });
    const a = fakeClient(game);
    a.send({ t: 'join', name: 'Luca', session: SESSION_A });
    for (const session of [SESSION_B, 'short', { x: 1 }, undefined]) {
      const thief = fakeClient(game);
      thief.send({ t: 'join', name: 'Luca', session });
      assert.equal(thief.last('error').code, 'nameTaken');
    }
    assert.equal(game.engine.getState().players.length, 1);
    assert.equal(a.closed.length, 0);
  });

  test('a rejected rejoin leaves the old player alone', () => {
    const game = createGame({ log: quiet, wordList: createWordList(['merda']) });
    const old = fakeClient(game);
    old.send({ t: 'join', name: 'Luca', session: SESSION_A });
    const again = fakeClient(game);
    again.send({ t: 'join', name: 'merda', session: SESSION_A });
    assert.equal(again.last('error').code, 'nameProfane');
    assert.equal(game.engine.getState().players[0].name, 'Luca');
    assert.equal(old.closed.length, 0);
  });

  test('maxPlayers is respected', () => {
    const game = createGame({ log: quiet });
    game.engine.updateConfig({ maxPlayers: 2 });
    for (const n of ['A', 'B']) fakeClient(game).send({ t: 'join', name: n });
    const late = fakeClient(game);
    late.send({ t: 'join', name: 'C' });
    assert.equal(late.last('error').code, 'full');
  });

  test('the me message carries status, direction and round', () => {
    const game = createGame({ log: quiet });
    const c = fakeClient(game);
    c.send({ t: 'join', name: 'Eva' });
    game.tickOnce();
    const me = c.last('me');
    assert.equal(me.round, 1);
    assert.equal(me.players.self.name, 'Eva');
    assert.equal(me.players.self.status, 'alive');
    assert.ok(['up', 'down', 'left', 'right'].includes(me.players.self.dir));
  });
});

describe('banned words admin', () => {
  test('admins can add and remove words live', () => {
    const game = createGame({ log: quiet, wordList: createWordList([]) });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    assert.deepEqual(admin.last('words').words, []);
    admin.send({ t: 'addWord', word: 'Pirla' });
    assert.deepEqual(admin.last('words').words, ['pirla']);
    const phone = fakeClient(game);
    phone.send({ t: 'join', name: 'pirla' });
    assert.equal(phone.last('error').code, 'nameProfane');
    admin.send({ t: 'addWord', word: 'P1RLA' });
    assert.equal(admin.last('error').code, 'word_exists');
    admin.send({ t: 'addWord', word: '!!' });
    assert.equal(admin.last('error').code, 'word_invalid');
    admin.send({ t: 'removeWord', word: 'pirla' });
    assert.deepEqual(admin.last('words').words, []);
    phone.send({ t: 'join', name: 'pirla' });
    assert.ok(phone.last('joined'));
  });

  test('public clients cannot edit the list', () => {
    const list = createWordList(['merda']);
    const game = createGame({ log: quiet, wordList: list });
    const c = fakeClient(game);
    c.send({ t: 'removeWord', word: 'merda' });
    c.send({ t: 'addWord', word: 'anna' });
    assert.deepEqual(list.words(), ['merda']);
  });
});

describe('side panel auto mode', () => {
  const st = (n, phase) => ({ phase, players: Array.from({ length: n }, () => ({})) });
  test('join panel with fewer than 2 players or during intermission', () => {
    assert.equal(resolveSidePanel('auto', st(1, 'playing')), 'join');
    assert.equal(resolveSidePanel('auto', st(3, 'intermission')), 'join');
    assert.equal(resolveSidePanel('auto', st(2, 'playing')), 'leaderboard');
    assert.equal(resolveSidePanel('auto', st(2, 'countdown')), 'leaderboard');
  });
  test('fixed modes ignore the state', () => {
    assert.equal(resolveSidePanel('leaderboard', st(0, 'waiting')), 'leaderboard');
    assert.equal(resolveSidePanel('join', st(5, 'playing')), 'join');
  });
});

describe('network helpers', () => {
  test('wifi payload escapes special characters', () => {
    assert.equal(wifiPayload({ ssid: 'Expo', password: 'pw' }), 'WIFI:T:WPA;S:Expo;P:pw;;');
    assert.equal(wifiPayload({ ssid: 'a;b', password: 'c:d\\e"' }), 'WIFI:T:WPA;S:a\\;b;P:c\\:d\\\\e\\";;');
    assert.equal(wifiPayload({ ssid: 'Open', password: '' }), 'WIFI:T:nopass;S:Open;;');
  });

  test('LAN IP prefers real private addresses over virtual adapters', () => {
    const ip = detectLanIp({
      'vEthernet (WSL)': [{ family: 'IPv4', address: '172.20.0.1', internal: false }],
      Loopback: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      'Wi-Fi': [
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv4', address: '192.168.1.23', internal: false },
      ],
    });
    assert.equal(ip, '192.168.1.23');
    assert.equal(detectLanIp({}), '127.0.0.1');
  });
});

describe('auth helpers', () => {
  test('password comparison', () => {
    assert.equal(passwordMatches('secret', 'secret'), true);
    assert.equal(passwordMatches('secreT', 'secret'), false);
    assert.equal(passwordMatches(undefined, 'secret'), false);
    assert.equal(passwordMatches('', ''), false);
  });

  test('cookie parsing', () => {
    assert.deepEqual(parseCookies('a=1; sb_admin=x%20y; bad'), { a: '1', sb_admin: 'x y' });
    assert.deepEqual(parseCookies(undefined), {});
  });

  test('login limiter locks out after repeated failures and resets', () => {
    let now = 0;
    const lim = createLoginLimiter({ maxFailures: 3, windowMs: 1000, now: () => now });
    for (let i = 0; i < 3; i++) lim.fail('ip');
    assert.equal(lim.retryAfter('ip'), 1);
    assert.equal(lim.retryAfter('other'), 0);
    now = 1000;
    assert.equal(lim.retryAfter('ip'), 0);
  });

  test('sessions expire', () => {
    let now = 0;
    const s = createSessionStore({ ttlMs: 100, now: () => now });
    const token = s.create();
    assert.equal(s.isValid(token), true);
    assert.equal(s.isValid('forged'), false);
    now = 100;
    assert.equal(s.isValid(token), false);
  });
});

describe('global leaderboard', () => {
  // Two phones; the round starts on the first tick. p1 is then steered into
  // the wall and p2 (6 segments long) wins.
  function twoPlayers(settings = {}) {
    const records = createRecords({}, { now: () => 5000 });
    const game = createGame({ log: quiet, records });
    game.engine.updateConfig({ intermissionMs: 0 });
    Object.assign(game.settings, settings);
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    for (const [i, name] of ['Anna', 'Luca'].entries()) {
      const phone = fakeClient(game);
      phone.send({ t: 'hello', role: 'player' });
      phone.send({ t: 'join', name, session: `session-${i}-abcdefghijklmnop` });
    }
    return { game, records, admin };
  }
  // p1 heads into the wall, p2 (6 segments) is safe.
  function place(game) {
    game.engine._debug.setSnake('p1', [[29, 5], [28, 5], [27, 5]], 'right');
    game.engine._debug.setSnake('p2', [[8, 15], [7, 15], [6, 15], [5, 15], [4, 15], [3, 15]], 'right');
  }
  function playRound(game) {
    game.tickOnce(); // starts the round (waiting/intermission -> playing)
    place(game);
    game.tickOnce(); // p1 hits the wall: p2 wins
    assert.equal(game.engine.getState().phase, 'intermission');
  }
  const empty = { wins: [], kills: [], score: [] };

  test('off by default: nothing is recorded or shown', () => {
    const { game, records } = twoPlayers();
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    playRound(game);
    assert.deepEqual(records.top(), empty);
    assert.equal(display.last('state').records, null);
  });

  test('on: wins, kills and best lengths are all recorded', () => {
    const { game, records } = twoPlayers({ leaderboard: true });
    playRound(game);
    playRound(game);
    assert.deepEqual(records.top(), {
      wins: [{ name: 'Luca', value: 2 }],
      kills: [],
      score: [{ name: 'Luca', value: 6 }, { name: 'Anna', value: 3 }],
    });
  });

  test('kills count: p1 runs into p2', () => {
    const { game, records } = twoPlayers({ leaderboard: true });
    game.tickOnce();
    game.engine._debug.setSnake('p1', [[4, 14], [4, 13], [4, 12]], 'down'); // into p2's body at (4, 15)
    game.engine._debug.setSnake('p2', [[8, 15], [7, 15], [6, 15], [5, 15], [4, 15], [3, 15]], 'right');
    game.tickOnce();
    assert.deepEqual(records.top().kills, [{ name: 'Luca', value: 1 }]);
    assert.deepEqual(records.top().wins, [{ name: 'Luca', value: 1 }]);
  });

  test('enabling it mid-round applies from the next round', () => {
    const { game, records, admin } = twoPlayers();
    game.tickOnce(); // round 1 starts with it off
    admin.send({ t: 'settings', leaderboard: true });
    place(game);
    game.tickOnce();
    assert.deepEqual(records.top(), empty);
    playRound(game); // round 2 counts
    assert.deepEqual(records.top().wins, [{ name: 'Luca', value: 1 }]);
    assert.equal(records.top().score.length, 2);
  });

  test('disabling mid-round still records the round that started enabled', () => {
    const { game, records, admin } = twoPlayers({ leaderboard: true });
    game.tickOnce();
    admin.send({ t: 'settings', leaderboard: false });
    place(game);
    game.tickOnce();
    assert.deepEqual(records.top().wins.map((e) => e.name), ['Luca']);
  });

  test('a restarted round keeps the lengths and kills but gives no win', () => {
    const { game, records, admin } = twoPlayers({ leaderboard: true });
    game.tickOnce();
    game.engine._debug.setSnake('p2', [[8, 15], [7, 15], [6, 15], [5, 15], [4, 15], [3, 15], [2, 15], [1, 15]], 'right');
    admin.send({ t: 'restart' });
    assert.deepEqual(records.top().wins, []);
    assert.deepEqual(records.top().score[0], { name: 'Luca', value: 8 });
  });

  test('kills from a restarted round, and from a player who then leaves, still count', () => {
    const { game, records, admin } = twoPlayers({ leaderboard: true });
    const third = fakeClient(game);
    third.send({ t: 'hello', role: 'player' });
    third.send({ t: 'join', name: 'Marta', session: 'session-x-abcdefghijklmnop' });
    game.tickOnce();
    // Marta (p3) runs into Luca (p2); Anna and Luca play on.
    game.engine._debug.setSnake('p1', [[8, 25], [7, 25], [6, 25]], 'right');
    game.engine._debug.setSnake('p2', [[8, 15], [7, 15], [6, 15], [5, 15], [4, 15], [3, 15]], 'right');
    game.engine._debug.setSnake('p3', [[4, 14], [4, 13], [4, 12]], 'down');
    game.tickOnce();
    assert.equal(game.engine.getState().phase, 'playing');
    // Luca's player leaves, then the round is restarted: the kill is kept.
    game.engine._debug.setSnake('p2', [[9, 15], [8, 15], [7, 15], [6, 15], [5, 15], [4, 15]], 'right');
    const luca = game.engine.getState().players.find((p) => p.name === 'Luca');
    assert.equal(luca.kills, 1);
    admin.send({ t: 'kick', id: luca.id });
    admin.send({ t: 'restart' });
    assert.deepEqual(records.top().kills, [{ name: 'Luca', value: 1 }]);
    assert.deepEqual(records.top().wins, []);
  });

  test('a player who leaves mid-round still gets their length recorded', () => {
    const { game, records } = twoPlayers({ leaderboard: true });
    const third = fakeClient(game);
    third.send({ t: 'hello', role: 'player' });
    third.send({ t: 'join', name: 'Marta', session: 'session-x-abcdefghijklmnop' });
    game.tickOnce();
    place(game);
    game.engine._debug.setSnake('p1', [[20, 5], [19, 5], [18, 5]], 'right');
    game.engine._debug.setSnake('p3', [[10, 25], [9, 25], [8, 25], [7, 25], [6, 25], [5, 25], [4, 25], [3, 25], [2, 25]], 'right');
    game.tickOnce();
    third.conn.disconnect();
    place(game);
    game.tickOnce();
    assert.deepEqual(records.top().score[0], { name: 'Marta', value: 9 });
  });

  test('admin resets one stat or all of them; bad values are rejected', () => {
    const { game, records, admin } = twoPlayers({ leaderboard: true });
    playRound(game);
    assert.deepEqual(admin.last('admin').recordCounts, { wins: 1, kills: 0, score: 2 });
    admin.send({ t: 'resetRecords', stat: 'score' });
    assert.deepEqual(admin.last('admin').recordCounts, { wins: 1, kills: 0, score: 0 });
    admin.send({ t: 'resetRecords', stat: 'hallOfFame' });
    assert.equal(admin.last('error').code, 'badMessage');
    admin.send({ t: 'resetRecords', stat: 'all' });
    assert.deepEqual(records.counts(), { wins: 0, kills: 0, score: 0 });
    admin.send({ t: 'settings', leaderboard: 'yes' });
    assert.equal(game.settings.leaderboard, true);
  });

  test('the stat shown on /display is an admin setting, applied at once', () => {
    const { game, admin } = twoPlayers({ leaderboard: true });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    playRound(game);
    let msg = display.last('state');
    assert.equal(msg.leaderboardStat, 'auto');
    assert.deepEqual(Object.keys(msg.records), ['wins', 'kills', 'score']);
    assert.equal(msg.sidePanel, 'records'); // auto mode, intermission
    admin.send({ t: 'settings', leaderboardStat: 'kills' });
    msg = display.last('state');
    assert.equal(msg.leaderboardStat, 'kills');
    admin.send({ t: 'settings', leaderboardStat: 'apples' });
    assert.equal(admin.last('error').code, 'badMessage');
    assert.equal(game.settings.leaderboardStat, 'kills');
  });

  test('engine rules and win conditions are set through config', () => {
    const { game, admin } = twoPlayers();
    admin.send({ t: 'config', values: { wrapWalls: true, corpseApples: 'on' } });
    assert.equal(game.config.wrapWalls, true);
    assert.equal(game.config.corpseApples, false);
    admin.send({ t: 'config', values: { timeLimitWin: true, roundTimeLimitSec: 60, timeLimitWinner: 'kills', targetLength: 2 } });
    assert.equal(game.config.timeLimitWin, true);
    assert.equal(game.config.roundTimeLimitSec, 60);
    assert.equal(game.config.timeLimitWinner, 'kills');
    assert.equal(game.config.targetLength, 4); // clamped above the start length
    const msg = admin.last('admin');
    assert.deepEqual(msg.toggles, ['corpseApples', 'wrapWalls', 'timeLimitWin', 'targetLengthWin', 'lastPersonWins', 'powerUps']);
    assert.deepEqual(msg.choices.timeLimitWinner, ['longest', 'kills']);
  });

  test('kills of the current round reach /display and /admin', () => {
    const { game, admin } = twoPlayers();
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    game.tickOnce();
    game.engine._debug.setSnake('p1', [[4, 14], [4, 13], [4, 12]], 'down');
    game.engine._debug.setSnake('p2', [[8, 15], [7, 15], [6, 15], [5, 15], [4, 15], [3, 15]], 'right');
    game.tickOnce();
    const luca = (players) => players.find((p) => p.name === 'Luca');
    assert.equal(luca(display.last('state').state.players).kills, 1);
    assert.equal(luca(admin.last('admin').players).kills, 1);
  });
});

describe('side panel with records', () => {
  const st = (n, phase) => ({ phase, players: Array.from({ length: n }, () => ({})) });
  test('auto: records replace the join panel during intermission only when enabled', () => {
    assert.equal(resolveSidePanel('auto', st(3, 'intermission'), true), 'records');
    assert.equal(resolveSidePanel('auto', st(3, 'intermission'), false), 'join');
    assert.equal(resolveSidePanel('auto', st(3, 'playing'), true), 'leaderboard');
    assert.equal(resolveSidePanel('auto', st(1, 'intermission'), true), 'join');
  });
  test('scoreboard mode shows records between rounds', () => {
    assert.equal(resolveSidePanel('leaderboard', st(3, 'intermission'), true), 'records');
    assert.equal(resolveSidePanel('leaderboard', st(0, 'waiting'), true), 'records');
    assert.equal(resolveSidePanel('leaderboard', st(3, 'playing'), true), 'leaderboard');
  });
  test('records mode falls back to the scoreboard when the leaderboard is off', () => {
    assert.equal(resolveSidePanel('records', st(3, 'playing'), true), 'records');
    assert.equal(resolveSidePanel('records', st(3, 'playing'), false), 'leaderboard');
  });
});

describe('side panel buttons on /display', () => {
  const st = (n, phase) => ({ phase, players: Array.from({ length: n }, () => ({})) });
  const nav = (mode, state, on) => {
    const r = sidePanelNav(mode, state, on);
    return r && { prev: r.prev?.panel ?? null, next: r.next?.panel ?? null };
  };

  test('none in auto mode', () => {
    assert.equal(sidePanelNav('auto', st(3, 'playing'), true), null);
  });

  test('join during play: ← scoreboard, records →', () => {
    assert.deepEqual(nav('join', st(3, 'playing'), true), { prev: 'leaderboard', next: 'records' });
  });

  test('with records off, records is not offered and one button remains', () => {
    assert.deepEqual(nav('join', st(3, 'playing'), false), { prev: 'leaderboard', next: null });
    assert.equal(sidePanelNav('join', st(3, 'playing'), false).prev.mode, 'leaderboard');
    assert.deepEqual(nav('leaderboard', st(3, 'playing'), false), { prev: null, next: 'join' });
  });

  test('scoreboard mode between rounds already shows records: no dead button', () => {
    // leaderboard mode shows records between rounds, so "records" wouldn't change anything.
    assert.deepEqual(nav('leaderboard', st(3, 'intermission'), true), { prev: null, next: 'join' });
    // From join, scoreboard and records modes both show records then: one button.
    const r = sidePanelNav('join', st(3, 'intermission'), true);
    assert.equal([r.prev, r.next].filter(Boolean).length, 1);
    assert.equal((r.prev ?? r.next).panel, 'records');
  });

  test('the display can switch only to an offered mode, with the toggle on', () => {
    const game = createGame({ log: quiet });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    game.settings.sidePanel = 'join';

    display.send({ t: 'sidePanel', mode: 'leaderboard' }); // toggle off
    assert.equal(display.last('error').code, 'badMessage');
    assert.equal(game.settings.sidePanel, 'join');

    game.settings.displayButtons = true;
    for (const mode of ['auto', 'records', 'nope', 42, null]) display.send({ t: 'sidePanel', mode }); // records off
    assert.equal(game.settings.sidePanel, 'join');

    const phone = fakeClient(game);
    phone.send({ t: 'hello', role: 'player' });
    phone.send({ t: 'sidePanel', mode: 'leaderboard' });
    assert.equal(phone.last('error').code, 'badMessage');
    assert.equal(game.settings.sidePanel, 'join');

    display.send({ t: 'sidePanel', mode: 'leaderboard' });
    assert.equal(game.settings.sidePanel, 'leaderboard');
    assert.equal(display.last('state').sideNav.next.mode, 'join');

    game.settings.sidePanel = 'auto';
    display.send({ t: 'sidePanel', mode: 'join' });
    assert.equal(game.settings.sidePanel, 'auto');
  });

  test('the toggle is an admin setting, default off', () => {
    const game = createGame({ log: quiet });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    assert.equal(game.settings.displayButtons, false);
    assert.equal(display.last('state').sideNav, null);
    admin.send({ t: 'settings', displayButtons: 'yes' });
    assert.equal(admin.last('error').code, 'badMessage');
    admin.send({ t: 'settings', displayButtons: true, sidePanel: 'join' });
    assert.equal(display.last('state').displayButtons, true);
    assert.ok(display.last('state').sideNav.prev);
  });
});

describe('display effects toggles', () => {
  const setup = () => {
    const game = createGame({ log: quiet });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    admin.send({ t: 'hello', role: 'admin' });
    return { game, display, admin };
  };

  test('only the snake animations are on by default, and the display gets them with the tick length', () => {
    const { game, display } = setup();
    game.tickOnce();
    const msg = display.last('state');
    assert.deepEqual(msg.effects, { particles: false, screenShake: false, snakeAnimations: true, killPopups: false, sounds: false });
    assert.equal(msg.tickMs, game.config.tickMs);
  });

  test('the admin turns each one on and off, live', () => {
    const { game, display, admin } = setup();
    for (const key of ['particles', 'screenShake', 'snakeAnimations', 'killPopups', 'sounds']) {
      admin.send({ t: 'settings', [key]: true });
      assert.equal(display.last('state').effects[key], true);
      admin.send({ t: 'settings', [key]: false });
      assert.equal(display.last('state').effects[key], false);
    }
    assert.equal(game.settings.screenShake, false);
  });

  test('non-boolean values are rejected', () => {
    const { game, admin } = setup();
    for (const value of ['yes', 1, null, {}]) {
      admin.send({ t: 'settings', screenShake: value });
      assert.equal(admin.last('error').code, 'badMessage');
    }
    assert.equal(game.settings.screenShake, false);
  });

  test('a settings.json saved before the snake animations existed keeps them on', () => {
    const game = createGame({ log: quiet, savedSettings: { config: {}, settings: { particles: true } } });
    assert.equal(game.settings.particles, true);
    assert.equal(game.settings.snakeAnimations, true);
  });

  test('sound volumes: master times each sound, sent only while sounds are on', () => {
    const { game, display, admin } = setup();
    game.tickOnce();
    assert.equal(display.last('state').soundGains, null);
    admin.send({ t: 'settings', sounds: true });
    const gains = display.last('state').soundGains;
    assert.deepEqual(Object.keys(gains).sort(), [...SOUND_NAMES].sort());
    // Turn sounds start muted; the rest at full volume.
    for (const [name, g] of Object.entries(gains)) assert.equal(g, name.startsWith('move') ? 0 : 1, name);
    admin.send({ t: 'settings', volumeMove: 80 });
    admin.send({ t: 'settings', soundVolume: 50 });
    admin.send({ t: 'settings', volumeEat: 150 });
    admin.send({ t: 'settings', volumeHit: 0 });
    const after = display.last('state').soundGains;
    assert.equal(after.eat, 0.75);
    assert.equal(after.hit, 0);
    assert.equal(after.shoot, 0.5);
    // One slider for all four turn sounds.
    for (const dir of ['Up', 'Down', 'Left', 'Right']) assert.equal(after[`move${dir}`], 0.4);
    assert.equal(game.settings.volumeEat, 150);
  });

  test('sound volumes out of range or not whole numbers are rejected', () => {
    const { game, admin } = setup();
    for (const [key, value] of [['soundVolume', 101], ['soundVolume', -5], ['volumeEat', 201], ['volumeEat', 12.5], ['volumeEat', '50'], ['volumeNope', 50], ['volumeMoveUp', 50], ['turnSounds', true]]) {
      admin.send({ t: 'settings', [key]: value });
      assert.equal(admin.last('error').code, 'badMessage', `${key}=${value}`);
    }
    assert.equal(game.settings.soundVolume, 100);
    assert.equal(game.settings.volumeEat, 100);
    assert.equal('volumeNope' in game.settings, false);
  });

  test('effects are not open to non-admin clients', () => {
    const { game, display } = setup();
    display.send({ t: 'settings', particles: true });
    assert.equal(game.settings.particles, false);
  });
});

describe('badger boss name', () => {
  const setup = () => {
    const game = createGame({ log: quiet });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    admin.send({ t: 'hello', role: 'admin' });
    return { game, display, admin };
  };

  test('none by default; the admin sets it and /display gets it', () => {
    const { game, display, admin } = setup();
    game.tickOnce();
    assert.equal(game.settings.badgerName, '');
    assert.equal(display.last('state').badgerName, null);
    admin.send({ t: 'settings', badgerName: 'Re Tasso' });
    assert.equal(display.last('state').badgerName, 'Re Tasso');
    admin.send({ t: 'settings', badgerName: '' });
    assert.equal(display.last('state').badgerName, null);
  });

  test('cleaned like a player name and capped at 20 characters', () => {
    const { game, admin } = setup();
    admin.send({ t: 'settings', badgerName: '  Il   Terribile​ ' });
    assert.equal(game.settings.badgerName, 'Il Terribile');
    admin.send({ t: 'settings', badgerName: 'x'.repeat(25) });
    assert.equal(game.settings.badgerName, 'x'.repeat(20));
    admin.send({ t: 'settings', badgerName: ' ㅤ ' });
    assert.equal(game.settings.badgerName, '');
  });

  test('anything but a reasonable string is rejected', () => {
    const { game, admin } = setup();
    admin.send({ t: 'settings', badgerName: 'Boss' });
    for (const value of [42, null, ['a'], {}, 'y'.repeat(201)]) {
      admin.send({ t: 'settings', badgerName: value });
      assert.equal(admin.last('error').code, 'badMessage');
    }
    assert.equal(game.settings.badgerName, 'Boss');
  });

  test('not open to non-admin clients', () => {
    const { game, display } = setup();
    display.send({ t: 'settings', badgerName: 'Hacker' });
    assert.equal(game.settings.badgerName, '');
  });
});

describe('hats', () => {
  const setup = () => {
    const game = createGame({ log: quiet });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    const join = (name, hat) => {
      const phone = fakeClient(game);
      phone.send({ t: 'hello', role: 'player' });
      phone.send(hat === undefined ? { t: 'join', name } : { t: 'join', name, hat });
      return phone.last('joined').id;
    };
    return { game, display, admin, join };
  };

  test('a listed hat is kept; anything else means no hat', () => {
    const { game, display, admin, join } = setup();
    const ids = {
      cap: join('Ada', 'cap'),
      gradcap: join('Bo', 'gradcap'),
      none: join('Cy'),
      unknown: join('Di', 'crown'),
      number: join('Ed', 3),
      object: join('Flo', { id: 'cap' }),
      proto: join('Gus', '__proto__'),
      nul: join('Hal', null),
    };
    game.tickOnce();
    assert.deepEqual(display.last('state').hats, { [ids.cap]: 'cap', [ids.gradcap]: 'gradcap' });
    const hatOf = Object.fromEntries(admin.last('admin').players.map((p) => [p.id, p.hat]));
    assert.equal(hatOf[ids.cap], 'cap');
    assert.equal(hatOf[ids.gradcap], 'gradcap');
    for (const k of ['none', 'unknown', 'number', 'object', 'proto', 'nul']) assert.equal(hatOf[ids[k]], null, k);
  });

  test('every hat in the list is accepted', () => {
    const { display, join } = setup();
    const ids = HAT_IDS.map((hat, i) => [join(`P${i}`, hat), hat]);
    assert.deepEqual(display.last('state').hats, Object.fromEntries(ids));
  });

  test('the toggle is on by default; off, /display gets no hats but /admin still lists them', () => {
    const { game, display, admin, join } = setup();
    assert.equal(game.settings.hats, true);
    const id = join('Ada', 'tophat');
    admin.send({ t: 'settings', hats: false });
    assert.equal(display.last('state').hats, null);
    assert.equal(admin.last('admin').players.find((p) => p.id === id).hat, 'tophat');
    admin.send({ t: 'settings', hats: true }); // the picked hat comes back
    assert.deepEqual(display.last('state').hats, { [id]: 'tophat' });
    admin.send({ t: 'settings', hats: 'yes' });
    assert.equal(admin.last('error').code, 'badMessage');
  });

  test('a player who leaves takes the hat along', () => {
    const { game, display } = setup();
    const phone = fakeClient(game);
    phone.send({ t: 'hello', role: 'player' });
    phone.send({ t: 'join', name: 'Ada', hat: 'sunhat' });
    phone.conn.disconnect();
    game.tickOnce();
    assert.deepEqual(display.last('state').hats, {});
  });
});

describe('fruit toggles', () => {
  const setup = (savedSettings = null) => {
    const saved = [];
    const game = createGame({ log: quiet, savedSettings, saveSettings: (snap) => saved.push(snap) });
    const display = fakeClient(game);
    display.send({ t: 'hello', role: 'display' });
    const admin = fakeClient(game, { admin: true, isAuthorized: () => true });
    return { game, display, admin, saved };
  };

  test('every fruit is on by default, and /display gets the list', () => {
    const { game, display } = setup();
    game.tickOnce();
    assert.deepEqual(display.last('state').fruits, FRUIT_CODES);
    assert.deepEqual(game.settings.fruits, FRUIT_CODES);
  });

  test('the admin picks any subset, kept in list order and saved', () => {
    const { game, display, admin, saved } = setup();
    admin.send({ t: 'settings', fruits: ['1f951', '1f34f'] });
    assert.deepEqual(display.last('state').fruits, ['1f34f', '1f951']);
    assert.deepEqual(saved.at(-1).settings.fruits, ['1f34f', '1f951']);
    admin.send({ t: 'settings', fruits: [] }); // none: /display falls back to 🍎
    assert.deepEqual(game.settings.fruits, []);
    assert.deepEqual(saved.at(-1).settings.fruits, []);
  });

  test('unknown codes, repeats and non-lists are rejected as a whole', () => {
    const { game, admin } = setup();
    admin.send({ t: 'settings', fruits: ['1f34e'] });
    for (const fruits of [['1f34e', 'nope'], ['1f34e', '1f34e'], '1f34e', null, [1], { 0: '1f34e' }, ['1f4a3']]) {
      admin.send({ t: 'settings', fruits });
      assert.equal(admin.last('error').code, 'badMessage', JSON.stringify(fruits));
    }
    assert.deepEqual(game.settings.fruits, ['1f34e']);
  });

  test('a saved list is restored; a bad one is ignored', () => {
    assert.deepEqual(setup({ config: {}, settings: { fruits: ['1f353', '1f34e'] } }).game.settings.fruits, ['1f34e', '1f353']);
    assert.deepEqual(setup({ config: {}, settings: { fruits: ['1f353', 'x'] } }).game.settings.fruits, FRUIT_CODES);
    assert.deepEqual(setup({ config: {}, settings: { particles: true } }).game.settings.fruits, FRUIT_CODES);
  });

  test('changing the admin message can not change the setting', () => {
    const { game, admin } = setup();
    admin.send({ t: 'settings', fruits: ['1f34e'] });
    admin.last('admin').settings.fruits.push('1f34f');
    assert.deepEqual(game.settings.fruits, ['1f34e']);
  });

  test('players can not change it', () => {
    const { game, display } = setup();
    display.send({ t: 'settings', fruits: [] });
    assert.deepEqual(game.settings.fruits, FRUIT_CODES);
  });
});
