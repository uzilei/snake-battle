# Snake Battle

Multiplayer snake for a school expo. One laptop runs the server, a big monitor shows `/display`, and players join from their phones over a local wifi network (no internet needed).

## Setup

```bash
npm install
npm start
```

On Windows you can double-click `run.bat` instead: it installs the dependencies on the first run, then starts the server. Close the window to stop it.

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

Player names are checked against `banned-words.json`. It is created from the starter list in `src/server/banned-words.default.json` on the first start, and can be edited live from /admin.

The game rules (dead snakes become apples, wrap-around walls) are /admin toggles, off by default, applied from the next round. So are two extra win conditions on top of "last snake alive", which always applies; when several are on, whichever triggers first ends the round:

- **Time limit** (`roundTimeLimitSec`): when it runs out, the longest living snake wins, or the one with the most kills this round (ties broken by length), as chosen on /admin. A full tie is a draw. /display shows the remaining time and flashes it in the last 10 seconds.
- **Target length** (`targetLength`): the first snake to reach it wins at once. If several reach it on the same tick the longest wins; a full tie is a draw.

In a solo round these can end the round, but nobody wins.

A snake earns a kill when another snake runs into its body or loses a head-on against it (walls and running into yourself give no kill). Kills of the current round are shown in the /display scoreboard and in /admin's player list.

The global leaderboard tracks three stats per player name: most wins, most kills and highest score (the best length each name ever reached). It is off by default; once enabled on /admin it records from the next round and /display shows one stat at a time as a top 10, either a fixed one or rotating every 10 seconds (that choice applies immediately). Each stat can be reset from /admin. The data is saved in `records.json`, created on the first recorded round. If `records.json` is ever unreadable, it is renamed to `records.json.bad` and the records start empty.

The /display effects (particles when a snake dies, a ring when an apple is eaten, a screen shake on head-on collisions) are also /admin toggles, off by default. They are purely visual and apply immediately.

With "Mouse e pulsanti ← →" enabled on /admin (off by default), /display shows the mouse cursor (it hides after a few seconds without movement) and, when the side column isn't on "Automatica", buttons in its bottom corners that switch to the previous or next panel. Any device that opens /display can press them while the toggle is on.

At startup the server prints the URLs for `/display`, `/play`, `/admin` and `/admin/print`.

## Pages

- `/display`: fullscreen view for the monitor. Double-click to toggle fullscreen. When "keyboard players" is enabled on /admin, WASD and the arrow keys control two local players.
- `/play`: phone controller. Add `?new` (for example `/play?new`) to ignore the saved name, so several tabs on one laptop can play as separate players. Arrow keys and WASD also steer there, for testing.
- `/admin`: password-protected control panel. It is not linked from anywhere.
- `/admin/print`: printable A4 page with the wifi and game QR codes.

## Tests

```bash
npm test
```

## Credits

Emoji graphics from [Twemoji](https://github.com/jdecked/twemoji), © Twitter, Inc. and other contributors, licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).
