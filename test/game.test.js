import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, sanitizeName, resolveSidePanel } from '../src/server/game.js';
import { createWordList } from '../src/server/profanity.js';
import { wifiPayload, detectLanIp } from '../src/server/network.js';
import { passwordMatches, parseCookies, createLoginLimiter, createSessionStore } from '../src/server/auth.js';

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

  test('names are sanitized, capped at 12 characters, and empty ones rejected', () => {
    assert.equal(sanitizeName('  Mario\u0000‮  Rossi  '), 'Mario Rossi');
    assert.equal(sanitizeName('x'.repeat(50)).length, 12);
    assert.equal(sanitizeName(123), '');
    const game = createGame({ log: quiet });
    const c = fakeClient(game);
    c.send({ t: 'join', name: '\u0007  \u0007' });
    assert.equal(c.last('error').code, 'nameEmpty');
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
    assert.equal(game.config.tickMs, 80);
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
    c.send({ t: 'config', values: { tickMs: 600 } });
    assert.equal(game.isPaused(), false);
    assert.equal(game.config.tickMs, 150);
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

  test('names are unique among connected players, ignoring case', () => {
    const game = createGame({ log: quiet });
    const a = fakeClient(game);
    const b = fakeClient(game);
    a.send({ t: 'join', name: 'Anna', session: SESSION_A });
    b.send({ t: 'join', name: 'ANNA', session: SESSION_B });
    assert.equal(b.last('error').code, 'nameTaken');
    // Once Anna leaves, the name is free again.
    a.conn.disconnect();
    b.send({ t: 'join', name: 'ANNA', session: SESSION_B });
    assert.equal(b.last('joined').name, 'ANNA');
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
