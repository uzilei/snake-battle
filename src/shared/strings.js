// All user-facing text, in Italian. Shared by the server (login page) and the
// browser pages (served at /shared/strings.js). Use fmt() for placeholders.

export const STRINGS = Object.freeze({
  appName: 'Snake Battle',

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
    recordsTitle: 'Record',
    winsTitle: 'Più vittorie',
    winsOne: '1 vittoria',
    winsMany: '{n} vittorie',
    fameTitle: 'Serpenti più lunghi',
    noRecords: 'Ancora nessun record',
    // ← / → buttons in the side column (labels name the panel they switch to)
    panelNames: { leaderboard: 'Classifica', records: 'Record', join: 'Come giocare' },
    panelPrev: '← {name}',
    panelNext: '{name} →',
  },

  // ---- join panel (display side column and /admin/print) ------------------
  join: {
    title: 'Come giocare',
    step1Title: '1. Connettiti al wifi',
    step1Text: 'Inquadra questo codice con la fotocamera del telefono.',
    step2Title: '2. Apri il gioco',
    step2Text: 'Poi inquadra questo codice per aprire il controller.',
    step3: 'Disattiva i dati mobili se il gioco non si apre.',
    wifiName: 'Rete: {ssid}',
    wifiPassword: 'Password: {password}',
    gameUrl: 'Indirizzo: {url}',
  },

  // ---- /play (phone controller) ---------------------------------------------
  play: {
    title: 'Snake Battle',
    namePrompt: 'Come ti chiami?',
    namePlaceholder: 'Il tuo nome',
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
  },

  // ---- /admin/login ------------------------------------------------------
  login: {
    title: 'Accesso amministratore',
    password: 'Password',
    submit: 'Entra',
    wrongPassword: 'Password errata.',
    tooManyAttempts: 'Troppi tentativi. Riprova tra {s} secondi.',
  },

  // ---- /admin ------------------------------------------------------------
  admin: {
    title: 'Pannello di controllo',
    logout: 'Esci',
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
    settings: 'Impostazioni',
    tickMs: 'Velocità (ms per passo, meno = più veloce)',
    appleCount: 'Numero di mele',
    growthPerApple: 'Crescita per mela',
    maxPlayers: 'Giocatori massimi',
    gridSize: 'Dimensione griglia (dal prossimo round)',
    intermissionMs: 'Pausa tra i round (ms)',
    countdownMs: 'Conto alla rovescia prima del round (ms, 0 = disattivato)',
    display: 'Schermo',
    sidePanel: 'Colonna laterale',
    sidePanelOptions: {
      auto: 'Automatica',
      leaderboard: 'Classifica',
      records: 'Record (vittorie e serpenti più lunghi)',
      join: 'Istruzioni per unirsi',
    },
    sidePanelAutoHint:
      'Automatica: istruzioni con meno di 2 giocatori, classifica durante il round. Durante l’intervallo: record se attivi, altrimenti istruzioni. Con «Classifica», i record compaiono tra un round e l’altro.',
    sidePanelRecordsOff:
      'I record sono spenti, quindi lo schermo mostra la classifica. Per vederli attiva la classifica delle vittorie o i serpenti più lunghi in «Regole».',
    keyboardPlayers: 'Giocatori da tastiera sullo schermo (WASD e frecce)',
    displayButtons: 'Mouse e pulsanti ← → sullo schermo per cambiare la colonna (non in «Automatica»)',
    effects: 'Effetti grafici',
    effectsHint: 'Solo grafica, valgono subito.',
    deathParticles: 'Esplosione di particelle quando un serpente muore',
    appleRings: 'Anello quando si mangia una mela',
    screenShake: 'Scossa dello schermo negli scontri frontali',
    rules: 'Regole',
    rulesHint: 'Le modifiche valgono dal prossimo round.',
    corpseApples: 'I serpenti morti diventano mele',
    wrapWalls: 'Bordi attraversabili (si esce da un lato e si rientra dall’altro)',
    leaderboard: 'Classifica delle vittorie sullo schermo',
    hallOfFame: 'Serpenti più lunghi di sempre sullo schermo',
    activeThisRound: 'Attive in questo round: {list}',
    noneActive: 'nessuna',
    resetHallOfFame: 'Azzera i serpenti più lunghi',
    confirmResetHallOfFame: 'Azzerare la lista dei serpenti più lunghi? Non si può annullare.',
    players: 'Giocatori',
    noPlayers: 'Nessun giocatore connesso.',
    colName: 'Nome',
    colStatus: 'Stato',
    colLength: 'Lunghezza',
    colSource: 'Dispositivo',
    sourcePhone: 'Telefono',
    sourceKeyboard: 'Tastiera',
    kick: 'Espelli',
    confirmKick: 'Espellere {name}?',
    playerStatus: { alive: 'In gioco', dead: 'Eliminato', queued: 'In attesa' },
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

// fmt('Round {n}', { n: 3 }) -> 'Round 3'
export function fmt(template, values = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(values, k) ? String(values[k]) : m));
}
