// Load test: node loadtest.js [--minutes 5] [--bots 16] [--server-bots 0] [--fill] [--tick-ms 200]
//
//   --bots         phone clients (named Phone01, Phone02...)
//   --server-bots  the server's own bots (the /admin "bots" setting), --fill
//                  for fill mode; --tick-ms sets the speed
//
// Starts a real server in a child process on 127.0.0.1, with its records and
// banned-word files in a fresh temp folder (never the project's own files) and
// a throwaway admin password. Then, from this process:
//   - an admin socket turns on every gameplay toggle and the global leaderboard;
//   - a display socket watches the rounds (and receives the full state each tick);
//   - N phone bots join with unique names and send a random valid direction
//     every 100-300 ms (3 times out of 4 picked among those that don't crash
//     on the next tick, so rounds last long enough for every win condition),
//     now and then disconnect and rejoin (same session, so the server's
//     "replace a stale player" path runs), and now and then send malformed,
//     forbidden or oversized messages.
// Every few seconds it samples /health (tick timing) and the child's memory
// after a forced GC. At the end it checks records.json against the server's
// own copy, hard-kills the server, restarts it on the same folder and checks
// that the records survived and a phone can rejoin.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PASSWORD = 'loadtest-only';
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

// ---- child: the server under test ------------------------------------------------
async function runServer(dir) {
  const imp = (p) => import(pathToFileURL(path.join(ROOT, p)));
  const { createApp } = await imp('src/server/app.js');
  const { loadRecords } = await imp('src/server/records.js');
  const { loadWordList } = await imp('src/server/profanity.js');
  const records = loadRecords(path.join(dir, 'records.json'));
  const wordList = loadWordList(path.join(dir, 'banned-words.json'), path.join(ROOT, 'src', 'server', 'banned-words.default.json'));
  const serverConfig = { port: 0, adminPassword: PASSWORD, wifi: { ssid: 'LoadTest', password: '' }, gameUrl: '' };
  const app = createApp({ serverConfig, wordList, records });
  process.on('uncaughtException', (err) => console.error('[server] uncaught exception:', err));
  process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));
  await app.listen(0, '127.0.0.1');
  process.on('message', (msg) => {
    if (msg === 'mem') {
      globalThis.gc?.();
      process.send({ t: 'mem', mem: process.memoryUsage() });
    } else if (msg === 'snapshot') {
      process.send({ t: 'snapshot', snapshot: records.snapshot() });
    }
  });
  process.send({ t: 'ready', port: app.server.address().port });
}

// ---- parent: the clients and the report --------------------------------------------
async function main() {
  const minutes = Number(arg('minutes', 5));
  const botCount = Number(arg('bots', 16));
  const serverBots = Number(arg('server-bots', 0));
  const fill = args.includes('--fill');
  const tickMs = arg('tick-ms', null);
  const durationMs = minutes * 60_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snake-loadtest-'));
  console.log(`Load test: ${botCount} phones, ${serverBots} server bots${fill ? ' (fill)' : ''} for ${minutes} min, data in ${dir}`);

  const logLines = [];
  let server = await startServer(dir, logLines);
  const base = `http://127.0.0.1:${server.port}`;
  const wsBase = `ws://127.0.0.1:${server.port}`;
  console.log(`Watch on http://127.0.0.1:${server.port}`)

  // Admin: every gameplay toggle on, plus the global leaderboard. A shorter
  // time limit, lower target and more apples than the defaults, so that every
  // win condition actually fires within the run.
  const wanted = {
    wrapWalls: true,
    corpseApples: true,
    timeLimitWin: true,
    targetLengthWin: true,
    roundTimeLimitSec: 30,
    targetLength: 12,
    appleCount: 10,
    // Power-ups: frequent, every type (default weights, all above 0), plus bombs.
    powerUps: true,
    powerUpChance: 60,
    bombsPerMinute: 10,
    ratChance: 30, // rats too
    chickenChance: 20, // and chickens
    ...(tickMs ? { tickMs: Number(tickMs) } : {}),
  };
  const admin = await openAdmin(base, wsBase);
  admin.ws.send(JSON.stringify({ t: 'config', values: wanted }));
  admin.ws.send(JSON.stringify({ t: 'settings', leaderboard: true, bots: serverBots, botFill: fill }));
  await waitFor(() => admin.last?.settings.leaderboard && admin.last.config.wrapWalls && admin.last.settings.bots === serverBots, 3000, 'admin settings');
  const configAfterSetup = JSON.stringify(admin.last.config);

  // Display: counts rounds by how they ended, and shares the board with the
  // bots so they can avoid dying instantly (they still steer randomly).
  const rounds = { lastAlive: 0, time: 0, target: 0, draws: 0 };
  const pickups = {}; // power-up type -> times picked up
  let lastTickKey = '';
  const board = { state: null };
  let lastPhase = null;
  const display = new WebSocket(`${wsBase}/ws`);
  display.on('open', () => display.send(JSON.stringify({ t: 'hello', role: 'display' })));
  display.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t !== 'state') return;
    board.state = msg.state;
    const { phase, endReason, winnerId } = msg.state;
    if (phase === 'intermission' && lastPhase !== 'intermission') {
      if (endReason in rounds) rounds[endReason]++;
      if (!winnerId) rounds.draws++;
    }
    lastPhase = phase;
    // The same tick can arrive twice (admin actions broadcast too): count it once.
    const tickKey = `${msg.state.round}:${msg.state.tick}`;
    if (tickKey !== lastTickKey) {
      lastTickKey = tickKey;
      for (const ev of msg.state.events ?? []) if (ev.type === 'pickup') pickups[ev.item] = (pickups[ev.item] ?? 0) + 1;
    }
  });

  // Bots.
  const stats = { joins: 0, rejoins: 0, replaced: 0, secondDevice: 0, joinErrors: {}, disconnects: 0, hostile: 0, oversized: 0, sent: 0, closedByServer: {} };
  const bots = Array.from({ length: botCount }, (_, i) => createBot(i, wsBase, stats, board));
  bots.forEach((b) => b.start());

  // Sampling.
  const health = [];
  const memory = [];
  const t0 = Date.now();
  const sample = async () => {
    try {
      const h = await (await fetch(`${base}/health`)).json();
      health.push({ at: Date.now() - t0, ...h });
    } catch (err) {
      logLines.push(`[loadtest] /health failed: ${err.message}`);
    }
  };
  const memSample = async () => memory.push({ at: Date.now() - t0, ...(await server.ask('mem')).mem });
  await sample();
  await memSample();
  const healthTimer = setInterval(sample, 5000);
  const memTimer = setInterval(memSample, 15_000);
  const progress = setInterval(() => {
    const h = health.at(-1);
    console.log(
      `  ${Math.round((Date.now() - t0) / 1000)}s: players ${h?.players}, rounds ${JSON.stringify(rounds)}, ` +
        `heap ${mb(memory.at(-1)?.heapUsed)} MB, tick mean ${h?.tick.meanMs} ms max ${h?.tick.maxMs} ms`,
    );
  }, 30_000);

  await sleep(durationMs);
  clearInterval(healthTimer);
  clearInterval(memTimer);
  clearInterval(progress);
  await sample();
  await memSample();
  bots.forEach((b) => b.stop());
  await sleep(500);

  // ---- integrity checks ------------------------------------------------------------
  const configAtEnd = JSON.stringify(admin.last.config);
  const snapshot = (await server.ask('snapshot')).snapshot;
  const integrity = checkRecordsFile(dir, snapshot);
  admin.ws.close();
  display.close();

  // ---- hard kill, restart, rejoin ------------------------------------------------------
  const firstCrashes = server.crashes;
  server.kill();
  await server.exited;
  server = await startServer(dir, logLines);
  const restartedSnapshot = (await server.ask('snapshot')).snapshot;
  const survived = JSON.stringify(restartedSnapshot) === JSON.stringify(snapshot);
  const rejoin = await rejoinCheck(`ws://127.0.0.1:${server.port}`, bots[0] ?? { name: 'Phone01', session: 'loadtest-session-0000' }); // a new phone if none ran
  server.kill();
  await server.exited;

  // ---- report ----------------------------------------------------------------------------
  report({
    minutes,
    botCount,
    serverBots,
    fill,
    wanted,
    configUnchanged: configAfterSetup === configAtEnd,
    rounds,
    pickups,
    stats,
    health,
    memory,
    logLines,
    integrity,
    survived,
    rejoin,
    crashes: [...firstCrashes, ...server.crashes],
  });
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- server process -------------------------------------------------------------------
function startServer(dir, logLines) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--child', dir], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const pending = new Map();
    const crashes = [];
    const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
    const collect = (stream) => {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        logLines.push(...lines.filter(Boolean));
      });
    };
    collect(child.stdout);
    collect(child.stderr);
    let killed = false;
    child.on('exit', (code, signal) => {
      if (!killed) crashes.push({ code, signal });
    });
    child.on('message', (msg) => {
      if (msg.t === 'ready') {
        resolve({
          port: msg.port,
          crashes,
          exited,
          ask: (what) => new Promise((r) => (pending.set(what, r), child.send(what))),
          kill: () => {
            killed = true;
            child.kill('SIGKILL'); // like a crash or a pulled plug: no clean shutdown
          },
        });
      } else pending.get(msg.t)?.(msg), pending.delete(msg.t);
    });
    child.once('exit', (code) => reject(new Error(`server exited early (${code})`)));
  });
}

async function openAdmin(base, wsBase) {
  const res = await fetch(`${base}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }),
  });
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`admin login failed (${res.status})`);
  const admin = { ws: new WebSocket(`${wsBase}/ws/admin`, { headers: { cookie } }), last: null };
  admin.ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.t === 'admin') admin.last = msg;
  });
  await new Promise((r, j) => (admin.ws.once('open', r), admin.ws.once('error', j)));
  return admin;
}

// ---- bots ----------------------------------------------------------------------------------
const DIRS = ['up', 'down', 'left', 'right'];
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const between = (a, b) => a + Math.random() * (b - a);

// Malformed, forbidden or hostile messages a phone could send. None of them
// may crash the server, change the config, or affect another player.
const HOSTILE = [
  () => '{not json',
  () => '',
  () => 'null',
  () => '[1,2,3]',
  () => '"just a string"',
  () => JSON.stringify({ t: 42 }),
  () => JSON.stringify({ t: 'dir', dir: 'sideways' }),
  () => JSON.stringify({ t: 'dir', dir: { toString: 'up' } }),
  () => JSON.stringify({ t: 'dir', dir: 'up', slot: 'wasd' }),
  () => JSON.stringify({ t: 'join', name: { a: 1 } }),
  () => JSON.stringify({ t: 'join', name: '\u0000​‮' }),
  () => JSON.stringify({ t: 'hello', role: 'admin' }),
  () => JSON.stringify({ t: 'config', values: { tickMs: 1, wrapWalls: false, maxPlayers: 1 } }),
  () => JSON.stringify({ t: 'kick', id: 'p1' }),
  () => JSON.stringify({ t: 'resetRecords', stat: 'all' }),
  () => JSON.stringify({ t: 'restart' }),
  () => JSON.stringify({ t: 'pause' }),
  () => JSON.stringify({ t: 'sidePanel', mode: 'join' }),
  () => JSON.stringify({ t: 'addWord', word: 'bot' }),
  () => JSON.stringify({ t: '__proto__', __proto__: { polluted: true } }),
  () => JSON.stringify({ t: 'leave', slot: 'arrows' }),
];

const STEP = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
const REVERSE = { up: 'down', down: 'up', left: 'right', right: 'left' };

// A random direction; three times out of four, a random one among those that
// don't hit a snake on the next tick, so rounds last long enough for the time
// limit and the target length to come into play.
function chooseDir(state, id) {
  const me = state?.snakes.find((s) => s.id === id && s.alive);
  if (!me || Math.random() < 0.25) return pick(DIRS);
  const n = state.gridSize;
  const blocked = new Set();
  for (const s of state.snakes) if (s.alive) for (const c of s.segments) blocked.add(c.x * 1000 + c.y);
  const head = me.segments[0];
  const safe = DIRS.filter((d) => {
    if (d === REVERSE[me.dir]) return false;
    let x = head.x + STEP[d][0];
    let y = head.y + STEP[d][1];
    if (state.rules.wrapWalls) {
      x = (x + n) % n;
      y = (y + n) % n;
    } else if (x < 0 || y < 0 || x >= n || y >= n) return false;
    return !blocked.has(x * 1000 + y);
  });
  return safe.length ? pick(safe) : pick(DIRS);
}

function createBot(index, wsBase, stats, board) {
  const name = `Phone${String(index + 1).padStart(2, '0')}`; // "Bot 1"... are the server's bots
  const session = `loadtest-session-${String(index).padStart(4, '0')}`;
  let ws = null;
  let running = false;
  let steerTimer = null;
  let eventTimer = null;
  let everJoined = false;
  let id = null;

  function connect() {
    if (!running) return;
    const socket = new WebSocket(`${wsBase}/ws`);
    ws = socket;
    socket.on('open', () => {
      socket.send(JSON.stringify({ t: 'hello', role: 'player' }));
      socket.send(JSON.stringify({ t: 'join', name, session }));
    });
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'joined') {
        id = msg.id;
        if (everJoined) stats.rejoins++;
        else stats.joins++;
        everJoined = true;
      } else if (msg.t === 'replaced') {
        stats.replaced++;
      } else if (msg.t === 'error' && msg.slot === 'self') {
        stats.joinErrors[msg.code] = (stats.joinErrors[msg.code] ?? 0) + 1;
      }
    });
    socket.on('close', (code) => {
      if (ws !== socket) return;
      ws = null;
      if (code !== 1000 && code !== 1005) stats.closedByServer[code] = (stats.closedByServer[code] ?? 0) + 1;
      if (running) setTimeout(connect, between(300, 2000));
    });
    socket.on('error', () => {});
  }

  function steer() {
    if (!running) return;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'dir', dir: chooseDir(board.state, id) }));
      stats.sent++;
    }
    steerTimer = setTimeout(steer, between(100, 300));
  }

  // Every 5-15 s: usually nothing, sometimes a disconnect or bad messages.
  function event() {
    if (!running) return;
    const r = Math.random();
    const socket = ws;
    if (socket?.readyState === WebSocket.OPEN) {
      if (r < 0.15) {
        stats.disconnects++;
        if (Math.random() < 0.5) socket.close();
        else socket.terminate(); // like a phone dropping off the wifi
      } else if (r < 0.45) {
        for (let i = 0; i < 3; i++) socket.send(pick(HOSTILE)());
        stats.hostile += 3;
      } else if (r < 0.5) {
        stats.oversized++;
        socket.send(JSON.stringify({ t: 'join', name: 'x'.repeat(5000) })); // over the 1 KB limit: closes this socket only
      } else if (r < 0.52) {
        stats.oversized++;
        socket.send(Buffer.from([1, 2, 3]), { binary: true }); // binary frames are refused
      } else if (r < 0.57) {
        // The same phone connecting again while its old socket still looks
        // alive (wifi dropped, server hasn't noticed): the new one takes over.
        stats.secondDevice++;
        socket.removeAllListeners('close');
        socket.on('close', () => {});
        ws = null;
        connect();
      } else if (r < 0.6) {
        for (let i = 0; i < 80; i++) socket.send(JSON.stringify({ t: 'dir', dir: pick(DIRS) })); // burst over the rate limit
        stats.hostile += 80;
      }
    }
    eventTimer = setTimeout(event, between(5000, 15000));
  }

  return {
    name,
    session,
    start() {
      running = true;
      connect();
      steerTimer = setTimeout(steer, between(100, 300));
      eventTimer = setTimeout(event, between(2000, 15000));
    },
    stop() {
      running = false;
      clearTimeout(steerTimer);
      clearTimeout(eventTimer);
      ws?.close();
    },
  };
}

// A phone pressing "Rientra" after a restart: same name, same session.
function rejoinCheck(wsBase, bot) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws`);
    const done = (result) => {
      clearTimeout(timer);
      ws.close();
      resolve(result);
    };
    const timer = setTimeout(() => done({ ok: false, reason: 'timeout' }), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'player' }));
      ws.send(JSON.stringify({ t: 'join', name: bot.name, session: bot.session }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.t === 'joined') done({ ok: msg.name === bot.name, name: msg.name });
      else if (msg.t === 'error') done({ ok: false, reason: msg.code });
    });
    ws.on('error', (err) => done({ ok: false, reason: err.message }));
  });
}

// ---- checks and report ---------------------------------------------------------------------
function checkRecordsFile(dir, snapshot) {
  const problems = [];
  const file = path.join(dir, 'records.json');
  let data = null;
  const nothingRecorded = ['wins', 'kills', 'score'].every((s) => !snapshot[s]?.length);
  if (!fs.existsSync(file) && nothingRecorded) {
    // Only server bots played: nothing to record, so no file was written.
    return { ok: true, problems, counts: { wins: 0, kills: 0, score: 0 }, data };
  }
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    problems.push(`records.json does not parse: ${err.message}`);
  }
  const counts = {};
  if (data) {
    if (data.version !== 2) problems.push(`version is ${data.version}`);
    for (const [stat, field] of [['wins', 'wins'], ['kills', 'kills'], ['score', 'length']]) {
      const list = data[stat];
      if (!Array.isArray(list)) {
        problems.push(`${stat} is not a list`);
        continue;
      }
      counts[stat] = list.length;
      const seen = new Set();
      for (const e of list) {
        if (seen.has(e.name)) problems.push(`${stat}: duplicate name ${e.name}`);
        seen.add(e.name);
        if (!Number.isInteger(e[field]) || e[field] <= 0) problems.push(`${stat}: bad value for ${e.name}`);
        // Only phones: a server bot ("Bot 3") must never be recorded.
        if (!/^Phone\d\d$/.test(e.name)) problems.push(`${stat}: unexpected name ${JSON.stringify(e.name)}`);
      }
    }
    if (JSON.stringify(data) !== JSON.stringify(snapshot)) problems.push('file differs from the server memory');
  }
  const leftovers = fs.readdirSync(dir).filter((f) => /\.(tmp|bad)/.test(f));
  if (leftovers.length) problems.push(`leftover files: ${leftovers.join(', ')}`);
  return { ok: problems.length === 0, problems, counts, data };
}

const EXPECTED_LOG = [
  /^\[game\] p\d+ joined \(phone\)$/,
  /^\[game\] p\d+ replaced by a new connection from the same device$/,
  /^\[ws\] Max payload size exceeded$/, // the oversized messages
  /^\[auth\] admin login from /,
  /^\[admin\] config /,
  /^\[bots\] (\d+ this round|b\d+ left to make room)$/,
  /^\[words\] created banned-words\.json from the starter list$/,
];

function report(r) {
  const unexpected = r.logLines.filter((l) => !EXPECTED_LOG.some((re) => re.test(l)));
  const expectedCounts = {};
  for (const l of r.logLines) {
    const re = EXPECTED_LOG.find((x) => x.test(l));
    if (re) expectedCounts[re.source] = (expectedCounts[re.source] ?? 0) + 1;
  }

  const h = r.health.filter((x) => x.tick.count > 0);
  const first = h[0];
  const last = h.at(-1);
  const tickMs = last.tick.configuredMs;
  const elapsedMs = last.at - first.at;
  const ticks = last.tick.count - first.tick.count;
  const actualMs = elapsedMs / ticks;
  const worst = Math.max(...h.map((x) => x.tick.maxMs ?? 0));
  const means = h.map((x) => x.tick.meanMs).filter((x) => x !== null);
  const tickErrors = last.tick.errors;

  const m0 = r.memory[1] ?? r.memory[0]; // after the bots have joined
  const m1 = r.memory.at(-1);

  const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`);
  console.log('\n==== Load test report ====');
  line('duration', `${r.minutes} min, ${r.botCount} phones, ${r.serverBots} server bots${r.fill ? ' (fill)' : ''}`);
  line('settings', JSON.stringify(r.wanted) + ' + global leaderboard');
  line('crashes', r.crashes.length ? JSON.stringify(r.crashes) : 'none');
  line('tick errors', tickErrors);
  line('unexpected log lines', unexpected.length);
  for (const l of unexpected.slice(0, 20)) console.log(`      ${l}`);
  line('expected log lines', JSON.stringify(expectedCounts));
  line('rounds', JSON.stringify(r.rounds));
  line('power-ups picked up', JSON.stringify(r.pickups));
  line('bot joins / rejoins', `${r.stats.joins} / ${r.stats.rejoins}`);
  line('join errors', JSON.stringify(r.stats.joinErrors));
  line('directions sent', r.stats.sent);
  line('disconnects', r.stats.disconnects);
  line('reconnect while still open', `${r.stats.secondDevice} (old socket told "replaced": ${r.stats.replaced})`);
  line('hostile messages', r.stats.hostile);
  line('oversized/binary', r.stats.oversized);
  line('closed by server', JSON.stringify(r.stats.closedByServer));
  line('config untouched by bots', r.configUnchanged ? 'yes' : 'NO');
  line('tick: configured', `${tickMs} ms`);
  line('tick: actual average', `${actualMs.toFixed(2)} ms over ${ticks} ticks (drift ${(((actualMs - tickMs) / tickMs) * 100).toFixed(2)}%)`);
  line('tick: 100-tick means', `${Math.min(...means)} .. ${Math.max(...means)} ms`);
  line('tick: worst interval', `${worst} ms`);
  const thinks = h.map((x) => x.bots?.thinkMeanMs).filter((x) => typeof x === 'number');
  const botCounts = h.map((x) => x.bots?.count ?? 0);
  line('server bots playing', `${Math.min(...botCounts)} .. ${Math.max(...botCounts)}`);
  line('bot think: 100-tick means', thinks.length ? `${Math.min(...thinks)} .. ${Math.max(...thinks)} ms` : 'n/a');
  line('bot think: worst', `${Math.max(0, ...h.map((x) => x.bots?.thinkMaxMs ?? 0))} ms`);
  line('heap after GC', `${mb(m0.heapUsed)} MB -> ${mb(m1.heapUsed)} MB`);
  line('rss', `${mb(m0.rss)} MB -> ${mb(m1.rss)} MB`);
  line('heap samples (MB)', r.memory.map((x) => mb(x.heapUsed)).join(' '));
  line('records.json', r.integrity.ok ? `valid, ${JSON.stringify(r.integrity.counts)}` : r.integrity.problems.join('; '));
  line('records after hard kill', r.survived ? 'identical' : 'DIFFERENT');
  line('rejoin after restart', r.rejoin.ok ? `ok (${r.rejoin.name})` : `FAILED (${r.rejoin.reason})`);
}

const mb = (bytes) => (bytes === undefined ? '?' : (bytes / 1024 / 1024).toFixed(1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

// Last, so every const above is initialised first.
if (args[0] === '--child') await runServer(args[1]);
else await main();
