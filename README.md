# Snake Battle

Multiplayer snake for a school expo. One laptop runs the server, a big monitor shows `/display`, and players join from their phones over a local wifi network (no internet needed).

## Setup

```bash
npm install
npm start
```

On Windows you can double-click `run.bat` instead: a computer needs only Node.js 20 or newer. Whenever a dependency in `package.json` is missing (the first run, or a `node_modules` copied from an older version), it runs `npm install`, which needs internet; after that everything runs offline. Then it starts the server. If the server ever exits (a crash, or a start-up error such as the port being busy), it is restarted after 3 seconds and the restart is logged with a timestamp in the window and in `server-restarts.log`. Close the window (or press Ctrl+C) to stop it.

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

The game rules (dead snakes become apples, wrap-around walls) are /admin toggles, applied from the next round (the expo setup turns dead snakes into apples, see below). Extra apples (from dead snakes and the 🍗 feast) come on top of the number of apples: the regular items stay at that number however many extras there are, and extras are never removed when it's lowered. Each apple from a dead snake (or a cut-off part) grows the snake that eats it by exactly 1, whatever "Crescita per mela" says, whether it runs into it or a magnet pulls it in; regular and feast apples grow it by "Crescita per mela". How they look is a setting under the toggle, applied at once and purely visual: "Frutta" (random fruit, as before) or "Resti", gray rounded snake segments joined like the body they came from, on the same faint green "food" glow as rats and chickens, a dead snake's head keeping its X X eyes. Each segment is still one apple, eaten one at a time, so eating one out of the middle leaves two separate pieces (the engine tags each corpse apple with its piece, its index in the body and, for a dead snake's head, its direction). So are three extra win conditions on top of "last snake alive", which always applies; when several are on, whichever triggers first ends the round:

- **Time limit** (`roundTimeLimitSec`): when it runs out, the longest living snake wins, or the one with the most kills this round (ties broken by length), as chosen on /admin. A full tie is a draw. /display shows the remaining time and flashes it in the last 10 seconds.
- **Target length** (`targetLength`): the first snake to reach it wins at once. If several reach it on the same tick the longest wins; a full tie is a draw.
- **Last person standing** (`lastPersonWins`): when only one person is left alive and every other living snake is a bot, the round ends and that person wins (it counts toward the global leaderboard like any win). Only in rounds that started with at least two people, so a lone player against bots still has to outlast them; /display says why the round ended.

In a solo round these can end the round, but nobody wins.

Every snake starts with spawn protection: a normal 🛡️ shield for the first `spawnShieldSec` seconds of play (/admin slider, 0-10 s, 3 by default, 0 turns it off; saved, applies from the next spawn). It works exactly like the power-up shield, whether or not power-ups are on: it pops on a hit, leaves the snake a ghost for 1 s, and shows the shield ring and countdown badge on /display. Its timer starts when play does, not during the pre-round countdown. Every spawn goes through the same code path: round start, a player joining during the countdown, and any future mid-round respawn.

A snake earns a kill when another snake runs into its body or loses a head-on against it (walls and running into yourself give no kill). A head-on between snakes of the same length kills both, and each gets the kill. The exception is a snake boxed in with no way out: if every way it could go was a wall, the badger or a body, and one of them was another snake's body, that snake gets the kill whichever way it died, so turning into the wall on purpose denies nobody a kill. Kills of the current round are shown in the /display scoreboard and in /admin's player list.

The global leaderboard tracks three stats per player name: most wins, most kills and highest score (the best length each name ever reached). It is off by default; once enabled on /admin it records from the next round and /display shows one stat at a time as a top 10, either a fixed one or rotating every 10 seconds (that choice applies immediately). Each stat can be reset from /admin. The data is saved in `records.json`, created on the first recorded round. If `records.json` is ever empty or unreadable, it is renamed to `records.json.bad` (or `records.json.bad-<time>` if that exists already) and the records start empty. The records are saved at the end of every round; a crash only loses the round in progress.

Everything set on /admin (sliders, game rules, win conditions, side panel, global leaderboard and its stat, keyboard players, /display effects, fruits, hats and buttons) is saved in `settings.json` and restored at startup, so a restart keeps the expo running as it was. Pause is not saved: a restarted server is never paused.

With no `settings.json` (and after "Ripristina impostazioni predefinite") the server uses the expo setup in `src/server/expo-defaults.js`: dead snakes become apples, power-ups on, the last person standing wins, rats 15%, chickens 5%, a 5 s countdown and a 5 s break between rounds, a badger every 60 s on average staying 30 s and named "Torquato Tasso", bot fill mode with skill weights 3, 3, 1, every /display effect and the side column buttons on, and 🍎 as the only fruit. Each value is validated like an /admin change. The "by default" values elsewhere in this README are the engine's own neutral defaults (rules off), which `createGame()` uses without that preset, as the tests do; index.js passes the preset. Values in the file are validated like /admin messages, and an empty or unreadable `settings.json` is renamed to `settings.json.bad` and the defaults are used. "Ripristina impostazioni predefinite" on /admin (with a confirmation) puts every one of these settings back to its default and saves that; like any /admin change, live values apply at once and round rules from the next round. It leaves the global leaderboard data, the banned words, `config.json` and the admin login alone.

Each category of /admin also has its own "Ripristina predefiniti di questa sezione" button at the bottom, and the power-up weights have a "Ripristina pesi predefiniti" button of their own. These put only that category's values (or only the weights) back to the same defaults the full reset uses, and leave the rest as it is. Neither touches the language or the reserved bot names; only the full reset clears those. Which values belong to which button is `RESET_GROUPS` in `src/server/game.js`; a test checks that every setting belongs to exactly one category.

`records.json`, `banned-words.json` and `settings.json` are all written to a temporary file first, flushed to disk and then renamed, so a crash or power cut mid-save never leaves a half-written file.

The /display effects (particles: explosions and sparks when something dies or is hit, and a ring when an apple is eaten; a screen shake on every snake death and on big hits) are also /admin toggles, all on in the expo setup. They are purely visual and apply immediately.

**Sounds** have their own /admin category, «Suoni 🔊», on in the expo setup. There are no audio files: each sound is a small [jsfxr](https://github.com/chr15m/jsfxr) preset in `sounds/` (JSON synth parameters), synthesized in the browser when /display loads. Browsers only play audio after a click or key press on the page, so /display shows a «Clicca qui per attivare i suoni» banner until someone clicks it once. The four turn sounds (one per snake turn: `moveUp`, `moveDown`, `moveLeft`, `moveRight`) share one volume slider, at 0 (muted) by default, since with many bots they play almost all the time. The category also has a master volume (0–100%) and a volume per sound (0–200%, relative to the master; 0 mutes it), applied live. When the same kind of sound happens several times in one tick (say three apples eaten, or several snakes turning, which count as one kind), they're spaced evenly over the tick instead of all playing at once. Every one plays, however many there are. A limiter at the end of the audio chain keeps a pile-up from clipping: it only turns the total down when it would go past full scale. Which event plays which sound is in `src/shared/sounds.js`; to change a sound, edit or replace its JSON (e.g. exported from sfxr.me).

Kill popups (also an /admin toggle, on in the expo setup): when a snake is killed by another, a tilted "KILL!" pops up over its head with a burst of stars and a ring. The killer's next kills in the same round read "DOUBLE KILL!!", "TRIPLE KILL!!!", "QUADRA KILL!!!!", "PENTA KILL!!!!!" and then "6× KILL!!!!!" and so on; each step is bigger, hotter in color and with more particles, from 3 kills on they glow and wobble, and past 5 they cycle through the rainbow. A new popup makes older ones close by fade out quickly. These texts are in English on purpose. Killing the badger counts too: its popup appears over the badger, and the numbering goes on from it (a snake with 3 kills that shoots the badger gets "QUADRA KILL!!!!", its next kill "PENTA KILL!!!!!"), the same count as the 🎯 on the scoreboard. The engine numbers them in each credited death event and `badgerKilled` event (`killNo`).

Takedowns (same toggle): killing the snake that led the round in kills (badger included, more than 2, ties included) adds "SHUTDOWN!" in cyan; the round's first credited kill (every one on that tick) adds "FIRST BLOOD!" in red; killing the longest snake (more than 20 cells, ties included) adds "MVP KILL!" in gold. Only one per kill: SHUTDOWN! first, then FIRST BLOOD!, then MVP KILL!. The text appears just below the KILL! and drops instead of rising, with its own falling burst. The engine works out the leaders as they were when the tick began (so a kill or growth on the tick the victim dies doesn't change it) and marks the death event with `takedown: 'streak' | 'firstBlood' | 'mvp'`; only a credited kill counts (a death nobody gets doesn't use up first blood).

How the snake died adds one more text, on top of any takedown: "HIT!" in orange for a projectile kill (a badger shot down too), "CRASH!" in pink for a head-on, "BOXED!" in purple for a snake boxed in with no way out (see Kills). It starts beside the head and drifts off to a random side, with a burst fanning out that way. The death event carries it as `how: 'hit' | 'crash' | 'boxed'`. Every text (KILL!, the takedown, the how) gets its own random tilt.

Snakes always have big eyes. The snake animations are on by default (turn them off on /admin if they hurt readability or speed): the eyes blink every few seconds and look at the nearest food or snake head within 4 cells, a forked tongue flicks out now and then, the mouth opens in a wide grin (with fangs) when food is up to 3 cells straight ahead, and a bump runs from the head to the tail after each bite. A snake that gets a kill winks one eye, with a small burst of sparkles by its head. Dead snakes get X eyes while they fade. With the animations off the eyes just look ahead. Every snake has its own random timers. When a snake turns, its head swings round within about the first third of the tick. All of this is worked out on /display and changes nothing in the game.

Apples are drawn as a random fruit (🍎🍏🍐🍊🍋🍉🍇🍓🫐🍈🍒🍑🥭🍍🍅🥑), picked when the apple appears and kept until it's eaten. Every fruit is a normal apple. Under "Frutta" on /admin each fruit has a checkbox (only 🍎 in the expo setup, listed first), plus "Tutti" and "Solo mela" shortcuts; the choice is saved, and applies to apples that appear from then on. With none ticked, apples are all 🍎. The list lives in `src/shared/fruits.js`. Each fruit and power-up is also drawn mirrored or not at random, picked when it appears and kept until it's eaten (rats, chickens and the badger face where they're going instead).

On /play's name screen players can pick a hat: none, 🧢, 👒, 🎩 or 🎓 (Twemoji, served locally). The choice is remembered on the phone and sent with the join; the server accepts only those hats (anything else means no hat) and /admin's player list shows it. On /display the hat sits behind the eyes, its top pointing toward the tail, sized to the cell, and turns with the head (`HAT_SIZE` and `HAT_BACK` in `public/display/display.js` set its size and how far back it sits). Dead snakes don't wear it. The scoreboard shows it after the player's name too (not in its two-column layout, where there's no room). The "Cappelli" toggle on /admin (on by default) switches the hats on /display; the picker on /play is always there. The list lives in `src/shared/hats.js`.

With "Mouse e pulsanti ← →" enabled on /admin (on in the expo setup), /display shows the mouse cursor (it hides after a few seconds without movement) and, when the side column isn't on "Automatica", buttons in its bottom corners that switch to the previous or next panel. Any device that opens /display can press them while the toggle is on.

Between rounds every phone that played the round shows a round card: its place, length and kills, for example "🥉 3° posto · lunghezza 42 · 2 eliminazioni". First place gets 🏆, second 🥈, third 🥉. The places follow the /display scoreboard (alive first, then longer first), except that the round's winner is always first; snakes with the same status and length share a place. The ranking lives in `src/shared/ranking.js`, shared by /display and the server.

At startup the server prints the URLs for `/display`, `/play`, `/admin` and `/admin/print`.

## Power-ups

On in the expo setup. "Power-up attivi" on /admin switches them from the next round; the sliders below it apply immediately.

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
| 🌀 | Portal | A two-way pair for 8 s: one end where it was eaten, the other somewhere safe with 3 free cells ahead. The eater's head goes through at once; after that, any head entering either end comes out of the other, same direction, and the body follows. If it runs out while a snake is still on its way through, it stays, closing: dim and still on /display, nothing can enter it (a head moving onto an end just moves there), and it goes once the tail is through. Items still can't spawn on its ends. Projectiles ignore portals. |
| 🍗 | Feast | 10 extra apples on the free cells around the eater. |
| 🛡️ | Shield | For 10 s, survives the next hit (wall, body, head-on or projectile): the shield pops and the snake is a ghost for 1 s. At a wall it turns aside instead. |
| 🔦 | Laser | Charges for 4 ticks (`laserChargeTicks`), then a beam hits the whole row through the pickup cell if the snake was moving left or right, or the whole column if it was moving up or down, walls or not. Every snake with a segment on the line is hit, except the shooter's own and ghosts. At its segment on the line nearest the head: the head dies, anywhere else is cut off there (fewer than 3 segments left: dead). A shield pops instead. Every death is the shooter's kill, even if the shooter has died since (a cut it survives is no kill; a shooter who left the game gets nothing). The badger on the line dies as if a projectile hit it (the shooter's kill); rats and chickens on it die (a chicken leaves its feast); items and bombs are untouched. The charge goes on if the shooter dies, and is called off when the round ends or restarts. Several can charge at once. |

On /display a charging laser is a thin line across the board in the shooter's color, brighter, pulsing faster and getting brighter as it charges, with sparks where it meets the board's edges. Then a bright full-length beam with a white core flashes for 250 ms and fades out over half a second, with sparks along it and the screen shake. The line always shows; its sparks follow "Effetti particellari" and the shake "Scossa dello schermo". Two sounds have their own volume sliders: "Laser in carica", a synthesized whine that rises from low to high over exactly the charge and stops early if the charge is called off (or the game is paused), and "Laser che spara" (`sounds/laser.json`).

Segments removed from a living snake (the part scissors or a laser cut off) become apples when "I serpenti morti diventano mele" is on, and vanish otherwise. The front a bomb blows off always vanishes.

To add a power-up: an entry in `src/shared/powerups.js` (its weight slider, /admin label and sprite are generated from it), its effect in the engine's `EFFECTS` table, and its name in `STRINGS.admin.powerUpNames` (Italian and English). A test checks all three are there.

## Rats 🐀

Rare food that runs away. A new apple becomes a rat with the "topo" probability on /admin (15% in the expo setup, 0 = never). That setting applies at once and doesn't depend on the power-up switch. Rats take an apple's place and count toward the number of apples.

- **Movement:** one cell every second tick (half a snake's speed), straight on. It picks a random new direction after 2–20 ticks, or straight away when the next cell is a wall, a snake, a bomb, a portal end, an item or another rat. Walls wrap when "Bordi attraversabili" is on, and rats ignore portals. A rat never turns back to the cell it just left unless that's the only way out. Boxed in, it stays put. Rats move at the start of a tick, before the snakes.
- **Eating:** a head entering the rat's cell eats it. So does a rat running into the cell a head is entering, or out of it in that same move, so it can never slip past a head. Ghosts eat rats too. A rat grows the snake by 4 × "Crescita per mela" and is replaced like an apple.
- **Not affected:** the magnet doesn't pull rats. A projectile (or a gun fired right next to one) kills a rat. The rat just disappears, and nobody gets a kill.
- **/display:** each rat is drawn as 🐀 or 🐁 (fixed per rat, purely visual). Rats slide smoothly between cells. The sprite is never rotated: it's mirrored while running right, and keeps its last left/right look while running up or down.

Rules and numbers live in `src/shared/rats.js`; the engine's `moveCreatures` does the movement.

## Chickens 🐓

Rarer food that flees. A new apple becomes a chicken with the "gallo" probability on /admin (5% in the expo setup, 0 = never), rolled when the rat roll fails. Like the rat's, the setting is saved, applies at once and doesn't depend on the power-up switch. Chickens take an apple's place and count toward the number of apples.

- **Calm:** it moves exactly like a rat: one cell every second tick, a new random direction every 2–20 ticks or when blocked, wrapping with the walls, ignoring portals.
- **Alerted:** a threat 2 grid steps away or closer alerts it. Threats are snake heads (ghosts too) and every cell of the active badger's block (not during its warning). It then moves every tick, starting that very tick. Each move, 90% of the time it takes the free way that ends furthest from the nearest threat, head or badger cell, whichever is closer (back where it came from included); otherwise it moves like a rat. It calms down once no threat has come that close for 1 s.
- **Eating:** caught exactly like a rat: a head entering its cell, or the chicken running into or out of the cell a head is entering. Ghosts catch it too. It grows the snake by 25 × "Crescita per mela", and a feast spawns round the eater, as if it had picked up 🍗. The 🍗 power-up itself is unchanged.
- **Other deaths:** a projectile (or a gun fired right next to it) or the badger kills it. Nobody grows or scores, and a 🍗 feast power-up takes its place on the cell where it died; it still counts toward the number of apples. The same goes for any way of dying other than being eaten by a snake. /display shows a poof of feathers.
- **Not affected:** the magnet doesn't pull it.
- **/display:** 🐓, never rotated, mirrored while running right, sliding between cells, on the rats' green glow. While it's alerted a small ❗ pops up above it and bobs, and goes when it calms down.

Rules and numbers live in `src/shared/chicken.js`.

## Honey badger 🦡

A rare predator: a 5×3 block (5 wide, 3 tall) that never rotates. Three /admin sliders control it; all are saved, and neither depends on the power-up switch:

- **"Tasso del miele" (average seconds between badgers):** 60 in the expo setup, 30–600, or 0 for never. The real delay is random, between half and one and a half times the average, counted in seconds of play. A change applies at once.
- **"Quanto resta in campo" (lifetime):** 30 s in the expo setup, 5–120. A change applies from the next badger.
- **"Vita del tasso" (health):** 3 HP by default, 1–10: the scissors hits it takes to die. A change applies from the next badger.

The timer never brings more than one badger: the next wait only starts once the board has none. More can only come from the Regia buttons on /admin (see below), and each then behaves on its own: it moves, bites, gets hit and expires by itself. Badgers may overlap. With more than one on the board, /display adds a Roman numeral to each one's name ("Torquato Tasso I", "Torquato Tasso II"), the lowest number not already in use, kept for as long as that badger lives.

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

## Bots 🤖

Computer players, so an empty booth still has something going on. Off by default: the "Numero di bot" slider on /admin is 0.

- **Settings** (saved): the number of bots (0–24), "Riempi" (fill mode) and one weight (0–10) per skill. Each new bot (so every round) gets a random skill by those weights, e.g. 1, 2, 1 makes half of them skill 2; all at 0 makes each skill as likely. The expo setup uses 3, 3, 1 with fill mode on. A settings.json saved with the old single skill keeps it as the only weight. On /display a bot's skill shows as a Twemoji in front of its name on the board, and as the same emoji in front of its name on the round scoreboard (in place of 🤖): 🐣 skill 1, ⚔️ skill 2, ☠️ skill 3. "Mostra il livello dei bot" (on by default, and in the expo setup) switches that off: every bot then shows 🤖 on the board and on the scoreboard instead (the server sends `'robot'` in place of each skill; the skills themselves don't change).
  - **Fill mode:** the bots only fill up to that number and step aside as people join. With 4: 1 phone gives 3 bots, and 4 or more phones give none.
  - **The 24-snake limit:** bots and people together never go past 24 (one color each). A person joining when there are already 24 makes the lowest-numbered bot leave at once, even mid-round, and takes its color. Between rounds, past 24 the bots fall back to fill mode, whatever the switch says.
- **Joining and leaving:** every round the bots are refreshed: they all leave and the right number join again, named "Bot 1", "Bot 2"…, each with a new random hat or none (shown when the hats toggle is on). They're marked 🤖 on the scoreboard and on /admin. Apart from that, a bot only leaves mid-round to make room for a person at the 24-snake limit (a "Bot N" before a reserved one, the lowest-numbered first).
- **Reserved bots ("Bot con nome"):** a list on /admin of names, each with a hat (or none), added, edited and removed there and saved in `settings.json` (`reservedBots`, at most 50). Names are cleaned and checked like player names (nothing visible left is refused), must be unique in the list and must not look like "Bot N". Each round the bots take a random pick of these profiles first, with their own hats; any more bots needed are "Bot 1", "Bot 2"… with a random hat as before. A profile whose name a person is using sits that round out. They're still bots, whatever their name: skill emoji, 🤖 on /admin, never in the global leaderboard.
- **People come first:** in the player list, and in colors: when a round starts, anyone who joined after the bots moves down to one of the first colors (their phone follows), and the bots take the ones after. On the scoreboard a person ranks above a bot of the same length. People can't pick a name like "Bot 3". Bots don't count toward "Giocatori massimi", nor toward the "fewer than 2 players: show how to join" rule of the automatic side column.
- **Records:** bots are never recorded on the global leaderboard. A person's kills of bots, and wins against them, count as usual.
- **Rounds:** a round where only bots are left alive ends at once, with no winner, as soon as a person is waiting to join.
- **The brain** (`src/bot-brain.js`) runs on the server before each tick. It reads the same state /display gets and steers through `setDirection`, like a phone. In order of priority:
  1. **Survive:** never a move that dies next tick if another doesn't, nor one into a pocket smaller than itself. A portal is judged by where it comes out. A charging laser's whole line counts as deadly for every snake but its shooter, so bots don't cross it or stay on it (a body already across it can still be cut).
  2. **Flee:** keep away from the heads of snakes as long or shorter (the ones that win or tie a head-on), from the badger and from bombs.
  3. **Hunt:** go for the best food it can reach, chickens and rats first. With scissors, it goes after another snake's body or the badger.
  4. **Wander.**
- **Effects:** a ghost with more than 2 s left ignores 1 and 2 (walls still count). A golden snake plans both of its moves each tick: it weighs every 2-move path (first direction, then second, no reversals), both cells checked for safety and the rest judged by where the path ends, and queues both directions, so it can go straight and then turn (around a wall, onto food). Its reaction wait counts both moves.
- **Skill:** at skill 1 (often) and 2 (rarely) a bot sometimes ignores step 2 and picks any safe move. At skill 3 it never does. Skill also sets the reaction time: after each decision a bot waits a random 0 to 3 of its moves before the next at skill 1, 0 to 2 at skill 2, and decides every move at skill 3. The wait is rolled afresh each time, so a bot can't fall into step with a loop it is running (like circling an apple without ever turning into it). In between it keeps going, but 85% of the time still turns away from certain death right ahead. Each round every bot starts with a fresh roll, so they don't all decide on the same tick.
- **Cost:** the work per tick has a fixed budget, so many bots can't slow the game down. 24 bots on an 80×80 board take well under a millisecond per tick on average; `/health` reports it under `bots`.

## Regia 🎬 (/admin match controls)

The "Regia" category on /admin has one-shot buttons for the operator. They only work while a round is being played (not paused or between rounds), and they ignore every cap; only a free cell, or room for a block, limits them. Each one is applied on the next tick, so /display shows its effects as usual.

- **Fai comparire (spawn):** 🍎 an apple, 🐀 a rat, 🐔 a chicken, 💣 a bomb (even past 5, even with power-ups off), 🦡 another badger (as many as you like), or any power-up. These are extras on top of the number of apples, like corpse apples. "Manda via i tassi" makes every badger leave.
- **Su un serpente (on one snake):** pick a living snake (bots too), then +5 length, give it any power-up (as if eaten, a 💣 included), or ⚡ Fulmine (smite, with a confirmation: it dies at once, shield or not, and nobody gets the kill).

A snake given length or a power-up becomes *assisted* for the rest of that round, shown with 🎬 in the players table. Its length that round doesn't count for the global highest-score record, but its win and kills still count. Spawning things and smiting don't make anyone assisted.

The engine side is `command()` in `src/engine.js`. The server messages are `spawn`, `removeBadger`, `grow`, `givePowerUp` and `smite`, each validated in `handleAdmin`.

## Pages

- `/display`: fullscreen view for the monitor. Double-click to toggle fullscreen. When "keyboard players" is enabled on /admin, WASD and the arrow keys control two local players.
- `/play`: phone controller. Add `?new` (for example `/play?new`) to ignore the saved name, so several tabs on one laptop can play as separate players. Arrow keys and WASD also steer there, for testing.
- `/admin`: password-protected control panel. It is not linked from anywhere.
- `/admin/print`: printable A4 page with the wifi and game QR codes.
- `/health`: JSON status for whoever runs the laptop: uptime, phase, player and connection counts, and tick timing (configured interval, measured mean and worst of the last 100 ticks). No names or settings.

## Language

Every page is in Italian by default. The **Lingua / Language** menu in the /admin header switches all of them to English (or back), and the choice is saved in `settings.json` (`locale`). "Reset settings to defaults" leaves it alone.

- /display and phones on /play switch in place, so the sound unlock, fullscreen and the game in progress are kept. /admin reloads itself in the new language; /admin/print and the login page use it the next time they load.
- Pages read the language at load from `/locale.js` (never cached), then follow the server's messages.
- The text is in `src/shared/strings.js` (Italian) and `src/shared/strings-en.js` (English). A test checks that both have the same keys, list lengths and `{placeholders}`, so a string added to one must be added to the other.
- Names stay as they were given: "Bot N" is the same in both languages, and keyboard players keep the name they joined with ("Tastiera WASD" / "Keyboard WASD") until they rejoin. The kill popups were English already.

## Tests

```bash
npm test
```

Load test (16 simulated phones, named Phone01…, for 5 minutes with every gameplay toggle on, power-ups included, malformed messages, disconnects, then a hard kill and restart). It runs its own server on 127.0.0.1 with its data in a temp folder, so it never touches `records.json`, `banned-words.json` or `config.json`:

```bash
node loadtest.js --minutes 5 --bots 16
```

`--server-bots N` adds the server's own bots (with `--fill` for fill mode) and `--tick-ms N` sets the speed. For example, 24 bots at the fastest speed:

```bash
node loadtest.js --minutes 1 --bots 0 --server-bots 24 --tick-ms 50
```

## Credits

Emoji graphics from [Twemoji](https://github.com/jdecked/twemoji), © Twitter, Inc. and other contributors, licensed under [CC-BY 4.0](https://creativecommons.org/licenses/by/4.0/).
