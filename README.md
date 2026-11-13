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

Names are cleaned the same way on /play and on the server (`src/shared/names.js`): control characters and characters that draw nothing (Hangul fillers, the blank Braille pattern, zero-width and typographic spaces and the like) are removed, whitespace is collapsed and the name is capped at 16 characters. A name with no letter, number, symbol or punctuation left is rejected as empty. Player names are checked against `banned-words.json`. It is created from the starter list in `src/server/banned-words.default.json` on the first start, and can be edited live from /admin. If the file is ever empty or unreadable, it is renamed to `banned-words.json.bad` and the starter list is used again, so the filter is never silently off.

Swipes are queued (up to 3) and one turn is applied per tick. A queued turn that would put the head straight into the snake's own body (not counting a tail that moves away) is skipped and the snake goes straight on, so one swipe too many isn't suicide; going straight into your own body still kills. Other snakes and walls get no such protection.

The game rules (dead snakes become apples, wrap-around walls) are /admin toggles, off by default, applied from the next round. So are two extra win conditions on top of "last snake alive", which always applies; when several are on, whichever triggers first ends the round:

- **Time limit** (`roundTimeLimitSec`): when it runs out, the longest living snake wins, or the one with the most kills this round (ties broken by length), as chosen on /admin. A full tie is a draw. /display shows the remaining time and flashes it in the last 10 seconds.
- **Target length** (`targetLength`): the first snake to reach it wins at once. If several reach it on the same tick the longest wins; a full tie is a draw.

In a solo round these can end the round, but nobody wins.

Every snake starts with spawn protection: a normal 🛡️ shield for the first `spawnShieldSec` seconds of play (/admin slider, 0-10 s, 3 by default, 0 turns it off; saved, applies from the next spawn). It works exactly like the power-up shield, whether or not power-ups are on: it pops on a hit, leaves the snake a ghost for 1 s, and shows the shield ring and countdown badge on /display. Its timer starts when play does, not during the pre-round countdown. Every spawn goes through the same code path: round start, a player joining during the countdown, and any future mid-round respawn.

A snake earns a kill when another snake runs into its body or loses a head-on against it (walls and running into yourself give no kill). Kills of the current round are shown in the /display scoreboard and in /admin's player list.

The global leaderboard tracks three stats per player name: most wins, most kills and highest score (the best length each name ever reached). It is off by default; once enabled on /admin it records from the next round and /display shows one stat at a time as a top 10, either a fixed one or rotating every 10 seconds (that choice applies immediately). Each stat can be reset from /admin. The data is saved in `records.json`, created on the first recorded round. If `records.json` is ever empty or unreadable, it is renamed to `records.json.bad` (or `records.json.bad-<time>` if that exists already) and the records start empty. The records are saved at the end of every round; a crash only loses the round in progress.

Everything set on /admin (sliders, game rules, win conditions, side panel, global leaderboard and its stat, keyboard players, /display effects, fruits, hats and buttons) is saved in `settings.json` and restored at startup, so a restart keeps the expo running as it was. Pause is not saved: a restarted server is never paused. Values in the file are validated like /admin messages, and an empty or unreadable `settings.json` is renamed to `settings.json.bad` and the defaults are used. "Ripristina impostazioni predefinite" on /admin (with a confirmation) puts every one of these settings back to its default and saves that; like any /admin change, live values apply at once and round rules from the next round. It leaves the global leaderboard data, the banned words, `config.json` and the admin login alone.

`records.json`, `banned-words.json` and `settings.json` are all written to a temporary file first, flushed to disk and then renamed, so a crash or power cut mid-save never leaves a half-written file.

The /display effects (particles when a snake dies, a ring when an apple is eaten, a screen shake on head-on collisions) are also /admin toggles, off by default. They are purely visual and apply immediately.

Snakes always have big eyes. The snake animations are on by default (turn them off on /admin if they hurt readability or speed): the eyes blink every few seconds and look at the nearest food or snake head within 4 cells, a forked tongue flicks out now and then, the mouth opens in a wide grin (with fangs) when food is up to 3 cells straight ahead, and a bump runs from the head to the tail after each bite. A snake that gets a kill winks one eye, with a small burst of sparkles by its head. Dead snakes get X eyes while they fade. With the animations off the eyes just look ahead. Every snake has its own random timers. When a snake turns, its head swings round within about the first third of the tick. All of this is worked out on /display and changes nothing in the game.

Apples are drawn as a random fruit (🍏🍎🍐🍊🍋🍉🍇🍓🫐🍈🍒🍑🥭🍍🍅🥑), picked when the apple appears and kept until it's eaten. Every fruit is a normal apple. Under "Frutta" on /admin each fruit has a checkbox (all on by default), plus "Tutti" and "Solo mela" shortcuts; the choice is saved, and applies to apples that appear from then on. With none ticked, apples are all 🍎. The list lives in `src/shared/fruits.js`. Each fruit and power-up is also drawn mirrored or not at random, picked when it appears and kept until it's eaten (rats, chickens and the badger face where they're going instead).

On /play's name screen players can pick a hat: none, 🧢, 👒, 🎩 or 🎓 (Twemoji, served locally). The choice is remembered on the phone and sent with the join; the server accepts only those hats (anything else means no hat) and /admin's player list shows it. On /display the hat sits behind the eyes, its top pointing toward the tail, sized to the cell, and turns with the head (`HAT_SIZE` and `HAT_BACK` in `public/display/display.js` set its size and how far back it sits). Dead snakes don't wear it. The "Cappelli" toggle on /admin (on by default) switches the hats on /display; the picker on /play is always there. The list lives in `src/shared/hats.js`.

With "Mouse e pulsanti ← →" enabled on /admin (off by default), /display shows the mouse cursor (it hides after a few seconds without movement) and, when the side column isn't on "Automatica", buttons in its bottom corners that switch to the previous or next panel. Any device that opens /display can press them while the toggle is on.

At startup the server prints the URLs for `/display`, `/play`, `/admin` and `/admin/print`.

## Power-ups

Off by default. "Power-up attivi" on /admin turns them on from the next round; the sliders below it apply immediately.

- **Spawning:** a new apple becomes a power-up with the chosen probability, picked by each power-up's weight (0 = never). Power-ups take an apple's place, count toward the number of apples, never disappear, and grow the snake like an apple before their effect.
- **Bombs:** each covers a 3x3 block, drawn as one big bomb inside a pulsing red danger outline like the badger's. They spawn separately (bombs per minute, at most 5 at once) only where all 9 cells are free, don't count as apples, don't grow the snake, and vanish after 10 seconds, blinking during the last 3.
- **Timed effects** don't stack: a new one replaces the current one. A small badge by the head counts it down on /display.

| | Power-up | Effect |
|---|---|---|
| ⭐ | Golden | Moves two cells per tick for 3 s. |
| 👻 | Ghost | For 3 s passes through every snake and projectile, and nothing collides with it. Walls still count. |
| 💣 | Bomb | A head entering any of its 9 cells sets it off. What happens depends on "Effetto delle bombe" on /admin (saved, applies at once). In "cut" mode (the default) the front half of the snake (at least 1 segment) is blown off and vanishes, and the snake carries on from the rest, in the direction that part was going, as a ghost for 1 s; its pending growth and queued turns are cleared, and if fewer than 3 segments would remain it dies. In "kill" mode the snake dies outright. Either way nobody gets the kill, a ghost passes through without setting it off, and a shield pops instead. |
| 🔫 | Gun | Fires one projectile straight ahead: 2 cells per tick, never wraps. Any snake it hits dies (the shooter gets the kill, unless it hit itself). Two projectiles that meet both vanish. |
| 🧲 | Magnet | For 5 s, every apple (regular or extra) within 3 cells flies straight into the mouth and is eaten. Power-ups and bombs aren't pulled. |
| 🧊 | Freeze | For 3 s, every other snake moves only every second tick. Rats, chickens and the badger move half as often too, and are tinted blue like the frozen snakes. |
| ✂️ | Scissors | For 8 s, the next time it runs into a body (another snake's or its own), it cuts that snake there instead of dying. A cut leaving fewer than 3 segments kills: it counts as a kill when it was another snake, and as no kill when it was yourself. Head-ons and heads are unaffected. |
| 🌀 | Portal | A two-way pair for 8 s: one end where it was eaten, the other somewhere safe with 3 free cells ahead. The eater's head goes through at once; after that, any head entering either end comes out of the other, same direction, and the body follows. Projectiles ignore portals. |
| 🍗 | Feast | 10 extra apples on the free cells around the eater. |
| 🛡️ | Shield | For 10 s, survives the next hit (wall, body, head-on or projectile): the shield pops and the snake is a ghost for 1 s. At a wall it turns aside instead. |

Segments removed from a living snake (the part scissors cut off) become apples when "I serpenti morti diventano mele" is on, and vanish otherwise. The front a bomb blows off always vanishes.

To add a power-up: an entry in `src/shared/powerups.js` (its weight slider, /admin label and sprite are generated from it), its effect in the engine's `EFFECTS` table, and its Italian name in `STRINGS.admin.powerUpNames`. A test checks all three are there.

## Rats 🐀

Rare food that runs away. A new apple becomes a rat with the "topo" probability on /admin (3% by default, 0 = never). That setting applies at once and doesn't depend on the power-up switch. Rats take an apple's place and count toward the number of apples.

- **Movement:** one cell every second tick (half a snake's speed), straight on. It picks a random new direction after 2–20 ticks, or straight away when the next cell is a wall, a snake, a bomb, a portal end, an item or another rat. Walls wrap when "Bordi attraversabili" is on, and rats ignore portals. A rat never turns back to the cell it just left unless that's the only way out. Boxed in, it stays put. Rats move at the start of a tick, before the snakes.
- **Eating:** a head entering the rat's cell eats it. So does a rat running into the cell a head is entering, or out of it in that same move, so it can never slip past a head. Ghosts eat rats too. A rat grows the snake by 4 × "Crescita per mela" and is replaced like an apple.
- **Not affected:** the magnet doesn't pull rats. A projectile (or a gun fired right next to one) kills a rat. The rat just disappears, and nobody gets a kill.
- **/display:** each rat is drawn as 🐀 or 🐁 (fixed per rat, purely visual). Rats slide smoothly between cells. The sprite is never rotated: it's mirrored while running right, and keeps its last left/right look while running up or down.

Rules and numbers live in `src/shared/rats.js`; the engine's `moveCreatures` does the movement.

## Chickens 🐓

Rarer food that flees. A new apple becomes a chicken with the "gallo" probability on /admin (2% by default, 0 = never), rolled when the rat roll fails. Like the rat's, the setting is saved, applies at once and doesn't depend on the power-up switch. Chickens take an apple's place and count toward the number of apples.

- **Calm:** it moves exactly like a rat: one cell every second tick, a new random direction every 2–20 ticks or when blocked, wrapping with the walls, ignoring portals.
- **Alerted:** a threat 2 grid steps away or closer alerts it. Threats are snake heads (ghosts too) and every cell of the active badger's block (not during its warning). It then moves every tick, starting that very tick. Each move, 90% of the time it takes the free way that ends furthest from the nearest threat, head or badger cell, whichever is closer (back where it came from included); otherwise it moves like a rat. It calms down once no threat has come that close for 1 s.
- **Eating:** caught exactly like a rat: a head entering its cell, or the chicken running into or out of the cell a head is entering. Ghosts catch it too. It grows the snake by 25 × "Crescita per mela", and a feast spawns round the eater, as if it had picked up 🍗. The 🍗 power-up itself is unchanged.
- **Other deaths:** a projectile (or a gun fired right next to it) or the badger kills it. Nobody grows or scores, and a 🍗 feast power-up takes its place on the cell where it died; it still counts toward the number of apples. The same goes for any way of dying other than being eaten by a snake. /display shows a poof of feathers.
- **Not affected:** the magnet doesn't pull it.
- **/display:** 🐓, never rotated, mirrored while running right, sliding between cells, on the rats' green glow. While it's alerted a small ❗ pops up above it and bobs, and goes when it calms down.

Rules and numbers live in `src/shared/chicken.js`.

## Honey badger 🦡

A rare predator: a 5×3 block (5 wide, 3 tall) that never rotates. Three /admin sliders control it; all are saved, and neither depends on the power-up switch:

- **"Tasso del miele" (average seconds between badgers):** 120 by default, 30–600, or 0 for never. The real delay is random, between half and one and a half times the average, counted in seconds of play. A change applies at once.
- **"Quanto resta in campo" (lifetime):** 20 s by default, 5–120. A change applies from the next badger.
- **"Vita del tasso" (health):** 3 HP by default, 1–10: the scissors hits it takes to die. A change applies from the next badger.

There is never more than one badger on the board.

- **Spawning:** fully on the board, clear of bombs and portal ends, with its whole block at least 3 steps from every snake head. Snake bodies and items may be under it. It first shows a 2 s warning, during which it does nothing. It blinks during its last 3 s, like a bomb, and when its lifetime ends it goes in a grey puff the size of its block. A new round clears it.
- **Movement:** like a rat but slower. It moves one cell every 4 ticks, straight on, and picks a random direction again after 20–40 ticks (it may keep the same one, but never turns straight back unless that's the only way), or straight away when blocked. When its block touches a wall, that pick is always away from the wall if it can be. Blocked means any of its cells would leave the board (it never wraps, even with wrap-around walls) or land on a bomb or a portal end. Snakes and items don't block it. Bombs never spawn on it, and portal exits never open inside it.
- **Snakes (new contact only):** each sub-step, a segment touches the badger only when it is newly inside the block, either because the head moved in from outside or because the badger moved onto that segment. Segments that were already inside are ignored until they leave. This covers a body that was under the warning. Ghosts are never touched. A snake that touches it while immune (a ghost, including the second after a shield pops) is passing through until no segment of it is inside any more: once the immunity ends, the badger moving onto more of it still doesn't bite. Its head moving into the block from outside (looping back in) does count as usual, a bite or a scissors hit. For each snake with new contact, the one nearest the head counts:
  - the head: the snake dies;
  - any other segment: the snake is cut there, and the cut-off part follows "dead snakes become apples";
  - if fewer than 3 segments would be left, the snake dies.

  A shield pops instead of any of these, and the badger never gives anyone a kill.

  **Scissors:** a snake holding scissors whose head moves into the block hits the badger instead of being bitten: 1 HP off, the scissors are used up, and the snake becomes a ghost for 1 s and is passing through (the badger moving onto it doesn't bite until it has fully left, but its head looping back in does). The badger moving onto a scissors snake bites as usual. The hit that takes the last HP kills it like a projectile: a kill for that snake, and the big burst. Hits are dealt before bites, so once it's dead nobody else is bitten that sub-step. Several snakes can be bitten at once. The badger bites before items are eaten, so a head can't eat its way out of it through a portal.
- **Items:** ignored. Fruits and power-ups spawn and stay under it as usual.
- **Rats and chickens:** a new apple that would become a rat or a chicken under the badger (warning included) stays a plain apple. A rat or chicken inside the active badger dies, whether it ran in, the badger moved onto it, or it was under the warning when the badger became active. Nobody grows or gets a kill, and a chicken leaves a 🍗 feast power-up in its place. Chickens flee the active badger like a snake head.
- **Projectiles:** a projectile entering any of its cells (or that the badger steps onto, or a gun fired right next to it) kills the badger at once, whatever its HP. That is a kill for the shooter, and the projectile is used up.
- **/display:**
  - one big 🦡 over its block, never rotated, mirrored while heading right, sliding smoothly;
  - while active, a red outline pulses round it;
  - the warning is a dashed, pulsing red outline with ⚠️ in the middle;
  - a boss-style health bar just above its block once active (red fill, dark frame, one segment per HP); each scissors hit flashes the badger white and the lost segment fades out;
  - a killed badger (shot, or its last HP) goes off in a bomb's burst the size of its block, and the killer winks;
  - rats and chickens get a soft green glow, so green means eat and red means run;
  - a boss name: the /admin field "Nome del tasso" (saved, up to 20 characters, cleaned like a player name, empty for none) is drawn above the health bar in big bold red-outlined letters, from the warning on. With no room above, the bar and the name go below the block instead.

  The burst and the puff follow the particles toggle.

Rules and numbers live in `src/shared/badger.js`.

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
