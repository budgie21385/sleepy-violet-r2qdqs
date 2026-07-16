// Been — your own check-in history, the memory ledger (Profile → Been).
// Rows: venue · label · when; tapping a row opens the CHECK-IN (its own
// object: label, companions, thread) — the venue card is one tap deeper via
// the venue name inside the thread. Extracted from App.js (July 13, 2026).
import { useState, useEffect } from "react";
import { ArrowLeft, MapPin } from "lucide-react";
import { supabase } from "../supabaseClient";
import { MapVenueSheet } from "./MapVenueSheet";
import { CheckinThreadSheet } from "./CheckinThreadSheet";

// One compact history row — also used by ProfileLookupScreen's Recent
// activity section (a friend's history on their profile).
export function CheckinHistoryRow({ c }) {
  const mins = Math.floor((Date.now() - new Date(c.created_at).getTime()) / 60000);
  const when =
    mins < 60
      ? `${Math.max(mins, 1)}m`
      : mins < 24 * 60
      ? `${Math.floor(mins / 60)}h`
      : `${Math.floor(mins / (24 * 60))}d`;
  return (
    <div className="flex items-center gap-2 px-1">
      <MapPin size={14} className="shrink-0 text-neutral-400" />
      <p className="flex-1 min-w-0 text-sm text-neutral-700 truncate">
        {c.venueName}
        {c.label ? <span className="text-neutral-500"> · {c.label}</span> : null}
      </p>
      <span className="text-xs text-neutral-400">{when}</span>
    </div>
  );
}

export function BeenScreen({ userId, savedIds, onSave, onUnsave, onHide, onBack }) {
  const [rows, setRows] = useState(null); // null = loading
  const [venueById, setVenueById] = useState(() => new Map());
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [thread, setThread] = useState(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("activities")
        .select("id, venue_id, label, created_at")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .order("created_at", { ascending: false })
        .limit(100);
      // Resolve venues directly (not from the curated pool) — open venue
      // reads mean even a check-in at someone else's manual venue resolves.
      const ids = Array.from(new Set((data || []).map((r) => r.venue_id)));
      let vMap = new Map();
      if (ids.length > 0) {
        const { data: vens } = await supabase
          .from("venues")
          .select("*")
          .in("id", ids);
        vMap = new Map((vens || []).map((v) => [v.id, v]));
      }
      if (cancelled) return;
      setVenueById(vMap);
      setRows(data || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  function when(ts) {
    const d = new Date(ts);
    const days = Math.floor((Date.now() - d.getTime()) / (24 * 60 * 60 * 1000));
    if (days === 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 7) return `${days}d ago`;
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  }

  return (
    <div className="fixed inset-0 z-[2500] overflow-y-auto bg-[#fdf6f0]">
      <div className="mx-auto w-full max-w-sm p-4 pb-24">
        <div className="mb-5 flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white border border-neutral-100 text-neutral-600"
          >
            <ArrowLeft size={16} />
          </button>
          <div>
            <p className="text-sm text-neutral-500">Your check-ins</p>
            <h1 className="text-2xl font-semibold tracking-tight">Been</h1>
          </div>
        </div>

        {rows === null && (
          <p className="text-sm text-neutral-500 text-center py-8">Loading…</p>
        )}
        {rows !== null && rows.length === 0 && (
          <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 text-center">
            <p className="text-sm text-neutral-600">Nowhere yet.</p>
            <p className="text-xs text-neutral-500 mt-1">
              Check in when you're out — every spot lands here.
            </p>
          </div>
        )}
        <div className="space-y-2">
          {(rows || []).map((r) => {
            const venue = venueById.get(r.venue_id) || null;
            return (
              <button
                key={r.id}
                type="button"
                onClick={() =>
                  setThread({
                    activityId: r.id,
                    ownerId: userId,
                    ownerName: "You",
                    ownerProfile: null,
                    venueName: venue?.name || "a spot",
                    label: r.label || null,
                    venueObj: venue,
                    timestamp: r.created_at,
                  })
                }
                className="w-full rounded-2xl bg-white border border-neutral-100 p-3 flex items-center gap-3 text-left hover:bg-neutral-50 active:scale-[0.99] transition"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b]">
                  <MapPin size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-neutral-900 truncate">
                    {venue?.name || "A spot"}
                    {r.label ? (
                      <span className="font-normal text-neutral-500"> · {r.label}</span>
                    ) : null}
                  </p>
                  <p className="text-[11px] text-neutral-500">{when(r.created_at)}</p>
                </div>
                <span className="text-neutral-400 text-lg leading-none shrink-0">›</span>
              </button>
            );
          })}
        </div>
      </div>
      {thread && (
        <CheckinThreadSheet
          thread={thread}
          userId={userId}
          onClose={() => setThread(null)}
          onOpenVenue={(v) => {
            setThread(null);
            setSelectedVenue(v);
          }}
        />
      )}
      {selectedVenue && (
        <MapVenueSheet
          venue={selectedVenue}
          onClose={() => setSelectedVenue(null)}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
        />
      )}
    </div>
  );
}
