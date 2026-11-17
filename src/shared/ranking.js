// The round's ranking, shared by /display's scoreboard and the round card on
// /play, so the phone never disagrees with the big screen. Pure data.

const STATUS_ORDER = { alive: 0, dead: 1, queued: 2 };

// Scoreboard order: alive first, then longer first; among equals people
// before bots, then by name.
export function compareRound(a, b) {
  return (
    STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
    b.length - a.length ||
    Number(a.bot) - Number(b.bot) ||
    a.name.localeCompare(b.name)
  );
}

/**
 * Place (1 = first) of everyone who played the round, as id -> place. The
 * winner is always first (a time-limit or target winner isn't always the
 * longest); after it the scoreboard order, where snakes with the same status
 * and length share a place (1, 2, 2, 4). Queued players get none.
 */
export function roundPlaces(players, winnerId = null) {
  const played = players.filter((p) => p.status !== 'queued');
  const winner = played.find((p) => p.id === winnerId) ?? null;
  const rest = played.filter((p) => p !== winner).sort(compareRound);
  const places = new Map();
  if (winner) places.set(winner.id, 1);
  let prev = null;
  rest.forEach((p, i) => {
    const place = winner ? i + 2 : i + 1;
    const tied = prev && prev.status === p.status && prev.length === p.length;
    places.set(p.id, tied ? places.get(prev.id) : place);
    prev = p;
  });
  return places;
}
