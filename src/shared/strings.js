// All user-facing text, in Italian. Shared by the server (login page) and the
// browser pages (served at /shared/strings.js). Use fmt() for placeholders.

export const STRINGS = Object.freeze({
  appName: 'Snake Battle',
  defaultName: 'Giocatore {n}',

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

  // ---- /play (placeholder until the phone controller is built) -----------
  play: {
    title: 'Snake Battle',
    comingSoon: 'Il controller per telefono è in arrivo.',
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
      join: 'Istruzioni per unirsi',
    },
    sidePanelAutoHint: 'Automatica: istruzioni con meno di 2 giocatori e durante l’intervallo, classifica altrimenti.',
    keyboardPlayers: 'Giocatori da tastiera sullo schermo (WASD e frecce)',
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
  },
});

// fmt('Round {n}', { n: 3 }) -> 'Round 3'
export function fmt(template, values = {}) {
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (Object.hasOwn(values, k) ? String(values[k]) : m));
}
