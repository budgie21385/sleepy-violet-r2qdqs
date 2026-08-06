// BEEN STATE (July 31, 2026) — one concept, a visit, three ways in: a live
// check-in, a backdated one, or a dateless "I've been here" mark (been_marks).
// This module answers "have I been to venue X, and how many times?" for every
// surface that shows the pill.
//
// Shape: { marked: Set<venueId>, visits: Map<venueId, count> }.
//   been(venueId)  = visits > 0 || marked
//   label          = visits >= 2 ? `Been ×${visits}` : "Been"
//   untickable     = marked && visits === 0  (events can't be un-happened;
//                    the mark is removable only while it's the ONLY source)
//
// Both queries return the caller's OWN rows only (RLS), so fetching everything
// at once is cheap — a person's lifetime of check-ins is hundreds of rows, and
// it lets the swipe deck read state per card with zero per-card queries.
import { supabase } from "../supabaseClient";

// Visits are NIGHTS, not rows (July 31, Mark: "how has this been added to
// Been 2 times?"). A mutual tag-accept leaves you TWO shard rows at the same
// venue for one morning — your check-in plus the twin — and counting rows
// showed "Been ×2" for a single coffee. Dedupe: rows at the same venue within
// 12h are one visit (the same window the night cluster uses).
const VISIT_WINDOW_MS = 12 * 60 * 60 * 1000;

export function countVisits(rows) {
  const visits = new Map();
  const byVenue = new Map();
  for (const r of rows || []) {
    if (!r.venue_id) continue;
    if (!byVenue.has(r.venue_id)) byVenue.set(r.venue_id, []);
    byVenue.get(r.venue_id).push(new Date(r.created_at).getTime());
  }
  for (const [venueId, times] of byVenue) {
    times.sort((a, b) => a - b);
    let count = 0;
    let lastCounted = -Infinity;
    for (const t of times) {
      if (t - lastCounted > VISIT_WINDOW_MS) {
        count++;
        lastCounted = t;
      }
    }
    visits.set(venueId, count);
  }
  return visits;
}

export async function fetchBeenState(userId) {
  if (!userId) return { marked: new Set(), visits: new Map() };
  const [marksRes, actsRes] = await Promise.all([
    supabase.from("been_marks").select("venue_id").eq("user_id", userId),
    supabase
      .from("activities")
      .select("venue_id, created_at")
      .eq("user_id", userId)
      .eq("kind", "checkin"),
  ]);
  const marked = new Set((marksRes.data || []).map((r) => r.venue_id));
  return { marked, visits: countVisits(actsRes.data) };
}

// Tick. 23505 means the mark already exists — same outcome, not an error.
export async function markBeen(userId, venueId) {
  if (!userId || !venueId) return false;
  const { error } = await supabase
    .from("been_marks")
    .insert({ user_id: userId, venue_id: venueId });
  if (error && error.code !== "23505") {
    console.error("Been mark failed:", error);
    return false;
  }
  return true;
}

// Untick — caller is responsible for only offering this when the mark is the
// sole source (no check-ins at the venue).
export async function unmarkBeen(userId, venueId) {
  if (!userId || !venueId) return false;
  const { error } = await supabase
    .from("been_marks")
    .delete()
    .eq("user_id", userId)
    .eq("venue_id", venueId);
  if (error) {
    console.error("Been unmark failed:", error);
    return false;
  }
  return true;
}

// Presentation helpers shared by every pill site.
export function beenLabel(visitCount) {
  return visitCount >= 2 ? `Been ×${visitCount}` : "Been";
}
