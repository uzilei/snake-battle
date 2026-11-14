# Snake Battle

Multiplayer snake for a school expo. One laptop runs the server and the admin panel, one 27" 16:9 monitor shows the game, and players join with their phones over a local wifi network with no internet.

## Hard rules

- **Engine is input-agnostic.** The game logic module must not know about WebSockets, keyboards, phones, rendering, or the DOM. All input goes through `setDirection(id, dir)`. It must also be plain JavaScript that runs unchanged in a browser: no Node built-ins (`fs`, `path`, `http`, `process`, `Buffer`, etc.). Persistence and file access belong in the server layer.
- **No external network requests at runtime.** No CDNs, no web fonts, no remote scripts. Every library and asset is installed via npm and served locally. The expo network has no internet.
- **Plain http, bound to 0.0.0.0.** No https.
- **All user-facing text is in Italian by default**, with English selectable on /admin. The text lives in `src/shared/strings.js` (Italian) and `src/shared/strings-en.js` (English), with the same keys in both. Code, comments, and logs stay in English.
- **No audio files.** Sounds are jsfxr presets (JSON synth parameters in `sounds/`), synthesized in the browser. Snakes and effects are drawn procedurally on canvas. Apples and power-ups use Twemoji SVGs, installed via npm (the maintained `@twemoji` fork) and served locally, preloaded once and drawn with `drawImage`. Twemoji graphics are CC-BY 4.0: include a credit line on /admin and in the README.
- **Never trust the client.** Validate every incoming message server-side (type, range, player ownership). One bad client must never crash the server.
- **New features are toggles on /admin, default off,** unless stated otherwise.

## Pages

- `/display`: fullscreen, read-only, for the big monitor. Square game area left, side column right. The side column shows either the round scoreboard / global leaderboard or a backup join panel (QR codes and instructions), switchable from /admin. QR codes are also printed.
- `/play`: phone controller. Name prompt, then a full-screen swipe pad in the player's color.
- `/admin`: control panel on the laptop screen. Live settings and player management. Password-protected, not linked anywhere.
- `/admin/print`: printable page with the wifi QR and game QR. Same password protection as /admin.

## Stack

Node.js (LTS), Express, ws. Tests with Node's built-in test runner (`node --test`).

## Workflow

- Keep changes scoped to the current task. Don't refactor unrelated code.
- Add or update tests whenever engine rules change, and run them before finishing.
- Config lives in a shared mutable object read every tick; grid size changes apply at the next round only.
