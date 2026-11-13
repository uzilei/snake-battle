// The fruits a plain apple can be drawn as on /display, in /admin order.
// Purely visual: every one is a normal apple. /admin picks which are in use
// (the `fruits` setting); with none picked, apples are all 🍎.
//
//   code   file name in @twemoji/svg (served at /twemoji/<code>.svg)
//   emoji  shown on its /admin checkbox

export const FRUITS = Object.freeze(
  [
    { code: '1f34f', emoji: '🍏' },
    { code: '1f34e', emoji: '🍎' },
    { code: '1f350', emoji: '🍐' },
    { code: '1f34a', emoji: '🍊' },
    { code: '1f34b', emoji: '🍋' },
    { code: '1f349', emoji: '🍉' },
    { code: '1f347', emoji: '🍇' },
    { code: '1f353', emoji: '🍓' },
    { code: '1fad0', emoji: '🫐' },
    { code: '1f348', emoji: '🍈' },
    { code: '1f352', emoji: '🍒' },
    { code: '1f351', emoji: '🍑' },
    { code: '1f96d', emoji: '🥭' },
    { code: '1f34d', emoji: '🍍' },
    { code: '1f345', emoji: '🍅' },
    { code: '1f951', emoji: '🥑' },
  ].map((f) => Object.freeze(f)),
);

export const FRUIT_CODES = Object.freeze(FRUITS.map((f) => f.code));

// The red apple: the "apple only" choice, and what's drawn when none is on.
export const APPLE_FRUIT = '1f34e';
