// Been — your own check-in history, the memory ledger (Profile → Been).
// Rows: venue · label · when; tapping a row opens the CHECK-IN (its own
// object: label, companions, thread) — the venue card is one tap deeper via
// the venue name inside the thread. Extracted from App.js (July 13, 2026).
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, MapPin } from "lucide-react";
import { supabase } from "../supabaseClient";
import { whenAgo } from "../lib/checkins";
import { MapVenueSheet } from "./MapVenueSheet";
import { CheckinThreadSheet } from "./CheckinThreadSheet";

// Same /api/add-venue caller as AddVenueSheet — the add-a-night search
// falls back to Google for places not on Flanit (July 25, Mark: "I want to
// add the cinema I went to yesterday and it won't come up").
async function callAddVenueApi(body) {
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

export function BeenScreen({ userId, savedIds, onSave, onUnsave, onHide, onBack, showToast, onOpenProfile }) {
  const [rows, setRows] = useState(null); // null = loading
  const [venueById, setVenueById] = useState(() => new Map());
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
  const [addVenue, setAddVenue] = useState(null);
  const [addDate, setAddDate] = useState(() =>
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
  const [addSaving, setAddSaving] = useState(false);
  const todayStr = new Date().toISOString().slice(0, 10);

  const [addGoogle, setAddGoogle] = useState([]); // Google fallback rows
  const [addingPlaceId, setAddingPlaceId] = useState(null);

  useEffect(() => {
    if (!addOpen) return;
    const q = addQ.trim();
    if (q.length < 2) {
      setAddResults([]);
      setAddGoogle([]);
      return;
    }
    const t = setTimeout(async () => {
      // Pool + Google in parallel — cinemas, bowling alleys, someone's
      // favourite kebab van: anywhere counts as a place you were.
      const [dbRes, gRes] = await Promise.all([
        supabase.from("venues").select("*").ilike("name", `%${q}%`).limit(12),
        callAddVenueApi({ action: "search", q }).catch(() => ({
          results: [],
        })),
      ]);
      const dbRows = dbRes.data || [];
      const knownPlaceIds = new Set(
        dbRows.map((v) => v.google_place_id).filter(Boolean)
      );
      setAddResults(dbRows);
      setAddGoogle(
        (gRes.results || []).filter((r) => !knownPlaceIds.has(r.place_id))
      );
    }, 250);
    return () => clearTimeout(t);
  }, [addQ, addOpen]);

  // Google pick: create the venue row WITHOUT saving it to their list
  // (Timber Yard rule — being somewhere ≠ curating it), then flow into the
  // normal date step.
  async function pickGooglePlace(r) {
    if (addingPlaceId) return;
    setAddingPlaceId(r.place_id);
    try {
      const { venue } = await callAddVenueApi({
        action: "add",
        placeId: r.place_id,
        save: false,
      });
      setAddVenue(venue);
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
    setAddVenue(null);
    setAddSaving(false);
  }

  async function confirmAddNight() {
    if (!addVenue || !addDate || addSaving) return;
    setAddSaving(true);
    // Land it at 8pm local — squarely inside the ±12h same-night window.
    // Picking TODAY before 8pm would timestamp the future → clamp to an hour
    // ago (also keeps a genuine tonight-pick reading as recent, not phantom).
    let ts = new Date(`${addDate}T20:00:00`);
    if (ts.getTime() > Date.now()) ts = new Date(Date.now() - 60 * 60 * 1000);
    const W = 12 * 60 * 60 * 1000;
    // Already have a check-in that night? Open it instead of a dupe twin.
    const { data: existing } = await supabase
      .from("activities")
      .select("id, created_at, label")
      .eq("user_id", userId)
      .eq("venue_id", addVenue.id)
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
          venue_id: addVenue.id,
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
      setVenueById((prev) => new Map(prev).set(addVenue.id, addVenue));
      setRows((prev) =>
        [
          {
            id: act.id,
            venue_id: addVenue.id,
            label: act.label || null,
            created_at: act.created_at,
          },
          ...(prev || []),
        ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      );
    }
    const picked = addVenue;
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
      setRows(data || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, reloadTick]);

  const when = whenAgo; // shared ladder — see lib/checkins

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
                  <p className="text-[11px] text-neutral-500">
                    {when(r.created_at)}
                    {(() => {
                      const names = withByAct.get(r.id);
                      if (!names || names.length === 0) return null;
                      const who =
                        names.length === 1
                          ? names[0]
                          : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
                      return ` · with ${who}`;
                    })()}
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
              Where were you?
            </label>
            {!addVenue ? (
              <>
                <input
                  value={addQ}
                  onChange={(e) => setAddQ(e.target.value)}
                  placeholder="Search for the place"
                  className="w-full rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b]"
                />
                <div className="mt-2 space-y-1">
                  {addResults.map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setAddVenue(v)}
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
                  {addQ.trim().length >= 2 &&
                    addResults.length === 0 &&
                    addGoogle.length === 0 && (
                      <p className="text-xs text-neutral-400 px-2 py-2">
                        Nothing by that name — check the spelling?
                      </p>
                    )}
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2.5 rounded-xl bg-neutral-50 px-3 py-2.5">
                <MapPin size={15} className="shrink-0 text-[#455d3b]" />
                <span className="flex-1 min-w-0 truncate text-sm font-medium text-neutral-900">
                  {addVenue.name}
                </span>
                <button
                  type="button"
                  onClick={() => setAddVenue(null)}
                  className="text-xs text-neutral-500 underline shrink-0"
                >
                  Change
                </button>
              </div>
            )}

            <label className="mt-3 block text-[11px] font-medium text-neutral-500 mb-1 px-1">
              Which night?
            </label>
            {/* appearance-none + explicit bg: iOS restyles date inputs
                into a gray centered pill otherwise. */}
            <input
              type="date"
              value={addDate}
              max={todayStr}
              onChange={(e) => setAddDate(e.target.value)}
              className="w-full appearance-none bg-white text-left rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b] mb-3"
            />
            <button
              type="button"
              disabled={addSaving || !addVenue || !addDate}
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
