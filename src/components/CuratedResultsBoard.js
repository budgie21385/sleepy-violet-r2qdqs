// Host's results board for a curated ("Send my options") session: shortlist
// venues ranked by guest votes (live-polled), a TOP PICK badge for a clear
// leader, multi-select + bulk save-to-list, tap a row to open its card, and
// "We're going here" to lock a decision. Reused read-only in Your Sessions.
// Extracted from App.js.
import { useState, useEffect, useMemo } from "react";
import { supabase } from "../supabaseClient";
import { Check } from "lucide-react";
import { ParticipantsStrip } from "./ParticipantsStrip";
import { MapVenueSheet } from "./MapVenueSheet";

export function CuratedResultsBoard({ sessionId, venues, hostUserId, userId, onDone, showToast, canDecide = true, savedIds, onSave, onUnsave, onHide, onOpenProfile }) {
  const [results, setResults] = useState(null);
  const [venueRows, setVenueRows] = useState([]);
  const [names, setNames] = useState({});
  const [participantsList, setParticipantsList] = useState([]);
  const [decidedVenueId, setDecidedVenueId] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [detailVenue, setDetailVenue] = useState(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    async function load(initial) {
      if (initial) setLoading(true);
      const [resRpc, venuesRpc, partsRpc, sessRpc] = await Promise.all([
        supabase.rpc("get_curated_results", { p_session_id: sessionId }),
        supabase.rpc("get_session_shortlist_venues", { p_session_id: sessionId }),
        supabase
          .from("session_participants")
          .select("user_id, display_name")
          .eq("session_id", sessionId),
        supabase
          .from("match_sessions")
          .select("decided_venue_id")
          .eq("id", sessionId)
          .single(),
      ]);
      if (cancelled) return;
      if (resRpc.error) console.error("get_curated_results failed:", resRpc.error);
      setResults(resRpc.data || []);
      setVenueRows(venuesRpc.data || []);
      const nameMap = {};
      (partsRpc.data || []).forEach((p) => {
        if (p.user_id !== hostUserId) nameMap[p.user_id] = p.display_name || "Friend";
      });
      setNames(nameMap);
      setParticipantsList(partsRpc.data || []);
      if (initial) setDecidedVenueId(sessRpc.data?.decided_venue_id ?? null);
      if (initial) setLoading(false);
    }
    load(true);
    // Poll so guest votes appear live without leaving/reopening the board.
    const pollId = setInterval(() => load(false), 5000);
    return () => {
      cancelled = true;
      clearInterval(pollId);
    };
  }, [sessionId, hostUserId]);

  // Venue details come from the shortlist RPC (bypasses venues RLS so
  // host-imported venues resolve for guests too); fall back to the venues prop.
  const venueById = useMemo(() => {
    const m = {};
    (venues || []).forEach((v) => {
      m[v.id] = v;
    });
    (venueRows || []).forEach((v) => {
      m[v.id] = v;
    });
    return m;
  }, [venues, venueRows]);

  async function decide(venueId) {
    setDeciding(true);
    const { error } = await supabase.rpc("set_curated_decision", {
      p_session_id: sessionId,
      p_venue_id: venueId,
    });
    setDeciding(false);
    if (error) {
      console.error("set_curated_decision failed:", error);
      if (showToast) showToast("Couldn't save — try again");
      return;
    }
    setDecidedVenueId(venueId);
    if (showToast) showToast("Locked it in");
    // Pop the venue card so the picker (and viewers) see the spot + can share it.
    const v = venueById[venueId];
    if (v) setDetailVenue(v);
  }

  if (loading) {
    return (
      <div className="flex-1 p-8 text-center text-sm text-neutral-500">
        Loading results…
      </div>
    );
  }

  const list = results || [];
  const topCount = list.length ? list[0].vote_count : 0;
  // Badge a "top pick" only when ONE venue holds the lead. A single venue on
  // 1 vote (others on 0) is a clear winner → badge. A multi-way tie at the top
  // (e.g. everything on 1) has no standout → no badge.
  const leaderCount = list.filter((r) => r.vote_count === topCount).length;
  const hasClearLeader = topCount > 0 && leaderCount === 1;

  // Only rows whose venue resolved (RPC rows merged into venueById).
  const rows = list
    .map((r) => ({ r, v: venueById[r.venue_id] }))
    .filter((x) => x.v);

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allSelected = rows.length > 0 && rows.every((x) => selectedIds.has(x.v.id));
  const someSelected = !allSelected && rows.some((x) => selectedIds.has(x.v.id));
  function toggleSelectAll() {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((x) => x.v.id)));
  }
  function bulkSave() {
    for (const id of selectedIds) {
      if (!savedIds?.has(id)) onSave(id);
    }
    setSelectedIds(new Set());
  }
  const newSelectionCount = Array.from(selectedIds).filter(
    (id) => !savedIds?.has(id)
  ).length;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-4 -mx-4">
        <ParticipantsStrip
          participants={participantsList}
          userId={userId}
          hostUserId={hostUserId}
          onOpenProfile={onOpenProfile}
          showToast={showToast}
        />
      </div>
      {decidedVenueId && (
        <div className="mb-4 rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-[#455d3b]">
            You're going to
          </p>
          <p className="mt-1 text-lg font-semibold text-[#2f3f29]">
            {venueById[decidedVenueId]?.name || "your pick"}
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm border border-neutral-100">
          <p className="text-sm text-neutral-600">
            No shortlist yet — add some places first.
          </p>
        </div>
      ) : (
        <>
          {/* Select-all + bulk save (mirrors the Right Now results view) */}
          {onSave && (
            <div className="mb-3 flex items-center gap-3">
              <button
                type="button"
                onClick={toggleSelectAll}
                aria-label={allSelected ? "Deselect all" : "Select all"}
                className={`flex h-5 w-5 items-center justify-center rounded border shrink-0 transition ${
                  allSelected
                    ? "bg-[#455d3b] border-[#455d3b] text-white"
                    : someSelected
                    ? "bg-[#455d3b]/40 border-[#455d3b]/40 text-white"
                    : "bg-white border-neutral-300"
                }`}
              >
                {(allSelected || someSelected) && <Check size={14} />}
              </button>
              <button
                type="button"
                onClick={bulkSave}
                disabled={selectedIds.size === 0 || newSelectionCount === 0}
                className="rounded-full bg-[#455d3b] px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {selectedIds.size === 0
                  ? "Save to my list"
                  : newSelectionCount === 0
                  ? `${selectedIds.size} already saved`
                  : `Save ${newSelectionCount} to my list`}
              </button>
            </div>
          )}

          <ul className="space-y-2">
            {rows.map(({ r, v }) => {
              const isTop = hasClearLeader && r.vote_count === topCount;
              const isDecided = decidedVenueId === r.venue_id;
              const isSelected = selectedIds.has(v.id);
              const voterNames = (r.voter_user_ids || []).map(
                (id) => names[id] || "Friend"
              );
              return (
                <li key={r.venue_id}>
                  <div
                    className={`flex items-start gap-3 rounded-2xl bg-white p-3 border ${
                      isDecided
                        ? "border-[#455d3b] ring-1 ring-[#455d3b]"
                        : isTop
                        ? "border-[#cdd9c6]"
                        : "border-neutral-100"
                    }`}
                  >
                    {onSave && (
                      <button
                        type="button"
                        onClick={() => toggleSelected(v.id)}
                        aria-label={isSelected ? "Deselect" : "Select"}
                        className={`flex h-5 w-5 items-center justify-center rounded border shrink-0 mt-1 transition ${
                          isSelected
                            ? "bg-[#455d3b] border-[#455d3b] text-white"
                            : "bg-white border-neutral-300"
                        }`}
                      >
                        {isSelected && <Check size={14} />}
                      </button>
                    )}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailVenue(v)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDetailVenue(v);
                        }
                      }}
                      className="flex-1 min-w-0 cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{v.name}</p>
                        {isTop && (
                          <span className="shrink-0 text-[10px] uppercase tracking-wide bg-[#edf2eb] text-[#455d3b] rounded-full px-2 py-0.5">
                            Top pick
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-neutral-500 truncate">
                        {r.vote_count === 0
                          ? "No votes yet"
                          : `${r.vote_count} vote${r.vote_count === 1 ? "" : "s"}${
                              voterNames.length ? " · " + voterNames.join(", ") : ""
                            }`}
                      </p>
                      <p className="text-xs text-neutral-500 truncate">
                        {v.type}
                        {v.suburb ? ` · ${v.suburb}` : ""}
                        {v.rating ? ` · ⭐ ${v.rating}` : ""}
                      </p>
                    </div>
                    {canDecide ? (
                      <button
                        type="button"
                        disabled={deciding || isDecided}
                        onClick={() => decide(r.venue_id)}
                        className={`shrink-0 self-center rounded-xl px-3 py-2 text-sm font-medium transition ${
                          isDecided
                            ? "bg-[#455d3b] text-white"
                            : "bg-[#edf2eb] text-[#455d3b] active:scale-[0.98]"
                        } disabled:opacity-60`}
                      >
                        {isDecided ? "Going ✓" : "We're going here"}
                      </button>
                    ) : isDecided ? (
                      <span className="shrink-0 self-center rounded-xl px-3 py-2 text-sm font-medium bg-[#455d3b] text-white">
                        Going ✓
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <button
        type="button"
        onClick={onDone}
        className="mt-6 w-full rounded-2xl bg-neutral-100 py-3 font-medium text-neutral-700"
      >
        Done
      </button>

      {detailVenue && (
        <MapVenueSheet
          venue={detailVenue}
          onClose={() => setDetailVenue(null)}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
        />
      )}
    </div>
  );
}
