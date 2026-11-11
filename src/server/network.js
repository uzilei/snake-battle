// LAN address detection, public URLs, and QR payloads.

import os from 'node:os';
import QRCode from 'qrcode';

// Adapter names that are almost never the expo wifi.
const VIRTUAL = /vEthernet|virtual|vmware|vbox|hyper-v|wsl|docker|loopback|tailscale|zerotier|bluetooth/i;

function privateRank(ip) {
  if (ip.startsWith('192.168.')) return 0;
  if (ip.startsWith('10.')) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (ip.startsWith('169.254.')) return 9; // link-local: no DHCP, last resort
  return 5;
}

// Best guess at the laptop's address on the local network.
export function detectLanIp(interfaces = os.networkInterfaces()) {
  const candidates = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal) continue;
      candidates.push({ ip: a.address, rank: privateRank(a.address) + (VIRTUAL.test(name) ? 10 : 0) });
    }
  }
  candidates.sort((x, y) => x.rank - y.rank);
  return candidates[0]?.ip ?? '127.0.0.1';
}

export function baseUrl(serverConfig, port, lanIp = detectLanIp()) {
  return `http://${lanIp}:${port}`;
}

// The URL phones open: the fixed gameUrl from the config file, or /play on the LAN IP.
export function playUrl(serverConfig, port, lanIp) {
  if (serverConfig.gameUrl) return serverConfig.gameUrl;
  return `${baseUrl(serverConfig, port, lanIp)}/play`;
}

// Escapes \ ; , : " as required by the WIFI: QR format.
function wifiEscape(s) {
  return s.replace(/([\\;,:"])/g, '\\$1');
}

export function wifiPayload({ ssid, password }) {
  if (!password) return `WIFI:T:nopass;S:${wifiEscape(ssid)};;`;
  return `WIFI:T:WPA;S:${wifiEscape(ssid)};P:${wifiEscape(password)};;`;
}

// Single QR generator used by both /display and /admin/print.
export async function qrSvg(text) {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } });
}
