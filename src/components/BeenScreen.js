// Been — your own check-in history, the memory ledger (Profile → Been).
// Rows: venue · label · when; tapping a row opens the CHECK-IN (its own
// object: label, companions, thread) — the venue card is one tap deeper via
// the venue name inside the thread. Extracted from App.js (July 13, 2026).
import { useState, useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, MapPin, Home } from "lucide-react";
import { supabase } from "../supabaseClient";
import { whenAgo } from "../lib/checkins";
import {
  searchPlaces,
  addGooglePlace,
  createPersonalPlace,
} from "../lib/venueSearch";
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

export function BeenScreen({ userId, savedIds, onSave, onUnsave, onHide, onBack, showToast, onOpenProfile }) {
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
  // "+ Add a past check-in" — backdated check-in for a night you didn't check in.
  // The cluster merge does the magic afterwards: if friends checked in that
  // night, your backdated card shows their photos/comments too.
  const [addOpen, setAddOpen] = useState(false);
  // Title leads the form (Mark, July 31): people recall a night by what it was
  // — "Renasha's birthday" — before they recall the address. Optional, because
  // most nights are an ordinary Tuesday that doesn't deserve a name; the venue
  // + date identify those on their own.
  const [addLabel, setAddLabel] = useState("");
  const [addQ, setAddQ] = useState("");
  const [addResults, setAddResults] = useState([]);
  // A night can span several places (Mark, July 31: "This was the night and we
  // went here, here and here"). Ordered — index 0 is where it started, and the
  // rest become legs hanging off it via joined_from. `addSearching` is whether
  // a search box is currently open; it starts true so the empty form shows one.
  const [addVenues, setAddVenues] = useState([]);
  const [addSearching, setAddSearching] = useState(true);
  const [addDate, setAddDate] = useState(() =>
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
  const [addSaving, setAddSaving] = useState(false);
  const todayStr = new Date().toISOString().slice(0, 10);

  const [addGoogle, setAddGoogle] = useState([]); // Google fallback rows
  const [addingPlaceId, setAddingPlaceId] = useState(null);
  // Tapping out of the search box means "I've finished typing" — the personal
  // place option steps forward at that point (Mark, July 31: the "not a venue"
  // row was too easy to read as a footnote).
  const [addBlurred, setAddBlurred] = useState(false);

  useEffect(() => {
    if (!addOpen) return;
    const q = addQ.trim();
    if (q.length < 2) {
      setAddResults([]);
      setAddGoogle([]);
      return;
    }
    const t = setTimeout(async () => {
      // Pool + Google — cinemas, bowling alleys, someone's favourite kebab
      // van: anywhere counts as a place you were. Shared with the card's
      // "somewhere else" search (lib/venueSearch).
      const { venues, google } = await searchPlaces(q, userId);
      setAddResults(venues);
      setAddGoogle(google);
    }, 250);
    return () => clearTimeout(t);
  }, [addQ, addOpen]);

  // Add a picked place to the trail and close the search box. Ignores a repeat
  // of somewhere already in the list — the same bar twice in one night is real,
  // but it's far more often a double tap.
  function pickVenue(v) {
    if (!v) return;
    setAddVenues((prev) => (prev.some((x) => x.id === v.id) ? prev : [...prev, v]));
    setAddSearching(false);
    setAddQ("");
    setAddResults([]);
    setAddGoogle([]);
  }

  // Google pick: create the venue row WITHOUT saving it to their list
  // (Timber Yard rule — being somewhere ≠ curating it), then into the trail.
  async function pickGooglePlace(r) {
    if (addingPlaceId) return;
    setAddingPlaceId(r.place_id);
    try {
      pickVenue(await addGooglePlace(r.place_id));
    } catch (e) {
      console.error("Google add-a-night pick failed:", e);
      showToast?.("Couldn't add that place");
    }
    setAddingPlaceId(null);
  }

  function closeAdd() {
    setAddOpen(false);
    setAddLabel("");
    setAddQ("");
    setAddResults([]);
    setAddGoogle([]);
    setAddingPlaceId(null);
    setAddVenues([]);
    setAddSearching(true);
    setAddSaving(false);
  }

  async function confirmAddNight() {
    const first = addVenues[0];
    if (!first || !addDate || addSaving) return;
    setAddSaving(true);
    // Land it at 8pm local — squarely inside the ±12h same-night window.
    // FUTURE dates are legitimate now (Aug 1, Mark — the old blanket clamp
    // silently converted a wedding-next-Friday into "an hour ago"): an
    // upcoming night is a real card, created ahead so the collect link and
    // QR exist before the event. Only a TODAY pick still clamps backward —
    // in the Been form, "today" means "earlier today", not "tonight".
    let ts = new Date(`${addDate}T20:00:00`);
    const isToday = addDate === new Date().toISOString().slice(0, 10);
    if (isToday && ts.getTime() > Date.now())
      ts = new Date(Date.now() - 60 * 60 * 1000);
    const W = 12 * 60 * 60 * 1000;
    // Already have a check-in that night? Open it instead of a dupe twin.
    const { data: existing } = await supabase
      .from("activities")
      .select("id, created_at, label")
      .eq("user_id", userId)
      .eq("venue_id", first.id)
      .eq("kind", "checkin")
      .gte("created_at", new Date(ts.getTime() - W).toISOString())
      .lte("created_at", new Date(ts.getTime() + W).toISOString())
      .limit(1);
    const label = addLabel.trim() || null;
    let act = existing?.[0] || null;
    // Reopening a night you already logged: give it the title if you've just
    // typed one and it had none. Never overwrite an existing label — that's
    // yours from the card, and a half-typed retry shouldn't clobber it.
    if (act && label && !act.label) {
      const { error: lblErr } = await supabase
        .from("activities")
        .update({ label })
        .eq("id", act.id);
      if (lblErr) console.error("Add night label update failed:", lblErr);
      else act = { ...act, label };
    }
    if (!act) {
      const { data: inserted, error } = await supabase
        .from("activities")
        .insert({
          user_id: userId,
          kind: "checkin",
          venue_id: first.id,
          label,
          created_at: ts.toISOString(),
        })
        .select("id, created_at, label")
        .single();
      if (error) {
        console.error("Add night failed:", error);
        setAddSaving(false);
        return;
      }
      act = inserted;
      // Surface it in the list immediately.
      setVenueById((prev) => new Map(prev).set(first.id, first));
      setRows((prev) =>
        [
          {
            id: act.id,
            venue_id: first.id,
            label: act.label || null,
            created_at: act.created_at,
          },
          ...(prev || []),
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      );
    }

    // The rest of the trail: one check-in per place, each pointing at the root
    // through joined_from. That's the SAME edge a tag-accept twin uses, so the
    // cluster merge folds them into one card with one album and one guest list
    // for free — no new visibility rules (Mark, July 31: "one night, one guest
    // list"). Each leg is still its own row, so Been and the map get a proper
    // entry per place: you did go to three places.
    //
    // Spaced an hour apart from the root so the trail keeps its order and the
    // whole night stays inside the ±12h window the cluster works in.
    const rest = addVenues.slice(1);
    if (rest.length > 0) {
      const legs = rest.map((v, i) => ({
        user_id: userId,
        kind: "checkin",
        venue_id: v.id,
        label: null, // the title belongs to the night, i.e. the root
        joined_from: act.id,
        created_at: new Date(
          new Date(act.created_at).getTime() + (i + 1) * 60 * 60 * 1000
        ).toISOString(),
      }));
      const { data: legRows, error: legErr } = await supabase
        .from("activities")
        .insert(legs)
        .select("id, venue_id, created_at, label");
      if (legErr) {
        // The night itself exists — don't strand the user on a half-failure.
        console.error("Add night legs failed:", legErr);
        showToast?.("Added the night, but some places didn't save");
      } else if (legRows?.length) {
        setVenueById((prev) => {
          const next = new Map(prev);
          rest.forEach((v) => next.set(v.id, v));
          return next;
        });
        setRows((prev) =>
          [...legRows, ...(prev || [])].sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at)
          )
        );
      }
    }

    const picked = first;
    closeAdd();
    setThread({
      activityId: act.id,
      ownerId: userId,
      ownerName: "You",
      ownerProfile: null,
      venueName: picked.name,
      label: act.label || null,
      venueObj: picked,
      timestamp: act.created_at,
    });
  }

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
  }, [userId, reloadTick]);

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
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="ml-auto rounded-full bg-[#455d3b] text-white text-xs font-medium px-3.5 py-2 active:scale-95 transition"
          >
            + Add a past check-in
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
      {addOpen &&
        // PORTALED to body: inside BeenScreen's fixed z-2500 container this
        // overlay's z only counted locally, so the root-level +FAB (z-3060)
        // still drew over it (Mark's report). Floating card anchored HIGH so
        // the iOS keyboard opens beneath the search input.
        createPortal(
        <div className="fixed inset-0 z-[4000]">
          <button
            type="button"
            aria-label="Close"
            onClick={closeAdd}
            className="absolute inset-0 bg-black/40"
          />
          <div
            className="absolute left-0 right-0 top-12 mx-auto max-w-sm bg-white rounded-3xl shadow-2xl overflow-y-auto p-5"
            style={{
              width: "calc(100% - 1.5rem)",
              maxHeight: "calc(100% - 130px)",
            }}
          >
            <div className="flex items-start justify-between mb-1">
              <p className="text-sm font-semibold">Add a past check-in</p>
              <button
                type="button"
                aria-label="Close"
                onClick={closeAdd}
                className="-mt-1 -mr-1 w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-100"
              >
                ✕
              </button>
            </div>
            <p className="text-[11px] text-neutral-500 mb-3">
              It lands in your Been list — add photos and videos after. If
              friends checked in that night, their moments show up too.
            </p>
            {/* ONE card, three fields in order (Mark, July 31): title, then
                location, then date. It used to be two steps — find the venue,
                then pick a night — which asked for the hardest thing first and
                never asked for a name at all (the label arrived later, from the
                card). No autoFocus anywhere: an unrequested keyboard shoves the
                rest of the form off-screen. */}
            <label className="block text-[11px] font-medium text-neutral-500 mb-1 px-1">
              What was it?
            </label>
            {/* text-base: sub-16px inputs make iOS Safari auto-zoom. */}
            <input
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              placeholder="Renasha's birthday (optional)"
              maxLength={80}
              className="w-full rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b] mb-3"
            />

            <label className="block text-[11px] font-medium text-neutral-500 mb-1 px-1">
              {addVenues.length > 1 ? "Where did you go?" : "Where were you?"}
            </label>
            {/* Picked places, in order — the night's trail. Each can be pulled
                back out; the search box reopens on "Add another location". */}
            {addVenues.map((v, i) => (
              <div
                key={v.id}
                className="flex items-center gap-2.5 rounded-xl bg-neutral-50 px-3 py-2.5 mb-1.5"
              >
                <MapPin size={15} className="shrink-0 text-[#455d3b]" />
                <span className="flex-1 min-w-0 truncate text-sm font-medium text-neutral-900">
                  {v.name}
                </span>
                {i > 0 && (
                  <span className="text-[11px] text-neutral-400 shrink-0">
                    then
                  </span>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${v.name}`}
                  onClick={() =>
                    setAddVenues((prev) => prev.filter((x) => x.id !== v.id))
                  }
                  className="text-xs text-neutral-500 underline shrink-0"
                >
                  Remove
                </button>
              </div>
            ))}
            {!addSearching ? (
              <button
                type="button"
                onClick={() => setAddSearching(true)}
                className="mt-1 mb-1 text-xs text-[#455d3b] underline underline-offset-2"
              >
                + Add another location
              </button>
            ) : (
              <>
                <input
                  value={addQ}
                  onChange={(e) => {
                    setAddQ(e.target.value);
                    setAddBlurred(false);
                  }}
                  onBlur={() => setAddBlurred(true)}
                  placeholder="Search for the place, or type your own"
                  className="w-full rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b]"
                />
                {addVenues.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setAddSearching(false);
                      setAddQ("");
                      setAddResults([]);
                      setAddGoogle([]);
                    }}
                    className="mt-1.5 text-xs text-neutral-500 underline underline-offset-2"
                  >
                    Cancel
                  </button>
                )}
                <div className="mt-2 space-y-1">
                  {addResults.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => pickVenue(v)}
                      className="w-full flex items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-neutral-50 active:scale-[0.99] transition"
                    >
                      <MapPin size={15} className="shrink-0 text-neutral-400" />
                      <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                        {v.name}
                      </span>
                      {v.suburb && (
                        <span className="text-[11px] text-neutral-400 shrink-0">
                          {v.suburb}
                        </span>
                      )}
                    </button>
                  ))}
                  {addGoogle.length > 0 && (
                    <>
                      <p className="px-2 pt-2 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                        More places
                      </p>
                      {addGoogle.map((r) => (
                        <button
                          key={r.place_id}
                          type="button"
                          disabled={!!addingPlaceId}
                          onClick={() => pickGooglePlace(r)}
                          className="w-full flex items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-neutral-50 active:scale-[0.99] transition disabled:opacity-50"
                        >
                          <MapPin size={15} className="shrink-0 text-neutral-300" />
                          <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                            {r.name}
                          </span>
                          <span className="text-[11px] text-neutral-400 shrink-0 truncate max-w-[110px]">
                            {addingPlaceId === r.place_id
                              ? "Adding…"
                              : r.address || ""}
                          </span>
                        </button>
                      ))}
                    </>
                  )}
                  {/* Not everywhere is a venue (Mark, July 31: "what if we
                      want it to be a random place, like Mark's place"). Its own
                      block rather than a row in the results, because it isn't
                      the same kind of thing — a name with no address and no pin
                      shouldn't queue up next to real venues as if it were one.
                      Emphasised once they tap out of the field: at that point
                      they've said what they meant and nothing matched it. */}
                  {addQ.trim().length >= 2 && (
                    <div
                      className={`mt-2 rounded-xl border p-2.5 transition ${
                        addBlurred && addResults.length === 0
                          ? "border-[#455d3b] bg-[#edf2eb]"
                          : "border-neutral-200 bg-white"
                      }`}
                    >
                      <button
                        type="button"
                        disabled={addingPlaceId === "personal"}
                        onClick={async () => {
                          setAddingPlaceId("personal");
                          const v = await createPersonalPlace(addQ, userId);
                          setAddingPlaceId(null);
                          if (v) pickVenue(v);
                          else showToast?.("Couldn't add that place");
                        }}
                        className="w-full flex items-center gap-2.5 text-left active:scale-[0.99] transition disabled:opacity-50"
                      >
                        <Home size={15} className="shrink-0 text-[#455d3b]" />
                        <span className="flex-1 min-w-0 truncate text-sm font-medium text-neutral-900">
                          {addingPlaceId === "personal"
                            ? "Adding…"
                            : `Use "${addQ.trim()}"`}
                        </span>
                      </button>
                      <p className="mt-1 pl-[25px] text-[11px] leading-snug text-neutral-500">
                        A place of your own — just a name. No address, and it
                        won't appear on the map.
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}

            <label className="mt-3 block text-[11px] font-medium text-neutral-500 mb-1 px-1">
              Which night?
            </label>
            {/* No max — future dates create an UPCOMING night (Aug 1): the
                card exists ahead of the event so the photo link and QR can go
                out before anyone arrives. appearance-none + explicit bg: iOS
                restyles date inputs into a gray centered pill otherwise. */}
            <input
              type="date"
              value={addDate}
              onChange={(e) => setAddDate(e.target.value)}
              className="w-full appearance-none bg-white text-left rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b] mb-3"
            />
            {addDate > todayStr && (
              <p className="-mt-1 mb-3 px-1 text-[11px] text-[#455d3b]">
                Upcoming night — the card's ready now, so you can share the
                photo link before the day.
              </p>
            )}
            <button
              type="button"
              disabled={addSaving || addVenues.length === 0 || !addDate}
              onClick={confirmAddNight}
              className="w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white active:scale-[0.99] transition disabled:opacity-60"
            >
              {addSaving ? "Adding…" : "Add to Been"}
            </button>
          </div>
        </div>,
        document.body
      )}
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
