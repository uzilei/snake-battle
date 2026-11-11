// Game controller: owns the engine, runs the tick loop, tracks which client
// owns which player, and validates every incoming message.
//
// Transport-agnostic: a client is { send(obj), close(code, reason) } plus a
// role. The WebSocket wiring lives in app.js.

import { createEngine, createDefaultConfig, CONFIG_LIMITS, PHASES } from '../engine.js';
import { STRINGS, fmt } from '../shared/strings.js';

export const SIDE_PANEL_MODES = Object.freeze(['auto', 'leaderboard', 'join']);
export const KEYBOARD_SLOTS = Object.freeze(['wasd', 'arrows']);
const SELF = 'self';
const MAX_NAME_LENGTH = 16;
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

export function resolveSidePanel(mode, state) {
  if (mode === 'leaderboard' || mode === 'join') return mode;
  return state.players.length < 2 || state.phase === PHASES.INTERMISSION ? 'join' : 'leaderboard';
}

export function createGame({ random = Math.random, log = console.log, joinInfo = {} } = {}) {
  const config = createDefaultConfig();
  const engine = createEngine({ config, random });
  const settings = { sidePanel: 'auto', keyboardPlayers: false };
  let paused = false;
  let nextPlayerNumber = 1;
  let timer = null;

  const clients = new Set();
  const owners = new Map(); // playerId -> { client, slot, source }

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
      if (p) out[slot] = { id, colorIndex: p.colorIndex, status: p.status };
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
      else if (c.role === 'player') safeSend(c, { t: 'me', phase: state.phase, paused, players: localPlayersOf(c, state) });
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

  function addOwnedPlayer(client, slot, name, source) {
    if (client.owned.has(slot)) return { ok: true, already: true };
    const id = `p${nextPlayerNumber++}`;
    const result = engine.addPlayer(id, name || fmt(STRINGS.defaultName, { n: id.slice(1) }));
    if (!result.ok) return result;
    client.owned.set(slot, id);
    owners.set(id, { client, slot, source });
    log(`[game] ${id} joined (${source}${slot === SELF ? '' : ` ${slot}`})`);
    return { ok: true, id, colorIndex: result.colorIndex };
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
        let name;
        let source;
        if (client.role === 'display') {
          if (!settings.keyboardPlayers) return safeSend(client, { t: 'error', code: 'keyboardDisabled' });
          name = slot === 'wasd' ? STRINGS.display.keyboardWasd : STRINGS.display.keyboardArrows;
          source = 'keyboard';
        } else {
          name = sanitizeName(msg.name);
          source = 'phone';
        }
        const result = addOwnedPlayer(client, slot, name, source);
        if (!result.ok) return safeSend(client, { t: 'error', code: result.reason === 'full' ? 'full' : 'badMessage', slot });
        if (!result.already) safeSend(client, { t: 'joined', slot, id: result.id, colorIndex: result.colorIndex });
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
    if (admin) safeSend(client, adminMessage(engine.getState()));

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

  return { engine, config, settings, connect, start, stop, tickOnce, isPaused: () => paused };
}
