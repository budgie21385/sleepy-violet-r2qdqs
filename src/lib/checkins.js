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

// Check the user in at a venue. Returns:
//   { activity, already: false }  — fresh check-in created
//   { activity, already: true }   — recent check-in at this venue already exists
// Throws on database failure — the caller decides how to surface it.
export async function performCheckIn(userId, venueId) {
  const since = new Date(Date.now() - DUPE_MS).toISOString();
  const { data: recent } = await supabase
    .from("activities")
    .select("id, created_at")
    .eq("user_id", userId)
    .eq("venue_id", venueId)
    .eq("kind", "checkin")
    .gte("created_at", since)
    .limit(1);
  if (recent && recent.length > 0) {
    return { activity: recent[0], already: true };
  }
  const { data: inserted, error } = await supabase
    .from("activities")
    .insert({ user_id: userId, kind: "checkin", venue_id: venueId })
    .select("id, created_at")
    .single();
  if (error) throw error;
  return { activity: inserted, already: false };
}
