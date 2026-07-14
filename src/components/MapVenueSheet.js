// Bottom-sheet venue card shown when a map marker (or a saved-place row) is
// tapped. Portaled to document.body so it sits above the FAB/tab bar. Extracted
// from App.js; used in several places (map tab, saved lists, results).
//
// On the Map, the card doubles as a discovery surface: when onNext/onPrev are
// provided, a horizontal swipe moves venue-to-venue through the set currently
// shown on the map — swipe RIGHT for the next venue, LEFT to go back — without
// closing the card. A one-time nudge tutorial teaches the gesture. The swipe is
// navigation only; saving is still the bookmark button. While nav is enabled the
// hero stops swiping photos (you tap the photo to advance) so the two gestures
// don't collide.
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, MoreVertical, Send, Bookmark, ChevronRight, ChevronLeft, MapPin, MessageCircle } from "lucide-react";
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";
import {
  VenueHeroCarousel,
  VenueRating,
  VenueEditorial,
  VenueVibes,
  VenueAmenities,
  VenueReview,
  OpeningHours,
  OpenMapsButton,
} from "./VenueBits";
import { getMapsUrl } from "../lib/venueLogic";

const HINT_KEY = "flanit_mapcard_swipe_hint"; // localStorage seen-flag

function timeAgoShort(ts) {
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 15) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

export function MapVenueSheet({
  venue,
  onClose,
  savedIds,
  onSave,
  onUnsave,
  onHide,
  onCheckIn,
  onOpenThread,
  onOpenProfile,
  userId,
  onNext,
  onPrev,
  hasNext = false,
  hasPrev = false,
}) {
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [checkedIn, setCheckedIn] = useState(null); // own activity row after check-in
  const [checkingIn, setCheckingIn] = useState(false);
  // "What's on?" — one-shot optional label prompt after checking in.
  const [labelText, setLabelText] = useState("");
  const [labelState, setLabelState] = useState("idle"); // idle|saving|done|dismissed
  // "With friends?" — optional tagging after checking in. Tags only render on
  // YOUR check-in (your audience) + nudge the friend to check in themselves.
  const [tagFriends, setTagFriends] = useState(null); // accepted friends, lazy
  const [taggedIds, setTaggedIds] = useState(() => new Set());
  // Friends' check-ins at this venue → the strip. null = loading/none yet.
  // { live: entry|null, liveCount, commentCount, memory: profiles[], memoryCount }
  const [strip, setStrip] = useState(null);
  const [enterDir, setEnterDir] = useState(null); // slide-in dir on venue change
  const [hint, setHint] = useState(false); // show the one-time two-way swipe pill
  const [dragX, setDragX] = useState(0); // live finger-follow offset
  const [animateBack, setAnimateBack] = useState(false); // snap-back transition
  const saved = !!(savedIds && savedIds.has(venue.id));
  const navEnabled = !!(onNext || onPrev);
  const touch = useRef({ x: 0, y: 0, active: false, axis: null });

  // One-time swipe tutorial: show the hint on the very first card the user opens
  // (persisted via localStorage so it only ever shows once).
  useEffect(() => {
    if (!navEnabled || !hasNext) return;
    let seen = false;
    try {
      seen = !!localStorage.getItem(HINT_KEY);
    } catch {
      /* storage blocked — just skip the hint */
    }
    if (!seen) setHint(true);
  }, [navEnabled, hasNext]);

  // Fresh venue on the card → fresh check-in state (swiping venue-to-venue
  // must not carry the "Checked in ✓" pill across).
  useEffect(() => {
    setCheckedIn(null);
    setCheckingIn(false);
    setLabelText("");
    setLabelState("idle");
    setTaggedIds(new Set());
  }, [venue.id]);

  // Load accepted friends once, the first time a check-in succeeds — they
  // become the tag chips.
  useEffect(() => {
    if (!checkedIn || tagFriends !== null || !userId) return;
    let cancelled = false;
    (async () => {
      const { data: fr } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id")
        .eq("status", "accepted")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
      const ids = Array.from(
        new Set(
          (fr || []).map((f) =>
            f.requester_id === userId ? f.addressee_id : f.requester_id
          )
        )
      );
      if (ids.length === 0) {
        if (!cancelled) setTagFriends([]);
        return;
      }
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", ids);
      if (!cancelled) setTagFriends(profs || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [checkedIn, tagFriends, userId]);

  // Toggle a tag: insert (pending) or delete — takes effect immediately, no
  // extra save step. The friend gets the consent nudge in their Activity.
  async function toggleTag(friendId) {
    if (!checkedIn) return;
    const isTagged = taggedIds.has(friendId);
    setTaggedIds((prev) => {
      const next = new Set(prev);
      if (isTagged) next.delete(friendId);
      else next.add(friendId);
      return next;
    });
    if (isTagged) {
      await supabase
        .from("activity_tags")
        .delete()
        .eq("activity_id", checkedIn.id)
        .eq("tagged_user_id", friendId);
    } else {
      const { error } = await supabase
        .from("activity_tags")
        .insert({ activity_id: checkedIn.id, tagged_user_id: friendId });
      if (error) {
        console.error("Tag failed:", error);
        setTaggedIds((prev) => {
          const next = new Set(prev);
          next.delete(friendId);
          return next;
        });
      }
    }
  }

  // Save the optional "what's on" label onto the check-in row we just created
  // (UPDATE — no second item, no duplicate notification; the existing item
  // simply grows the "· label" suffix wherever it renders).
  async function saveLabel() {
    const text = labelText.trim().slice(0, 80);
    if (!text || !checkedIn) return;
    setLabelState("saving");
    const { error } = await supabase
      .from("activities")
      .update({ label: text })
      .eq("id", checkedIn.id);
    setLabelState(error ? "idle" : "done");
  }

  // Friends' check-ins at this venue. RLS scopes the read to own + friends'
  // rows, so the only client work is excluding self and splitting live (<3h,
  // green "is here" strip) from memory (gray "N friends have been here").
  useEffect(() => {
    let cancelled = false;
    setStrip(null);
    if (!userId) return;
    (async () => {
      const { data: rows } = await supabase
        .from("activities")
        .select("id, user_id, created_at, label")
        .eq("kind", "checkin")
        .eq("venue_id", venue.id)
        .order("created_at", { ascending: false })
        .limit(50);
      const others = (rows || []).filter((r) => r.user_id !== userId);
      if (others.length === 0) {
        if (!cancelled) setStrip({ none: true });
        return;
      }
      const FRESH_MS = 3 * 60 * 60 * 1000;
      const fresh = others.filter(
        (r) => Date.now() - new Date(r.created_at).getTime() < FRESH_MS
      );
      // Distinct friends over all time (memory), newest first.
      const seen = new Set();
      const distinct = [];
      for (const r of others) {
        if (seen.has(r.user_id)) continue;
        seen.add(r.user_id);
        distinct.push(r);
      }
      const needIds = Array.from(
        new Set([...fresh.slice(0, 3), ...distinct.slice(0, 3)].map((r) => r.user_id))
      );
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", needIds);
      const profById = Object.fromEntries((profs || []).map((p) => [p.id, p]));
      let commentCount = 0;
      const target = fresh[0] || distinct[0];
      if (target) {
        const { count } = await supabase
          .from("activity_comments")
          .select("id", { count: "exact", head: true })
          .eq("activity_id", target.id);
        commentCount = count ?? 0;
      }
      if (cancelled) return;
      setStrip({
        live: fresh[0] ? { ...fresh[0], profile: profById[fresh[0].user_id] } : null,
        liveCount: new Set(fresh.map((r) => r.user_id)).size,
        memory: distinct.slice(0, 3).map((r) => profById[r.user_id]).filter(Boolean),
        memoryCount: distinct.length,
        target: { ...target, profile: profById[target.user_id] },
        commentCount,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [venue.id, userId]);

  function openStripThread() {
    if (!strip || strip.none || !onOpenThread) return;
    const t = strip.live || strip.target;
    onOpenThread({
      activityId: t.id,
      ownerId: t.user_id,
      ownerName: t.profile?.display_name || "A friend",
      ownerProfile: t.profile || null,
      venueName: venue.name,
      label: t.label || null,
      timestamp: t.created_at,
    });
  }

  // Avatar taps open the person; the card closes so the profile screen
  // (normal z-stack) isn't buried under this portal.
  function openProfile(uid) {
    if (!uid || !onOpenProfile) return;
    onOpenProfile(uid);
    onClose?.();
  }

  // Retire the tutorial after a few seconds even if they don't swipe.
  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => {
      setHint(false);
      try {
        localStorage.setItem(HINT_KEY, "1");
      } catch {
        /* ignore */
      }
    }, 5000);
    return () => clearTimeout(t);
  }, [hint]);

  function go(dir) {
    if (dir === "next") {
      if (!hasNext || !onNext) return;
      setEnterDir("right");
      onNext();
    } else {
      if (!hasPrev || !onPrev) return;
      setEnterDir("left");
      onPrev();
    }
    setMapMenuOpen(false);
    // First swipe retires the one-time tutorial.
    if (hint) {
      setHint(false);
      try {
        localStorage.setItem(HINT_KEY, "1");
      } catch {
        /* ignore */
      }
    }
  }

  function handleSwipeStart(e) {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, active: true, axis: null };
    setAnimateBack(false);
  }
  function handleSwipeMove(e) {
    if (!touch.current.active) return;
    const t = e.touches[0];
    const dx = t.clientX - touch.current.x;
    const dy = t.clientY - touch.current.y;
    // Lock to an axis after a little movement so vertical scrolling still works.
    if (!touch.current.axis && (Math.abs(dx) > 10 || Math.abs(dy) > 10)) {
      touch.current.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (touch.current.axis !== "x") return;
    // Resist dragging past the ends of the list.
    let offset = dx;
    if ((dx > 0 && !hasNext) || (dx < 0 && !hasPrev)) offset = dx * 0.25;
    setDragX(offset);
  }
  function handleSwipeEnd() {
    if (!touch.current.active) return;
    const wasX = touch.current.axis === "x";
    const dx = dragX;
    touch.current.active = false;
    touch.current.axis = null;
    if (wasX && Math.abs(dx) > 70) {
      // Commit: swap venue and reset offset instantly (the new card slides in).
      setAnimateBack(false);
      setDragX(0);
      go(dx > 0 ? "next" : "prev"); // swipe right → next, left → back
    } else {
      // Snap back to centre.
      setAnimateBack(true);
      setDragX(0);
    }
  }

  // Share the public card link (flanit.co/v/<id>) — opens this card with no
  // login. Native share sheet on mobile; copy-to-clipboard fallback elsewhere.
  async function handleShare() {
    const url = `https://flanit.co/v/${venue.id}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: venue.name, text: `${venue.name} — on Flanit`, url });
      } catch {
        /* user cancelled — ignore */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — ignore */
    }
  }

  const slideClass =
    enterDir === "right"
      ? "flanit-slide-from-right"
      : enterDir === "left"
        ? "flanit-slide-from-left"
        : "";

  // Portaled to document.body so it escapes MapScreen's `fixed inset-0
  // z-[1500]` stacking context. Otherwise its zIndex only competes inside that
  // layer and can never sit above the app-level FAB (z-[3060]). `fixed` keeps
  // the same on-screen placement the old `absolute` had inside the fixed map.
  return createPortal(
    <div
      className="fixed left-0 right-0 mx-auto max-w-sm bg-white rounded-3xl border border-neutral-100 shadow-2xl flex flex-col"
      style={{
        bottom: 80,
        width: "calc(100% - 1.5rem)",
        maxHeight: "calc(100% - 100px)",
        // Above the bell (2950) and FAB (3060) so the open card is top-level.
        zIndex: 3100,
        // Live finger-follow while dragging; left undefined at rest so the
        // one-time nudge animation can drive the transform.
        transform: dragX !== 0 ? `translateX(${dragX}px)` : undefined,
        transition: animateBack ? "transform 0.2s ease-out" : "none",
      }}
      onTouchStart={navEnabled ? handleSwipeStart : undefined}
      onTouchMove={navEnabled ? handleSwipeMove : undefined}
      onTouchEnd={navEnabled ? handleSwipeEnd : undefined}
    >
      <div className="sticky top-0 z-10 flex items-center justify-end bg-white px-4 py-3 rounded-t-3xl">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100"
        >
          <X size={16} />
        </button>
      </div>

      <div
        key={venue.id}
        className={`flex-1 overflow-y-auto p-4 space-y-3 ${slideClass}`}
      >
        <VenueHeroCarousel venue={venue} disableSwipe={navEnabled} />
        <VenueRating venue={venue} />
        <OpeningHours venue={venue} />
        {strip && !strip.none && strip.live && (
          <div className="w-full flex items-center gap-2.5 rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] px-3 py-2.5">
            <button
              type="button"
              aria-label="View profile"
              onClick={() => openProfile(strip.live.user_id)}
              className="shrink-0 active:scale-95 transition"
            >
              <FriendAvatar profile={strip.live.profile} small />
            </button>
            <button
              type="button"
              onClick={openStripThread}
              className="flex-1 min-w-0 flex items-center gap-2 text-left active:scale-[0.99] transition"
            >
              <p className="flex-1 min-w-0 text-sm text-[#2f3f29] truncate">
                <strong className="font-medium">
                  {strip.live.profile?.display_name || "A friend"}
                  {strip.liveCount > 1 ? ` +${strip.liveCount - 1}` : ""}
                </strong>{" "}
                is here · {timeAgoShort(strip.live.created_at)}
                {strip.live.label ? ` · ${strip.live.label}` : ""}
              </p>
              <span className="shrink-0 inline-flex items-center gap-1 text-xs font-medium text-[#455d3b]">
                <MessageCircle size={14} />
                {strip.commentCount > 0 ? strip.commentCount : ""}
              </span>
            </button>
          </div>
        )}
        {strip && !strip.none && !strip.live && (
          <div className="w-full flex items-center gap-2.5 rounded-2xl border border-neutral-200 px-3 py-2.5">
            <button
              type="button"
              aria-label="View profile"
              onClick={() => openProfile(strip.memory[0]?.id)}
              className="flex shrink-0 active:scale-95 transition"
            >
              {strip.memory.map((p, i) => (
                <span key={p.id} style={i > 0 ? { marginLeft: -8 } : undefined}>
                  <FriendAvatar profile={p} small />
                </span>
              ))}
            </button>
            <button
              type="button"
              onClick={openStripThread}
              className="flex-1 min-w-0 flex items-center gap-2 text-left active:scale-[0.99] transition"
            >
              <p className="flex-1 min-w-0 text-sm text-neutral-600 truncate">
                {strip.memoryCount === 1
                  ? `${strip.memory[0]?.display_name || "A friend"} has been here`
                  : `${strip.memoryCount} friends have been here`}
              </p>
              <ChevronRight size={14} className="shrink-0 text-neutral-400" />
            </button>
          </div>
        )}
        <VenueEditorial venue={venue} />
        <p className="text-sm leading-6 text-neutral-500">{venue.address}</p>
        <VenueVibes venue={venue} />
        <VenueAmenities venue={venue} />
        <VenueReview venue={venue} />
        <OpenMapsButton url={getMapsUrl(venue)} />
      </div>

      {hint && dragX === 0 && (
        <div className="flanit-hint-in pointer-events-none absolute bottom-24 left-1/2 z-20 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-full bg-black/60 px-4 py-2 text-[13px] font-medium text-white shadow-lg backdrop-blur">
            {hasPrev && <ChevronLeft size={16} className="flanit-arrow-left" />}
            <span>Swipe</span>
            <ChevronRight size={16} className="flanit-arrow-right" />
          </div>
        </div>
      )}

      <div className="p-4 pt-3 border-t border-neutral-100 bg-white rounded-b-3xl">
        {checkedIn && labelState !== "dismissed" && labelState !== "done" && (
          <div className="mb-3 flex items-center gap-2 rounded-full bg-[#edf2eb] border border-[#cdd9c6] pl-4 pr-1.5 py-1.5">
            {/* text-base: sub-16px inputs make iOS Safari auto-zoom on focus. */}
            <input
              value={labelText}
              onChange={(e) => setLabelText(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && saveLabel()}
              placeholder="What's on tonight?"
              maxLength={80}
              className="flex-1 min-w-0 bg-transparent text-base text-[#2f3f29] placeholder-[#77906c] focus:outline-none"
            />
            {labelText.trim() ? (
              <button
                type="button"
                aria-label="Save"
                disabled={labelState === "saving"}
                onClick={saveLabel}
                className="w-8 h-8 shrink-0 rounded-full bg-[#455d3b] text-white flex items-center justify-center disabled:opacity-50 active:scale-95 transition"
              >
                ✓
              </button>
            ) : (
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => setLabelState("dismissed")}
                className="w-8 h-8 shrink-0 rounded-full text-neutral-400 flex items-center justify-center hover:bg-neutral-100"
              >
                <X size={14} />
              </button>
            )}
          </div>
        )}
        {labelState === "done" && (
          <p className="mb-3 text-center text-xs text-[#455d3b] font-medium">
            Added — friends see "{labelText.trim()}"
          </p>
        )}
        {checkedIn && tagFriends && tagFriends.length > 0 && (
          <div className="mb-3">
            <p className="mb-1.5 px-1 text-[11px] font-medium text-neutral-500">
              With friends? They'll be asked before their friends see anything.
            </p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {tagFriends.map((f) => {
                const on = taggedIds.has(f.id);
                return (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => toggleTag(f.id)}
                    className={`shrink-0 flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium active:scale-95 transition ${
                      on
                        ? "bg-[#455d3b] border-[#455d3b] text-white"
                        : "border-neutral-200 text-neutral-700"
                    }`}
                  >
                    <FriendAvatar profile={f} small />
                    {(f.display_name || "?").split(" ")[0]}
                    {on ? " ✓" : ""}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div className="flex items-center justify-around relative">
          <button
            type="button"
            onClick={() => setMapMenuOpen(true)}
            aria-label="More options"
            className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 active:scale-95 transition"
          >
            <MoreVertical size={20} />
          </button>
          {/* Check in = "I'm here NOW" (presence, notifies friends) — the one
              labeled action on the card. Reviews are a future, quieter kind. */}
          {onCheckIn && (
            <button
              type="button"
              disabled={checkingIn}
              onClick={async () => {
                // Second tap after checking in → open your own thread to
                // watch comments arrive.
                if (checkedIn) {
                  onOpenThread?.({
                    activityId: checkedIn.id,
                    ownerName: "You",
                    venueName: venue.name,
                    timestamp: checkedIn.created_at,
                  });
                  return;
                }
                setCheckingIn(true);
                const activity = await onCheckIn(venue);
                setCheckingIn(false);
                if (activity) setCheckedIn(activity);
              }}
              className={`flex-1 mx-1 flex items-center justify-center gap-1.5 rounded-full py-2.5 text-sm font-medium active:scale-95 transition ${
                checkedIn
                  ? "bg-[#edf2eb] text-[#455d3b]"
                  : "bg-[#455d3b] text-white"
              }`}
            >
              {checkedIn ? <MessageCircle size={15} /> : <MapPin size={15} />}
              {checkedIn ? "Checked in ✓" : checkingIn ? "Checking in…" : "Check in"}
            </button>
          )}
          <button
            type="button"
            onClick={handleShare}
            aria-label="Share"
            className="relative flex h-11 w-11 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100 active:scale-95 transition"
          >
            <Send size={20} />
            {copied && (
              <span className="absolute bottom-full mb-1 whitespace-nowrap rounded-full bg-neutral-900 px-2 py-1 text-[10px] font-medium text-white">
                Link copied
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => (saved ? onUnsave(venue.id) : onSave(venue.id))}
            aria-label={saved ? "Remove from list" : "Add to list"}
            className="flex h-11 w-11 items-center justify-center rounded-full hover:bg-neutral-100 active:scale-95 transition"
          >
            <Bookmark
              size={20}
              fill={saved ? "#455d3b" : "none"}
              className={saved ? "text-[#455d3b]" : "text-neutral-600"}
            />
          </button>
          {mapMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-[3400]"
                onClick={() => setMapMenuOpen(false)}
              />
              <div className="absolute bottom-full left-0 mb-2 bg-white border border-neutral-200 rounded-xl shadow-lg z-[3500] overflow-hidden">
                <button
                  type="button"
                  onClick={() => {
                    onHide(venue.id);
                    setMapMenuOpen(false);
                    onClose();
                  }}
                  className="block px-5 py-3 text-red-700 font-medium hover:bg-neutral-50 whitespace-nowrap text-left"
                >
                  Don't show this again
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
