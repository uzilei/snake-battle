// Player name helpers shared by the game controller and the records store.

// Key for comparing names: the uniqueness check on join, and grouping
// global leaderboard entries. Case-sensitive on purpose ("marco" and
// "Marco" are different players); NFC only makes an accented letter typed as
// one character or as letter + accent compare equal.
export const nameKey = (name) => String(name).normalize('NFC');
