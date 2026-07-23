// Venue heavy-tail hydration (July 21, 2026 — speed pair, part 2).
// The bootstrap now fetches only LIGHT columns (filters + pins + card
// headers); the megabytes — image arrays, reviews, editorial summaries —
// load here, per venue, when a card actually opens. In-memory cache, and
// `prefetchVenueDetails` warms the next swipe cards so the deck never waits.
import { useState, useEffect } from "react";
import { supabase } from "../supabaseClient";

const cache = new Map(); // venueId → full row

export async function fetchVenueDetails(venueId) {
  if (!venueId) return null;
  if (cache.has(venueId)) return cache.get(venueId);
  const { data } = await supabase
    .from("venues")
    .select("*")
    .eq("id", venueId)
    .maybeSingle();
  if (data) cache.set(venueId, data);
  return data;
}

export function prefetchVenueDetails(venueIds) {
  for (const id of venueIds || []) {
    if (id && !cache.has(id)) fetchVenueDetails(id);
  }
}

// Drop-in hydrator: give it the light venue, use the result exactly like the
// old full venue. Already-full objects (add flow, cached) pass through
// instantly; light ones fill in a beat later.
export function useVenueDetails(venue) {
  const [full, setFull] = useState(() =>
    venue?.id && cache.has(venue.id)
      ? { ...venue, ...cache.get(venue.id) }
      : venue
  );

  useEffect(() => {
    let cancelled = false;
    if (!venue?.id) {
      setFull(venue);
      return;
    }
    const cached = cache.get(venue.id);
    if (cached) {
      setFull({ ...venue, ...cached });
      return;
    }
    // Heavy field already present → object is full (e.g. add-venue flow).
    if (venue.image_urls !== undefined) {
      setFull(venue);
      return;
    }
    setFull(venue); // render light immediately
    fetchVenueDetails(venue.id).then((d) => {
      if (!cancelled && d) setFull({ ...venue, ...d });
    });
    return () => {
      cancelled = true;
    };
  }, [venue?.id]);

  return full || venue;
}
