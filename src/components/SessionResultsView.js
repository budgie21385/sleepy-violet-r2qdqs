// Concurrent ("Right now") session results: a Matches / My-likes toggle over the
// reconciled likes, multi-select bulk save-to-list, tap a row for its card, and
// the host's "We're going here" decision (shared decided_venue_id mechanism).
// Includes a one-shot confetti burst on the match reveal. Extracted from App.js.
import { useState, useEffect, useMemo, useRef } from "react";
import { supabase } from "../supabaseClient";
import { Check, Shuffle, CalendarDays } from "lucide-react";
import { ParticipantsStrip } from "./ParticipantsStrip";
import { MapVenueSheet } from "./MapVenueSheet";
import { PlanScheduler } from "./PlanScheduler";

export function ConfettiBurst() {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const colors = ["#455d3b", "#c5d4c2", "#fdb22d", "#f06292", "#5e60ce", "#fff"];
    const particles = [];
    const centerX = window.innerWidth / 2;
    const startY = window.innerHeight / 3;
    for (let i = 0; i < 140; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 12 + 6;
      particles.push({
        x: centerX,
        y: startY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 4,
        rotation: Math.random() * 360,
        vr: (Math.random() - 0.5) * 12,
        color: colors[Math.floor(Math.random() * colors.length)],
        w: Math.random() * 8 + 6,
        h: Math.random() * 4 + 3,
      });
    }
    let frame;
    const gravity = 0.35;
    const drag = 0.99;
    function tick() {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      let alive = false;
      for (const p of particles) {
        p.vy += gravity;
        p.vx *= drag;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.vr;
        if (p.y < window.innerHeight + 50) alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-[9999]"
      aria-hidden="true"
    />
  );
}

export function SessionResultsView({
  participants = [],
  sessionId,
  sessionMatches,
  myLikedIds,
  venues,
  userId,
  hostUserId,
  savedIds,
  onSave,
  onUnsave,
  onHide,
  onOpenProfile,
  showConfetti = false,
  showToast,
  // Aug 1 — "We're going here" opens the SCHEDULER instead of deciding
  // instantly; after locking, "Set up the album" hands (venue, dateStr|"")
  // up to App, which opens the Been add form prefilled. "" = going right now.
  onScheduleNight,
  expectedTotal = 0, // party size incl. host — strip shows who's missing
  voteSplit = false, // running session: strip groups Voted / Still to vote
}) {
  const [view, setView] = useState("matches");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [detailVenue, setDetailVenue] = useState(null);
  // Host's final pick for this session ("We're going here") — reuses the same
  // decided_venue_id mechanism as the curated board.
  const [decidedVenueId, setDecidedVenueId] = useState(null);
  // The plan's WHEN (Aug 1) — drives the date banner over the pinned pick.
  const [decidedFor, setDecidedFor] = useState(null);
  const canDecide = !!sessionId && !!userId && userId === hostUserId;

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    supabase
      .from("match_sessions")
      .select("decided_venue_id, decided_for")
      .eq("id", sessionId)
      .single()
      .then(({ data }) => {
        if (cancelled) return;
        setDecidedVenueId(data?.decided_venue_id ?? null);
        setDecidedFor(data?.decided_for ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // THE SCHEDULER (Aug 1, Mark) — extracted to components/PlanScheduler.js
  // so the curated board runs the IDENTICAL flow (Mark, Aug: "Does the same
  // UI and UX happen for the shortlist?"). This board just opens the venue
  // card under it and applies the decision via onDecided.
  const [schedulingVenue, setSchedulingVenue] = useState(null);

  function openScheduler(venueId) {
    if (!canDecide) return;
    const v = venueById.get(venueId);
    if (!v) return;
    setDetailVenue(v); // the card sits UNDER the sheet (Mark's spec)
    setSchedulingVenue(v);
  }

  // Clear per-row selections when switching tabs.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [view]);

  // Pick for us — random selector, relocated from the retired live end-of-game
  // wrapper (July 31, Mark: one board, in Sessions). Host-only, hidden once
  // decided: it's a decide tool, so it lives with "We're going here".
  function pickForUs() {
    const candidates = (sessionMatches || [])
      .map((m) => venueById.get(m.venue_id))
      .filter(Boolean);
    if (candidates.length === 0) return;
    setDetailVenue(candidates[Math.floor(Math.random() * candidates.length)]);
  }

  const venueById = useMemo(
    () => new Map(venues.map((v) => [v.id, v])),
    [venues]
  );
  const matchedIdSet = new Set(
    (sessionMatches || []).map((m) => m.venue_id)
  );
  const likeCountById = new Map(
    (sessionMatches || []).map((m) => [m.venue_id, m.like_count])
  );
  // WHO liked it, by first name (July 31, Mark: "I want this to read the
  // names" — ×3 says how many, not who, and who is the information). Names
  // resolve through the participants strip's rows; anyone we can't name
  // stays a count so the chip never lies.
  const nameByUid = new Map(
    (participants || []).map((p) => [
      p.user_id,
      (p.display_name || "").trim().split(" ")[0],
    ])
  );
  function likerNames(venueId) {
    const m = (sessionMatches || []).find((x) => x.venue_id === venueId);
    if (!m?.liker_user_ids?.length) return null;
    const named = [];
    let unnamed = 0;
    for (const uid of m.liker_user_ids) {
      const n = uid === userId ? "You" : nameByUid.get(uid);
      if (n) named.push(n);
      else unnamed++;
    }
    if (named.length === 0) return null;
    return unnamed > 0 ? `${named.join(", ")} +${unnamed}` : named.join(", ");
  }

  let rows;
  let loading;
  let emptyMessage;
  if (view === "matches") {
    loading = sessionMatches === null;
    rows = (sessionMatches || [])
      .map((m) => {
        const venue = venueById.get(m.venue_id);
        if (!venue) return null;
        return { venue, likeCount: m.like_count, isMatch: true };
      })
      .filter(Boolean);
    emptyMessage = "No mutual matches in this session.";
  } else {
    loading = myLikedIds === null;
    rows = (myLikedIds || [])
      .map((id) => {
        const venue = venueById.get(id);
        if (!venue) return null;
        return {
          venue,
          likeCount: likeCountById.get(id) || 1,
          isMatch: matchedIdSet.has(id),
        };
      })
      .filter(Boolean);
    emptyMessage = "You didn't like any places in this session.";
  }

  // THE PICK LEADS THE LIST (Aug 1, Mark: drawer tap should land on the
  // board "with that venue highlighted and sitting at the top of the list
  // of matches and the time and date sitting above it"). Pin in both views
  // so the plan is never buried.
  if (decidedVenueId) {
    const di = rows.findIndex((r) => r.venue.id === decidedVenueId);
    if (di > 0) rows.unshift(rows.splice(di, 1)[0]);
  }
  // The plan's when, rendered over the pinned card — ALWAYS shown once
  // decided (Mark, Aug 20: "it should still say when you're going and
  // where", even for a right-now plan — the decide moment IS the when).
  // Only legacy decides with no stored when show nothing.
  const planWhen = decidedFor
    ? `${new Date(decidedFor).toLocaleDateString("en-AU", {
        weekday: "long",
        day: "numeric",
        month: "short",
      })} · ${new Date(decidedFor).toLocaleTimeString("en-AU", {
        hour: "numeric",
        minute: "2-digit",
      })}`
    : null;

  const matchesCount = (sessionMatches || []).length;
  const myLikesCount = (myLikedIds || []).length;

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allVisibleSelected =
    rows.length > 0 && rows.every((r) => selectedIds.has(r.venue.id));
  const someVisibleSelected =
    !allVisibleSelected && rows.some((r) => selectedIds.has(r.venue.id));
  function toggleSelectAll() {
    if (allVisibleSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((r) => r.venue.id)));
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
    <>
      {showConfetti && <ConfettiBurst />}

      {/* Participants strip */}
      <ParticipantsStrip
        participants={participants}
        userId={userId}
        hostUserId={hostUserId}
        onOpenProfile={onOpenProfile}
        showToast={showToast}
        expectedTotal={expectedTotal}
        sessionId={sessionId}
        voteSplit={voteSplit}
      />

      {/* GUEST, MATCHED, PRE-LOCK (Mark, Aug 20): the board shows the match,
          but the plan isn't a plan until the host locks it — this banner
          holds the space, then the decide replaces it with the pinned pick
          + date banner. */}
      {!canDecide && !decidedVenueId && matchesCount > 0 && (
        <div className="bg-white px-4 pt-3">
          <div className="rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] px-4 py-3 text-center">
            <p className="text-sm text-[#2f3f29]">
              {(participants || []).find((p) => p.user_id === hostUserId)
                ?.display_name?.split(" ")[0] || "The host"}{" "}
              locks in the time and place. We'll nudge you the moment we have
              all the details.
            </p>
          </div>
        </div>
      )}

      {/* Pick for us — host shortcut when several places matched. */}
      {canDecide && !decidedVenueId && matchesCount > 1 && (
        <div className="bg-white px-4 pt-3 flex justify-center">
          <button
            type="button"
            onClick={pickForUs}
            className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-4 py-2 text-xs font-medium text-neutral-700 active:scale-95 transition"
          >
            <Shuffle size={14} /> Pick for us
          </button>
        </div>
      )}

      {/* Matches / My likes pill toggle */}
      <div className="bg-white border-b border-neutral-100 px-4 py-3 flex justify-center">
        <div className="flex bg-neutral-100 rounded-full p-0.5">
          <button
            type="button"
            onClick={() => setView("matches")}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition ${
              view === "matches"
                ? "bg-white text-[#455d3b] shadow-sm"
                : "text-neutral-500"
            }`}
          >
            Matches ({matchesCount})
          </button>
          <button
            type="button"
            onClick={() => setView("my_likes")}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition ${
              view === "my_likes"
                ? "bg-white text-[#455d3b] shadow-sm"
                : "text-neutral-500"
            }`}
          >
            My likes ({myLikesCount})
          </button>
        </div>
      </div>

      {/* Top action row — select-all checkbox + Save button */}
      {rows.length > 0 && (
        <div className="px-4 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={toggleSelectAll}
            aria-label={allVisibleSelected ? "Deselect all" : "Select all"}
            className={`flex h-5 w-5 items-center justify-center rounded border shrink-0 transition ${
              allVisibleSelected
                ? "bg-[#455d3b] border-[#455d3b] text-white"
                : someVisibleSelected
                ? "bg-[#455d3b]/40 border-[#455d3b]/40 text-white"
                : "bg-white border-neutral-300"
            }`}
          >
            {(allVisibleSelected || someVisibleSelected) && <Check size={14} />}
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

      {/* Venue list */}
      <div className="flex-1 overflow-y-auto p-4 pb-24">
        {loading ? (
          <div className="text-center text-neutral-500 mt-12 text-sm">
            Loading...
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center text-neutral-500 mt-12 text-sm">
            {emptyMessage}
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map(({ venue, likeCount, isMatch }) => {
              const isSelected = selectedIds.has(venue.id);
              return (
                <li key={venue.id}>
                  {/* Time and date over the pick (Aug 1, Mark) */}
                  {decidedVenueId === venue.id && planWhen && (
                    <div className="mb-1.5 flex items-center gap-2 rounded-xl bg-[#edf2eb] border border-[#c5d4c2] px-3 py-2">
                      <CalendarDays size={15} className="text-[#455d3b] shrink-0" />
                      <p className="text-sm font-medium text-[#2f4429] truncate">
                        {planWhen}
                      </p>
                    </div>
                  )}
                  <div className={`flex items-start gap-3 rounded-2xl border bg-white p-3 ${
                    decidedVenueId === venue.id
                      ? "border-[#455d3b] ring-1 ring-[#455d3b]"
                      : "border-neutral-100"
                  }`}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelected(venue.id);
                      }}
                      aria-label={isSelected ? "Deselect" : "Select"}
                      className={`flex h-5 w-5 items-center justify-center rounded border shrink-0 mt-1 transition ${
                        isSelected
                          ? "bg-[#455d3b] border-[#455d3b] text-white"
                          : "bg-white border-neutral-300"
                      }`}
                    >
                      {isSelected && <Check size={14} />}
                    </button>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailVenue(venue)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDetailVenue(venue);
                        }
                      }}
                      className="flex-1 min-w-0 cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{venue.name}</p>
                        {likeCount >= 2 && isMatch && (
                          <span className="inline-flex items-center rounded-full bg-[#edf2eb] px-2 py-0.5 text-[10px] font-medium text-[#3f5a3a] border border-[#c5d4c2] shrink-0 max-w-[140px] truncate">
                            {likerNames(venue.id) || `×${likeCount}`}
                          </span>
                        )}
                        {view === "my_likes" && isMatch && (
                          <span className="inline-flex items-center rounded-full bg-[#455d3b]/10 px-2 py-0.5 text-[10px] font-medium text-[#455d3b] shrink-0">
                            Matched
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-neutral-500 truncate">
                        {venue.type}
                        {venue.suburb ? ` · ${venue.suburb}` : ""}
                        {venue.rating ? ` · ⭐ ${venue.rating}` : ""}
                      </p>
                    </div>
                    {canDecide ? (
                      <button
                        type="button"
                        disabled={decidedVenueId === venue.id}
                        onClick={() => openScheduler(venue.id)}
                        className={`shrink-0 self-center rounded-xl px-3 py-2 text-xs font-medium transition ${
                          decidedVenueId === venue.id
                            ? "bg-[#455d3b] text-white"
                            : "bg-[#edf2eb] text-[#455d3b] active:scale-[0.98]"
                        } disabled:opacity-60`}
                      >
                        {decidedVenueId === venue.id ? "Going ✓" : "We're going here"}
                      </button>
                    ) : decidedVenueId === venue.id ? (
                      <span className="shrink-0 self-center rounded-xl px-3 py-2 text-xs font-medium bg-[#455d3b] text-white">
                        Going ✓
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {detailVenue && (
        <MapVenueSheet
          venue={detailVenue}
          onClose={() => setDetailVenue(null)}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
          userId={userId}
        />
      )}
      {/* THE SCHEDULER — shared with the curated board (PlanScheduler.js).
          Portaled inside the component; this board opens the venue card
          under it and applies the decision via onDecided. */}
      {schedulingVenue && (
        <PlanScheduler
          sessionId={sessionId}
          userId={userId}
          venue={schedulingVenue}
          participants={participants}
          showToast={showToast}
          onScheduleNight={
            onScheduleNight
              ? (v, dateStr, invitees, opts) => {
                  setSchedulingVenue(null);
                  setDetailVenue(null);
                  onScheduleNight(v, dateStr, invitees, opts);
                }
              : undefined
          }
          onDecided={(vid, iso) => {
            setDecidedVenueId(vid);
            setDecidedFor(iso); // banner appears without a refetch
          }}
          onClose={() => setSchedulingVenue(null)}
        />
      )}
    </>
  );
}
