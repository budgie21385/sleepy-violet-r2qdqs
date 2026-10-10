// NIGHTS TIMELINE (Oct 11, 2026 — profile doctrine stage 1). The profile
// IS the person's nights in three tenses: Now / Next / Been, one list,
// three toggles (naming ruled Oct 11, "done is boring" → Been keeps its
// earned meaning). Next also carries ACTIVE SESSIONS as dashed "still
// deciding" rows — sessions stopped being a place; decided ones already
// birthed nights and appear as normal rows.
// Legs collapse into their roots (multi-stop nights are ONE night), same
// rule as the Events tab this timeline replaces.
import { useEffect, useState } from "react";
import { supabase } from "../supabaseClient";
import { nightTense, whenAgo } from "../lib/checkins";

function rowWhen(ts, tense) {
  if (tense === "now") return "happening now";
  const d = new Date(ts);
  const day = d.toLocaleDateString("en-AU", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  if (tense === "coming_up") {
    const t = d.toLocaleTimeString("en-AU", {
      hour: "numeric",
      minute: "2-digit",
    });
    return `${day} · ${t}`;
  }
  return whenAgo(ts);
}

export function NightsTimeline({
  userId,
  onOpenThread,
  onOpenSession,
  onSeeAllBeen,
  refreshSignal = 0,
}) {
  const [tab, setTab] = useState("next"); // "now" | "next" | "been"
  const [nights, setNights] = useState(null); // null = loading
  const [sessions, setSessions] = useState([]);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      // Own nights, newest first — covers all three tenses in one query
      // (future timestamps sort above now in desc order).
      const { data: mine } = await supabase
        .from("activities")
        .select("id, user_id, venue_id, label, created_at, joined_from")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .order("created_at", { ascending: false })
        .limit(150);
      // Nights I've accepted a tag onto — invited plans belong in Next.
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
          .select("id, user_id, venue_id, label, created_at, joined_from")
          .in("id", tagIds)
          .gt("created_at", new Date().toISOString());
        invited = acts || [];
      }
      // Active sessions — hosted or joined, still undecided, recent.
      const sinceIso = new Date(
        Date.now() - 14 * 24 * 60 * 60 * 1000
      ).toISOString();
      const [{ data: hosted }, { data: partRows }] = await Promise.all([
        supabase
          .from("match_sessions")
          .select("id, mode, created_at, decided_venue_id")
          .eq("host_user_id", userId)
          .is("decided_venue_id", null)
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: false })
          .limit(10),
        supabase
          .from("session_participants")
          .select("session_id")
          .eq("user_id", userId)
          .limit(50),
      ]);
      let joined = [];
      const joinIds = (partRows || []).map((r) => r.session_id);
      if (joinIds.length > 0) {
        const { data: js } = await supabase
          .from("match_sessions")
          .select("id, mode, created_at, decided_venue_id")
          .in("id", joinIds)
          .is("decided_venue_id", null)
          .gte("created_at", sinceIso)
          .limit(10);
        joined = js || [];
      }
      const seenS = new Set();
      const liveSessions = [...(hosted || []), ...joined].filter((s) =>
        seenS.has(s.id) ? false : seenS.add(s.id)
      );

      // Merge + collapse legs (a row whose joined_from root is also here
      // folds into it — one night, one row).
      const seen = new Set();
      let all = [...(mine || []), ...invited].filter((a) =>
        seen.has(a.id) ? false : seen.add(a.id)
      );
      const ids = new Set(all.map((a) => a.id));
      all = all.filter((a) => !a.joined_from || !ids.has(a.joined_from));

      // Venue + owner names for rendering.
      const vids = Array.from(
        new Set(all.map((a) => a.venue_id).filter(Boolean))
      );
      let vById = {};
      if (vids.length > 0) {
        const { data: vens } = await supabase
          .from("venues")
          .select("*")
          .in("id", vids);
        vById = Object.fromEntries((vens || []).map((v) => [v.id, v]));
      }
      const ownerIds = Array.from(
        new Set(all.map((a) => a.user_id).filter((id) => id !== userId))
      );
      let pById = {};
      if (ownerIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", ownerIds);
        pById = Object.fromEntries((profs || []).map((p) => [p.id, p]));
      }
      if (cancelled) return;
      setNights(
        all.map((a) => ({
          ...a,
          venue: a.venue_id ? vById[a.venue_id] || null : null,
          ownerName:
            a.user_id === userId
              ? "You"
              : pById[a.user_id]?.display_name || "A friend",
        }))
      );
      setSessions(liveSessions);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, refreshSignal]);

  const bucket = (t) =>
    (nights || []).filter((a) => nightTense(a.created_at) === t);
  const rows =
    tab === "now"
      ? bucket("now")
      : tab === "next"
      ? bucket("coming_up").sort(
          (a, b) => new Date(a.created_at) - new Date(b.created_at)
        )
      : bucket("past");

  const openNight = (a) =>
    onOpenThread?.({
      activityId: a.id,
      ownerId: a.user_id,
      ownerName: a.ownerName,
      venueName: a.venue?.name || a.label || "Somewhere",
      label: a.label || null,
      venueObj: a.venue,
      timestamp: a.created_at,
    });

  const seg = (key, label) => (
    <button
      key={key}
      type="button"
      onClick={() => setTab(key)}
      className={`flex-1 rounded-full py-2 text-xs font-medium transition ${
        tab === key ? "bg-white text-[#455d3b] shadow-sm" : "text-neutral-500"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="rounded-3xl bg-white p-4 shadow-sm border border-neutral-100 mb-3">
      <div className="flex items-center justify-between mb-2.5 px-1">
        <p className="font-medium text-sm">My nights</p>
        {tab === "been" && (
          <button
            type="button"
            onClick={onSeeAllBeen}
            className="text-[11px] font-medium text-[#455d3b]"
          >
            See all ›
          </button>
        )}
      </div>
      <div className="flex bg-neutral-100 rounded-full p-0.5 mb-2.5">
        {seg("now", "Now")}
        {seg("next", "Next")}
        {seg("been", "Been")}
      </div>

      {nights === null && (
        <p className="py-3 text-center text-xs text-neutral-400">Loading…</p>
      )}

      {nights !== null && (
        <>
          {rows.slice(0, tab === "been" ? 15 : 30).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => openNight(a)}
              className="flex w-full items-center gap-3 border-t border-neutral-50 py-2.5 text-left active:bg-neutral-50 transition first:border-t-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-neutral-900">
                  {a.label || a.venue?.name || "Somewhere"}
                  {a.ownerName !== "You" && (
                    <span className="font-normal text-neutral-400">
                      {" "}
                      · {a.ownerName}'s
                    </span>
                  )}
                </p>
                <p className="truncate text-[11px] text-neutral-500">
                  {a.label && a.venue?.name ? `${a.venue.name} · ` : ""}
                  {tab === "now" ? (
                    <span className="font-medium text-[#455d3b]">
                      ● happening now
                    </span>
                  ) : (
                    rowWhen(a.created_at, nightTense(a.created_at))
                  )}
                </p>
              </div>
              <span className="text-lg leading-none text-neutral-300">›</span>
            </button>
          ))}

          {/* Active sessions ride in NEXT as dashed deciding rows — tap
              opens the board; Decide births the night and the row becomes
              a real one on the next load. */}
          {tab === "next" &&
            sessions.map((s) => (
              <button
                key={`s_${s.id}`}
                type="button"
                onClick={() => onOpenSession?.(s.id)}
                className="mt-1.5 flex w-full items-center gap-3 rounded-2xl border border-dashed border-[#cfdcc9] px-3 py-2.5 text-left active:bg-[#edf2eb]/50 transition"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-[#455d3b]">
                    Still deciding 🤔
                  </p>
                  <p className="truncate text-[11px] text-neutral-500">
                    {s.mode === "curated" ? "Shortlist" : "Pick together"} ·
                    opens the board
                  </p>
                </div>
                <span className="text-lg leading-none text-neutral-300">
                  ›
                </span>
              </button>
            ))}

          {rows.length === 0 &&
            !(tab === "next" && sessions.length > 0) && (
              <p className="py-3 text-center text-xs text-neutral-400">
                {tab === "now"
                  ? "Nothing on right now"
                  : tab === "next"
                  ? "No plans yet. The + knows what to do"
                  : "Nothing in the books yet"}
              </p>
            )}
        </>
      )}
    </div>
  );
}
