// Been — your own check-in history, the memory ledger (Profile → Been).
// Rows: venue · label · when; tapping a row opens the CHECK-IN (its own
// object: label, companions, thread) — the venue card is one tap deeper via
// the venue name inside the thread. Extracted from App.js (July 13, 2026).
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
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
  const [withByAct, setWithByAct] = useState(() => new Map()); // activityId → first names
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [thread, setThread] = useState(null);
  // "+ Add a night" — backdated check-in for a night you didn't check in.
  // The cluster merge does the magic afterwards: if friends checked in that
  // night, your backdated card shows their photos/comments too.
  const [addOpen, setAddOpen] = useState(false);
  const [addQ, setAddQ] = useState("");
  const [addResults, setAddResults] = useState([]);
  const [addVenue, setAddVenue] = useState(null);
  const [addDate, setAddDate] = useState(() =>
    new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  );
  const [addSaving, setAddSaving] = useState(false);
  const todayStr = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (!addOpen) return;
    const q = addQ.trim();
    if (q.length < 2) {
      setAddResults([]);
      return;
    }
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("venues")
        .select("*")
        .ilike("name", `%${q}%`)
        .limit(12);
      setAddResults(data || []);
    }, 250);
    return () => clearTimeout(t);
  }, [addQ, addOpen]);

  function closeAdd() {
    setAddOpen(false);
    setAddQ("");
    setAddResults([]);
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
    let act = existing?.[0] || null;
    if (!act) {
      const { data: inserted, error } = await supabase
        .from("activities")
        .insert({
          user_id: userId,
          kind: "checkin",
          venue_id: addVenue.id,
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
            label: null,
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
        const { data: tags } = await supabase
          .from("activity_tags")
          .select("activity_id, tagged_user_id, status")
          .in("activity_id", actIds)
          .neq("status", "removed");
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
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="ml-auto rounded-full bg-[#455d3b] text-white text-xs font-medium px-3.5 py-2 active:scale-95 transition"
          >
            + Add a night
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
              <p className="text-sm font-semibold">Add a past night</p>
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
            {!addVenue ? (
              <>
                {/* text-base: sub-16px inputs make iOS Safari auto-zoom. */}
                <input
                  value={addQ}
                  onChange={(e) => setAddQ(e.target.value)}
                  placeholder="Where were you?"
                  autoFocus
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
                  {addQ.trim().length >= 2 && addResults.length === 0 && (
                    <p className="text-xs text-neutral-400 px-2 py-2">
                      Nothing on Flanit by that name yet.
                    </p>
                  )}
                </div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2.5 rounded-xl bg-neutral-50 px-3 py-2.5 mb-3">
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
                <label className="block text-[11px] font-medium text-neutral-500 mb-1 px-1">
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
                  disabled={addSaving || !addDate}
                  onClick={confirmAddNight}
                  className="w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white active:scale-[0.99] transition disabled:opacity-60"
                >
                  {addSaving ? "Adding…" : "Add to Been"}
                </button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
      {thread && (
        <CheckinThreadSheet
          thread={thread}
          userId={userId}
          onClose={() => setThread(null)}
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
          zIndex={3700}
        />
      )}
    </div>
  );
}
