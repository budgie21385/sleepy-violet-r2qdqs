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
import { X, MoreVertical, Send, Bookmark } from "lucide-react";
import {
  VenueHeroCarousel,
  VenueRating,
  VenueVibes,
  OpeningHours,
  OpenMapsButton,
} from "./VenueBits";
import { getMapsUrl } from "../lib/venueLogic";

const HINT_KEY = "flanit_mapcard_swipe_hint"; // localStorage seen-flag

export function MapVenueSheet({
  venue,
  onClose,
  savedIds,
  onSave,
  onUnsave,
  onHide,
  onNext,
  onPrev,
  hasNext = false,
  hasPrev = false,
}) {
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [enterDir, setEnterDir] = useState(null); // slide-in dir on venue change
  const [hint, setHint] = useState(null); // 'right' | 'left' | null (one-time)
  const saved = !!(savedIds && savedIds.has(venue.id));
  const navEnabled = !!(onNext || onPrev);
  const touch = useRef({ x: 0, y: 0, active: false });

  // One-time swipe tutorial: nudge right on the very first card the user opens.
  useEffect(() => {
    if (!navEnabled || !hasNext) return;
    let seen = false;
    try {
      seen = !!localStorage.getItem(HINT_KEY);
    } catch {
      /* storage blocked — just skip the hint */
    }
    if (!seen) setHint("right");
  }, [navEnabled, hasNext]);

  // After the "swipe back" (left) hint has shown once, retire the tutorial.
  useEffect(() => {
    if (hint !== "left") return;
    const t = setTimeout(() => {
      setHint(null);
      try {
        localStorage.setItem(HINT_KEY, "1");
      } catch {
        /* ignore */
      }
    }, 2400);
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
    // Advance the tutorial: first swipe → show the "swipe back" hint; a further
    // swipe (or the timer) retires it.
    if (hint === "right") {
      setHint("left");
    } else if (hint === "left") {
      setHint(null);
      try {
        localStorage.setItem(HINT_KEY, "1");
      } catch {
        /* ignore */
      }
    }
  }

  function handleSwipeStart(e) {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY, active: true };
  }
  function handleSwipeEnd(e) {
    if (!touch.current.active) return;
    touch.current.active = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.current.x;
    const dy = t.clientY - touch.current.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      go(dx > 0 ? "next" : "prev"); // swipe right → next, left → back
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

  const nudgeClass =
    hint === "right"
      ? "flanit-nudge-right"
      : hint === "left"
        ? "flanit-nudge-left"
        : "";
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
      className={`fixed left-0 right-0 mx-auto max-w-sm bg-white rounded-3xl border border-neutral-100 shadow-2xl flex flex-col ${nudgeClass}`}
      style={{
        bottom: 80,
        width: "calc(100% - 1.5rem)",
        maxHeight: "calc(100% - 100px)",
        // Above the bell (2950) and FAB (3060) so the open card is top-level.
        zIndex: 3100,
      }}
      onTouchStart={navEnabled ? handleSwipeStart : undefined}
      onTouchEnd={navEnabled ? handleSwipeEnd : undefined}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between bg-white px-4 py-3 border-b border-neutral-100 rounded-t-3xl">
        <span className="text-sm font-semibold text-neutral-800 truncate pr-2">
          {venue.name}
        </span>
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
        <p className="text-sm leading-6 text-neutral-500">{venue.address}</p>
        <VenueRating venue={venue} />
        <VenueVibes venue={venue} />
        <OpeningHours venue={venue} />
        <OpenMapsButton url={getMapsUrl(venue)} />
      </div>

      <div className="p-4 pt-3 border-t border-neutral-100 bg-white rounded-b-3xl">
        <div className="flex items-center justify-around relative">
          <button
            type="button"
            onClick={() => setMapMenuOpen(true)}
            aria-label="More options"
            className="flex h-11 w-11 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100 active:scale-95 transition"
          >
            <MoreVertical size={20} />
          </button>
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
