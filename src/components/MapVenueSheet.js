// Bottom-sheet venue card shown when a map marker (or a saved-place row) is
// tapped. Portaled to document.body so it sits above the FAB/tab bar. Extracted
// from App.js; used in several places (map tab, saved lists, results).
import { useState } from "react";
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

export function MapVenueSheet({ venue, onClose, savedIds, onSave, onUnsave, onHide }) {
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const saved = !!(savedIds && savedIds.has(venue.id));

  // Share the public card link (flanit.co/v/<id>) — opens this card with no
  // login. Native share sheet on mobile; copy-to-clipboard fallback elsewhere.
  async function handleShare() {
    const url = `https://flanit.co/v/${venue.id}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: venue.name, text: `${venue.name} — on Flanit`, url });
      } catch (e) {
        /* user cancelled — ignore */
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      /* clipboard blocked — ignore */
    }
  }
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
      }}
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

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <VenueHeroCarousel venue={venue} />
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
