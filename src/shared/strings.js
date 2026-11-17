// All user-facing text: Italian here, English in strings-en.js (same keys,
// same {placeholders}). Shared by the server (login page) and the browser
// pages (served at /shared/strings.js). Use fmt() for placeholders.
//
// The language is an /admin setting (`locale`). The server picks a table with
// stringsFor(locale). Each page calls setLocale() with the current one, read
// from /locale.js at load and from the server's messages after, and reads
// STRINGS: an ES module live binding, so it follows setLocale().

import { STRINGS_EN } from './strings-en.js';

const STRINGS_IT = Object.freeze({
  appName: 'Snake Battle',
  // Each language under its own name, the same in every table (the /admin menu).
  localeNames: { it: 'Italiano', en: 'English' },

  // ---- /display ----------------------------------------------------------
  display: {
    title: 'Snake Battle',
    scoreboard: 'Classifica',
    round: 'Round {n}',
    alive: 'in gioco',
    dead: 'eliminato',
    queued: 'in attesa',
    noPlayers: 'Nessun giocatore',
    waiting: 'In attesa di giocatori…',
    waitingHint: 'Inquadra i codici QR per unirti!',
    paused: 'In pausa',
    winner: '{name} vince!',
    draw: 'Pareggio!',
    nextRound: 'Prossimo round tra {s}…',
    countdownGo: 'Via!',
    disconnected: 'Connessione al server persa. Riconnessione…',
    keyboardWasd: 'Tastiera WASD',
    keyboardArrows: 'Tastiera Frecce',
    keyboardHint: 'Premi WASD o le frecce per giocare dalla tastiera',
    soundHint: '🔇 Clicca qui per attivare i suoni',
    // Kills of the current round, next to the length in the scoreboard: a
    // 🎯 and the number; this is the 🎯's description (tooltip, screen readers).
    killsIcon: 'Eliminazioni',
    // time limit and target length (top of the side column)
    timeLeft: 'Tempo {t}',
    target: 'Obiettivo: lunghezza {n}',
    timeUp: 'Tempo scaduto!',
    targetReached: 'Lunghezza {n} raggiunta!',
    lastPerson: 'Ultimo giocatore rimasto, contro solo bot!',
    // global leaderboard (one stat at a time)
    recordsTitle: 'Classifica globale',
    stats: { wins: 'Più vittorie', kills: 'Più eliminazioni', score: 'Punteggio più alto' },
    winsOne: '1 vittoria',
    winsMany: '{n} vittorie',
    killsOne: '1 eliminazione',
    killsMany: '{n} eliminazioni',
    scoreValue: 'lunghezza {n}',
    noRecords: 'Ancora nessun record',
    // ← / → buttons in the side column (labels name the panel they switch to)
    panelNames: { leaderboard: 'Classifica', records: 'Record', join: 'Come giocare' },
    panelPrev: '← {name}',
    panelNext: '{name} →',
    // Popup over a snake killed by another (/admin effect), by the killer's
    // snake kills this round. Left in English on purpose (arcade style); past
    // the last one, killPopupMore with the count.
    killPopups: ['KILL!', 'DOUBLE KILL!!', 'TRIPLE KILL!!!', 'QUADRA KILL!!!!', 'PENTA KILL!!!!!'],
    killPopupMore: '{n}× KILL!!!!!',
    // Below it, dropping, when the snake killed led the round in kills
    // (streak) or was the longest (mvp), or for the round's first kill
    // (firstBlood). Also English on purpose.
    takedowns: { streak: 'SHUTDOWN!', mvp: 'KINGSLAYER!', firstBlood: 'FIRST BLOOD!' },
    // Beside it, drifting to one side, how it died: shot (hit), a head-on
    // (crash), boxed in with no way out (boxed). Also English on purpose.
    killHow: { hit: 'HIT!', crash: 'CRASH!', boxed: 'BOXED!' },
  },

  // ---- join panel (display side column and /admin/print) ------------------
  join: {
    title: 'Come giocare',
    step1Title: '1. Connettiti al wifi',
    step1Text: 'Inquadra questo codice con la fotocamera del telefono.',
    step2Title: '2. Apri il gioco',
    step2Text: 'Poi inquadra questo codice per aprire il controller.',
    step3: 'Disattiva i dati mobili se il gioco non si apre.',
    browser: 'Altri problemi? Usa Chrome o Safari.',
    wifiName: 'Rete: {ssid}',
    wifiPassword: 'Password: {password}',
    gameUrl: 'Indirizzo: {url}',
  },

  // ---- /play (phone controller) ---------------------------------------------
  play: {
    title: 'Snake Battle',
    namePrompt: 'Come ti chiami?',
    namePlaceholder: 'Il tuo nome',
    hatPrompt: 'Scegli un cappello',
    hatNone: 'X',
    // One per entry of src/shared/hats.js (also used by /admin).
    hatNames: {
      cap: 'Berretto',
      sunhat: 'Cappello di paglia',
      tophat: 'Cilindro',
      gradcap: 'Tocco da laureato',
    },
    join: 'Gioca',
    connecting: 'Connessione…',
    cannotConnect: 'Impossibile raggiungere il gioco. Sei connesso al wifi della partita?',
    queued: 'in coda',
    dead: 'sei morto, aspetta il prossimo round',
    paused: 'in pausa',
    connectionLost: 'Connessione persa',
    replaced: 'Il gioco è stato aperto in un’altra scheda.',
    rejoin: 'Rientra',
    swipeHint: 'Scorri il dito sullo schermo per muoverti',
    toggleControls: 'Mostra o nascondi i pulsanti',
    dirUp: 'Su',
    dirDown: 'Giù',
    dirLeft: 'Sinistra',
    dirRight: 'Destra',
    // The round card, between rounds: "🥉 3° posto · lunghezza 42 · 2 eliminazioni".
    // {ord}: the ordinal ending for {n}, by Intl.PluralRules ordinal category.
    cardPlace: '{n}{ord} posto',
    cardOrdinals: { one: '°', two: '°', few: '°', other: '°' },
    cardLength: 'lunghezza {n}',
    cardKillsOne: '1 eliminazione',
    cardKillsMany: '{n} eliminazioni',
    cardTitle: 'Il tuo round',
  },

  // ---- /admin/login ------------------------------------------------------
  login: {
    title: 'Accesso amministratore',
    password: 'Password',
    submit: 'Entra',
    wrongPassword: 'Password errata.',
    tooManyAttempts: 'Troppi tentativi. Riprova tra {s} secondi.',
  },

  botName: 'Bot {n}', // computer players: "Bot 1", "Bot 2"...

  // ---- /admin ------------------------------------------------------------
  admin: {
    title: 'Pannello di controllo',
    logout: 'Esci',
    language: 'Lingua',
    connected: 'Connesso',
    disconnected: 'Disconnesso, riconnessione…',
    sessionExpired: 'Sessione scaduta. Accedi di nuovo.',
    game: 'Partita',
    status: 'Stato',
    phase: {
      waiting: 'In attesa di giocatori',
      countdown: 'Conto alla rovescia',
      playing: 'In corso',
      intermission: 'Intervallo',
    },
    pausedSuffix: ' (in pausa)',
    round: 'Round',
    pause: 'Pausa',
    resume: 'Riprendi',
    restartRound: 'Ricomincia round',
    confirmRestart: 'Ricominciare il round in corso?',
    resetSettings: 'Ripristina impostazioni predefinite',
    confirmResetSettings:
      'Riportare tutte le impostazioni ai valori predefiniti? Cursori, regole, condizioni di vittoria, power-up, colonna laterale, classifica globale (attivazione) ed effetti tornano come al primo avvio. Le regole del round cambiano dal prossimo round. I dati della classifica globale, le parole vietate, la lingua e la password non vengono toccati.',
    // One per category, and one for the power-up weights alone.
    resetCategory: 'Ripristina predefiniti di questa sezione',
    confirmResetCategory: 'Riportare ai valori predefiniti le impostazioni di «{name}»? Il resto non cambia.',
    resetWeights: 'Ripristina pesi predefiniti',
    confirmResetWeights: 'Riportare i pesi dei power-up ai valori predefiniti?',
    settings: 'Impostazioni',
    tickMs: 'Velocità (ms per passo, meno = più veloce)',
    appleCount: 'Numero di mele',
    growthPerApple: 'Crescita per mela',
    ratChance: 'Probabilità che una nuova mela sia un topo 🐀 che scappa e vale 4 mele (%, 0 = mai)',
    chickenChance:
      'Probabilità che una nuova mela sia un pollo 🐓 che fugge dai serpenti vicini, vale 25 mele e lascia un banchetto (%, 0 = mai)',
    badgerEverySec:
      'Tasso 🦡, il predatore: secondi in media tra un tasso e l’altro (s, il tempo esatto varia a caso; 0 = mai)',
    badgerLifetimeSec: 'Quanto resta in campo il tasso 🦡 (s)',
    badgerHealth: 'Vita del tasso 🦡: colpi di forbici ✂️ per eliminarlo (un proiettile lo elimina sempre)',
    badgerName: 'Nome del tasso 🦡, scritto sopra di lui come un boss (vuoto = nessun nome)',
    badgerNamePlaceholder: 'Nessun nome',
    maxPlayers: 'Giocatori massimi (i bot 🤖 non contano)',
    botsTitle: 'Bot 🤖',
    botsHint:
      'Serpenti guidati dal computer, per non lasciare lo schermo vuoto. A ogni round vengono rinnovati (nomi e cappelli nuovi); i giocatori hanno sempre i primi colori. Non finiscono mai nella classifica globale. Bot e giocatori insieme non superano 24: se si unisce qualcuno quando sono già 24, un bot esce subito per fargli posto.',
    bots: 'Numero di bot (0 = nessuno)',
    botFill:
      'Riempi: i bot completano i posti fino al numero scelto e lasciano il posto a chi si unisce (es. 4: con 1 telefono 3 bot, con 4 o più nessuno)',
    botLevels: 'Mostra il livello dei bot (🐣 ⚔️ ☠️ accanto al nome; spento: 🤖 per tutti)',
    // One weight slider per bot skill (the emoji is added in front).
    botWeights: {
      1: 'Peso abilità 1 (lenti, spesso sbagliano)',
      2: 'Peso abilità 2 (medi, sbagliano di rado)',
      3: 'Peso abilità 3 (pronti, mai errori)',
    },
    reservedBotsTitle: 'Bot con nome',
    reservedBotsHint:
      'Nomi (e cappelli) che i bot usano prima di «Bot 1», «Bot 2»... A ogni round se ne pescano a caso quanti ne servono; i bot in più si chiamano «Bot N». Se un giocatore usa uno di questi nomi, quel bot salta il round. Restano bot: emoji dell’abilità sullo schermo e niente classifica.',
    reservedBotsEmpty: 'Nessuno: i bot si chiamano tutti «Bot N».',
    reservedBotPlaceholder: 'Nome del bot',
    reservedBotAdd: 'Aggiungi',
    reservedBotRemove: 'Rimuovi «{name}»',
    reservedBotNoHat: 'Nessun cappello',
    reservedBotErrors: {
      empty: 'Scrivi un nome.',
      botName: 'I nomi come «Bot 3» sono per i bot senza nome.',
      duplicate: 'Questo nome è già nella lista.',
      full: 'La lista è piena.',
    },
    botWeightsHint: 'Ogni nuovo bot riceve un’abilità a caso secondo questi pesi (es. 1, 2, 1: metà abilità 2). Tutti a 0 = ognuna ugualmente probabile. Vale dal prossimo round. L’emoji compare accanto al nome del bot sullo schermo.',
    gridSize: 'Dimensione griglia (dal prossimo round)',
    intermissionMs: 'Pausa tra i round (ms)',
    countdownMs: 'Conto alla rovescia prima del round (ms, 0 = disattivato)',
    spawnShieldSec: 'Protezione all’inizio: scudo 🛡️ per i primi secondi di gioco (s, 0 = disattivata)',
    display: 'Schermo',
    sidePanel: 'Colonna laterale',
    sidePanelOptions: {
      auto: 'Automatica',
      leaderboard: 'Classifica',
      records: 'Record (classifica globale)',
      join: 'Istruzioni per unirsi',
    },
    sidePanelAutoHint:
      'Automatica: istruzioni con meno di 2 giocatori, classifica durante il round. Durante l’intervallo: classifica globale se attiva, altrimenti istruzioni. Con «Classifica», la classifica globale compare tra un round e l’altro.',
    sidePanelRecordsOff:
      'La classifica globale è spenta, quindi lo schermo mostra la classifica del round. Per vederla attivala in «Classifica globale».',
    keyboardPlayers: 'Giocatori da tastiera sullo schermo (WASD e frecce)',
    hats: 'Cappelli dei giocatori sui serpenti (scelti su /play)',
    roundCard: 'Scheda di fine round sui telefoni (posizione, lunghezza, eliminazioni)',
    displayButtons: 'Mouse e pulsanti ← → sullo schermo per cambiare la colonna (non in «Automatica»)',
    effects: 'Effetti grafici',
    effectsHint: 'Solo grafica, valgono subito.',
    particles: 'Effetti particellari (esplosioni e scintille quando qualcosa muore o viene colpito, anelli quando si mangia una mela)',
    screenShake: 'Scossa dello schermo',
    snakeAnimations: 'Animazioni dei serpenti (sguardo, battito di ciglia, lingua, bocca, boccone che scende, occhiolino dopo un’eliminazione)',
    killPopups: 'Scritta «KILL!» con particelle su ogni eliminazione («DOUBLE KILL!!», «TRIPLE KILL!!!»… per chi ne fa di più nel round)',
    soundsTitle: 'Suoni 🔊',
    soundsHint: 'Escono dallo schermo /display e valgono subito. Il browser li attiva solo dopo un clic sulla pagina /display.',
    sounds: 'Suoni sullo schermo (mele, colpi, esplosioni, conto alla rovescia…)',
    soundVolume: 'Volume generale (%)',
    soundVolumesTitle: 'Volume di ogni suono (%)',
    soundVolumesHint: 'In proporzione al volume generale. 100 = normale, 0 = muto, fino a 200 per alzarne uno.',
    soundNames: {
      badgerSpawn: 'Arriva il tasso',
      count: 'Conto alla rovescia',
      death: 'Morte di un serpente',
      disappear: 'Bomba o tasso che spariscono',
      eat: 'Mela mangiata',
      eatCreature: 'Topo o pollo mangiati',
      explosion: 'Esplosione (bomba, tasso ucciso)',
      hit: 'Colpo a segno',
      hurt: 'Ferita (serpente tagliato, tasso colpito)',
      move: 'Svolte dei serpenti (molto frequenti con tanti bot: 0 di base)',
      multikill: 'Uccisione multipla (2 o 3)',
      overkill: 'Uccisione multipla (4 o più)',
      portal: 'Portale che si apre',
      powerUp: 'Potenziamento',
      shoot: 'Sparo',
      start: 'Inizio del round',
    },
    fruitsTitle: 'Frutta',
    fruitsHint: 'Le mele compaiono come uno di questi frutti, a caso. Solo grafica: vale per le mele nuove. Nessuno selezionato = tutte 🍎.',
    fruitsAll: 'Tutti',
    fruitsAppleOnly: 'Solo mela',
    // One per entry of src/shared/fruits.js, by Twemoji code.
    fruitNames: {
      '1f34e': 'Mela rossa',
      '1f34f': 'Mela verde',
      '1f350': 'Pera',
      '1f34a': 'Arancia',
      '1f34b': 'Limone',
      '1f349': 'Anguria',
      '1f347': 'Uva',
      '1f353': 'Fragola',
      '1fad0': 'Mirtilli',
      '1f348': 'Melone',
      '1f352': 'Ciliegie',
      '1f351': 'Pesca',
      '1f96d': 'Mango',
      '1f34d': 'Ananas',
      '1f345': 'Pomodoro',
      '1f951': 'Avocado',
    },
    rules: 'Regole',
    rulesHint: 'Le modifiche valgono dal prossimo round.',
    corpseApples: 'I serpenti morti diventano mele',
    corpseStyle: 'Aspetto delle mele dei serpenti morti e dei pezzi tagliati (vale subito)',
    corpseStyleOptions: {
      fruit: 'Frutta',
      remains: 'Resti: pezzi di serpente grigi',
    },
    wrapWalls: 'Bordi attraversabili (si esce da un lato e si rientra dall’altro)',
    winConditions: 'Condizioni di vittoria',
    winHint: '«Ultimo serpente in vita» vale sempre. Con più condizioni attive, il round finisce con quella che scatta prima.',
    timeLimitWin: 'Limite di tempo',
    roundTimeLimitSec: 'Durata del round (secondi)',
    timeLimitWinner: 'Allo scadere vince',
    timeLimitWinnerOptions: {
      longest: 'il serpente più lungo',
      kills: 'chi ha più eliminazioni (a parità, il più lungo)',
    },
    targetLengthWin: 'Lunghezza obiettivo (vince chi la raggiunge per primo)',
    targetLength: 'Lunghezza obiettivo',
    lastPersonWins: 'Vince l’ultimo giocatore rimasto, anche se restano dei bot (round con almeno 2 giocatori)',
    // power-ups card
    powerUpsTitle: 'Power-up',
    powerUps: 'Power-up attivi (dal prossimo round)',
    powerUpsHint:
      'L’interruttore vale dal prossimo round; i cursori valgono subito. Un power-up prende il posto di una mela e conta nel numero di mele.',
    powerUpChance: 'Probabilità che una nuova mela sia un power-up (%)',
    // creatures and hazards card
    creaturesTitle: 'Creature e pericoli',
    creaturesHint: 'Valgono subito.',
    bombsTitle: 'Bombe 💣',
    bombsHint: 'Compaiono a parte, non contano nel numero di mele, e spariscono dopo 10 secondi. Solo con i power-up attivi.',
    bombsPerMinute: 'Bombe al minuto (0 = nessuna)',
    bombMode: 'Effetto delle bombe (vale subito)',
    bombModeOptions: {
      cut: 'Tagliano via la metà davanti del serpente',
      kill: 'Eliminano il serpente',
    },
    weightsTitle: 'Frequenza di ogni power-up',
    weightsHint: 'Più alto = più frequente rispetto agli altri. 0 = mai.',
    // One per entry of src/shared/powerups.js (the weight sliders use them).
    powerUpNames: {
      golden: 'Stella dorata: doppia velocità',
      ghost: 'Fantasma: attraversa tutto',
      gun: 'Pistola: un colpo dritto avanti',
      magnet: 'Calamita: mangia le mele vicine',
      freeze: 'Ghiaccio: rallenta gli altri',
      scissors: 'Forbici: taglia chi tocchi',
      portal: 'Portale: ingresso e uscita',
      feast: 'Banchetto: 10 mele intorno',
      shield: 'Scudo: resiste a un colpo',
      bomb: 'Bomba: taglia via la metà davanti o elimina (vedi «Effetto delle bombe»)',
    },
    activeThisRound: 'Attive in questo round: {list}',
    noneActive: 'nessuna',
    globalLeaderboard: 'Classifica globale',
    leaderboard: 'Registra e mostra la classifica globale (dal prossimo round)',
    leaderboardStat: 'Sullo schermo',
    leaderboardStatOptions: {
      auto: 'Automatica (cambia ogni 10 secondi)',
      wins: 'Più vittorie',
      kills: 'Più eliminazioni',
      score: 'Punteggio più alto',
    },
    reset: {
      wins: 'Azzera vittorie',
      kills: 'Azzera eliminazioni',
      score: 'Azzera punteggi',
      all: 'Azzera tutto',
    },
    confirmReset: {
      wins: 'Azzerare la classifica delle vittorie? Non si può annullare.',
      kills: 'Azzerare la classifica delle eliminazioni? Non si può annullare.',
      score: 'Azzerare la classifica dei punteggi? Non si può annullare.',
      all: 'Azzerare tutta la classifica globale (vittorie, eliminazioni e punteggi)? Non si può annullare.',
    },
    players: 'Giocatori',
    noPlayers: 'Nessun giocatore connesso.',
    colName: 'Nome',
    colStatus: 'Stato',
    colLength: 'Lunghezza',
    colKills: 'Eliminazioni',
    colSource: 'Dispositivo',
    colHat: 'Cappello',
    sourcePhone: 'Telefono',
    sourceKeyboard: 'Tastiera',
    sourceBot: 'Bot 🤖',
    kick: 'Espelli',
    confirmKick: 'Espellere {name}?',
    playerStatus: { alive: 'In gioco', dead: 'Eliminato', queued: 'In attesa' },
    assisted: 'Aiutato dalla Regia in questo turno: la sua lunghezza non vale per i record',
    // Regia card: one-shot match controls
    directorTitle: 'Regia 🎬',
    directorHint: 'Comandi immediati sulla partita, senza limiti. Funzionano solo mentre si gioca (non in pausa).',
    directorBoard: 'Fai comparire',
    directorSnake: 'Su un serpente',
    directorSnakeHint: 'Chi riceve lunghezza o un power-up dalla Regia non entra nei record di lunghezza per questo turno.',
    directorPick: 'Serpente',
    noLivingSnake: 'Nessun serpente in gioco',
    spawnNames: {
      apple: 'Mela',
      rat: 'Topo',
      chicken: 'Pollo',
      bomb: 'Bomba',
      badger: 'Tasso',
    },
    removeBadgers: 'Manda via i tassi',
    givePowerUp: 'Dai un power-up',
    grow: '+5 lunghezza',
    smite: '⚡ Fulmine',
    confirmSmite: 'Eliminare {name} con un fulmine?',
    links: 'Indirizzi',
    printPage: 'Pagina da stampare con i codici QR',
    words: 'Parole vietate nei nomi',
    wordsHint:
      'Controllate senza distinguere maiuscole e minuscole, anche con sostituzioni come 0→o, 1→i, 3→e, 4→a, 5→s. Le parole di 3 lettere o meno bloccano solo la parola intera.',
    wordPlaceholder: 'Nuova parola',
    addWord: 'Aggiungi',
    removeWord: 'Rimuovi «{word}»',
    wordCount: '{n} parole',
    wordErrors: {
      word_invalid: 'Parola non valida: servono almeno 2 lettere, massimo 30 caratteri.',
      word_exists: 'Questa parola è già nella lista.',
      word_tooMany: 'La lista è piena.',
    },
    credits: 'Grafica emoji: Twemoji di Twitter, Inc. e altri contributori, licenza CC-BY 4.0.',
  },

  // ---- /admin/print -------------------------------------------------------
  print: {
    title: 'Snake Battle – Codici QR',
    heading: 'Gioca a Snake Battle!',
    wifiLabel: 'Passo 1: connettiti al wifi',
    gameLabel: 'Passo 2: apri il gioco',
    mobileData: 'Se il gioco non si apre, disattiva i dati mobili.',
    browser: 'Problemi? Usa Chrome o Safari.',
    printButton: 'Stampa',
  },

  // ---- errors sent by the server to clients -------------------------------
  errors: {
    full: 'La partita è piena.',
    keyboardDisabled: 'I giocatori da tastiera sono disattivati.',
    badMessage: 'Messaggio non valido.',
    kicked: 'Sei stato espulso dalla partita.',
    nameEmpty: 'Scrivi il tuo nome.',
    nameTaken: 'Questo nome è già in uso. Scegline un altro.',
    nameProfane: 'Questo nome non è permesso. Scegline un altro.',
  },
});

export const LOCALES = Object.freeze(['it', 'en']);
export const DEFAULT_LOCALE = 'it';
const TABLES = Object.freeze({ it: STRINGS_IT, en: STRINGS_EN });

// The table for a locale; Italian for anything unknown.
export const stringsFor = (locale) => (Object.hasOwn(TABLES, locale) ? TABLES[locale] : STRINGS_IT);

export let LOCALE = DEFAULT_LOCALE;
export let STRINGS = STRINGS_IT;

// Switches STRINGS (for every importer) to a known locale. Returns whether it
// changed anything.
export function setLocale(locale) {
  if (!LOCALES.includes(locale) || locale === LOCALE) return false;
  LOCALE = locale;
  STRINGS = TABLES[locale];
  return true;
}

// fmt('Round {n}', { n: 3 }) -> 'Round 3'
export function fmt(template, values = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(values, k) ? String(values[k]) : m));
}
