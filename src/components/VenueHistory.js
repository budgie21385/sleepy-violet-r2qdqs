// VENUE HISTORY (Oct 15, 2026 — the accordion's expanded content, Mark's
// spec after the show-me rounds): address line → Nights | Media toggle →
// content. YOUR visits only (friends' history lives on the map's Friends
// lens and the venue card's strip — Mark: "I don't want to see any of my
// friends' visits in the list/media area"). No action row, no notes (cut).
// Nights lines open their cards; Media opens the full-screen viewer
// directly — the card never gets involved.
import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { fetchCheckinPhotosMany } from "../lib/photos";
import { whenAgo } from "../lib/checkins";
import { MediaViewer } from "./MediaViewer";

export function VenueHistory({ userId, venue, onOpenThread }) {
  const [nights, setNights] = useState(null); // [{id,label,created_at,rating,photoCount}]
  const [tab, setTab] = useState("nights");
  const [media, setMedia] = useState(null); // signed rows, lazily on Media tab
  const [lightbox, setLightbox] = useState(null);

  useEffect(() => {
    if (!userId || !venue?.id) return;
    let cancelled = false;
    (async () => {
      const { data: acts } = await supabase
        .from("activities")
        .select("id, label, created_at, rating, joined_from")
        .eq("user_id", userId)
        .eq("venue_id", venue.id)
        .eq("kind", "checkin")
        .lte("created_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(30);
      if (cancelled) return;
      const ids = new Set((acts || []).map((a) => a.id));
      const roots = (acts || []).filter(
        (a) => !a.joined_from || !ids.has(a.joined_from)
      );
      // Photo counts in one sweep (rows only, no signing yet).
      let counts = {};
      if (roots.length > 0) {
        const { data: ph } = await supabase
          .from("activity_photos")
          .select("activity_id")
          .in(
            "activity_id",
            (acts || []).map((a) => a.id)
          );
        for (const p of ph || [])
          counts[p.activity_id] = (counts[p.activity_id] || 0) + 1;
      }
      if (!cancelled)
        setNights(
          roots.map((a) => ({
            ...a,
            photoCount: counts[a.id] || 0,
          }))
        );
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, venue?.id]);

  // Media signs lazily — only when the tab is opened.
  useEffect(() => {
    if (tab !== "media" || media !== null || !nights) return;
    let cancelled = false;
    (async () => {
      const rows = await fetchCheckinPhotosMany(nights.map((n) => n.id));
      if (!cancelled)
        setMedia(
          [...rows].sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at)
          )
        );
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, media, nights]);

  const totalPhotos = (nights || []).reduce((s, n) => s + n.photoCount, 0);

  function stepLightbox(dir) {
    if (!lightbox || !media) return;
    const i = media.findIndex((p) => p.id === lightbox.id);
    const next = media[i + dir];
    if (next) setLightbox(next);
  }

  if (nights !== null && nights.length === 0)
    return (
      <p className="px-1 pb-1 pt-2 text-[11px] text-neutral-400">
        You haven't been here yet
      </p>
    );

  return (
    <div className="pt-2">
      {venue?.address && (
        <p className="mb-2 px-1 text-[11px] text-neutral-500">
          📍 {venue.address}
        </p>
      )}
      <div className="mb-2 flex">
        <div className="flex rounded-full bg-neutral-100 p-0.5">
          <button
            type="button"
            onClick={() => setTab("nights")}
            className={`rounded-full px-3.5 py-1 text-[11px] font-medium transition ${
              tab === "nights"
                ? "bg-white text-[#455d3b] shadow-sm"
                : "text-neutral-500"
            }`}
          >
            Visits
          </button>
          <button
            type="button"
            onClick={() => setTab("media")}
            className={`rounded-full px-3.5 py-1 text-[11px] font-medium transition ${
              tab === "media"
                ? "bg-white text-[#455d3b] shadow-sm"
                : "text-neutral-500"
            }`}
          >
            Media{totalPhotos > 0 ? ` · ${totalPhotos}` : ""}
          </button>
        </div>
      </div>

      {tab === "nights" && (
        <div className="ml-1.5 border-l-2 border-[#edf2eb] pl-3">
          {(nights || []).map((n) => (
            <button
              key={n.id}
              type="button"
              onClick={() =>
                onOpenThread?.({
                  activityId: n.id,
                  ownerId: userId,
                  ownerName: "You",
                  venueName: venue.name,
                  label: n.label || null,
                  venueObj: venue,
                  timestamp: n.created_at,
                })
              }
              className="flex w-full items-center gap-1.5 py-1.5 text-left"
            >
              <span className="min-w-0 flex-1 truncate text-xs text-neutral-800">
                {/* Untitled visits lead with the date — no "A night here"
                    placeholder (Oct 16, Mark: kill the night references). */}
                {n.label || whenAgo(n.created_at)}
                {n.rating != null && (
                  <span className="ml-1 text-[10px] text-[#f4a820]">
                    ★{n.rating}
                  </span>
                )}
                <span className="ml-1 text-[10px] text-neutral-400">
                  {n.label ? `· ${whenAgo(n.created_at)}` : ""}
                  {n.photoCount > 0 ? ` · ${n.photoCount} 📷` : ""}
                </span>
              </span>
              <span className="shrink-0 text-neutral-300">›</span>
            </button>
          ))}
          {nights === null && (
            <p className="py-1.5 text-[11px] text-neutral-400">Loading…</p>
          )}
        </div>
      )}

      {tab === "media" && (
        <>
          {media === null && (
            <p className="py-1.5 text-[11px] text-neutral-400">Loading…</p>
          )}
          {media !== null && media.length === 0 && (
            <p className="py-1.5 text-[11px] text-neutral-400">
              No photos from your visits here yet
            </p>
          )}
          {media !== null && media.length > 0 && (
            <div className="grid grid-cols-4 gap-1">
              {media.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setLightbox(p)}
                  className="relative aspect-square overflow-hidden rounded-lg bg-neutral-100 active:scale-95 transition"
                >
                  {p.url && (
                    <img
                      src={p.url}
                      alt=""
                      loading="lazy"
                      className="h-full w-full object-cover"
                    />
                  )}
                  {p.kind === "video" && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-black/50 text-[10px] text-white">
                        ▶
                      </span>
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {lightbox && (
        <MediaViewer
          photos={media || []}
          photo={lightbox}
          onStep={stepLightbox}
          onClose={() => setLightbox(null)}
          userId={userId}
          mediaProfiles={{}}
        />
      )}
    </div>
  );
}
