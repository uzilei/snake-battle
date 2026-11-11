// Player colors, indexed by the engine's colorIndex (max 12 players).
// Chosen to stay distinguishable on a dark background from a few meters away.
export const PLAYER_COLORS = Object.freeze([
  '#ff4d4d', // red
  '#4da6ff', // blue
  '#ffd23f', // yellow
  '#3ddc84', // green
  '#c77dff', // purple
  '#ff9f1c', // orange
  '#2ee6d6', // cyan
  '#ff6fb5', // pink
  '#a3e635', // lime
  '#f5f5f5', // white
  '#b08968', // brown
  '#7b8cff', // indigo
]);

export function playerColor(colorIndex) {
  return PLAYER_COLORS[colorIndex % PLAYER_COLORS.length] ?? '#ffffff';
}

// Relative luminance (WCAG) of a #rrggbb color.
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// Black or white, whichever contrasts more with the player's color. Used for
// the name on the phone, whose whole background is the snake color.
export function contrastText(colorIndex) {
  const l = luminance(playerColor(colorIndex));
  const vsBlack = (l + 0.05) / 0.05;
  const vsWhite = 1.05 / (l + 0.05);
  return vsBlack >= vsWhite ? '#111111' : '#ffffff';
}
