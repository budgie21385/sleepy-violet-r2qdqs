// THE MATCH IS PEOPLE (Aug 20, Mark: the matched screen was "a little
// underwhelming" — a grey tick and one host-only card). Two pieces, both
// fed by the same fetch:
//   <SessionPeople part="stack">  — overlapping avatars of the whole group,
//                                   replaces the check circle
//   <SessionPeople part="list">   — "In this session": every FLANIT member
//                                   with a state-aware chip (Add friend /
//                                   Requested / Accept / ✓ Friends), host
//                                   badged. Replaces AddHostFriendCard on
//                                   the matched state — a 3-person session
//                                   offers you everyone, not just the host.
// Anonymous guests: shown in the stack (they were there), muted "Not on
// Flanit yet" in the list — you can't friend an anon, so nothing dangles
// when they claim later (they become addable via the drawer's meet-people
// items, whose rows adoption re-keys).
// Requests go through lib/friendships — the write and its push travel
// together, and accepting is always the other person's tap (no auto-friend).
import { useState, useEffect } from "react";
import { supabase } from "../supabaseClient";
import {
  sendFriendRequest,
  acceptFriendRequest,
  friendRequestToast,
} from "../lib/friendships";
import { FriendAvatar } from "./FriendAvatar";

export function SessionPeople({ sessionId, viewerUserId, viewerName, hostUserId, showToast, part = "list" }) {
  const [rows, setRows] = useState(null); // [{uid, profile, isHost, isSelf, real, relation, friendshipId}]
  const [acting, setActing] = useState(null);

  useEffect(() => {
    if (!sessionId || !viewerUserId) return;
    let cancelled = false;
    (async () => {
      const { data: parts } = await supabase
        .from("session_participants")
        .select("user_id, display_name")
        .eq("session_id", sessionId);
      const uids = Array.from(
        new Set((parts || []).map((p) => p.user_id).filter(Boolean))
      );
      if (uids.length === 0) {
        if (!cancelled) setRows([]);
        return;
      }
      const [profsRes, accountsRes, frRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", uids),
        supabase.rpc("get_account_user_ids", { p_user_ids: uids }),
        supabase
          .from("friendships")
          .select("id, requester_id, addressee_id, status")
          .or(`requester_id.eq.${viewerUserId},addressee_id.eq.${viewerUserId}`),
      ]);
      if (cancelled) return;
      const profById = Object.fromEntries(
        (profsRes.data || []).map((p) => [p.id, p])
      );
      const realSet = new Set(
        (accountsRes.data || []).map((r) => r.user_id)
      );
      const relByUid = {};
      const fidByUid = {};
      for (const f of frRes.data || []) {
        const other =
          f.requester_id === viewerUserId ? f.addressee_id : f.requester_id;
        fidByUid[other] = f.id;
        if (f.status === "accepted") relByUid[other] = "friends";
        else if (f.status === "pending")
          relByUid[other] =
            f.requester_id === viewerUserId ? "pending_out" : "pending_in";
      }
      const partByUid = Object.fromEntries(
        (parts || []).map((p) => [p.user_id, p])
      );
      setRows(
        uids.map((uid) => ({
          uid,
          profile: profById[uid] || null,
          name:
            profById[uid]?.display_name ||
            partByUid[uid]?.display_name ||
            "A guest",
          isHost: uid === hostUserId,
          isSelf: uid === viewerUserId,
          real: realSet.has(uid),
          relation: relByUid[uid] || "none",
          friendshipId: fidByUid[uid] || null,
        }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, viewerUserId, hostUserId]);

  async function add(row) {
    setActing(row.uid);
    const result = await sendFriendRequest(viewerUserId, row.uid, viewerName);
    setActing(null);
    showToast?.(friendRequestToast(result));
    if (result === "sent" || result === "already")
      setRows((prev) =>
        prev.map((r) =>
          r.uid === row.uid ? { ...r, relation: "pending_out" } : r
        )
      );
  }

  async function accept(row) {
    setActing(row.uid);
    const ok = await acceptFriendRequest(viewerUserId, row.uid, row.friendshipId);
    setActing(null);
    if (ok) {
      showToast?.("You're friends now");
      setRows((prev) =>
        prev.map((r) =>
          r.uid === row.uid ? { ...r, relation: "friends" } : r
        )
      );
    } else showToast?.("Couldn't update");
  }

  if (part === "stack") {
    const stack = (rows || []).slice(0, 5);
    if (stack.length === 0) return null;
    return (
      <div className="mb-4 flex justify-center">
        {stack.map((r, i) => (
          <div
            key={r.uid}
            className={i > 0 ? "-ml-3" : ""}
            style={{ zIndex: stack.length - i }}
          >
            <div className="rounded-full ring-[3px] ring-[#fdf6f0]">
              <FriendAvatar profile={r.profile} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const others = (rows || []).filter((r) => !r.isSelf);
  if (!rows || others.length === 0) return null;
  return (
    <div className="rounded-2xl bg-white shadow-sm border border-neutral-100 p-4 text-left">
      <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400 mb-2">
        In this session
      </p>
      <div className="space-y-2">
        {others.map((r) => (
          <div key={r.uid} className="flex items-center gap-2.5">
            <FriendAvatar profile={r.profile} small />
            <span className="flex-1 min-w-0 truncate text-sm font-medium text-neutral-900">
              {r.name}
              {r.isHost && (
                <span className="ml-1.5 text-[9px] font-medium uppercase tracking-wide text-neutral-400">
                  Host
                </span>
              )}
            </span>
            {!r.real ? (
              <span className="shrink-0 text-[11px] text-neutral-400">
                Not on Flanit yet
              </span>
            ) : r.relation === "friends" ? (
              <span className="shrink-0 rounded-full bg-[#edf2eb] px-3 py-1.5 text-[11px] font-medium text-[#455d3b]">
                ✓ Friends
              </span>
            ) : r.relation === "pending_out" ? (
              <span className="shrink-0 rounded-full bg-neutral-100 px-3 py-1.5 text-[11px] font-medium text-neutral-500">
                Requested
              </span>
            ) : r.relation === "pending_in" ? (
              <button
                type="button"
                disabled={acting === r.uid}
                onClick={() => accept(r)}
                className="shrink-0 rounded-full bg-[#455d3b] px-3 py-1.5 text-[11px] font-medium text-white active:scale-95 transition disabled:opacity-50"
              >
                Accept
              </button>
            ) : (
              <button
                type="button"
                disabled={acting === r.uid}
                onClick={() => add(r)}
                className="shrink-0 rounded-full bg-[#455d3b] px-3 py-1.5 text-[11px] font-medium text-white active:scale-95 transition disabled:opacity-50"
              >
                Add friend
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
