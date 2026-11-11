// Loads the server config file (config.json in the project root).
// If it doesn't exist yet, one is created with a random admin password so the
// admin pages are never left open by accident.

import fs from 'node:fs';
import crypto from 'node:crypto';

export const DEFAULT_PORT = 3000;

function str(value, max = 200) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

// Normalises a parsed config object; never throws.
export function normalizeServerConfig(raw) {
  const obj = raw && typeof raw === 'object' ? raw : {};
  const wifi = obj.wifi && typeof obj.wifi === 'object' ? obj.wifi : {};
  const port = Number.isInteger(obj.port) && obj.port > 0 && obj.port < 65536 ? obj.port : DEFAULT_PORT;
  return {
    port,
    adminPassword: str(obj.adminPassword),
    wifi: { ssid: str(wifi.ssid, 64), password: str(wifi.password, 128) },
    gameUrl: str(obj.gameUrl, 500).trim(),
  };
}

export function loadServerConfig(fileUrl, log = console.log) {
  if (!fs.existsSync(fileUrl)) {
    const generated = {
      port: DEFAULT_PORT,
      adminPassword: crypto.randomBytes(6).toString('base64url'),
      wifi: { ssid: '', password: '' },
      gameUrl: '',
    };
    fs.writeFileSync(fileUrl, JSON.stringify(generated, null, 2) + '\n');
    log(`[config] Created ${fileUrl.pathname ?? fileUrl} with a random admin password: ${generated.adminPassword}`);
    log('[config] Edit it to set the wifi SSID/password and your own admin password.');
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(fileUrl, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read config file: ${err.message}`);
  }
  const config = normalizeServerConfig(parsed);
  if (!config.adminPassword) throw new Error('config.json: "adminPassword" must be a non-empty string');
  if (!config.wifi.ssid) log('[config] Warning: wifi.ssid is empty, the wifi QR code will not work.');
  return config;
}
