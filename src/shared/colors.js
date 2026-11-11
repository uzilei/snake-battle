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
