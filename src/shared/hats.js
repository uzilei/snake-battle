// The hats a phone player can pick on /play, in picker order. Purely
// cosmetic: /display draws the hat on the snake's head (when the /admin
// "hats" toggle is on), /admin shows it in the player list. The server
// accepts only these ids; anything else means no hat.
//
//   id       sent in the join message and stored per player
//   emoji    shown in the /admin player list
//   twemoji  file name in @twemoji/svg (served at /twemoji/<code>.svg)

export const HATS = Object.freeze(
  [
    { id: 'cap', emoji: '🧢', twemoji: '1f9e2' },
    { id: 'sunhat', emoji: '👒', twemoji: '1f452' },
    { id: 'tophat', emoji: '🎩', twemoji: '1f3a9' },
    { id: 'gradcap', emoji: '🎓', twemoji: '1f393' },
  ].map((h) => Object.freeze(h)),
);

export const HAT_IDS = Object.freeze(HATS.map((h) => h.id));

// A hat id as received from a client: one of the list, or null (no hat).
export const validHat = (value) => (typeof value === 'string' && HAT_IDS.includes(value) ? value : null);
