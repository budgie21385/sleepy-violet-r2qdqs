// Been — your own check-in history, the memory ledger (Profile → Been).
// Rows: venue · label · when; tapping a row opens the CHECK-IN (its own
// object: label, companions, thread) — the venue card is one tap deeper via
// the venue name inside the thread. Extracted from App.js (July 13, 2026).
// The add-night FORM left this file in Aug's overlay refactor — it lives in
// components/CheckinForm.js now, mounted at App level so it can overlay any
// page (Mark: "It should stay on the same page you are on"). This screen is
// purely the list; "+ Add" calls up through onAddNight.
import { useState, useEffect, useMemo } from "react";
import { ArrowLeft, MapPin } from "lucide-react";
import { supabase } from "../supabaseClient";
import { whenAgo } from "../lib/checkins";
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
      {/* Title first, venue second — same rule as the Been list. */}
      <p className="flex-1 min-w-0 text-sm text-neutral-700 truncate">
        {c.label || c.venueName}
        {c.label ? (
          <span className="text-neutral-500"> · {c.venueName}</span>
        ) : null}
      </p>
      <span className="text-xs text-neutral-400">{when}</span>
    </div>
  );
}

export function BeenScreen({ userId, savedIds, onSave, onUnsave, onHide, onBack, showToast, onOpenProfile, onAddNight, refreshSignal = 0 }) {
  const [rows, setRows] = useState(null); // null = loading
  const [venueById, setVenueById] = useState(() => new Map());
  // NIGHTS vs PLACES (July 31, Mark: "more of a list of locations rather than
  // your events... something you checked into and added photos should be
  // separate from the been list"). Nights = the event history (grouped by
  // night, trails, companions). Places = the deduped location list: every
  // venue you've visited or marked, one row each, no dates or people.
  const beenView = "nights"; // pinned — see the pulled-toggle note below
  const [beenMarkIds, setBeenMarkIds] = useState(() => new Set());
  const [withByAct, setWithByAct] = useState(() => new Map()); // activityId → first names
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [thread, setThread] = useState(null);
  const [reloadTick, setReloadTick] = useState(0); // refetch after leave/changes


  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("activities")
        .select("id, venue_id, label, created_at, joined_from")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .order("created_at", { ascending: false })
        .limit(100);
      // Been marks ride the same load — the Places view unions them with
      // check-in venues, so marked-only places need their venue rows too.
      const { data: marks } = await supabase
        .from("been_marks")
        .select("venue_id")
        .eq("user_id", userId);
      const markIds = new Set((marks || []).map((m) => m.venue_id));
      // Resolve venues directly (not from the curated pool) — open venue
      // reads mean even a check-in at someone else's manual venue resolves.
      const ids = Array.from(
        new Set([...(data || []).map((r) => r.venue_id), ...markIds])
      );
      let vMap = new Map();
      if (ids.length > 0) {
        const { data: vens } = await supabase
          .from("venues")
          .select("*")
          .in("id", ids);
        vMap = new Map((vens || []).map((v) => [v.id, v]));
      }
      // "with John" — companions tagged on each check-in (pending + accepted
      // render, removed never does — same rule as the thread card).
      const wMap = new Map();
      const actIds = (data || []).map((r) => r.id);
      if (actIds.length > 0) {
        const { data: rawTags } = await supabase
          .from("activity_tags")
          .select("activity_id, tagged_user_id, status, requested_by")
          .in("activity_id", actIds)
          .neq("status", "removed");
        // Hide pending self-requests (join asks awaiting the owner).
        const tags = (rawTags || []).filter(
          (t) =>
            !(t.status === "pending" && t.requested_by === t.tagged_user_id)
        );
        const uids = Array.from(
          new Set((tags || []).map((t) => t.tagged_user_id))
        );
        if (uids.length > 0) {
          const { data: profs } = await supabase
            .from("profiles")
            .select("id, display_name")
            .in("id", uids);
          const nameById = Object.fromEntries(
            (profs || []).map((p) => [
              p.id,
              (p.display_name || "").split(" ")[0],
            ])
          );
          for (const t of tags || []) {
            const n = nameById[t.tagged_user_id];
            if (!n) continue;
            if (!wMap.has(t.activity_id)) wMap.set(t.activity_id, []);
            wMap.get(t.activity_id).push(n);
          }
        }
      }
      if (cancelled) return;
      setVenueById(vMap);
      setWithByAct(wMap);
      setBeenMarkIds(markIds);
      setRows(data || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, reloadTick, refreshSignal]);

  const when = whenAgo; // shared ladder — see lib/checkins

  // BEEN IS GROUPED BY NIGHT, NOT BY ROW (Mark, July 31: "there are now 2
  // check-in cards, one for venue 1 and one for venue 2"). A night that hopped
  // three venues is three activities rows — right for the map, wrong for a
  // history: it read as three separate nights.
  //
  // The group key is the row's root, walked through joined_from WITHIN the
  // loaded set. If the chain leaves the set — a tag-accept twin whose parent is
  // a friend's check-in — the key becomes that foreign id, which still groups
  // all your legs of that night together without needing to read their row.
  //
  // Known and accepted (Mark: "that edge case is fine"): your own check-in and
  // a leg you were tagged into that same night have different roots, so they
  // stay two entries. Linking them would mean inferring a night from time
  // proximity, which is the coincidence rule we deliberately don't use.
  const nights = useMemo(() => {
    if (!rows) return null;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const rootOf = (row) => {
      let cur = row;
      for (let hop = 0; hop < 6; hop++) {
        if (!cur.joined_from) return cur.id;
        const parent = byId.get(cur.joined_from);
        if (!parent) return cur.joined_from; // outside my rows — key on the id
        cur = parent;
      }
      return cur.id;
    };
    const groups = new Map();
    for (const r of rows) {
      const key = rootOf(r);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    return Array.from(groups.values())
      .map((legs) => {
        // Oldest first: that's the order the night actually happened in.
        const ordered = [...legs].sort(
          (a, b) => new Date(a.created_at) - new Date(b.created_at)
        );
        return {
          key: ordered[0].id,
          legs: ordered,
          // The title lives on the root; fall back to any leg that carries one.
          label: ordered.find((l) => l.label)?.label || null,
          startedAt: ordered[0].created_at,
        };
      })
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }, [rows]);

  // PLACES — one row per venue: visit count from check-ins, plus marked-only
  // venues at the end (they have no recency to sort by).
  const places = useMemo(() => {
    if (!rows) return null;
    const byVenue = new Map();
    for (const r of rows) {
      if (!r.venue_id) continue;
      const cur = byVenue.get(r.venue_id) || { visits: 0, lastAt: null };
      cur.visits += 1;
      if (!cur.lastAt || r.created_at > cur.lastAt) cur.lastAt = r.created_at;
      byVenue.set(r.venue_id, cur);
    }
    for (const vid of beenMarkIds) {
      if (!byVenue.has(vid)) byVenue.set(vid, { visits: 0, lastAt: null });
    }
    return Array.from(byVenue.entries())
      .map(([venueId, s]) => ({ venueId, ...s, venue: venueById.get(venueId) || null }))
      .sort((a, b) => {
        if (a.lastAt && b.lastAt) return new Date(b.lastAt) - new Date(a.lastAt);
        if (a.lastAt) return -1;
        if (b.lastAt) return 1;
        return (a.venue?.name || "").localeCompare(b.venue?.name || "");
      });
  }, [rows, beenMarkIds, venueById]);

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
          {/* Opens the ONE check-in form (App-level overlay). "Create a
              check-in", not "past" — the form does right-now and upcoming
              too (Mark, Aug 20). This was the second add button; the
              refactor rewired only the first — tapping this one threw on
              the deleted setAddOpen. */}
          <button
            type="button"
            onClick={() => onAddNight?.()}
            className="ml-auto rounded-full bg-[#455d3b] text-white text-xs font-medium px-3.5 py-2 active:scale-95 transition"
          >
            + Create a check-in
          </button>
        </div>

        {/* PLACES VIEW PULLED (July 31, Mark: the Been-list restructure is a
            conversation we haven't had — I built ahead of it). The `places`
            memo, the marks fetch and this render block stay dormant behind
            beenView, which is now pinned to "nights"; when the conversation
            happens, restoring the segmented toggle here re-enables it. */}
        {false && places !== null && (
          <div className="space-y-2">
            {places.length === 0 && (
              <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 text-center">
                <p className="text-sm text-neutral-600">No places yet.</p>
                <p className="text-xs text-neutral-500 mt-1">
                  Check in, or tap "Not been" on a venue you know.
                </p>
              </div>
            )}
            {places.map((p) => (
              <button
                key={p.venueId}
                type="button"
                disabled={!p.venue}
                onClick={() => p.venue && setSelectedVenue(p.venue)}
                className="w-full rounded-2xl bg-white border border-neutral-100 p-3 flex items-center gap-3 text-left hover:bg-neutral-50 active:scale-[0.99] transition disabled:opacity-60"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b]">
                  <MapPin size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-neutral-900 truncate">
                    {p.venue?.name || "A spot"}
                  </p>
                  <p className="text-[11px] text-neutral-500">
                    {p.visits >= 2
                      ? `Been ×${p.visits} · last ${when(p.lastAt)}`
                      : p.visits === 1
                        ? `Been · ${when(p.lastAt)}`
                        : "Been"}
                    {p.venue?.suburb ? ` · ${p.venue.suburb}` : ""}
                  </p>
                </div>
                <span className="text-neutral-400 text-lg leading-none shrink-0">›</span>
              </button>
            ))}
          </div>
        )}

        {beenView === "nights" && rows === null && (
          <p className="text-sm text-neutral-500 text-center py-8">Loading…</p>
        )}
        {beenView === "nights" && rows !== null && rows.length === 0 && (
          <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 text-center">
            <p className="text-sm text-neutral-600">Nowhere yet.</p>
            <p className="text-xs text-neutral-500 mt-1">
              Check in when you're out — every spot lands here.
            </p>
          </div>
        )}
        <div className="space-y-2">
          {beenView === "nights" &&
          (nights || []).map((n) => {
            const first = n.legs[0];
            const venue = venueById.get(first.venue_id) || null;
            // The trail, in order, duplicates collapsed — going back to the
            // first bar at 2am shouldn't print its name twice.
            const trail = [];
            for (const leg of n.legs) {
              const nm = venueById.get(leg.venue_id)?.name;
              if (nm && trail[trail.length - 1] !== nm) trail.push(nm);
            }
            // Companions are per-leg; the night shows everyone who was on any
            // part of it.
            const who = Array.from(
              new Set(n.legs.flatMap((l) => withByAct.get(l.id) || []))
            );
            return (
              <button
                key={n.key}
                type="button"
                onClick={() =>
                  setThread({
                    activityId: first.id,
                    ownerId: userId,
                    ownerName: "You",
                    ownerProfile: null,
                    venueName: venue?.name || "a spot",
                    label: n.label,
                    venueObj: venue,
                    timestamp: first.created_at,
                  })
                }
                className="w-full rounded-2xl bg-white border border-neutral-100 p-3 flex items-center gap-3 text-left hover:bg-neutral-50 active:scale-[0.99] transition"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b]">
                  <MapPin size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  {/* TITLE LEADS (Mark, July 31: "have a focus on the title if
                      it exists"). A named night is remembered by its name —
                      "Renasha's birthday", not "Napier Hotel". Where it
                      happened drops to the line below, which is also where a
                      multi-venue trail belongs: it's detail, not identity.
                      Untitled nights are unchanged — the trail is the name. */}
                  <p className="text-sm font-medium text-neutral-900 truncate flex items-center gap-1.5">
                    <span className="truncate">
                      {n.label || (trail.length > 0 ? trail.join(" → ") : "A spot")}
                    </span>
                    {new Date(n.startedAt).getTime() > Date.now() && (
                      <span className="shrink-0 rounded-full bg-[#edf2eb] border border-[#cdd9c6] px-2 py-0.5 text-[10px] font-medium text-[#3f5a3a]">
                        Upcoming
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] text-neutral-500 truncate">
                    {n.label && trail.length > 0 ? `${trail.join(" → ")} · ` : ""}
                    {when(first.created_at)}
                    {!n.label && trail.length > 1 ? ` · ${trail.length} places` : ""}
                    {who.length > 0
                      ? ` · with ${
                          who.length === 1
                            ? who[0]
                            : `${who.slice(0, -1).join(", ")} and ${who[who.length - 1]}`
                        }`
                      : ""}
                  </p>
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
          showToast={showToast}
          onClose={() => {
            setThread(null);
            setReloadTick((n) => n + 1); // rows may have changed (leave, tags)
          }}
          onOpenProfile={(uid) => {
            // Lookup renders above the card — keep it open unless self.
            if (uid === userId) setThread(null);
            onOpenProfile?.(uid);
          }}
          onOpenVenue={(v) => {
            // Thread stays open underneath; the venue card stacks above it.
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
          userId={userId}
          onOpenProfile={onOpenProfile}
          zIndex={3700}
        />
      )}
    </div>
  );
}
