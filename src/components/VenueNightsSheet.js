// VENUE NIGHTS SHEET (Sep 6, 2026 — the Been list behind a Past-lens pin).
// One venue, every night you + your friends have had there, plus bare
// been-marks. Two row kinds, per Mark's Aug 20 ruling: a night (people,
// date, photos — opens the card) and a bare mark ("James has been here" —
// nothing behind it, nothing to open). This is the same list the venue
// card's strip will eventually front (04-next); the map got there first.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "../supabaseClient";

function firstName(profile, isSelf) {
  if (isSelf) return "You";
  return (profile?.display_name || "A friend").split(" ")[0];
}

// "You, Resha and Tom" / "You, Resha + 2 more" — own name first, always You.
function namesLine(entries, userId) {
  const seen = new Set();
  const people = [];
  for (const e of entries) {
    if (seen.has(e.user_id)) continue;
    seen.add(e.user_id);
    people.push({ id: e.user_id, name: firstName(e.profile, e.user_id === userId) });
  }
  people.sort((a, b) => (a.id === userId ? -1 : b.id === userId ? 1 : 0));
  const names = people.map((p) => p.name);
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} + ${names.length - 2} more`;
}

function nightDate(ts) {
  const d = new Date(ts);
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-AU", opts);
}

function Avatar({ profile, isSelf }) {
  if (profile?.avatar_url) {
    return (
      <img
        src={profile.avatar_url}
        alt=""
        className="w-8 h-8 rounded-full object-cover bg-white shrink-0"
      />
    );
  }
  const initial = (isSelf ? "Y" : (profile?.display_name || "?").trim().charAt(0)).toUpperCase();
  return (
    <div className="w-8 h-8 rounded-full bg-[#455d3b] text-white text-xs font-semibold flex items-center justify-center shrink-0">
      {initial}
    </div>
  );
}

export function VenueNightsSheet({ group, userId, onClose, onOpenNight }) {
  // Photo counts arrive after the sheet opens — a count of zero simply
  // renders no photos segment, so there's nothing to wait for.
  const [photoCounts, setPhotoCounts] = useState({});
  useEffect(() => {
    const ids = group.nights.flatMap((n) => n.entries.map((e) => e.id));
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("activity_photos")
        .select("activity_id")
        .in("activity_id", ids);
      if (cancelled) return;
      const counts = {};
      for (const r of data || []) {
        counts[r.activity_id] = (counts[r.activity_id] || 0) + 1;
      }
      setPhotoCounts(counts);
    })();
    return () => {
      cancelled = true;
    };
  }, [group]);

  const people = new Set([
    ...group.nights.flatMap((n) => n.entries.map((e) => e.user_id)),
    ...group.marks.map((m) => m.user_id),
  ]);
  const friendCount = people.size - (people.has(userId) ? 1 : 0);
  const summary = [
    `${group.nights.length} ${group.nights.length === 1 ? "night" : "nights"}`,
    people.has(userId)
      ? friendCount > 0
        ? `you and ${friendCount} ${friendCount === 1 ? "friend" : "friends"}`
        : "just you"
      : `${friendCount} ${friendCount === 1 ? "friend" : "friends"}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return createPortal(
    <div className="fixed inset-0 z-[3300]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="absolute left-0 right-0 bottom-0 max-h-[75%] flex flex-col bg-white rounded-t-3xl shadow-2xl">
        <div className="px-5 pt-3 pb-2">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
          <h2 className="text-base font-semibold leading-tight">
            {group.venue.name}
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">{summary}</p>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-6">
          {group.nights.map((night) => {
            const label =
              night.entries.find((e) => e.label)?.label || null;
            const isAlbum = night.entries.some((e) => e.is_album);
            const photos = night.entries.reduce(
              (sum, e) => sum + (photoCounts[e.id] || 0),
              0
            );
            const names = namesLine(night.entries, userId);
            const face =
              night.entries.find((e) => e.user_id === userId) ||
              night.entries[0];
            const sub = [
              label ? names : null,
              nightDate(night.entries[0].created_at),
              photos > 0
                ? `${photos} ${photos === 1 ? "photo" : "photos"}`
                : null,
              isAlbum ? "album" : null,
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <button
                key={night.key}
                type="button"
                onClick={() => onOpenNight(night)}
                className="w-full flex items-center gap-3 py-3 border-t border-neutral-100 text-left active:bg-neutral-50 transition"
              >
                <Avatar
                  profile={face.profile}
                  isSelf={face.user_id === userId}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-neutral-900 truncate">
                    {label || names}
                  </p>
                  <p className="text-xs text-neutral-500 mt-0.5 truncate">
                    {sub}
                  </p>
                </div>
                <span className="text-neutral-300 text-lg leading-none">
                  ›
                </span>
              </button>
            );
          })}
          {group.marks.map((mark) => (
            <div
              key={`mark_${mark.user_id}`}
              className="w-full flex items-center gap-3 py-3 border-t border-neutral-100"
            >
              <Avatar
                profile={mark.profile}
                isSelf={mark.user_id === userId}
              />
              <p className="text-sm text-neutral-600">
                {firstName(mark.profile, mark.user_id === userId)}
                {mark.user_id === userId ? " have" : " has"} been here
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body
  );
}
