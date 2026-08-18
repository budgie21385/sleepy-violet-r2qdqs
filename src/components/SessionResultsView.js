// Concurrent ("Right now") session results: a Matches / My-likes toggle over the
// reconciled likes, multi-select bulk save-to-list, tap a row for its card, and
// the host's "We're going here" decision (shared decided_venue_id mechanism).
// Includes a one-shot confetti burst on the match reveal. Extracted from App.js.
import { useState, useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../supabaseClient";
import { sendPush } from "../lib/push";
import { Check, Shuffle } from "lucide-react";
import { ParticipantsStrip } from "./ParticipantsStrip";
import { MapVenueSheet } from "./MapVenueSheet";

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
}) {
  const [view, setView] = useState("matches");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [detailVenue, setDetailVenue] = useState(null);
  // Host's final pick for this session ("We're going here") — reuses the same
  // decided_venue_id mechanism as the curated board.
  const [decidedVenueId, setDecidedVenueId] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const canDecide = !!sessionId && !!userId && userId === hostUserId;

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    supabase
      .from("match_sessions")
      .select("decided_venue_id")
      .eq("id", sessionId)
      .single()
      .then(({ data }) => {
        if (!cancelled) setDecidedVenueId(data?.decided_venue_id ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // THE SCHEDULER (Aug 1, Mark). "We're going here" no longer decides on the
  // spot — it opens the venue card with this sheet over it:
  //   step 1: when are you going (right now / pick a day) → Lock it in
  //   step 2: locked ✓ → Share the plan (link with details, for the group
  //           chat) → "Want the album ready?" → Been add form, prefilled
  // The in-app tell is automatic: the decide push now carries the WHEN.
  const [scheduler, setScheduler] = useState(null); // {venueId, step, when, date}
  const todayStr = new Date().toISOString().slice(0, 10);

  function openScheduler(venueId) {
    if (!canDecide) return;
    const v = venueById.get(venueId);
    if (v) setDetailVenue(v); // the card sits UNDER the sheet (Mark's spec)
    setScheduler({ venueId, step: 1, when: "now", date: "" });
  }

  function schedulerWhenText(s) {
    if (s.when === "now" || !s.date) return "tonight";
    const d = new Date(`${s.date}T20:00:00`);
    return d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "short" });
  }

  async function lockItIn() {
    if (!scheduler || deciding) return;
    setDeciding(true);
    const { error } = await supabase.rpc("set_curated_decision", {
      p_session_id: sessionId,
      p_venue_id: scheduler.venueId,
    });
    setDeciding(false);
    if (error) {
      console.error("set_curated_decision failed:", error);
      showToast?.("Couldn't save — try again");
      return;
    }
    setDecidedVenueId(scheduler.venueId);
    // Tell everyone where AND WHEN — lock-screen push per participant.
    const vName = venueById.get(scheduler.venueId)?.name || "the spot";
    const whenBody =
      scheduler.when === "now" || !scheduler.date
        ? "The plan is locked — see you there"
        : `Locked in for ${schedulerWhenText(scheduler)}`;
    for (const p of participants || []) {
      if (p.user_id && p.user_id !== userId) {
        sendPush(p.user_id, `${vName} it is 🎉`, whenBody);
      }
    }
    setScheduler((s) => (s ? { ...s, step: 2 } : s));
  }

  async function sharePlan() {
    if (!scheduler) return;
    const vName = venueById.get(scheduler.venueId)?.name || "the spot";
    const when =
      scheduler.when === "now" || !scheduler.date
        ? ""
        : ` on ${schedulerWhenText(scheduler)}`;
    const text = `We're going to ${vName}${when} 🎉`;
    const url = `https://flanit.co/v/${scheduler.venueId}`;
    try {
      if (navigator.share) {
        await navigator.share({ text, url });
      } else {
        await navigator.clipboard.writeText(`${text} ${url}`);
        showToast?.("Copied — paste it in the group chat");
      }
    } catch {
      /* share sheet closed — their call */
    }
  }

  // Legacy path kept for nothing — decide now always goes through the
  // scheduler. (Removed decideVenue; rows call openScheduler.)

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
      />

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
                        disabled={deciding || decidedVenueId === venue.id}
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
      {/* THE SCHEDULER — over the venue card. PORTALED to body (the card
          portals too, so an in-tree overlay is trapped in this screen's
          stacking context and paints UNDERNEATH regardless of z — Mark's
          field report, and the same class as the July upload-tile bug).
          pb-28 keeps the CTA clear of the bottom tab bar. */}
      {scheduler &&
        createPortal(
        <div className="fixed inset-0 z-[4200] flex items-end justify-center sm:items-center">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setScheduler(null)}
            className="absolute inset-0 bg-black/40"
          />
          <div className="relative w-full max-w-sm rounded-t-3xl sm:rounded-3xl bg-white p-5 pb-28 sm:pb-5 shadow-xl max-h-[85vh] overflow-y-auto">
            {scheduler.step === 1 ? (
              <>
                <h2 className="text-xl font-semibold tracking-tight">
                  {venueById.get(scheduler.venueId)?.name || "This spot"} it is 🎉
                </h2>
                <p className="mt-1 text-sm text-neutral-600">When are you going?</p>
                <div className="mt-4 flex gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setScheduler((s) => ({ ...s, when: "now", date: "" }))
                    }
                    className={`flex-1 rounded-2xl border py-3 text-sm font-medium transition ${
                      scheduler.when === "now"
                        ? "border-[#455d3b] bg-[#edf2eb] text-[#2f3f29]"
                        : "border-neutral-200 bg-white text-neutral-600"
                    }`}
                  >
                    Right now
                  </button>
                  <input
                    type="date"
                    min={todayStr}
                    value={scheduler.date}
                    onChange={(e) =>
                      setScheduler((s) => ({
                        ...s,
                        date: e.target.value,
                        when: e.target.value ? "date" : "now",
                      }))
                    }
                    className={`flex-1 appearance-none rounded-2xl border px-3 py-3 text-sm font-medium focus:outline-none ${
                      scheduler.when === "date"
                        ? "border-[#455d3b] bg-[#edf2eb] text-[#2f3f29]"
                        : "border-neutral-200 bg-white text-neutral-600"
                    }`}
                  />
                </div>
                <p className="mt-3 text-xs text-neutral-500">
                  Everyone on the session gets told in the app.
                </p>
                <button
                  type="button"
                  disabled={deciding}
                  onClick={lockItIn}
                  className="mt-4 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition disabled:opacity-60"
                >
                  {deciding ? "Locking…" : "Lock it in"}
                </button>
              </>
            ) : (
              <>
                <h2 className="text-xl font-semibold tracking-tight">
                  Locked in ✓
                </h2>
                <p className="mt-1 text-sm text-neutral-600">
                  {venueById.get(scheduler.venueId)?.name || "The spot"},{" "}
                  {scheduler.when === "now" ? "tonight" : schedulerWhenText(scheduler)}
                  . Everyone's been told in the app.
                </p>
                <button
                  type="button"
                  onClick={sharePlan}
                  className="mt-4 w-full rounded-2xl border border-[#cdd9c6] bg-[#edf2eb] py-3 font-medium text-[#455d3b] active:scale-[0.98] transition"
                >
                  Share the plan — send the link
                </button>
                {onScheduleNight && (
                  <div className="mt-4 rounded-2xl border border-neutral-200 p-4">
                    <p className="text-sm font-semibold">Want the album ready?</p>
                    <p className="mt-1 text-xs text-neutral-500">
                      We'll set up the night's card now — share the photo link
                      ahead, and everyone's photos land in one place.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        const v = venueById.get(scheduler.venueId);
                        const dateStr =
                          scheduler.when === "date" ? scheduler.date : "";
                        setScheduler(null);
                        setDetailVenue(null);
                        onScheduleNight(v, dateStr);
                      }}
                      className="mt-3 w-full rounded-2xl bg-[#455d3b] py-2.5 text-sm font-medium text-white active:scale-[0.98] transition"
                    >
                      Set up the album
                    </button>
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => setScheduler(null)}
                  className="mt-3 w-full text-center text-sm text-neutral-500"
                >
                  Not now
                </button>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
