// HTTP + WebSocket wiring. createApp() builds everything without listening, so
// tests can start it on a random port.

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createGame } from './game.js';
import { createSessionStore, createLoginLimiter, passwordMatches, SESSION_COOKIE } from './auth.js';
import { wifiPayload, qrSvg, playUrl, baseUrl, detectLanIp } from './network.js';
import { STRINGS, fmt } from '../shared/strings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const ADMIN_PAGES = path.join(ROOT, 'admin');
const LOGIN_TARGETS = new Set(['/admin', '/admin/print']);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loginPage({ error = '', next = '/admin' } = {}) {
  const t = STRINGS.login;
  return `<!doctype html>
<html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t.title)} – ${escapeHtml(STRINGS.appName)}</title>
<link rel="stylesheet" href="/admin/assets/admin.css"></head>
<body class="login"><form method="post" action="/admin/login" class="card">
<h1>${escapeHtml(t.title)}</h1>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<label>${escapeHtml(t.password)}<input type="password" name="password" autocomplete="current-password" required autofocus></label>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit" class="primary">${escapeHtml(t.submit)}</button>
</form></body></html>`;
}

/**
 * @param {object} opts
 * @param {object} opts.serverConfig normalised config file contents
 * @param {Function} [opts.log]
 * @param {Function} [opts.random] RNG for the engine
 * @param {object} [opts.limiter] options for the login limiter
 * @param {object} [opts.wordList] banned-word list for names (see profanity.js)
 * @param {number} [opts.heartbeatMs] how often sockets are pinged; dead ones are dropped
 */
export function createApp({ serverConfig, log = console.log, random, limiter: limiterOpts, wordList, heartbeatMs = 5000 } = {}) {
  const joinInfo = { ssid: serverConfig.wifi.ssid, wifiPassword: serverConfig.wifi.password, playUrl: '' };
  const game = createGame({ random, log, joinInfo, wordList });
  const sessions = createSessionStore();
  const limiter = createLoginLimiter(limiterOpts);
  const lanIp = detectLanIp();
  let port = serverConfig.port;

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });

  // ---- public pages and assets ----------------------------------------------
  app.get('/', (req, res) => res.redirect('/display'));
  app.get('/display', (req, res) => res.sendFile(path.join(PUBLIC, 'display', 'index.html')));
  app.get('/play', (req, res) => res.sendFile(path.join(PUBLIC, 'play', 'index.html')));
  app.use('/static', express.static(PUBLIC, { index: false }));
  app.use('/shared', express.static(path.join(ROOT, 'src', 'shared'), { index: false }));
  // Keeps phone screens awake on /play (a tiny looping video, since the Wake
  // Lock API needs https).
  app.use('/vendor/nosleep', express.static(path.join(ROOT, 'node_modules', 'nosleep.js', 'dist'), { index: false, maxAge: '1d' }));
  app.use('/twemoji', express.static(path.join(ROOT, 'node_modules', '@twemoji', 'svg'), { index: false, maxAge: '1d' }));

  // One QR generator for both /display and /admin/print, so they always match.
  const qrCache = new Map();
  async function sendQr(res, text) {
    if (!qrCache.has(text)) qrCache.set(text, await qrSvg(text));
    res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(qrCache.get(text));
  }
  app.get('/qr/wifi.svg', (req, res, next) => sendQr(res, wifiPayload(serverConfig.wifi)).catch(next));
  app.get('/qr/play.svg', (req, res, next) => sendQr(res, joinInfo.playUrl).catch(next));

  // ---- admin ------------------------------------------------------------------
  const adminHeaders = (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
    next();
  };
  const requireAdmin = (req, res, next) => {
    if (sessions.fromRequest(req)) return next();
    const fullPath = (req.baseUrl + req.path).replace(/\/+$/, ''); // req.path is relative to the mount
    if (req.method === 'GET' && LOGIN_TARGETS.has(fullPath)) {
      return res.redirect(`/admin/login?next=${encodeURIComponent(fullPath)}`);
    }
    res.status(401).type('text/plain').send('Unauthorized');
  };

  app.use('/admin', adminHeaders);
  // The login page's stylesheet must be reachable before logging in.
  app.get('/admin/assets/admin.css', (req, res) => res.sendFile(path.join(ADMIN_PAGES, 'admin.css')));

  app.get('/admin/login', (req, res) => {
    if (sessions.fromRequest(req)) return res.redirect('/admin');
    const next = LOGIN_TARGETS.has(req.query.next) ? req.query.next : '/admin';
    res.type('html').send(loginPage({ next }));
  });

  app.post('/admin/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const ip = req.socket.remoteAddress ?? 'unknown';
    const next = LOGIN_TARGETS.has(req.body?.next) ? req.body.next : '/admin';
    const wait = limiter.retryAfter(ip);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      return res.status(429).type('html').send(loginPage({ error: fmt(STRINGS.login.tooManyAttempts, { s: wait }), next }));
    }
    if (!passwordMatches(req.body?.password, serverConfig.adminPassword)) {
      limiter.fail(ip);
      log(`[auth] failed admin login from ${ip}`);
      return res.status(401).type('html').send(loginPage({ error: STRINGS.login.wrongPassword, next }));
    }
    limiter.succeed(ip);
    const token = sessions.create();
    res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 12 * 60 * 60 * 1000 });
    log(`[auth] admin login from ${ip}`);
    res.redirect(303, next);
  });

  app.post('/admin/logout', (req, res) => {
    const token = sessions.fromRequest(req);
    if (token) sessions.destroy(token);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
    res.redirect(303, '/admin/login');
  });

  app.use('/admin', requireAdmin);
  app.get('/admin', (req, res) => res.sendFile(path.join(ADMIN_PAGES, 'index.html')));
  app.get('/admin/print', (req, res) => res.sendFile(path.join(ADMIN_PAGES, 'print.html')));
  app.get('/admin/api/info', (req, res) => res.json({ ...joinInfo, urls: urls() }));
  app.use('/admin/assets', express.static(ADMIN_PAGES, { index: false }));

  app.use((req, res) => res.status(404).type('text/plain').send('Not found'));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    log(`[http] ${req.method} ${req.path} failed: ${err.message}`);
    if (!res.headersSent) res.status(err.status && err.status < 500 ? err.status : 500).type('text/plain').send('Error');
  });

  // ---- WebSocket ----------------------------------------------------------------
  const server = http.createServer(app);
  const publicWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const adminWss = new WebSocketServer({ noServer: true, maxPayload: 4096 });

  function reject(socket, status, text) {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.destroy();
  }

  // Admin sockets must come from a page on this same host (blocks cross-site
  // WebSocket hijacking) and carry a valid session cookie.
  function sameOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser client: the cookie check still applies
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return reject(socket, 400, 'Bad Request');
    }
    if (pathname === '/ws') {
      return publicWss.handleUpgrade(req, socket, head, (ws) => attach(ws, {}));
    }
    if (pathname === '/ws/admin') {
      const token = sessions.fromRequest(req);
      if (!token || !sameOrigin(req)) return reject(socket, 401, 'Unauthorized');
      return adminWss.handleUpgrade(req, socket, head, (ws) =>
        attach(ws, { admin: true, isAuthorized: () => sessions.isValid(token) }),
      );
    }
    reject(socket, 404, 'Not Found');
  });

  // Heartbeat: a phone that drops off the wifi never sends a close frame, so
  // without pings its player would linger. A socket that misses one ping is
  // terminated, which removes its player like any other disconnect.
  const heartbeat = setInterval(() => {
    for (const ws of [...publicWss.clients, ...adminWss.clients]) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }, heartbeatMs);
  heartbeat.unref();

  function attach(ws, opts) {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    const conn = game.connect(
      {
        send: (obj) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
        },
        close: (code, reason) => ws.close(code, reason),
      },
      opts,
    );
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(1003, 'text only');
      conn.message(data);
    });
    ws.on('close', () => conn.disconnect());
    ws.on('error', (err) => log(`[ws] ${err.message}`));
  }

  // ---- lifecycle ------------------------------------------------------------------
  function urls() {
    const base = baseUrl(serverConfig, port, lanIp);
    return {
      display: `${base}/display`,
      play: playUrl(serverConfig, port, lanIp),
      admin: `${base}/admin`,
      print: `${base}/admin/print`,
    };
  }

  function listen(listenPort = serverConfig.port, host = '0.0.0.0') {
    return new Promise((resolve, reject_) => {
      server.once('error', reject_);
      server.listen(listenPort, host, () => {
        server.off('error', reject_);
        port = server.address().port;
        joinInfo.playUrl = playUrl(serverConfig, port, lanIp);
        game.start();
        resolve(urls());
      });
    });
  }

  function close() {
    clearInterval(heartbeat);
    game.stop();
    for (const ws of [...publicWss.clients, ...adminWss.clients]) ws.terminate();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { app, server, game, sessions, listen, close, urls };
}
