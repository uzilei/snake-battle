// Integration tests: real HTTP server and WebSockets on a random local port.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../src/server/app.js';
import { normalizeServerConfig } from '../src/server/config.js';

const PASSWORD = 'test-password';
let app;
let base;
let wsBase;

before(async () => {
  app = createApp({
    serverConfig: normalizeServerConfig({ adminPassword: PASSWORD, wifi: { ssid: 'Expo', password: 'pw' } }),
    log: () => {},
    limiter: { maxFailures: 3, windowMs: 60_000 },
  });
  await app.listen(0, '127.0.0.1');
  const { port } = app.server.address();
  base = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
});

after(() => app.close());

const get = (path, headers = {}) => fetch(base + path, { redirect: 'manual', headers });
const login = (password, headers = {}) =>
  fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ password, next: '/admin/print' }),
  });

async function sessionCookie() {
  const res = await login(PASSWORD);
  assert.equal(res.status, 303);
  return res.headers.get('set-cookie').split(';')[0];
}

function openWs(path, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsBase + path, { headers });
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error('rejected'), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

function nextMessage(ws, t) {
  return new Promise((resolve) => {
    const onMsg = (data) => {
      const msg = JSON.parse(String(data));
      if (msg.t === t) {
        ws.off('message', onMsg);
        resolve(msg);
      }
    };
    ws.on('message', onMsg);
  });
}

describe('public pages', () => {
  test('display, play, strings, QR codes and twemoji are served', async () => {
    for (const path of ['/display', '/play', '/shared/strings.js', '/static/display/display.js', '/twemoji/1f34e.svg']) {
      assert.equal((await get(path)).status, 200, path);
    }
    const qr = await get('/qr/wifi.svg');
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /svg/);
    assert.match(await qr.text(), /<svg/);
    assert.equal((await get('/qr/play.svg')).status, 200);
  });
});

describe('admin protection', () => {
  test('admin pages redirect to the login page without a session', async () => {
    for (const path of ['/admin', '/admin/print']) {
      const res = await get(path);
      assert.equal(res.status, 302, path);
      assert.match(res.headers.get('location'), /^\/admin\/login\?next=/);
    }
    assert.equal((await get('/admin/api/info')).status, 401);
    assert.equal((await get('/admin/assets/admin.js')).status, 401);
    const page = await get('/admin/login');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Accesso amministratore/);
  });

  test('a forged cookie is not accepted', async () => {
    assert.equal((await get('/admin', { cookie: 'sb_admin=forged' })).status, 302);
  });

  test('login sets an HttpOnly session cookie that opens the admin pages', async () => {
    const res = await login(PASSWORD);
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/admin/print');
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = setCookie.split(';')[0];
    for (const path of ['/admin', '/admin/print', '/admin/assets/admin.js']) {
      assert.equal((await get(path, { cookie })).status, 200, path);
    }
    const info = await (await get('/admin/api/info', { cookie })).json();
    assert.equal(info.ssid, 'Expo');
    assert.match(info.urls.play, /\/play$/);
  });

  test('logout invalidates the session', async () => {
    const cookie = await sessionCookie();
    await fetch(`${base}/admin/logout`, { method: 'POST', redirect: 'manual', headers: { cookie } });
    assert.equal((await get('/admin', { cookie })).status, 302);
  });

  test('admin socket requires a session', async () => {
    await assert.rejects(openWs('/ws/admin'), (err) => err.status === 401);
    await assert.rejects(openWs('/ws/admin', { cookie: 'sb_admin=forged' }), (err) => err.status === 401);
  });

  test('admin socket rejects a foreign Origin even with a valid cookie', async () => {
    const cookie = await sessionCookie();
    await assert.rejects(openWs('/ws/admin', { cookie, origin: 'http://evil.example' }), (err) => err.status === 401);
  });

  test('admin socket works with a session and clamps config', async () => {
    const cookie = await sessionCookie();
    const ws = await openWs('/ws/admin', { cookie });
    const first = await nextMessage(ws, 'admin');
    assert.equal(first.limits.appleCount.max, 30);
    ws.send(JSON.stringify({ t: 'config', values: { appleCount: 500 } }));
    let msg;
    do msg = await nextMessage(ws, 'admin');
    while (msg.config.appleCount !== 30);
    assert.equal(app.game.config.appleCount, 30);
    ws.close();
  });

  test('admin commands on the public socket are ignored', async () => {
    const ws = await openWs('/ws');
    ws.send(JSON.stringify({ t: 'pause' }));
    const err = await nextMessage(ws, 'error');
    assert.equal(err.code, 'badMessage');
    assert.equal(app.game.isPaused(), false);
    ws.close();
  });

  // Runs last in this suite: it locks 127.0.0.1 out of further logins.
  test('login attempts are rate limited', async () => {
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await login('wrong')).status);
    assert.deepEqual(statuses.slice(-2), [401, 429]);
    const locked = await login(PASSWORD);
    assert.equal(locked.status, 429, 'even the right password is refused while locked out');
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
  });
});

describe('robustness', () => {
  test('oversized and binary frames close only that socket', async () => {
    const bad = await openWs('/ws');
    const closed = new Promise((resolve) => bad.once('close', resolve));
    bad.send('x'.repeat(5000));
    await closed;

    const bin = await openWs('/ws');
    const closed2 = new Promise((resolve) => bin.once('close', resolve));
    bin.send(Buffer.from([1, 2, 3]));
    await closed2;

    // Server still healthy.
    const ok = await openWs('/ws');
    ok.send(JSON.stringify({ t: 'hello', role: 'display' }));
    const info = await nextMessage(ok, 'joinInfo');
    assert.match(info.joinInfo.playUrl, /\/play$/);
    ok.close();
  });

  test('unknown socket paths are refused', async () => {
    await assert.rejects(openWs('/nope'), (err) => err.status === 404);
  });
});
