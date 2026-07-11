// "Find a place" — the map's search sheet (magnifier in the map header).
// One merged suggestion list: venues already in the pool (free, instant, from
// our own DB) deduped against Google Autocomplete results. No visible split —
// per Mark, users shouldn't care where a result lives. The TAP does the honest
// thing for each source (July 11, 2026 search-first reframe):
//   - pool venue  → onOpenVenue(venue): the map flies to the pin, card opens
//   - Google result → Place Details (server-side, once) → confirm card →
//     "Add to Flanit": enriched insert (photos cached, cuisine_bucket derived)
//     + auto-save to the user's list, via /api/add-venue.
import { useState, useEffect, useRef } from "react";
import { Search, X, Star, ArrowLeft } from "lucide-react";
import { supabase } from "../supabaseClient";
import { formatPriceSymbols } from "../lib/venueLogic";

async function authHeader() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function callApi(body) {
  const headers = { "Content-Type": "application/json", ...(await authHeader()) };
  const resp = await fetch("/api/add-venue", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json;
}

export function AddVenueSheet({ onClose, onAdded, onOpenVenue, showToast }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]); // [{key, kind:'db'|'google', ...}]
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(null); // {kind, venue?} | {kind, card}
  const [loadingCard, setLoadingCard] = useState(false);
  const [adding, setAdding] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const mySeq = ++seq.current;
    const timer = setTimeout(async () => {
      try {
        // Our own pool first (RLS scopes to public + own venues) + Google, in
        // parallel; merged with DB rows ranked first and deduped by place id.
        const [dbRes, googleRes] = await Promise.all([
          supabase
            .from("venues")
            .select("*")
            .ilike("name", `%${term}%`)
            .limit(5),
          callApi({ action: "search", q: term }).catch(() => ({ results: [] })),
        ]);
        if (mySeq !== seq.current) return; // stale response
        const dbRows = dbRes.data || [];
        const knownPlaceIds = new Set(
          dbRows.map((v) => v.google_place_id).filter(Boolean)
        );
        const merged = [
          ...dbRows.map((v) => ({
            key: `db_${v.id}`,
            kind: "db",
            venue: v,
            name: v.name,
            address: v.suburb || v.address || "",
          })),
          ...(googleRes.results || [])
            .filter((r) => !knownPlaceIds.has(r.place_id))
            .map((r) => ({
              key: `g_${r.place_id}`,
              kind: "google",
              place_id: r.place_id,
              name: r.name,
              address: r.address,
            })),
        ];
        setResults(merged);
      } finally {
        if (mySeq === seq.current) setSearching(false);
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [q]);

  async function pick(r) {
    if (r.kind === "db") {
      // Found it — navigate, don't "add". The map flies to the pin and the
      // venue card opens; saving stays one tap away on the card's bookmark.
      onOpenVenue?.(r.venue);
      onClose();
      return;
    }
    setLoadingCard(true);
    try {
      const { card } = await callApi({ action: "details", placeId: r.place_id });
      setSelected({ kind: "google", card });
    } catch (e) {
      showToast?.("Couldn't load that place");
    } finally {
      setLoadingCard(false);
    }
  }

  async function add() {
    setAdding(true);
    try {
      const { venue, existing } = await callApi({
        action: "add",
        placeId: selected.card.place_id,
      });
      onAdded?.(venue, { existing });
      showToast?.("Added to your list");
      onClose();
    } catch (e) {
      console.error("Add venue failed:", e);
      showToast?.("Couldn't add that venue");
    } finally {
      setAdding(false);
    }
  }

  // Confirm card only ever shows Google results now — pool taps navigate away.
  const card = selected?.card
    ? {
        name: selected.card.name,
        address: selected.card.address,
        rating: selected.card.rating,
        review_count: selected.card.review_count,
        priceSymbols: formatPriceSymbols({ price_level: selected.card.price_level }),
        cuisine: selected.card.cuisine,
        photo: selected.card.photo_url,
      }
    : null;

  return (
    <div className="fixed inset-0 z-[3200]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="absolute left-0 right-0 bottom-0 max-h-[85%] flex flex-col bg-white rounded-t-3xl shadow-2xl">
        <div className="px-5 pt-3 pb-2">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              {card && (
                <button
                  type="button"
                  aria-label="Back to search"
                  onClick={() => setSelected(null)}
                  className="w-8 h-8 -ml-1 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-100"
                >
                  <ArrowLeft size={16} />
                </button>
              )}
              <h2 className="text-base font-semibold">Find a place</h2>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="w-8 h-8 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-100"
            >
              <X size={16} />
            </button>
          </div>

          {!card && (
            <div className="flex items-center gap-2 rounded-full border border-neutral-200 px-4 py-2.5 mb-1">
              <Search size={15} className="text-neutral-400 shrink-0" />
              {/* text-base (16px), not text-sm: iOS Safari auto-zooms the page
                  when a focused input is under 16px, which shoves the whole
                  sheet half off-screen. 16px suppresses the zoom. */}
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search for a place"
                className="flex-1 text-base focus:outline-none"
              />
              {q && (
                <button
                  type="button"
                  aria-label="Clear"
                  onClick={() => setQ("")}
                  className="text-neutral-400"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-8">
          {!card && (
            <>
              {searching && (
                <p className="text-xs text-neutral-400 text-center py-3">
                  Searching…
                </p>
              )}
              {!searching && q.trim().length >= 2 && results.length === 0 && (
                <p className="text-sm text-neutral-500 text-center py-6">
                  No places found — try the full name.
                </p>
              )}
              <div className="space-y-1.5">
                {results.map((r) => (
                  <button
                    key={r.key}
                    type="button"
                    disabled={loadingCard}
                    onClick={() => pick(r)}
                    className="w-full flex items-center gap-3 rounded-xl border border-neutral-100 px-3 py-2.5 text-left hover:bg-neutral-50 active:scale-[0.99] transition disabled:opacity-60"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-neutral-900 truncate">
                        {r.name}
                      </p>
                      {r.address && (
                        <p className="text-[11px] text-neutral-500 truncate">
                          {r.address}
                        </p>
                      )}
                    </div>
                    <span className="text-neutral-300 text-lg leading-none shrink-0">
                      ›
                    </span>
                  </button>
                ))}
              </div>
              {q.trim().length < 2 && (
                <p className="text-xs text-neutral-400 text-center py-6">
                  Type a venue name to search.
                </p>
              )}
            </>
          )}

          {card && (
            <div>
              {card.photo ? (
                <img
                  src={card.photo}
                  alt={card.name}
                  className="w-full h-40 object-cover rounded-2xl mb-3"
                />
              ) : (
                <div className="w-full h-24 rounded-2xl bg-neutral-100 mb-3" />
              )}
              <p className="text-lg font-semibold leading-tight">{card.name}</p>
              {card.cuisine && (
                <p className="text-xs text-neutral-500 mt-0.5">{card.cuisine}</p>
              )}
              <p className="text-sm text-neutral-600 mt-2 flex items-center gap-1.5">
                {card.rating != null && (
                  <>
                    <Star size={13} className="text-amber-500 fill-amber-500" />
                    <span>
                      {card.rating}
                      {card.review_count != null && ` · ${card.review_count} reviews`}
                    </span>
                  </>
                )}
                {card.priceSymbols && (
                  <span className="text-[#455d3b] font-medium">
                    {card.rating != null ? " · " : ""}
                    {card.priceSymbols}
                  </span>
                )}
              </p>
              {card.address && (
                <p className="text-xs text-neutral-500 mt-1">{card.address}</p>
              )}
              <button
                type="button"
                disabled={adding}
                onClick={add}
                className="w-full mt-4 rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white disabled:opacity-60"
              >
                {adding ? "Adding…" : "Add to Flanit"}
              </button>
              <p className="text-[11px] text-neutral-400 text-center mt-2">
                Saves to your list · pins on your map
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
