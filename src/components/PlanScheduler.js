// THE SCHEDULER (Aug 1, Mark) — ONE implementation for every "We're going
// here" (concurrent board + curated board; Mark, Aug: "Does the same UI and
// UX happen for the shortlist?" — now it does, structurally: the sheet, the
// decide, the pushes and the album prompt live HERE, so the boards can't
// drift apart the way the friend-request surfaces once did).
//
//   step 1: when are you going (Right now / Choose date+time) → per-friend
//           "Tell them" pushes → copyable public link that CARRIES the plan
//           (?when= → PublicVenuePage banner) → Done locks it
//   step 2: locked ✓ → "Want the album ready?" → Been add form prefilled,
//           session friends auto-invited onto the night
//
// PORTALED to body: the venue card underneath portals too, so an in-tree
// overlay would be trapped in the caller's stacking context and paint
// UNDERNEATH regardless of z (Mark's field report). pb-28 keeps the CTA
// clear of the bottom tab bar.
//
// The parent owns: opening the venue card under the sheet, and applying the
// decision to its own board state via onDecided(venueId, decidedForIso).
import { useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../supabaseClient";
import { sendPush } from "../lib/push";

export function PlanScheduler({
  sessionId,
  userId,
  venue, // full venue object — the pick
  participants = [], // session_participants rows ({user_id, display_name})
  showToast,
  onScheduleNight, // (venue, dateStr|"", inviteeIds) → Been add form prefilled
  onDecided, // (venueId, decidedForIso) → parent updates its decided state
  onClose,
}) {
  const [step, setStep] = useState(1);
  const [when, setWhen] = useState("now"); // "now" | "date"
  const [dateTime, setDateTime] = useState("");
  const [told, setTold] = useState(() => new Set());
  const [deciding, setDeciding] = useState(false);

  const venueName = venue?.name || "This spot";
  const friends = (participants || []).filter(
    (p) => p.user_id && p.user_id !== userId
  );
  const dateMissing = when === "date" && !dateTime;

  function whenText() {
    if (when === "now" || !dateTime) return "tonight";
    const d = new Date(dateTime);
    return `${d.toLocaleDateString("en-AU", {
      weekday: "long",
      day: "numeric",
      month: "short",
    })} · ${d.toLocaleTimeString("en-AU", {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }

  function planUrl() {
    const base = `https://flanit.co/v/${venue?.id}`;
    return when === "date" && dateTime
      ? `${base}?when=${encodeURIComponent(new Date(dateTime).toISOString())}`
      : base;
  }

  function pushBody() {
    return when === "now" || !dateTime
      ? "The plan is locked — see you there"
      : `Locked in for ${whenText()}`;
  }

  // Per-friend push (Mark's mock) — "Tell them" carries the details as
  // currently chosen. Done re-pushes anyone not yet told, so nobody's missed.
  function tellFriend(uid) {
    if (!uid) return;
    sendPush(uid, `${venueName} it is 🎉`, pushBody());
    setTold((prev) => new Set([...prev, uid]));
  }

  async function copyPlanLink() {
    try {
      await navigator.clipboard.writeText(planUrl());
      showToast?.("Link copied");
    } catch {
      showToast?.("Couldn't copy — long-press the link");
    }
  }

  async function lockItIn() {
    if (deciding || !venue?.id) return;
    setDeciding(true);
    const { error } = await supabase.rpc("set_curated_decision", {
      p_session_id: sessionId,
      p_venue_id: venue.id,
    });
    setDeciding(false);
    if (error) {
      console.error("set_curated_decision failed:", error);
      showToast?.("Couldn't save — try again");
      return;
    }
    // Persist the WHEN (Aug 1) — without this the plan's time lived only in
    // push text and the share URL, and no in-app surface could show it.
    // Fire-and-forget; hosts already update match_sessions directly.
    const decidedForIso =
      when === "date" && dateTime
        ? new Date(dateTime).toISOString()
        : new Date().toISOString();
    supabase
      .from("match_sessions")
      .update({ decided_for: decidedForIso })
      .eq("id", sessionId)
      .eq("host_user_id", userId)
      .then(({ error: dfErr }) => {
        if (dfErr) console.error("decided_for write failed:", dfErr);
      });
    onDecided?.(venue.id, decidedForIso);
    // Anyone not personally told gets the push now — Done means everyone knows.
    for (const p of friends) {
      if (!told.has(p.user_id)) {
        sendPush(p.user_id, `${venueName} it is 🎉`, pushBody());
      }
    }
    setStep(2);
  }

  if (!venue) return null;
  return createPortal(
    <div className="fixed inset-0 z-[4200] flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative w-full max-w-sm rounded-t-3xl sm:rounded-3xl bg-white p-5 pb-28 sm:pb-5 shadow-xl max-h-[85vh] overflow-y-auto">
        {step === 1 ? (
          <>
            <h2 className="text-xl font-semibold tracking-tight">
              {venueName} it is 🎉
            </h2>
            <p className="mt-1 text-sm text-neutral-600">When are you going?</p>
            {/* SEGMENTED control (Mark's pick, Aug 1 — same style as the
                advanced Matches | Suburb only | 3h row): grey track, white
                active segment. Labels stay LITERAL — "Choose date" never
                echoes the date; the input below owns that. */}
            <div className="mt-4 flex bg-neutral-100 rounded-full p-0.5 text-sm font-medium">
              <button
                type="button"
                onClick={() => {
                  setWhen("now");
                  setDateTime("");
                }}
                className={`flex-1 rounded-full py-2.5 transition ${
                  when === "now"
                    ? "bg-white text-[#455d3b] shadow-sm"
                    : "text-neutral-500"
                }`}
              >
                Right now
              </button>
              <button
                type="button"
                onClick={() => {
                  if (when === "date") return;
                  setWhen("date");
                  // Never a blank picker (Mark): default to the next sensible
                  // evening — 7pm today, or tomorrow if 7pm has passed. Local
                  // time, hand-built (toISOString would shift to UTC).
                  if (!dateTime) {
                    const d = new Date();
                    if (d.getHours() >= 19) d.setDate(d.getDate() + 1);
                    const pad = (n) => String(n).padStart(2, "0");
                    setDateTime(
                      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T19:00`
                    );
                  }
                }}
                className={`flex-1 rounded-full py-2.5 transition ${
                  when === "date"
                    ? "bg-white text-[#455d3b] shadow-sm"
                    : "text-neutral-500"
                }`}
              >
                Choose date
              </button>
            </div>
            {/* Date AND time (Mark's mock note). datetime-local gives both in
                one native picker; text-base keeps iOS from zooming. */}
            {when === "date" && (
              <input
                type="datetime-local"
                value={dateTime}
                onChange={(e) => setDateTime(e.target.value)}
                className="mt-2 w-full appearance-none rounded-2xl border border-[#cdd9c6] bg-white px-3 py-3 text-base focus:outline-none focus:border-[#455d3b]"
              />
            )}

            {/* Friends in session — each gets the details as a push. */}
            {friends.length > 0 && (
              <div className="mt-5">
                <p className="text-xs font-medium text-neutral-500">
                  Friends in session
                </p>
                <div className="mt-2 space-y-2">
                  {friends.map((p) => (
                    <div key={p.user_id} className="flex items-center gap-3">
                      <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                        {p.display_name || "A guest"}
                      </span>
                      <button
                        type="button"
                        // No details, no telling (Mark): a "date" choice with
                        // no date would push wrong info.
                        disabled={told.has(p.user_id) || dateMissing}
                        onClick={() => tellFriend(p.user_id)}
                        className={`shrink-0 rounded-full px-3.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                          told.has(p.user_id)
                            ? "bg-[#edf2eb] text-[#455d3b]"
                            : "bg-[#455d3b] text-white active:scale-95"
                        }`}
                      >
                        {told.has(p.user_id) ? "Told ✓" : "Tell them"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Public link — carries the WHEN, so the page shows the plan,
                not just the venue (Mark: "a time and date along with the
                business card"). */}
            <div className="mt-5">
              <p className="text-xs font-medium text-neutral-500">
                Share details with people not on Flanit
              </p>
              <div className="mt-2 flex items-center gap-2">
                <span className="flex-1 min-w-0 truncate rounded-full border border-neutral-200 bg-neutral-50 px-4 py-2.5 text-xs text-neutral-500">
                  {planUrl().replace("https://", "")}
                </span>
                <button
                  type="button"
                  disabled={dateMissing}
                  onClick={copyPlanLink}
                  className="shrink-0 rounded-full bg-[#455d3b] px-4 py-2 text-xs font-medium text-white active:scale-95 transition disabled:opacity-50"
                >
                  Copy
                </button>
              </div>
            </div>

            <button
              type="button"
              disabled={deciding || dateMissing}
              onClick={lockItIn}
              className="mt-5 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition disabled:opacity-60"
            >
              {deciding ? "Locking…" : "Done"}
            </button>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold tracking-tight">Locked in ✓</h2>
            <p className="mt-1 text-sm text-neutral-600">
              {venueName}, {when === "now" ? "tonight" : whenText()}. Everyone's
              been told.
            </p>
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
                    const dateStr =
                      when === "date" && dateTime ? dateTime.slice(0, 10) : "";
                    // AUTO-INVITE (Aug, Mark) — the session's people ride
                    // along; BeenScreen tags them on the created night.
                    const invitees = friends.map((p) => p.user_id);
                    onClose?.();
                    onScheduleNight(venue, dateStr, invitees);
                  }}
                  className="mt-3 w-full rounded-2xl bg-[#455d3b] py-2.5 text-sm font-medium text-white active:scale-[0.98] transition"
                >
                  Set up the album
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={onClose}
              className="mt-3 w-full text-center text-sm text-neutral-500"
            >
              Not now
            </button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
