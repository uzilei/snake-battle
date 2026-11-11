import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, sanitizeName, resolveSidePanel } from '../src/server/game.js';
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

  test('names are sanitized and fall back to a default', () => {
    assert.equal(sanitizeName('  Mario\u0000‮  Rossi  '), 'Mario Rossi');
    assert.equal(sanitizeName('x'.repeat(50)).length, 16);
    assert.equal(sanitizeName(123), '');
    const game = createGame({ log: quiet });
    fakeClient(game).send({ t: 'join', name: '\u0007\u0007' });
    assert.match(game.engine.getState().players[0].name, /^Giocatore \d+$/);
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
    c.send({ t: 'join', slot: 'wasd' });
    assert.equal(game.engine.getState().players[0].name, 'Giocatore 1');
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
