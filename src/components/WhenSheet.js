// THE WHEN-SHEET (Oct 9 doctrine; order RULED Oct 15) — one + per tab, one
// question: "When?". Four core options on every tab; "Coming up" sits at
// the TOP and wears the sage tint in ALL situations (Mark's Oct 15 ruling —
// the per-tab tilt system is retired; planning ahead is the default act).
// An open list hands the tint to "We can't decide" instead. Map adds "Map
// it out", Profile adds "People". Contextual shortcuts elsewhere skip this
// sheet. "We can't decide" expands IN PLACE to the two session starters.
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  X,
  MapPin,
  CalendarDays,
  Moon,
  Shuffle,
  Upload,
  UserPlus,
  HeartHandshake,
  ListChecks,
} from "lucide-react";

// TILT_BY_TAB retired (Oct 15): Coming up is the default everywhere.

export function WhenSheet({
  tab,
  listContext = null, // open venue list — We-can't-decide wears it
  onClose,
  onNow,
  onComingUp,
  onPast,
  onRightNow,
  onShortlist,
  onAddSpot,
  onImportMap,
  onAddFriend,
}) {
  // "We can't decide" swaps the core list for the two session starters.
  const [deciding, setDeciding] = useState(false);

  const pick = (fn) => () => {
    onClose();
    fn?.();
  };

  const row = (key, icon, label, sub, action, tinted) => (
    <button
      key={key}
      type="button"
      onClick={action}
      className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left active:scale-[0.99] transition ${
        tinted
          ? "border-[#c5d4c2] bg-[#edf2eb]"
          : "border-neutral-100 bg-white"
      }`}
    >
      <span
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
          tinted ? "bg-white text-[#455d3b]" : "bg-[#f5f1ea] text-neutral-500"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block text-sm font-medium ${
            tinted ? "text-[#2f4429]" : "text-neutral-900"
          }`}
        >
          {label}
        </span>
        <span
          className={`block text-[11px] ${
            tinted ? "text-[#55614d]" : "text-neutral-500"
          }`}
        >
          {sub}
        </span>
      </span>
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[3300]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="absolute left-0 right-0 bottom-0 mx-auto max-w-md rounded-t-3xl bg-white px-5 pt-3 shadow-2xl"
        style={{ paddingBottom: "max(20px, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
        {/* NO TITLE on the main sheet (Mark, Oct 15) — the four options
            speak for themselves. The deciding sub-view keeps its label. */}
        <div className="mb-3 flex items-center justify-between">
          {deciding ? (
            <h2 className="text-base font-semibold">Make an unplanned plan</h2>
          ) : (
            <span />
          )}
          <button
            type="button"
            aria-label="Close"
            onClick={deciding ? () => setDeciding(false) : onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 active:bg-neutral-200"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>

        {deciding ? (
          <div className="space-y-2">
            {row(
              "pick_together",
              <HeartHandshake size={16} />,
              "Pick together",
              listContext
                ? `Everyone swipes ${listContext.name}, first match wins`
                : "Everyone swipes, first match wins",
              pick(onRightNow),
              true
            )}
            {row(
              "shortlist",
              <ListChecks size={16} />,
              "Send a shortlist",
              listContext
                ? `Send ${listContext.name} out, they vote`
                : "You pick a few, they vote",
              pick(onShortlist),
              false
            )}
            <button
              type="button"
              onClick={() => setDeciding(false)}
              className="w-full pt-1 pb-0.5 text-center text-xs font-medium text-neutral-400"
            >
              ‹ Back
            </button>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {row(
                "coming_up",
                <CalendarDays size={16} />,
                "Coming up",
                "Make the plan, invite people after",
                pick(onComingUp),
                // The default everywhere (Oct 15 ruling) — unless an open
                // list makes We-can't-decide THE contextual option.
                !listContext
              )}
              {row(
                "now",
                <MapPin size={16} />,
                "Happening now",
                "Friends can see it and join you",
                pick(onNow),
                false
              )}
              {row(
                "past",
                <Moon size={16} />,
                "Already happened",
                "Add it from the camera roll",
                pick(onPast),
                false
              )}
              {row(
                "undecided",
                <Shuffle size={16} />,
                "Decide together",
                listContext
                  ? `Pick from ${listContext.emoji} ${listContext.name} · ${listContext.ids.length} places`
                  : "Make an unplanned plan. The app helps pick",
                () => setDeciding(true),
                !!listContext
              )}
            </div>

            {tab === "map" && (onAddSpot || onImportMap) && (
              <>
                <p className="mt-4 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                  Map it out
                </p>
                <div className="space-y-2">
                  {onAddSpot &&
                    row(
                      "add_spot",
                      <MapPin size={16} />,
                      "Add a spot",
                      "Toilets, parking, study spots. Friends only",
                      pick(onAddSpot),
                      false
                    )}
                  {onImportMap &&
                    row(
                      "import_map",
                      <Upload size={16} />,
                      "Import a map",
                      "Bring your saved Google Maps places in",
                      pick(onImportMap),
                      false
                    )}
                </div>
              </>
            )}

            {tab === "profile" && onAddFriend && (
              <>
                <p className="mt-4 mb-1.5 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                  People
                </p>
                <div className="space-y-2">
                  {row(
                    "add_friend",
                    <UserPlus size={16} />,
                    "Add a friend",
                    "Nights are better shared",
                    pick(onAddFriend),
                    false
                  )}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
