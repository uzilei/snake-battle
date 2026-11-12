# Snake Battle

Multiplayer snake for a school expo. One laptop runs the server, a big monitor shows `/display`, and players join from their phones over a local wifi network (no internet needed).

## Setup

```bash
npm install
npm start
```

On Windows you can double-click `run.bat` instead: it installs the dependencies on the first run, then starts the server. If the server ever exits (a crash, or a start-up error such as the port being busy), it is restarted after 3 seconds and the restart is logged with a timestamp in the window and in `server-restarts.log`. Close the window (or press Ctrl+C) to stop it.

The first start creates `config.json` with a random admin password, which is printed in the console. Edit it before the expo:

```json
{
  "port": 3000,
  "adminPassword": "choose-a-password",
  "wifi": { "ssid": "ExpoWifi", "password": "wifi-password" },
  "gameUrl": ""
}
```

- `wifi` is used for the wifi QR code. Leave `password` empty for an open network.
- `gameUrl` is optional. If it is empty, the /play URL is built from the laptop's LAN IP, which is detected automatically.

Player names are checked against `banned-words.json`. It is created from the starter list in `src/server/banned-words.default.json` on the first start, and can be edited live from /admin. If the file is ever empty or unreadable, it is renamed to `banned-words.json.bad` and the starter list is used again, so the filter is never silently off.

The game rules (dead snakes become apples, wrap-around walls) are /admin toggles, off by default, applied from the next round. So are two extra win conditions on top of "last snake alive", which always applies; when several are on, whichever triggers first ends the round:

- **Time limit** (`roundTimeLimitSec`): when it runs out, the longest living snake wins, or the one with the most kills this round (ties broken by length), as chosen on /admin. A full tie is a draw. /display shows the remaining time and flashes it in the last 10 seconds.
- **Target length** (`targetLength`): the first snake to reach it wins at once. If several reach it on the same tick the longest wins; a full tie is a draw.

In a solo round these can end the round, but nobody wins.

A snake earns a kill when another snake runs into its body or loses a head-on against it (walls and running into yourself give no kill). Kills of the current round are shown in the /display scoreboard and in /admin's player list.

The global leaderboard tracks three stats per player name: most wins, most kills and highest score (the best length each name ever reached). It is off by default; once enabled on /admin it records from the next round and /display shows one stat at a time as a top 10, either a fixed one or rotating every 10 seconds (that choice applies immediately). Each stat can be reset from /admin. The data is saved in `records.json`, created on the first recorded round. If `records.json` is ever empty or unreadable, it is renamed to `records.json.bad` (or `records.json.bad-<time>` if that exists already) and the records start empty. The records are saved at the end of every round; a crash only loses the round in progress.

Everything set on /admin (sliders, game rules, win conditions, side panel, global leaderboard and its stat, keyboard players, /display effects and buttons) is saved in `settings.json` and restored at startup, so a restart keeps the expo running as it was. Pause is not saved: a restarted server is never paused. Values in the file are validated like /admin messages, and an empty or unreadable `settings.json` is renamed to `settings.json.bad` and the defaults are used.

`records.json`, `banned-words.json` and `settings.json` are all written to a temporary file first, flushed to disk and then renamed, so a crash or power cut mid-save never leaves a half-written file.

The /display effects (particles when a snake dies, a ring when an apple is eaten, a screen shake on head-on collisions) are also /admin toggles, off by default. They are purely visual and apply immediately.

With "Mouse e pulsanti ← →" enabled on /admin (off by default), /display shows the mouse cursor (it hides after a few seconds without movement) and, when the side column isn't on "Automatica", buttons in its bottom corners that switch to the previous or next panel. Any device that opens /display can press them while the toggle is on.

At startup the server prints the URLs for `/display`, `/play`, `/admin` and `/admin/print`.

## Power-ups

Off by default. "Power-up attivi" on /admin turns them on from the next round; the sliders below it apply immediately.

- **Spawning:** a new apple becomes a power-up with the chosen probability, picked by each power-up's weight (0 = never). Power-ups take an apple's place, count toward the number of apples, never disappear, and grow the snake like an apple before their effect.
- **Bombs:** spawn separately (bombs per minute, at most 5 at once), don't count as apples, don't grow the snake, and vanish after 10 seconds, blinking during the last 3.
- **Timed effects** don't stack: a new one replaces the current one. A small badge by the head counts it down on /display.

| | Power-up | Effect |
|---|---|---|
| ⭐ | Golden | Moves two cells per tick for 3 s. |
| 👻 | Ghost | For 3 s passes through every snake and projectile, and nothing collides with it. Walls still count. |
| 💣 | Bomb | Shrinks the snake by a quarter (never below 3) and cancels its pending growth. |
| 🔫 | Gun | Fires one projectile straight ahead: 2 cells per tick, never wraps. Any snake it hits dies (the shooter gets the kill, unless it hit itself). Two projectiles that meet both vanish. |
| 🧲 | Magnet | For 5 s, apples and power-ups within 3 cells move one cell toward the head each tick. Bombs aren't pulled. |
| 🧊 | Freeze | For 3 s, every other snake moves only every second tick. |
| ✂️ | Scissors | For 8 s, the next time it runs into another snake's body, it cuts that snake there instead of dying. A cut leaving fewer than 3 segments kills (and counts as a kill). Head-ons and your own body are unaffected. |
| 🌀 | Portal | An entrance where it was eaten and an exit somewhere safe, for 8 s. Any head entering the entrance comes out of the exit, same direction. Projectiles ignore portals. |
| 🍗 | Feast | 10 extra apples on the free cells around the eater. |
| 🛡️ | Shield | For 10 s, survives the next hit (wall, body, head-on or projectile): the shield pops and the snake is a ghost for 1 s. At a wall it turns aside instead. |

Segments removed from a living snake (the part scissors cut off) become apples when "I serpenti morti diventano mele" is on, and vanish otherwise. A bomb's lost tail always vanishes.

To add a power-up: an entry in `src/shared/powerups.js` (its weight slider, /admin label and sprite are generated from it), its effect in the engine's `EFFECTS` table, and its Italian name in `STRINGS.admin.powerUpNames`. A test checks all three are there.

## Pages

- `/display`: fullscreen view for the monitor. Double-click to toggle fullscreen. When "keyboard players" is enabled on /admin, WASD and the arrow keys control two local players.
- `/play`: phone controller. Add `?new` (for example `/play?new`) to ignore the saved name, so several tabs on one laptop can play as separate players. Arrow keys and WASD also steer there, for testing.
- `/admin`: password-protected control panel. It is not linked from anywhere.
- `/admin/print`: printable A4 page with the wifi and game QR codes.
- `/health`: JSON status for whoever runs the laptop: uptime, phase, player and connection counts, and tick timing (configured interval, measured mean and worst of the last 100 ticks). No names or settings.

## Tests

```bash
npm test
```

Load test (16 simulated phones for 5 minutes with every gameplay toggle on, power-ups included, malformed messages, disconnects, then a hard kill and restart). It runs its own server on 127.0.0.1 with its data in a temp folder, so it never touches `records.json`, `banned-words.json` or `config.json`:

```bash
node loadtest.js --minutes 5 --bots 16
```

## Credits

Emoji graphics from [Twemoji](https://github.com/jdecked/twemoji), © Twitter, Inc. and other contributors, licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).
