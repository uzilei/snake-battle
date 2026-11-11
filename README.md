# Snake Battle

Multiplayer snake for a school expo. One laptop runs the server, a big monitor shows `/display`, and players join from their phones over a local wifi network (no internet needed).

## Setup

```bash
npm install
npm start
```

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
