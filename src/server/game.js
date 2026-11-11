// Game controller: owns the engine, runs the tick loop, tracks which client
// owns which player, and validates every incoming message.
//
// Transport-agnostic: a client is { send(obj), close(code, reason) } plus a
// role. The WebSocket wiring lives in app.js.

import { createEngine, createDefaultConfig, CONFIG_LIMITS, PHASES } from '../engine.js';
import { STRINGS } from '../shared/strings.js';
import { createWordList } from './profanity.js';
import { MAX_NAME_LENGTH } from '../shared/limits.js';

export const SIDE_PANEL_MODES = Object.freeze(['auto', 'leaderboard', 'join']);
export const KEYBOARD_SLOTS = Object.freeze(['wasd', 'arrows']);
const SELF = 'self';
export { MAX_NAME_LENGTH };
const SESSION_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_MESSAGES_PER_SECOND = 40;

// Strips control/format characters and extra whitespace; caps the length.
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  const cleaned = raw
    .replace(/[\p{C}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...cleaned].slice(0, MAX_NAME_LENGTH).join('').trim();
}

// Key for the case-insensitive uniqueness check.
export const nameKey = (name) => name.normalize('NFC').toLocaleLowerCase('it');

export function resolveSidePanel(mode, state) {
  if (mode === 'leaderboard' || mode === 'join') return mode;
  return state.players.length < 2 || state.phase === PHASES.INTERMISSION ? 'join' : 'leaderboard';
}

export function createGame({ random = Math.random, log = console.log, joinInfo = {}, wordList = createWordList() } = {}) {
  const config = createDefaultConfig();
  const engine = createEngine({ config, random });
  const settings = { sidePanel: 'auto', keyboardPlayers: false };
  let paused = false;
  let nextPlayerNumber = 1;
  let timer = null;

  const clients = new Set();
  const owners = new Map(); // playerId -> { client, slot, source, session }

  // ---- outgoing ------------------------------------------------------------

  function safeSend(client, msg) {
    try {
      client.send(msg);
    } catch (err) {
      log(`[game] send failed: ${err.message}`);
    }
  }

  function displayMessage(state) {
    return {
      t: 'state',
      state,
      paused,
      sidePanel: resolveSidePanel(settings.sidePanel, state),
      keyboardPlayers: settings.keyboardPlayers,
      localPlayers: null, // filled per client
    };
  }

  function adminMessage(state) {
    return {
      t: 'admin',
      phase: state.phase,
      round: state.round,
      paused,
      config: { ...config },
      limits: CONFIG_LIMITS,
      settings: { ...settings },
      players: state.players.map((p) => ({ ...p, source: owners.get(p.id)?.source ?? 'unknown' })),
      joinInfo,
    };
  }

  function localPlayersOf(client, state) {
    const out = {};
    for (const [slot, id] of client.owned) {
      const p = state.players.find((x) => x.id === id);
      if (!p) continue;
      const snake = state.snakes.find((x) => x.id === id);
      out[slot] = { id, name: p.name, colorIndex: p.colorIndex, status: p.status, dir: snake?.dir ?? null };
    }
    return out;
  }

  function broadcast() {
    const state = engine.getState();
    const display = displayMessage(state);
    const admin = adminMessage(state);
    for (const c of clients) {
      if (c.role === 'display') safeSend(c, { ...display, localPlayers: localPlayersOf(c, state) });
      else if (c.role === 'admin') safeSend(c, admin);
      else if (c.role === 'player') safeSend(c, { t: 'me', phase: state.phase, round: state.round, paused, players: localPlayersOf(c, state) });
    }
  }

  // ---- tick loop -------------------------------------------------------------

  function tickOnce() {
    if (!paused) engine.tick();
    broadcast();
  }

  function start() {
    if (timer) return;
    let next = Date.now() + config.tickMs;
    const loop = () => {
      try {
        tickOnce();
      } catch (err) {
        log(`[game] tick failed: ${err.stack ?? err}`);
      }
      // config.tickMs is read every tick, so speed changes apply at once.
      next = Math.max(next + config.tickMs, Date.now());
      timer = setTimeout(loop, next - Date.now());
    };
    timer = setTimeout(loop, config.tickMs);
  }

  function stop() {
    clearTimeout(timer);
    timer = null;
  }

  // ---- players ---------------------------------------------------------------

  function addOwnedPlayer(client, slot, name, source, session = null) {
    if (client.owned.has(slot)) return { ok: true, already: true };
    const id = `p${nextPlayerNumber++}`;
    const result = engine.addPlayer(id, name);
    if (!result.ok) return result;
    client.owned.set(slot, id);
    owners.set(id, { client, slot, source, session });
    log(`[game] ${id} joined (${source}${slot === SELF ? '' : ` ${slot}`})`);
    return { ok: true, id, name, colorIndex: result.colorIndex };
  }

  function removeOwnedPlayer(id) {
    const owner = owners.get(id);
    if (owner) {
      owner.client.owned.delete(owner.slot);
      owners.delete(id);
    }
    return engine.removePlayer(id);
  }

  function kick(id) {
    const owner = owners.get(id);
    if (!removeOwnedPlayer(id)) return false;
    if (owner) safeSend(owner.client, { t: 'kicked', slot: owner.slot });
    log(`[game] ${id} kicked by admin`);
    return true;
  }

  // Phone name rules. Returns an error code, or null if the name is fine.
  // `ownId` is excluded from the uniqueness check (a reconnecting player).
  function nameProblem(name, ownId) {
    if (!name) return 'nameEmpty';
    if (wordList.matches(name)) return 'nameProfane';
    const key = nameKey(name);
    const taken = engine.getState().players.some((p) => p.id !== ownId && nameKey(p.name) === key);
    return taken ? 'nameTaken' : null;
  }

  // The phone player that belongs to this session token, if any.
  function playerOfSession(session) {
    if (!session) return null;
    for (const [id, o] of owners) if (o.session === session) return id;
    return null;
  }

  // A device rejoining (e.g. after its wifi dropped before the server noticed)
  // replaces its old player instead of being told its own name is taken.
  function replaceStale(id) {
    const old = owners.get(id);
    removeOwnedPlayer(id);
    if (!old) return;
    safeSend(old.client, { t: 'replaced' });
    try {
      old.client.close(4000, 'replaced');
    } catch {
      /* already closed */
    }
    log(`[game] ${id} replaced by a new connection from the same device`);
  }

  function joinPhone(client, msg) {
    if (client.owned.has(SELF)) return; // already playing on this connection
    const name = sanitizeName(msg.name);
    const session = typeof msg.session === 'string' && SESSION_PATTERN.test(msg.session) ? msg.session : null;
    const previous = playerOfSession(session);
    const problem = nameProblem(name, previous);
    if (problem) return safeSend(client, { t: 'error', code: problem, slot: SELF });
    if (previous) replaceStale(previous);
    const result = addOwnedPlayer(client, SELF, name, 'phone', session);
    if (!result.ok) return safeSend(client, { t: 'error', code: result.reason === 'full' ? 'full' : 'badMessage', slot: SELF });
    safeSend(client, { t: 'joined', slot: SELF, id: result.id, name: result.name, colorIndex: result.colorIndex });
    broadcast();
  }

  function sendWords(client) {
    safeSend(client, { t: 'words', words: wordList.words() });
  }

  function broadcastWords() {
    for (const c of clients) if (c.role === 'admin') sendWords(c);
  }

  // ---- incoming --------------------------------------------------------------

  function slotFor(client, msg) {
    if (client.role === 'display') return KEYBOARD_SLOTS.includes(msg.slot) ? msg.slot : null;
    if (client.role === 'player') return SELF;
    return null;
  }

  function handlePublic(client, msg) {
    switch (msg.t) {
      case 'hello': {
        // Role is chosen once; display and player are the only public roles.
        if (client.helloDone) return;
        if (msg.role === 'display' || msg.role === 'player') client.role = msg.role;
        client.helloDone = true;
        if (client.role === 'display') safeSend(client, { t: 'joinInfo', joinInfo });
        broadcast();
        return;
      }
      case 'join': {
        const slot = slotFor(client, msg);
        if (!slot) return badMessage(client);
        if (slot === SELF) return joinPhone(client, msg);
        if (!settings.keyboardPlayers) return safeSend(client, { t: 'error', code: 'keyboardDisabled' });
        const name = slot === 'wasd' ? STRINGS.display.keyboardWasd : STRINGS.display.keyboardArrows;
        const result = addOwnedPlayer(client, slot, name, 'keyboard');
        if (!result.ok) return safeSend(client, { t: 'error', code: result.reason === 'full' ? 'full' : 'badMessage', slot });
        if (!result.already) safeSend(client, { t: 'joined', slot, id: result.id, name, colorIndex: result.colorIndex });
        broadcast();
        return;
      }
      case 'dir': {
        const slot = slotFor(client, msg);
        const id = slot && client.owned.get(slot);
        if (!id) return; // not your player: ignore silently
        engine.setDirection(id, msg.dir); // engine validates the direction itself
        return;
      }
      case 'leave': {
        const slot = slotFor(client, msg);
        const id = slot && client.owned.get(slot);
        if (id) {
          removeOwnedPlayer(id);
          broadcast();
        }
        return;
      }
      default:
        return badMessage(client);
    }
  }

  function handleAdmin(client, msg) {
    switch (msg.t) {
      case 'config': {
        if (!msg.values || typeof msg.values !== 'object' || Array.isArray(msg.values)) return badMessage(client);
        const accepted = engine.updateConfig(msg.values); // clamps and drops unknown keys
        if (Object.keys(accepted).length) log(`[admin] config ${JSON.stringify(accepted)}`);
        break;
      }
      case 'pause':
        paused = true;
        break;
      case 'resume':
        paused = false;
        break;
      case 'restart':
        engine.restartRound();
        log('[admin] round restarted');
        break;
      case 'kick':
        if (typeof msg.id !== 'string' || !kick(msg.id)) return badMessage(client);
        break;
      case 'settings': {
        if (Object.hasOwn(msg, 'sidePanel')) {
          if (!SIDE_PANEL_MODES.includes(msg.sidePanel)) return badMessage(client);
          settings.sidePanel = msg.sidePanel;
        }
        if (Object.hasOwn(msg, 'keyboardPlayers')) {
          if (typeof msg.keyboardPlayers !== 'boolean') return badMessage(client);
          settings.keyboardPlayers = msg.keyboardPlayers;
          if (!msg.keyboardPlayers) {
            for (const [id, o] of [...owners]) if (o.source === 'keyboard') kick(id);
          }
        }
        break;
      }
      case 'addWord': {
        const result = wordList.add(msg.word);
        if (!result.ok) return safeSend(client, { t: 'error', code: `word_${result.reason}` });
        log('[admin] banned word added');
        return broadcastWords();
      }
      case 'removeWord':
        if (!wordList.remove(msg.word)) return badMessage(client);
        log('[admin] banned word removed');
        return broadcastWords();
      default:
        return badMessage(client);
    }
    broadcast();
  }

  function badMessage(client) {
    safeSend(client, { t: 'error', code: 'badMessage' });
  }

  // Rate limit per client: excess messages in a one-second window are dropped.
  function allow(client) {
    const now = Date.now();
    if (now - client.windowStart >= 1000) {
      client.windowStart = now;
      client.windowCount = 0;
    }
    return ++client.windowCount <= MAX_MESSAGES_PER_SECOND;
  }

  /**
   * Registers a connection.
   * @param {object} io { send(obj), close(code, reason) }
   * @param {object} [opts]
   * @param {boolean} [opts.admin] admin connection (already authenticated at handshake)
   * @param {() => boolean} [opts.isAuthorized] re-checked on every admin message
   */
  function connect(io, { admin = false, isAuthorized = () => false } = {}) {
    const client = {
      send: io.send,
      close: io.close,
      role: admin ? 'admin' : 'player',
      helloDone: admin,
      owned: new Map(), // slot -> playerId
      windowStart: 0,
      windowCount: 0,
    };
    clients.add(client);
    if (admin) {
      safeSend(client, adminMessage(engine.getState()));
      sendWords(client);
    }

    return {
      message(raw) {
        try {
          if (!allow(client)) return;
          if (admin && !isAuthorized()) {
            safeSend(client, { t: 'unauthorized' });
            client.close(4401, 'unauthorized');
            return;
          }
          let msg;
          try {
            msg = JSON.parse(String(raw));
          } catch {
            return badMessage(client);
          }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return badMessage(client);
          if (admin) handleAdmin(client, msg);
          else handlePublic(client, msg);
        } catch (err) {
          log(`[game] message handling failed: ${err.stack ?? err}`);
        }
      },
      disconnect() {
        clients.delete(client);
        let removed = false;
        for (const id of [...client.owned.values()]) removed = removeOwnedPlayer(id) || removed;
        if (removed) broadcast();
      },
    };
  }

  return { engine, config, settings, wordList, connect, start, stop, tickOnce, isPaused: () => paused };
}
