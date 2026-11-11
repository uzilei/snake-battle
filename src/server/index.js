// Entry point: node src/server/index.js

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadServerConfig } from './config.js';
import { createApp } from './app.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configPath = path.join(ROOT, 'config.json');

const serverConfig = loadServerConfig(configPath);
const { listen } = createApp({ serverConfig });

// A single bad client must never take the server down.
process.on('uncaughtException', (err) => console.error('[server] uncaught exception:', err));
process.on('unhandledRejection', (err) => console.error('[server] unhandled rejection:', err));

try {
  const urls = await listen(serverConfig.port, '0.0.0.0');
  console.log('Snake Battle is running:');
  console.log(`  Display      ${urls.display}`);
  console.log(`  Play         ${urls.play}`);
  console.log(`  Admin        ${urls.admin}`);
  console.log(`  Admin print  ${urls.print}`);
} catch (err) {
  console.error(`[server] could not start on port ${serverConfig.port}: ${err.message}`);
  process.exit(1);
}
