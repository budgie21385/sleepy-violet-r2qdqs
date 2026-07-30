// Check-in domain logic + shared constants. Check-ins were smeared across
// App.js and four components with duplicated helpers — this is the one home
// (Mark, July 13, 2026). UI side-effects (toasts, opening the CheckinSheet)
// stay with the callers; this file only talks to the database.
import { supabase } from "../supabaseClient";

// "Is at" vs "checked in at" — the live-presence window, used by the Activity
// items, the venue-card strip, friends-map pin styling, and the Join button.
export const FRESH_MS = 3 * 60 * 60 * 1000;

// Same-venue re-check-in guard window.
export const DUPE_MS = 4 * 60 * 60 * 1000;

export function timeAgoShort(ts) {
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 15) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

// ONE TIME LADDER for "when was this?" (July 25 — Been said "today" for a
// check-in from 8pm YESTERDAY, because it divided elapsed ms by 24h instead
// of comparing calendar dates). Rules:
//   under an hour  → "just now" / "42m ago"
//   under a day    → "14h ago"   (unambiguous, no calendar guessing)
//   beyond that    → CALENDAR days: "yesterday" means the previous DATE
export function whenAgo(ts) {
  const d = new Date(ts);
  const mins = Math.floor((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const startOfDay = (x) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round(
    (startOfDay(new Date()) - startOfDay(d)) / 86400000
  );
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}

// Check the user in at a venue. Returns:
//   { activity, already: false }  — fresh check-in created
//   { activity, already: true }   — recent check-in at this venue already exists
// Throws on database failure — the caller decides how to surface it.
// joinedFrom: the check-in being JOINED ("I'm here too") — the night-graph
// edge (July 23). A join links your shard into their night; a plain check-in
// starts a night of its own. If a recent check-in already exists but has no
// edge yet, the join adopts it into the night.
export async function performCheckIn(userId, venueId, joinedFrom = null) {
  const since = new Date(Date.now() - DUPE_MS).toISOString();
  const { data: recent } = await supabase
    .from("activities")
    .select("id, created_at, joined_from")
    .eq("user_id", userId)
    .eq("venue_id", venueId)
    .eq("kind", "checkin")
    .gte("created_at", since)
    .limit(1);
  if (recent && recent.length > 0) {
    const existing = recent[0];
    if (joinedFrom && !existing.joined_from && existing.id !== joinedFrom) {
      await supabase
        .from("activities")
        .update({ joined_from: joinedFrom })
        .eq("id", existing.id);
      existing.joined_from = joinedFrom;
    }
    return { activity: existing, already: true };
  }
  const { data: inserted, error } = await supabase
    .from("activities")
    .insert({
      user_id: userId,
      kind: "checkin",
      venue_id: venueId,
      joined_from: joinedFrom,
    })
    .select("id, created_at")
    .single();
  if (error) throw error;
  return { activity: inserted, already: false };
}
