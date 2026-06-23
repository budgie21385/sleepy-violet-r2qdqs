// Standalone public venue card shown at flanit.co/v/<id> — what a shared card
// link opens. No login, no app chrome; fetches the venue via the
// get_public_venue SECURITY DEFINER RPC (so host-imported venues resolve for
// anyone), renders the same card pieces as the in-app sheet, and nudges the
// viewer into Flanit. Rendered standalone from index.js (the heavy app never
// mounts for this route).
import { useState, useEffect } from "react";
import { supabase } from "../supabaseClient";
import { MapPin } from "lucide-react";
import {
  VenueHeroCarousel,
  VenueRating,
  VenueVibes,
  OpeningHours,
  OpenMapsButton,
} from "./VenueBits";
import { getMapsUrl } from "../lib/venueLogic";

export function PublicVenuePage({ venueId }) {
  const [venue, setVenue] = useState(undefined); // undefined = loading, null = not found

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("get_public_venue", {
        p_venue_id: Number(venueId),
      });
      if (cancelled) return;
      if (error) {
        console.error("get_public_venue failed:", error);
        setVenue(null);
        return;
      }
      setVenue((data && data[0]) || null);
    })();
    return () => {
      cancelled = true;
    };
  }, [venueId]);

  return (
    <div className="min-h-screen bg-[#fdf6f0]">
      <div className="max-w-sm mx-auto p-4">
        <a
          href="/"
          className="inline-block mb-4 text-lg font-semibold tracking-tight text-[#455d3b]"
        >
          Flanit
        </a>

        {venue === undefined && (
          <p className="text-sm text-neutral-500 text-center py-16">Loading…</p>
        )}

        {venue === null && (
          <div className="rounded-3xl bg-white p-6 text-center shadow-sm border border-neutral-100">
            <p className="text-sm text-neutral-600">
              This place isn't available.
            </p>
            <a
              href="/"
              className="mt-4 inline-block rounded-2xl bg-[#455d3b] px-5 py-3 text-sm font-medium text-white"
            >
              Open Flanit
            </a>
          </div>
        )}

        {venue && (
          <>
            <div className="rounded-[2rem] bg-white p-5 shadow-sm border border-neutral-100">
              <VenueHeroCarousel venue={venue} />
              {/* Name fallback for venues with no photo (hero renders null). */}
              {!venue.image_urls?.length && !venue.primary_image && (
                <div className="mb-3">
                  <h1 className="text-xl font-semibold leading-tight">
                    {venue.name}
                  </h1>
                  <p className="mt-0.5 flex items-center gap-1 text-sm text-neutral-500">
                    <MapPin size={13} className="shrink-0" />
                    {venue.type}
                    {venue.suburb ? ` · ${venue.suburb}` : ""}
                  </p>
                </div>
              )}
              <p className="text-sm leading-6 text-neutral-500">
                {venue.address}
              </p>
              <VenueRating venue={venue} />
              <VenueVibes venue={venue} />
              <OpeningHours venue={venue} />
              <OpenMapsButton url={getMapsUrl(venue)} />
            </div>

            <a
              href="/"
              className="mt-4 block w-full rounded-2xl bg-[#455d3b] py-3 text-center font-medium text-white"
            >
              Open in Flanit
            </a>
            <p className="mt-3 text-center text-xs text-neutral-500">
              Shared from Flanit — find a place, together.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
