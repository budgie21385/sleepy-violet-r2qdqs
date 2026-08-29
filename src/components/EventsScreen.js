// EVENTS — the fifth tab (Aug 29–30, 2026; Mark: "a new modal, similar to
// check in, that lives in its own feed. It's our future plans, it's called
// events"). Upcoming = every future night you're on — your own future
// check-ins plus nights you've accepted a tag onto — soonest first. Past =
// the deliberate tier only (is_event rows: birthdays, parties, weddings);
// ordinary nights live in Been, an event's afterlife is worth its own shelf.
// "+ Create event" opens the unified form in its EVENT variant (date-only,
// Collect photos + Open guest list toggles, no Who — invites come from the
// card). RSVPs deliberately deferred. Personal places render name + suburb
// only ("Mark's house party · Fitzroy") — the address stays behind the
// guest list, on the card.
import { useState, useEffect } from "react";
import { ArrowLeft, Camera, CalendarDays } from "lucide-react";
import { supabase } from "../supabaseClient";
import { CheckinThreadSheet } from "./CheckinThreadSheet";

export function EventsScreen({ userId, onBack, showToast, onOpenProfile, onCreateEvent, refreshSignal = 0 }) {
  const [rows, setRows] = useState(null); // null = loading
  const [pastRows, setPastRows] = useState([]);
  const [venueById, setVenueById] = useState(() => new Map());
  const [thread, setThread] = useState(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const nowIso = new Date().toISOString();
      // My own upcoming nights.
      const { data: mine } = await supabase
        .from("activities")
        .select("id, user_id, venue_id, label, created_at, is_album, is_event")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .gt("created_at", nowIso)
        .order("created_at", { ascending: true })
        .limit(50);
      // Nights I've accepted a tag onto (someone invited me).
      const { data: tags } = await supabase
        .from("activity_tags")
        .select("activity_id")
        .eq("tagged_user_id", userId)
        .eq("status", "accepted")
        .limit(200);
      const tagIds = (tags || []).map((t) => t.activity_id);
      let invited = [];
      if (tagIds.length > 0) {
        const { data: acts } = await supabase
          .from("activities")
          .select("id, user_id, venue_id, label, created_at, is_album, is_event")
          .in("id", tagIds)
          .gt("created_at", nowIso);
        invited = acts || [];
      }
      const seen = new Set();
      const upcoming = [...(mine || []), ...invited]
        .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

      // PAST EVENTS (Mark, Aug 29: "Let's also add a section for past
      // events") — is_event only, own or accepted-invite, newest first.
      const { data: pastMine } = await supabase
        .from("activities")
        .select("id, user_id, venue_id, label, created_at, is_album, is_event")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .eq("is_event", true)
        .lte("created_at", nowIso)
        .order("created_at", { ascending: false })
        .limit(20);
      let pastInvited = [];
      if (tagIds.length > 0) {
        const { data: acts } = await supabase
          .from("activities")
          .select("id, user_id, venue_id, label, created_at, is_album, is_event")
          .in("id", tagIds)
          .eq("is_event", true)
          .lte("created_at", nowIso);
        pastInvited = acts || [];
      }
      const seenPast = new Set();
      const past = [...(pastMine || []), ...pastInvited]
        .filter((a) => (seenPast.has(a.id) ? false : seenPast.add(a.id)))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, 20);

      // Venues for the rows (open reads — unresolvable ones fall back).
      const vids = Array.from(
        new Set(
          [...upcoming, ...past].map((a) => a.venue_id).filter(Boolean)
        )
      );
      let vMap = new Map();
      if (vids.length > 0) {
        const { data: vens } = await supabase
          .from("venues")
          .select("*")
          .in("id", vids);
        vMap = new Map((vens || []).map((v) => [v.id, v]));
      }
      if (cancelled) return;
      setVenueById(vMap);
      setRows(upcoming);
      setPastRows(past);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, reloadTick, refreshSignal]);

  function whenText(ts, withTime = true) {
    const d = new Date(ts);
    const day = d.toLocaleDateString("en-AU", {
      weekday: "short",
      day: "numeric",
      month: "short",
    });
    if (!withTime) return day;
    return `${day} · ${d.toLocaleTimeString("en-AU", {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }

  function renderRow(a, { past = false } = {}) {
    const venue = venueById.get(a.venue_id) || null;
    const isMine = a.user_id === userId;
    const placeBits = [
      a.label && venue?.name ? venue.name : null,
      venue?.source === "personal" && venue?.suburb ? venue.suburb : null,
    ].filter(Boolean);
    return (
      <button
        key={a.id}
        type="button"
        onClick={() =>
          setThread({
            activityId: a.id,
            ownerId: a.user_id,
            ownerName: isMine ? "You" : "Host",
            ownerProfile: null,
            venueName: venue?.name || "a spot",
            label: a.label || null,
            venueObj: venue,
            timestamp: a.created_at,
          })
        }
        className="w-full rounded-2xl bg-white border border-neutral-100 p-3 flex items-center gap-3 text-left hover:bg-neutral-50 active:scale-[0.99] transition"
      >
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${
            past
              ? "bg-neutral-100 text-neutral-500"
              : "bg-[#455d3b]/10 text-[#455d3b]"
          }`}
        >
          {a.is_album ? <Camera size={16} /> : <CalendarDays size={16} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-neutral-900 truncate">
            {a.label || venue?.name || "A spot"}
          </p>
          <p className="text-[11px] text-neutral-500 truncate">
            {placeBits.length > 0 ? `${placeBits.join(" · ")} · ` : ""}
            {whenText(a.created_at, !past)}
            {isMine || past ? "" : " · you're invited"}
          </p>
        </div>
        <span className="text-neutral-400 text-lg leading-none shrink-0">›</span>
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-[2500] overflow-y-auto bg-[#fdf6f0]">
      <div className="mx-auto w-full max-w-sm p-4 pb-24">
        <div className="mb-5 flex items-center gap-3">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Back"
              className="flex h-10 w-10 items-center justify-center rounded-full bg-white border border-neutral-100 text-neutral-600 shadow-sm"
            >
              <ArrowLeft size={16} />
            </button>
          )}
          <div>
            <p className="text-sm text-neutral-500">Your future plans</p>
            <h1 className="text-2xl font-semibold tracking-tight">Events</h1>
          </div>
          <button
            type="button"
            onClick={onCreateEvent}
            className="ml-auto rounded-full bg-[#455d3b] text-white text-xs font-medium px-3.5 py-2 active:scale-95 transition"
          >
            + Create event
          </button>
        </div>

        {rows === null && (
          <p className="text-sm text-neutral-500 text-center py-8">Loading…</p>
        )}
        {rows !== null && rows.length === 0 && (
          <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 text-center">
            <p className="text-sm text-neutral-600">Nothing planned yet.</p>
            <p className="text-xs text-neutral-500 mt-1">
              Create an event and the album is ready before the night — share
              the photo link ahead.
            </p>
          </div>
        )}
        <div className="space-y-2">{(rows || []).map((a) => renderRow(a))}</div>

        {pastRows.length > 0 && (
          <>
            <p className="mt-6 mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              Past events
            </p>
            <div className="space-y-2">
              {pastRows.map((a) => renderRow(a, { past: true }))}
            </div>
          </>
        )}
      </div>

      {thread && (
        <CheckinThreadSheet
          thread={thread}
          userId={userId}
          showToast={showToast}
          onClose={() => {
            setThread(null);
            setReloadTick((n) => n + 1);
          }}
          onOpenProfile={(uid) => {
            if (uid === userId) setThread(null);
            onOpenProfile?.(uid);
          }}
        />
      )}
    </div>
  );
}
