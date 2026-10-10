// TOP FRIENDS (Oct 11, 2026 — profile doctrine). The shelf: up to four
// friends, ordered, #1 wearing the gold ring. PUBLIC by ruling (Mark:
// "friendly joking competition") — stored on profiles.top_friends so the
// public face can render it later with the "you're #1" tease.
// The editor is a bottom sheet: current four with move-up / remove, every
// other friend below with Add. Writes are immediate (optimistic, reverted
// on failure) — no save button to forget.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, ChevronUp, Plus } from "lucide-react";
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";

const CAP = 4;

export function TopFriends({
  userId,
  profile,
  setProfile,
  onSeeAll,
  friendCount = null,
  requestCount = 0,
}) {
  const topIds = profile?.top_friends || [];
  const [editing, setEditing] = useState(false);
  // Profiles for the shelf + the editor's add list. null = loading.
  const [friends, setFriends] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const { data: fr } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id")
        .eq("status", "accepted")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
      const ids = Array.from(
        new Set(
          (fr || []).map((f) =>
            f.requester_id === userId ? f.addressee_id : f.requester_id
          )
        )
      );
      if (ids.length === 0) {
        if (!cancelled) setFriends([]);
        return;
      }
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", ids)
        .order("display_name", { ascending: true });
      if (!cancelled) setFriends(profs || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const byId = Object.fromEntries((friends || []).map((p) => [p.id, p]));
  // Drop ids that stopped being friends — render only resolvable ones.
  const top = topIds.map((id) => byId[id]).filter(Boolean);
  const rest = (friends || []).filter((p) => !topIds.includes(p.id));

  async function write(next) {
    if (busy) return;
    setBusy(true);
    const prev = topIds;
    setProfile?.((p) => (p ? { ...p, top_friends: next } : p));
    const { error } = await supabase
      .from("profiles")
      .update({ top_friends: next })
      .eq("id", userId);
    setBusy(false);
    if (error) {
      console.error("Top friends save failed:", error);
      setProfile?.((p) => (p ? { ...p, top_friends: prev } : p));
    }
  }

  const add = (id) => topIds.length < CAP && write([...topIds, id]);
  const remove = (id) => write(topIds.filter((x) => x !== id));
  const moveUp = (id) => {
    const i = topIds.indexOf(id);
    if (i <= 0) return;
    const next = [...topIds];
    [next[i - 1], next[i]] = [next[i], next[i - 1]];
    write(next);
  };

  // No friends at all → no shelf (the Friends card below handles the
  // empty-state invitation).
  if (friends !== null && friends.length === 0) return null;

  return (
    <>
      <div className="mb-4">
        <div className="flex items-center justify-between mb-2 px-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
            Top friends
          </p>
          <button
            type="button"
            onClick={onSeeAll}
            className="flex items-center gap-1.5 text-[11px] font-medium text-[#455d3b]"
          >
            See all{friendCount ? ` ${friendCount}` : ""} friends ›
            {requestCount > 0 && (
              <span className="inline-flex min-w-[16px] items-center justify-center rounded-full bg-red-600 px-1 py-0.5 text-[9px] font-semibold text-white">
                {requestCount}
              </span>
            )}
          </button>
        </div>
        <div className="flex items-center gap-2.5">
          {top.map((p, i) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setEditing(true)}
              className={`rounded-full active:scale-95 transition ${
                i === 0 ? "ring-2 ring-[#f4a820] ring-offset-2" : ""
              }`}
              aria-label={`Edit top friends (${p.display_name || "friend"})`}
            >
              <FriendAvatar profile={p} />
            </button>
          ))}
          {topIds.length < CAP && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              aria-label="Add a top friend"
              className="flex h-12 w-12 items-center justify-center rounded-full border border-dashed border-neutral-300 text-neutral-400 active:scale-95 transition"
            >
              <Plus size={16} />
            </button>
          )}
        </div>
      </div>

      {editing &&
        createPortal(
          <div className="fixed inset-0 z-[3300]">
            <button
              type="button"
              aria-label="Close"
              onClick={() => setEditing(false)}
              className="absolute inset-0 bg-black/30"
            />
            <div
              className="absolute left-0 right-0 bottom-0 mx-auto max-w-md max-h-[80%] flex flex-col rounded-t-3xl bg-white shadow-2xl"
              style={{ paddingBottom: "max(16px, env(safe-area-inset-bottom))" }}
            >
              <div className="px-5 pt-3 pb-2">
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold">Top friends</h2>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setEditing(false)}
                    className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 active:bg-neutral-200"
                  >
                    <X size={13} strokeWidth={2} />
                  </button>
                </div>
                <p className="mt-0.5 text-xs text-neutral-500">
                  Your top {CAP}, in order. Friends can see this.
                </p>
              </div>
              <div className="flex-1 overflow-y-auto px-5 pb-4">
                {top.length === 0 && (
                  <p className="py-2 text-xs text-neutral-400">
                    Nobody yet. Add up to {CAP} below.
                  </p>
                )}
                {top.map((p, i) => (
                  <div key={p.id} className="flex items-center gap-3 py-2">
                    <span className="w-5 text-center text-xs font-semibold text-neutral-400">
                      {i + 1}
                    </span>
                    <FriendAvatar profile={p} small />
                    <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                      {p.display_name || "Someone"}
                    </span>
                    {i > 0 && (
                      <button
                        type="button"
                        aria-label="Move up"
                        disabled={busy}
                        onClick={() => moveUp(p.id)}
                        className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 active:scale-95 transition disabled:opacity-50"
                      >
                        <ChevronUp size={14} />
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label="Remove"
                      disabled={busy}
                      onClick={() => remove(p.id)}
                      className="flex h-8 w-8 items-center justify-center rounded-full border border-neutral-200 text-neutral-400 active:scale-95 transition disabled:opacity-50"
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
                {rest.length > 0 && (
                  <>
                    <p className="mt-3 mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                      Friends
                    </p>
                    {rest.map((p) => (
                      <div key={p.id} className="flex items-center gap-3 py-2">
                        <FriendAvatar profile={p} small />
                        <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                          {p.display_name || "Someone"}
                        </span>
                        <button
                          type="button"
                          disabled={busy || topIds.length >= CAP}
                          onClick={() => add(p.id)}
                          className="shrink-0 rounded-full bg-[#455d3b] px-3.5 py-1.5 text-xs font-medium text-white active:scale-95 transition disabled:opacity-40"
                        >
                          Add
                        </button>
                      </div>
                    ))}
                    {topIds.length >= CAP && (
                      <p className="mt-1 text-[10px] text-neutral-400">
                        That's the {CAP}. Remove one to swap someone in.
                      </p>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
