// LISTS (Oct 12, 2026 — profile doctrine, Mark's My Lists mock, v1).
// The index: the three SYSTEM lists (Saved / Been / Haven't Been) wearing
// the custom-lists clothes — they're derived, not rows, which is why they
// can't be renamed or deleted. "Create a list" ships greyed with "soon":
// a feature promise, not a door (custom + collaborative lists are the
// next stage). Hidden-venue management moved to the settings cog.
// The detail: venue rows with photo, type/suburb/rating, your Been ×N and
// the friends who've been — the knowledge layer wearing list clothes.
// Row tap → the full venue card (with Plan).
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Bookmark } from "lucide-react";
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";
import { MapVenueSheet } from "./MapVenueSheet";

function Thumb({ v }) {
  const raw = v.primary_image || null;
  const src = raw
    ? raw.includes("googleapis.com")
      ? `/api/place-photo?url=${encodeURIComponent(raw)}`
      : raw
    : null;
  return (
    <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#edf2eb] text-sm font-semibold text-[#455d3b]">
      {(v.name || "?").charAt(0).toUpperCase()}
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}

export function ListsScreen({
  userId,
  venues,
  savedIds,
  onUnsave,
  onBack,
  onCheckIn,
  onOpenThread,
  onOpenProfile,
  showToast,
}) {
  const [list, setList] = useState(null); // null = index | "saved"|"been"|"not_been"
  const [selectedVenue, setSelectedVenue] = useState(null);
  // My been venue ids (marks + own check-ins with counts).
  const [beenData, setBeenData] = useState(null); // {counts: Map, ids: Set}
  // Friends who've been, per venue (avatars on rows).
  const [friendsAt, setFriendsAt] = useState(new Map());

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const [{ data: marks }, { data: acts }, { data: fr }] =
        await Promise.all([
          supabase
            .from("been_marks")
            .select("venue_id")
            .eq("user_id", userId),
          supabase
            .from("activities")
            .select("venue_id")
            .eq("user_id", userId)
            .eq("kind", "checkin")
            .not("venue_id", "is", null)
            .lte("created_at", new Date().toISOString())
            .limit(500),
          supabase
            .from("friendships")
            .select("requester_id, addressee_id")
            .eq("status", "accepted")
            .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
        ]);
      const counts = new Map();
      for (const a of acts || []) {
        counts.set(a.venue_id, (counts.get(a.venue_id) || 0) + 1);
      }
      const ids = new Set([
        ...(marks || []).map((m) => m.venue_id),
        ...counts.keys(),
      ]);
      if (cancelled) return;
      setBeenData({ counts, ids });

      // Friends' presence at venues — marks + past check-ins, capped.
      const friendIds = Array.from(
        new Set(
          (fr || []).map((f) =>
            f.requester_id === userId ? f.addressee_id : f.requester_id
          )
        )
      );
      if (friendIds.length === 0) return;
      const [{ data: fMarks }, { data: fActs }, { data: profs }] =
        await Promise.all([
          supabase
            .from("been_marks")
            .select("venue_id, user_id")
            .in("user_id", friendIds)
            .limit(500),
          supabase
            .from("activities")
            .select("venue_id, user_id")
            .in("user_id", friendIds)
            .eq("kind", "checkin")
            .not("venue_id", "is", null)
            .lte("created_at", new Date().toISOString())
            .limit(500),
          supabase
            .from("profiles")
            .select("id, display_name, avatar_url")
            .in("id", friendIds),
        ]);
      const pById = Object.fromEntries((profs || []).map((p) => [p.id, p]));
      const at = new Map();
      for (const r of [...(fMarks || []), ...(fActs || [])]) {
        if (!r.venue_id) continue;
        if (!at.has(r.venue_id)) at.set(r.venue_id, new Map());
        const m = at.get(r.venue_id);
        if (!m.has(r.user_id) && pById[r.user_id])
          m.set(r.user_id, pById[r.user_id]);
      }
      if (!cancelled)
        setFriendsAt(
          new Map(
            Array.from(at.entries()).map(([vid, m]) => [
              vid,
              Array.from(m.values()),
            ])
          )
        );
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const vById = useMemo(
    () => new Map((venues || []).map((v) => [v.id, v])),
    [venues]
  );
  const beenIds = beenData?.ids || new Set();
  const savedList = Array.from(savedIds || [])
    .map((id) => vById.get(id))
    .filter(Boolean);
  const beenList = Array.from(beenIds)
    .map((id) => vById.get(id))
    .filter(Boolean);
  const notBeenList = savedList.filter((v) => !beenIds.has(v.id));

  const LISTS = {
    saved: { emoji: "🔖", name: "Saved", rows: savedList },
    been: { emoji: "✔️", name: "Been", rows: beenList },
    not_been: { emoji: "⏳", name: "Haven't Been", rows: notBeenList },
  };

  const row = (v) => {
    const beenCount =
      (beenData?.counts.get(v.id) || 0) || (beenIds.has(v.id) ? 1 : 0);
    const pals = (friendsAt.get(v.id) || []).slice(0, 3);
    return (
      <button
        key={v.id}
        type="button"
        onClick={() => setSelectedVenue(v)}
        className="mb-2 flex w-full items-center gap-3 rounded-2xl bg-white p-3 text-left shadow-sm border border-neutral-100 active:scale-[0.99] transition"
      >
        <Thumb v={v} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
            <span className="truncate">{v.name}</span>
            {beenCount > 0 && (
              <span className="shrink-0 text-[10px] font-medium text-[#455d3b]">
                Been{beenCount > 1 ? ` ×${beenCount}` : ""}
              </span>
            )}
          </span>
          <span className="block truncate text-[11px] text-neutral-500">
            {[v.type, v.suburb, v.rating ? `★ ${v.rating}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {pals.length > 0 && (
          <span className="flex shrink-0">
            {pals.map((p, i) => (
              <span key={p.id} style={i > 0 ? { marginLeft: -8 } : undefined}>
                <FriendAvatar profile={p} small />
              </span>
            ))}
          </span>
        )}
        {list === "saved" && (
          <span
            role="button"
            aria-label="Remove from Saved"
            onClick={(e) => {
              e.stopPropagation();
              onUnsave?.(v.id);
            }}
            className="shrink-0 p-1 text-[#455d3b]"
          >
            <Bookmark size={16} fill="#455d3b" />
          </span>
        )}
      </button>
    );
  };

  const active = list ? LISTS[list] : null;

  return (
    <div className="fixed inset-0 z-[2000] overflow-y-auto bg-[#fdf6f0] px-6 pt-6 pb-28 lg:pl-[108px]">
      <div className="mx-auto w-full max-w-sm">
        <button
          type="button"
          onClick={() => (list ? setList(null) : onBack())}
          className="mb-3 flex items-center gap-1.5 text-sm font-medium text-[#455d3b]"
        >
          <ArrowLeft size={16} /> {list ? "My Lists" : "Profile"}
        </button>

        {!list && (
          <>
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">
              My Lists
            </h1>
            {Object.entries(LISTS).map(([key, l]) => (
              <button
                key={key}
                type="button"
                onClick={() => setList(key)}
                className="mb-2.5 flex w-full items-center gap-3 rounded-2xl bg-white p-3.5 text-left shadow-sm border border-neutral-100 active:scale-[0.99] transition"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#edf2eb] text-base">
                  {l.emoji}
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-neutral-900">
                    {l.name}
                  </span>
                  <span className="block text-[11px] text-neutral-500">
                    {beenData === null && key !== "saved"
                      ? "Loading…"
                      : `${l.rows.length} place${
                          l.rows.length === 1 ? "" : "s"
                        }`}
                  </span>
                </span>
                <span className="text-lg leading-none text-neutral-300">
                  ›
                </span>
              </button>
            ))}
            {/* Custom + collaborative lists are the NEXT stage — this row
                is the feature promise (discoverability doctrine), not a
                door yet. */}
            <div className="mt-1 flex w-full items-center gap-3 rounded-2xl border border-dashed border-[#cfdcc9] p-3.5 opacity-70">
              <span className="flex h-10 w-10 items-center justify-center rounded-full text-[#455d3b]">
                <Plus size={16} />
              </span>
              <span className="flex-1 text-sm font-medium text-[#455d3b]">
                Create a list
              </span>
              <span className="rounded-full bg-[#edf2eb] px-2 py-0.5 text-[10px] font-medium text-[#455d3b]">
                soon
              </span>
            </div>
          </>
        )}

        {active && (
          <>
            <h1 className="mb-4 text-2xl font-semibold tracking-tight">
              {active.emoji} {active.name}{" "}
              <span className="text-sm font-normal text-neutral-400">
                · {active.rows.length}
              </span>
            </h1>
            {active.rows.map(row)}
            {active.rows.length === 0 && (
              <p className="py-8 text-center text-sm text-neutral-400">
                {list === "saved"
                  ? "Nothing saved yet. The bookmark on any venue card starts this list"
                  : list === "been"
                  ? "Nowhere yet. Your nights fill this in"
                  : "Everywhere you've saved, you've been. Impressive"}
              </p>
            )}
          </>
        )}
      </div>

      {selectedVenue && (
        <MapVenueSheet
          venue={selectedVenue}
          onClose={() => setSelectedVenue(null)}
          savedIds={savedIds}
          onSave={() => {}}
          onUnsave={onUnsave}
          onHide={() => {}}
          userId={userId}
          onCheckIn={onCheckIn}
          onOpenThread={onOpenThread}
          onOpenProfile={onOpenProfile}
          zIndex={3100}
        />
      )}
    </div>
  );
}
