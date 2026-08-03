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
export async function searchPlaces(q) {
  const term = (q || "").trim();
  if (term.length < 2) return { venues: [], google: [] };
  const [dbRes, gRes] = await Promise.all([
    supabase.from("venues").select("*").ilike("name", `%${term}%`).limit(12),
    callAddVenueApi({ action: "search", q: term }).catch(() => ({ results: [] })),
  ]);
  const venues = dbRes.data || [];
  const known = new Set(venues.map((v) => v.google_place_id).filter(Boolean));
  return {
    venues,
    google: (gRes.results || []).filter((r) => !known.has(r.place_id)),
  };
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
