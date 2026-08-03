// SHARED PLACE SEARCH (July 31) — lifted out of BeenScreen so the check-in
// card can extend a night with another venue using the same lookup the
// add-a-night form uses. Two callers, one behaviour: Flanit's own venues first,
// Google behind them for anywhere we've never heard of (July 25, Mark: "I want
// to add the cinema I went to yesterday and it won't come up").
import { supabase } from "../supabaseClient";

// Same /api/add-venue caller as AddVenueSheet.
export async function callAddVenueApi(body) {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const resp = await fetch("/api/add-venue", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `HTTP ${resp.status}`);
  return json;
}

// Pool + Google in parallel. Google rows we already hold are dropped, so a
// place never shows twice. Returns { venues, google } — venues are real rows
// ready to use; google rows need addGooglePlace() to become one.
//
// Personal places (source='personal') are filtered to the caller's own. Venue
// reads are open to every signed-in user by design, so this is presentation,
// not security — but "Mark's place" has no business appearing in a stranger's
// search. Over-fetch then trim, so filtering can't leave a short list.
export async function searchPlaces(q, viewerId) {
  const term = (q || "").trim();
  if (term.length < 2) return { venues: [], google: [] };
  const [dbRes, gRes] = await Promise.all([
    supabase.from("venues").select("*").ilike("name", `%${term}%`).limit(24),
    callAddVenueApi({ action: "search", q: term }).catch(() => ({ results: [] })),
  ]);
  const venues = (dbRes.data || [])
    .filter((v) => v.source !== "personal" || v.created_by === viewerId)
    .slice(0, 12);
  const known = new Set(venues.map((v) => v.google_place_id).filter(Boolean));
  return {
    venues,
    google: (gRes.results || []).filter((r) => !known.has(r.place_id)),
  };
}

// Create a name-only place — someone's house, a park, a backyard wedding.
// No address and no coordinates, ever: venue rows are readable by every
// signed-in user, so the name is all we're willing to put there. Enforced by
// the venues_insert_personal policy too, not just here (personal_places.sql).
export async function createPersonalPlace(name, userId) {
  const clean = (name || "").trim().slice(0, 60);
  if (!clean || !userId) return null;
  const { data, error } = await supabase
    .from("venues")
    .insert({
      name: clean,
      source: "personal",
      created_by: userId,
      verified: false,
    })
    .select("*")
    .single();
  if (error) {
    console.error("Personal place insert failed:", error);
    return null;
  }
  return data;
}

// Turn a Google result into a venue row WITHOUT saving it to the user's list —
// the Timber Yard rule: being somewhere isn't the same as curating it.
export async function addGooglePlace(placeId) {
  const { venue } = await callAddVenueApi({
    action: "add",
    placeId,
    save: false,
  });
  return venue;
}
