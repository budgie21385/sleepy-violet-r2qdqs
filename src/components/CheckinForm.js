// THE ONE CHECK-IN FORM (Aug, Mark: "combine the check in experiences...
// the been draw to be the standard" + "It should stay on the same page you
// are on"). Extracted from BeenScreen so it can OVERLAY any page — map,
// profile, a results board — with no tab switch. Four doors, one form:
//   venue card "Check in"  → venue prefilled, Right now selected
//   the + menu "Check in"  → empty form, search open, Right now selected
//   Been "+ Add"           → date mode (yesterday)
//   scheduler album prompt → date mode, plan's date+time, invitees riding
// PRESENCE IS THE TOGGLE: "Show on live map" (default off) is the only
// thing that puts anyone on live surfaces — never the timestamp.
//
// Mounted by App when `prefill` exists; unmounts on close, so state
// initializers read the prefill directly (fresh mount per open).
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { MapPin, Home } from "lucide-react";
import { supabase } from "../supabaseClient";
import { sendPush } from "../lib/push";
import {
  searchPlaces,
  addGooglePlace,
  createPersonalPlace,
} from "../lib/venueSearch";

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export function CheckinForm({ userId, prefill, onClose, onCreated, showToast }) {
  const todayStr = localDateStr();
  const [addLabel, setAddLabel] = useState("");
  const [addQ, setAddQ] = useState("");
  const [addResults, setAddResults] = useState([]);
  const [addGoogle, setAddGoogle] = useState([]);
  const [addingPlaceId, setAddingPlaceId] = useState(null);
  const [addVenues, setAddVenues] = useState(() =>
    prefill?.venue ? [prefill.venue] : []
  );
  const [addSearching, setAddSearching] = useState(() => !prefill?.venue);
  const [addBlurred, setAddBlurred] = useState(false);
  const [addMode, setAddMode] = useState(() =>
    prefill?.mode === "now" ? "now" : "date"
  );
  const [addDate, setAddDate] = useState(() =>
    prefill?.date
      ? prefill.date
      : prefill?.mode === "now"
      ? localDateStr()
      : localDateStr(new Date(Date.now() - 24 * 60 * 60 * 1000))
  );
  const [addTime, setAddTime] = useState(() => prefill?.time || "");
  const [addShowLive, setAddShowLive] = useState(false);
  const [addSaving, setAddSaving] = useState(false);
  const addInvitees = prefill?.invitees || [];
  // BORN-ALBUM (Aug 21): the scheduler door creates the album directly —
  // its own popup already asked, so the post-save prompt must not double-ask.
  const bornAlbum = prefill?.album === true;

  useEffect(() => {
    const q = addQ.trim();
    if (q.length < 2) {
      setAddResults([]);
      setAddGoogle([]);
      return;
    }
    const t = setTimeout(async () => {
      const { venues, google } = await searchPlaces(q, userId);
      setAddResults(venues);
      setAddGoogle(google);
    }, 250);
    return () => clearTimeout(t);
  }, [addQ, userId]);

  function pickVenue(v) {
    if (!v) return;
    setAddVenues((prev) =>
      prev.some((x) => x.id === v.id) ? prev : [...prev, v]
    );
    setAddSearching(false);
    setAddQ("");
    setAddResults([]);
    setAddGoogle([]);
  }

  async function pickGooglePlace(r) {
    if (addingPlaceId) return;
    setAddingPlaceId(r.place_id);
    try {
      pickVenue(await addGooglePlace(r.place_id));
    } catch (e) {
      console.error("Google check-in pick failed:", e);
      showToast?.("Couldn't add that place");
    }
    setAddingPlaceId(null);
  }

  async function confirmAddNight() {
    const first = addVenues[0];
    if (!first || addSaving) return;
    if (addMode === "date" && !addDate) return;
    setAddSaving(true);
    // "Right now" = the actual clock time. A dated TODAY/FUTURE night lands
    // at its chosen time (default 7pm); a PAST night lands at 8pm, inside
    // the ±12h same-night window.
    const isNow = addMode === "now";
    let ts;
    if (isNow) ts = new Date();
    else if (addDate >= todayStr)
      ts = new Date(`${addDate}T${addTime || "19:00"}:00`);
    else ts = new Date(`${addDate}T20:00:00`);
    const liveEligible = isNow || (addMode === "date" && addDate >= todayStr);
    const showLive = liveEligible && addShowLive;
    const W = 12 * 60 * 60 * 1000;
    // Already have a check-in that night? Open it instead of a dupe twin.
    const { data: existing } = await supabase
      .from("activities")
      .select("id, created_at, label")
      .eq("user_id", userId)
      .eq("venue_id", first.id)
      .eq("kind", "checkin")
      .gte("created_at", new Date(ts.getTime() - W).toISOString())
      .lte("created_at", new Date(ts.getTime() + W).toISOString())
      .limit(1);
    const label = addLabel.trim() || null;
    let act = existing?.[0] || null;
    // Reopening an existing plain night through the album door (scheduler)
    // flips its album on — own row, plain update.
    if (act && bornAlbum) {
      await supabase
        .from("activities")
        .update({ is_album: true })
        .eq("id", act.id);
    }
    if (act && label && !act.label) {
      const { error: lblErr } = await supabase
        .from("activities")
        .update({ label })
        .eq("id", act.id);
      if (lblErr) console.error("Check-in label update failed:", lblErr);
      else act = { ...act, label };
    }
    if (!act) {
      const { data: inserted, error } = await supabase
        .from("activities")
        .insert({
          user_id: userId,
          kind: "checkin",
          venue_id: first.id,
          label,
          created_at: ts.toISOString(),
          show_live: showLive,
          is_album: bornAlbum, // night-level flag lives on the root
        })
        .select("id, created_at, label")
        .single();
      if (error) {
        console.error("Check-in failed:", error);
        showToast?.("Couldn't save — try again");
        setAddSaving(false);
        return;
      }
      act = inserted;
    }

    // The trail: legs point at the root via joined_from — the cluster folds
    // them into one card, one album, one guest list (July 31 doctrine).
    const rest = addVenues.slice(1);
    if (rest.length > 0) {
      const legs = rest.map((v, i) => ({
        user_id: userId,
        kind: "checkin",
        venue_id: v.id,
        label: null,
        joined_from: act.id,
        created_at: new Date(
          new Date(act.created_at).getTime() + (i + 1) * 60 * 60 * 1000
        ).toISOString(),
        show_live: showLive, // one night, one visibility choice
      }));
      const { error: legErr } = await supabase.from("activities").insert(legs);
      if (legErr) {
        console.error("Check-in legs failed:", legErr);
        showToast?.("Added the night, but some places didn't save");
      }
    }

    // AUTO-INVITE the session's people (Aug, Mark) — pending tag + push on
    // the ROOT; 23505 (already tagged / self-requested) left alone.
    if (addInvitees.length > 0) {
      const future = new Date(act.created_at).getTime() > Date.now();
      const dateTxt = new Date(act.created_at).toLocaleDateString("en-AU", {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
      for (const uid of addInvitees) {
        if (!uid || uid === userId) continue;
        const { error: tagErr } = await supabase
          .from("activity_tags")
          .insert({ activity_id: act.id, tagged_user_id: uid });
        if (!tagErr) {
          sendPush(
            uid,
            future ? "You're on the plan 🎉" : "You've been checked in",
            future
              ? `${label || first.name} · ${dateTxt} — accept to join the night`
              : `${label || first.name} — accept to add it to your Been list`
          );
        } else if (tagErr.code !== "23505") {
          console.error("Auto-invite failed:", tagErr);
        }
      }
    }

    onCreated?.({
      activityId: act.id,
      ownerId: userId,
      ownerName: "You",
      ownerProfile: null,
      venueName: first.name,
      label: act.label || null,
      venueObj: first,
      timestamp: act.created_at,
      bornAlbum, // App skips the album prompt when the door already asked
    });
  }

  return createPortal(
    <div className="fixed inset-0 z-[4000]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div
        className="absolute left-0 right-0 top-12 mx-auto max-w-sm bg-white rounded-3xl shadow-2xl overflow-y-auto p-5"
        style={{ width: "calc(100% - 1.5rem)", maxHeight: "calc(100% - 130px)" }}
      >
        <div className="flex items-start justify-between mb-1">
          <p className="text-sm font-semibold">
            {addMode === "now" ? "Check in" : "Create a check-in"}
          </p>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mt-1 -mr-1 w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-100"
          >
            ✕
          </button>
        </div>
        <p className="text-[11px] text-neutral-500 mb-3">
          It lands in your Been list. Add photos and videos after, and if
          friends checked in that night, their moments show up too.
        </p>
        {/* What / Where / When (Mark, Aug 20) — three questions, no more
            words. Also settles audit #4: flat labels beat mode-aware ones. */}
        <label className="block text-[11px] font-medium text-neutral-500 mb-1 px-1">
          What?
        </label>
        <input
          value={addLabel}
          onChange={(e) => setAddLabel(e.target.value)}
          placeholder="Renasha's birthday (optional)"
          maxLength={80}
          className="w-full rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b] mb-3"
        />

        <label className="block text-[11px] font-medium text-neutral-500 mb-1 px-1">
          Where?
        </label>
        {addVenues.map((v, i) => (
          <div
            key={v.id}
            className="flex items-center gap-2.5 rounded-xl bg-neutral-50 px-3 py-2.5 mb-1.5"
          >
            <MapPin size={15} className="shrink-0 text-[#455d3b]" />
            <span className="flex-1 min-w-0 truncate text-sm font-medium text-neutral-900">
              {v.name}
            </span>
            {i > 0 && (
              <span className="text-[11px] text-neutral-400 shrink-0">then</span>
            )}
            <button
              type="button"
              aria-label={`Remove ${v.name}`}
              onClick={() =>
                setAddVenues((prev) => prev.filter((x) => x.id !== v.id))
              }
              className="text-xs text-neutral-500 underline shrink-0"
            >
              Remove
            </button>
          </div>
        ))}
        {!addSearching ? (
          <button
            type="button"
            onClick={() => setAddSearching(true)}
            className="mt-1 mb-1 text-xs text-[#455d3b] underline underline-offset-2"
          >
            + Add another location
          </button>
        ) : (
          <>
            <input
              value={addQ}
              onChange={(e) => {
                setAddQ(e.target.value);
                setAddBlurred(false);
              }}
              onBlur={() => setAddBlurred(true)}
              placeholder="Search for the place, or type your own"
              className="w-full rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b]"
            />
            {addVenues.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setAddSearching(false);
                  setAddQ("");
                  setAddResults([]);
                  setAddGoogle([]);
                }}
                className="mt-1.5 text-xs text-neutral-500 underline underline-offset-2"
              >
                Cancel
              </button>
            )}
            <div className="mt-2 space-y-1">
              {addResults.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => pickVenue(v)}
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
              {addGoogle.length > 0 && (
                <>
                  <p className="px-2 pt-2 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                    More places
                  </p>
                  {addGoogle.map((r) => (
                    <button
                      key={r.place_id}
                      type="button"
                      disabled={!!addingPlaceId}
                      onClick={() => pickGooglePlace(r)}
                      className="w-full flex items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-neutral-50 active:scale-[0.99] transition disabled:opacity-50"
                    >
                      <MapPin size={15} className="shrink-0 text-neutral-300" />
                      <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                        {r.name}
                      </span>
                      <span className="text-[11px] text-neutral-400 shrink-0 truncate max-w-[110px]">
                        {addingPlaceId === r.place_id ? "Adding…" : r.address || ""}
                      </span>
                    </button>
                  ))}
                </>
              )}
              {addQ.trim().length >= 2 && (
                <div
                  className={`mt-2 rounded-xl border p-2.5 transition ${
                    addBlurred && addResults.length === 0
                      ? "border-[#455d3b] bg-[#edf2eb]"
                      : "border-neutral-200 bg-white"
                  }`}
                >
                  <button
                    type="button"
                    disabled={addingPlaceId === "personal"}
                    onClick={async () => {
                      setAddingPlaceId("personal");
                      const v = await createPersonalPlace(addQ, userId);
                      setAddingPlaceId(null);
                      if (v) pickVenue(v);
                      else showToast?.("Couldn't add that place");
                    }}
                    className="w-full flex items-center gap-2.5 text-left active:scale-[0.99] transition disabled:opacity-50"
                  >
                    <Home size={15} className="shrink-0 text-[#455d3b]" />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium text-neutral-900 truncate">
                        Use "{addQ.trim()}"
                      </span>
                      <span className="block text-[11px] text-neutral-500">
                        A place of your own — just a name. No address, and it
                        won't appear on the map.
                      </span>
                    </span>
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        <label className="mt-3 block text-[11px] font-medium text-neutral-500 mb-1 px-1">
          When?
        </label>
        <div className="mb-2 flex bg-neutral-100 rounded-full p-0.5 text-sm font-medium">
          <button
            type="button"
            onClick={() => setAddMode("now")}
            className={`flex-1 rounded-full py-2.5 transition ${
              addMode === "now"
                ? "bg-white text-[#455d3b] shadow-sm"
                : "text-neutral-500"
            }`}
          >
            Right now
          </button>
          <button
            type="button"
            onClick={() => setAddMode("date")}
            className={`flex-1 rounded-full py-2.5 transition ${
              addMode === "date"
                ? "bg-white text-[#455d3b] shadow-sm"
                : "text-neutral-500"
            }`}
          >
            Choose date
          </button>
        </div>
        {addMode === "date" && (
          <div className="mb-2 flex gap-2">
            <input
              type="date"
              value={addDate}
              onChange={(e) => setAddDate(e.target.value)}
              className="flex-1 min-w-0 appearance-none bg-white text-left rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b]"
            />
            {addDate >= todayStr && (
              <input
                type="time"
                value={addTime || "19:00"}
                onChange={(e) => setAddTime(e.target.value)}
                className="w-28 shrink-0 appearance-none bg-white text-left rounded-full border border-neutral-200 px-3 py-2.5 text-base focus:outline-none focus:border-[#455d3b]"
              />
            )}
          </div>
        )}
        {addMode === "date" && addDate > todayStr && (
          <p className="mb-2 px-1 text-[11px] text-[#455d3b]">
            Upcoming night — the card's ready now, so you can share the photo
            link before the day.
          </p>
        )}
        {addMode === "now" || (addMode === "date" && addDate >= todayStr) ? (
          <div className="mb-3 rounded-2xl border border-neutral-200 px-3.5 py-2.5">
            <div className="flex items-center gap-3">
              <span className="flex-1 text-sm font-medium text-neutral-800">
                Show on live map
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={addShowLive}
                onClick={() => setAddShowLive((v) => !v)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition ${
                  addShowLive ? "bg-[#455d3b]" : "bg-neutral-300"
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all ${
                    addShowLive ? "left-[22px]" : "left-0.5"
                  }`}
                />
              </button>
            </div>
            <p className="mt-1 text-[11px] text-neutral-500">
              {!addShowLive
                ? "Off — friends won't see you're here"
                : addMode === "now"
                ? `Friends see you're at ${addVenues[0]?.name || "the spot"} now`
                : `Friends see you at ${addVenues[0]?.name || "the spot"} from ${
                    addTime || "19:00"
                  } on the day`}
            </p>
          </div>
        ) : (
          <p className="mb-3 px-1 text-[11px] text-neutral-500">
            Goes in your history — never on the live map.
          </p>
        )}
        <button
          type="button"
          disabled={
            addSaving ||
            addVenues.length === 0 ||
            (addMode === "date" && !addDate)
          }
          onClick={confirmAddNight}
          className="w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white active:scale-[0.99] transition disabled:opacity-60"
        >
          {addSaving
            ? "Adding…"
            : addMode === "now"
            ? "Check in"
            : addDate > todayStr
            ? "Create the event"
            : "Add to Been"}
        </button>
      </div>
    </div>,
    document.body
  );
}
