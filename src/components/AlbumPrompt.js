// CREATE ALBUM — the one popup, three doors (Aug 21, Mark: the album is
// the explicit upgrade, offered lightly; "Make it an event" failed as a
// prompt). Shown after a check-in saves (all form doors), after the
// drawer's "Did you go? → Yes", and never forced — Not now leaves a plain
// check-in whose card offers the same upgrade forever.
import { createPortal } from "react-dom";

export function AlbumPrompt({ venueName, busy, onCreate, onSkip }) {
  return createPortal(
    // CENTERED card, not a bottom sheet (Mark, Aug 21: "I prefer the one
    // that happens after you select a place in a session").
    <div className="fixed inset-0 z-[4300] flex items-center justify-center p-6">
      <button
        type="button"
        aria-label="Not now"
        onClick={onSkip}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative w-full max-w-sm rounded-3xl bg-white p-5 shadow-xl">
        <h2 className="text-xl font-semibold tracking-tight">
          Create an album?
        </h2>
        <p className="mt-1 text-sm text-neutral-600">
          Want to collect photos from {venueName ? venueName : "the night"}?
          Everyone on the check-in can add theirs, and a share link collects
          the rest.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={onCreate}
          className="mt-4 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition disabled:opacity-60"
        >
          {busy ? "Creating…" : "Create album"}
        </button>
        <button
          type="button"
          onClick={onSkip}
          className="mt-3 w-full text-center text-sm text-neutral-500"
        >
          Not now
        </button>
      </div>
    </div>,
    document.body
  );
}
