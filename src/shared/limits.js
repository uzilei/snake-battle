// Limits shared by the server and the browser pages (served at /shared/limits.js).

// Longest player name, in characters (code points). The server enforces it;
// /play uses it for the input's maxlength.
export const MAX_NAME_LENGTH = 16;
