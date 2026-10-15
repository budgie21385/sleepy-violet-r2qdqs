// Deck-grammar tests (Oct 15, 2026). Every case here is a bug Mark and
// Renasha field-hit on Oct 14-15, plus the parity invariant that makes the
// whole class impossible: for the same session row, host and guest build
// the same deck.
import {
  buildHostDeck,
  sessionPoolIds,
  buildGuestListDeck,
  deckExhausted,
} from "./pool";
import { orderGroupDeck } from "./venueLogic";

const v = (id, extra = {}) => ({ id, name: `Venue ${id}`, ...extra });
const ids = (deck) => deck.map((x) => x.id);

// A world: 10 venues, the user's live filters pass only 1-4,
// a custom list holds 3, 6, 8, 9.
const venues = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) =>
  v(n, { rating: (n % 5) + 1 })
);
const filteredPool = venues.filter((x) => x.id <= 4);
const listIds = new Set([3, 6, 8, 9]);

describe("buildHostDeck", () => {
  test("a picked list IS the pool: setup filters do not trim it", () => {
    // Field bug: "wasn't able to send all 15 places" — a collaborator's
    // area/cuisine filters silently shrank a shared list.
    const deck = buildHostDeck({
      source: "list",
      listIds,
      venues,
      filteredPool,
    });
    expect(ids(deck).sort()).toEqual([3, 6, 8, 9]);
  });

  test("list source ignores the map-viewport carry", () => {
    const deck = buildHostDeck({
      source: "list",
      listIds,
      venues,
      filteredPool,
      viewIds: new Set([3]), // stale viewport must NOT trim the list
    });
    expect(ids(deck).sort()).toEqual([3, 6, 8, 9]);
  });

  test("all source = filtered pool, trimmed to the viewport when present", () => {
    const deck = buildHostDeck({
      source: "all",
      venues,
      filteredPool,
      viewIds: new Set([2, 3, 7]), // 7 is outside the filtered pool
    });
    expect(ids(deck).sort()).toEqual([2, 3]);
  });

  test("solo drops already-saved venues from the all source", () => {
    const deck = buildHostDeck({
      source: "all",
      mode: "solo",
      venues,
      filteredPool,
      savedIds: new Set([1, 4]),
    });
    expect(ids(deck).sort()).toEqual([2, 3]);
  });
});

describe("sessionPoolIds (what the session row carries to guests)", () => {
  test("a chosen list wins over the viewport", () => {
    // Field bug: list ids never reached the row — guests got all 151.
    expect(
      sessionPoolIds({
        source: "list",
        listIds,
        viewIds: new Set([1, 2]),
      }).sort()
    ).toEqual([3, 6, 8, 9]);
  });

  test("all source carries the viewport when present, else nothing", () => {
    expect(
      sessionPoolIds({ source: "all", viewIds: new Set([1, 2]) }).sort()
    ).toEqual([1, 2]);
    expect(sessionPoolIds({ source: "all" })).toBeNull();
  });
});

describe("buildGuestListDeck", () => {
  test("trims the fetched pool to the row's viewVenueIds, nothing else", () => {
    const pool = venues; // what the RPC returned
    const deck = buildGuestListDeck({
      pool,
      filters: { viewVenueIds: [3, 6, 8, 9] },
    });
    expect(ids(deck).sort()).toEqual([3, 6, 8, 9]);
  });

  test("legacy rows without viewVenueIds use the whole fetched pool", () => {
    const pool = venues.slice(0, 3);
    expect(ids(buildGuestListDeck({ pool, filters: {} }))).toEqual([1, 2, 3]);
  });
});

describe("PARITY: host and guest build the same deck from the same row", () => {
  test("list session end to end", () => {
    // Host starts from the list...
    const hostDeck = buildHostDeck({
      source: "list",
      listIds,
      venues,
      filteredPool, // host's own filters differ — must not matter
    });
    // ...the row carries the constraint...
    const row = { viewVenueIds: sessionPoolIds({ source: "list", listIds }) };
    // ...the guest rebuilds from the row (their RPC pool = the same venues).
    const guestDeck = buildGuestListDeck({ pool: venues, filters: row });
    expect(ids(guestDeck).sort()).toEqual(ids(hostDeck).sort());
  });

  test("group ordering is deterministic over the same pool", () => {
    const a = orderGroupDeck(venues);
    const b = orderGroupDeck([...venues].reverse());
    expect(ids(a)).toEqual(ids(b));
  });
});

describe("deckExhausted", () => {
  test("ends at the deck's own length, not any other pool's", () => {
    // Field bug: "my session finished before I got to the end of the list" —
    // the end check counted filteredVenues while the deck was the list.
    const deck = buildHostDeck({ source: "list", listIds, venues, filteredPool });
    expect(deckExhausted(deck.length - 1, deck)).toBe(false);
    expect(deckExhausted(deck.length, deck)).toBe(true);
  });

  test("an empty or missing deck is exhausted at 0", () => {
    expect(deckExhausted(0, [])).toBe(true);
    expect(deckExhausted(0, null)).toBe(true);
  });
});
