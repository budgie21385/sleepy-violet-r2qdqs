// THE DECK GRAMMAR (Oct 15, 2026) — one module owns how a session's venue
// pool is built, on BOTH sides of the wire. Extracted from App.js after a
// day where host and guest decks diverged three ways (list ids never written
// to the session row; a collaborator's filters trimming a shared list; the
// deck ending at the filtered pool's length instead of its own).
//
// The rules, in one place:
// - A picked list IS the pool: no setup filters, no verified-or-saved
//   curation, no viewport trim. The list's ids are the whole constraint.
// - The "all" source is the filtered pool, optionally trimmed to the map
//   viewport; solo mode additionally drops already-saved venues.
// - Whatever constrained the host's pool MUST ride the session row as
//   filters.viewVenueIds, because guests rebuild their deck from that row.
//
// Everything here is pure: arrays/Sets in, arrays out. App.js supplies the
// filtered pool (live widgets) and the serialized filters (session row).

/**
 * The host's swipe deck, before group ordering.
 * - source "list": venues ∩ listIds (the list IS the pool).
 * - source "all": filteredPool, minus saved in solo, ∩ viewport if present.
 */
export function buildHostDeck({
  source, // "all" | "list"
  listIds = null, // Set of venue ids when source === "list"
  venues = [], // the full venue read (list rows live outside the filters)
  filteredPool = [], // filteredVenues — the live widget-filtered pool
  mode = "concurrent", // "concurrent" | "curated" | "solo"
  savedIds = null, // Set — solo drops these
  viewIds = null, // Set — map-viewport carry, "all" source only
}) {
  if (source === "list" && listIds) {
    return venues.filter((v) => listIds.has(v.id));
  }
  let q =
    mode === "solo" && savedIds
      ? filteredPool.filter((v) => !savedIds.has(v.id))
      : filteredPool;
  if (viewIds) q = q.filter((v) => viewIds.has(v.id));
  return q;
}

/**
 * The venue-id constraint to write into the session row's filters JSON
 * (filters.viewVenueIds) — the ONE field guests read to trim their pool.
 * A chosen list wins; otherwise the map-viewport carry; otherwise nothing.
 * Returns an array of ids, or null for "no constraint".
 */
export function sessionPoolIds({ source, listIds = null, viewIds = null }) {
  if (source === "list" && listIds) return Array.from(listIds);
  if (viewIds) return Array.from(viewIds);
  return null;
}

/**
 * A guest's deck for a source="list" session: the fetched pool trimmed to
 * the row's viewVenueIds, nothing else — the host applied no filters, so
 * the guest must not either, or the decks diverge.
 */
export function buildGuestListDeck({ pool = [], filters = {} }) {
  const viewSet = filters?.viewVenueIds?.length
    ? new Set(filters.viewVenueIds)
    : null;
  return viewSet ? pool.filter((v) => viewSet.has(v.id)) : pool;
}

/**
 * Has the swiper reached the end of THIS deck? (The Oct 15 bug: the check
 * counted the filtered pool while the deck was the list.)
 */
export function deckExhausted(nextIndex, deck) {
  return nextIndex >= (deck?.length || 0);
}
