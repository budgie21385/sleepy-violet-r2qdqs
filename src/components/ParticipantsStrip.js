// Horizontal strip of session participants with inline friend actions
// (Add / Accept / Friends / Guest). Differentiates signed-up vs anonymous
// guests via the get_account_user_ids RPC. Shared by the results boards.
// Extracted from App.js.
import { useState, useEffect, useMemo } from "react";
import { supabase } from "../supabaseClient";
import { Check } from "lucide-react";

export function ParticipantsStrip({ participants = [], userId, hostUserId, onOpenProfile, showToast }) {
  const [friendshipByOtherId, setFriendshipByOtherId] = useState(() => new Map());
  const [profileExistsSet, setProfileExistsSet] = useState(() => new Set());
  const [chipActingOn, setChipActingOn] = useState(null);
  const [signedUpIds, setSignedUpIds] = useState(() => new Set());

  const otherIds = useMemo(
    () => participants.map((p) => p.user_id).filter((id) => id && id !== userId),
    [participants, userId]
  );

  async function loadFriendshipState() {
    if (!userId || otherIds.length === 0) {
      setFriendshipByOtherId(new Map());
      setProfileExistsSet(new Set());
      setSignedUpIds(new Set());
      return;
    }
    const [friendshipsRes, profilesRes, accountsRes] = await Promise.all([
      supabase
        .from("friendships")
        .select("id, requester_id, addressee_id, status")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
      supabase.from("profiles").select("id").in("id", otherIds),
      supabase.rpc("get_account_user_ids", { p_user_ids: otherIds }),
    ]);
    const otherIdSet = new Set(otherIds);
    const map = new Map();
    for (const row of friendshipsRes.data || []) {
      const other =
        row.requester_id === userId ? row.addressee_id : row.requester_id;
      if (otherIdSet.has(other)) map.set(other, row);
    }
    setFriendshipByOtherId(map);
    setProfileExistsSet(new Set((profilesRes.data || []).map((r) => r.id)));
    setSignedUpIds(new Set((accountsRes.data || []).map((r) => r.user_id)));
  }

  const otherIdsKey = otherIds.join("|");
  useEffect(() => {
    loadFriendshipState();
  }, [userId, otherIdsKey]);

  function getRowState(p) {
    if (!p.user_id) return "invite";
    if (p.user_id === userId) return "self";
    const row = friendshipByOtherId.get(p.user_id);
    if (row) {
      if (row.status === "accepted") return "friends";
      if (row.status === "pending") {
        return row.addressee_id === userId ? "incoming" : "outgoing";
      }
    }
    if (!profileExistsSet.has(p.user_id)) return "invite";
    return "none";
  }

  async function sendRequestTo(otherId) {
    if (!userId || !otherId) return;
    setChipActingOn(otherId);
    const existing = friendshipByOtherId.get(otherId);
    if (existing && existing.status === "declined") {
      const { error: delError } = await supabase
        .from("friendships")
        .delete()
        .eq("id", existing.id);
      if (delError) {
        setChipActingOn(null);
        console.error("sendRequestTo delete failed:", delError);
        showToast?.("Couldn't send request");
        return;
      }
    }
    const { error } = await supabase
      .from("friendships")
      .insert({ requester_id: userId, addressee_id: otherId, status: "pending" });
    setChipActingOn(null);
    if (error) {
      console.error("sendRequestTo failed:", error);
      showToast?.("Couldn't send request");
      return;
    }
    showToast?.("Request sent");
    await loadFriendshipState();
  }

  async function acceptRequestFrom(otherId) {
    const row = friendshipByOtherId.get(otherId);
    if (!row) return;
    setChipActingOn(otherId);
    const { error } = await supabase
      .from("friendships")
      .update({ status: "accepted" })
      .eq("id", row.id);
    setChipActingOn(null);
    if (error) {
      console.error("acceptRequestFrom failed:", error);
      showToast?.("Couldn't accept");
      return;
    }
    showToast?.("Friend added");
    await loadFriendshipState();
  }

  if (participants.length === 0) return null;

  return (
    <div className="bg-white border-b border-neutral-100 px-4 py-3">
      <p className="text-xs text-neutral-500 mb-1.5">
        {participants.length === 1 ? "Just you" : `${participants.length} people`}
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        {participants.map((p) => {
          const name =
            p.display_name?.trim() || (p.user_id === userId ? "You" : "Guest");
          const initial = name.charAt(0).toUpperCase();
          const isMe = p.user_id === userId;
          const isSignedUp = signedUpIds.has(p.user_id);
          const isHost = !!hostUserId && p.user_id === hostUserId;
          const state = getRowState(p);
          const acting = chipActingOn === p.user_id;
          return (
            <div
              key={p.user_id}
              className="inline-flex items-center gap-1.5 rounded-full bg-neutral-50 border border-neutral-100 pl-1 pr-2 py-1"
            >
              <button
                type="button"
                onClick={() => {
                  if (isMe) return;
                  onOpenProfile?.(p.user_id);
                }}
                aria-label={isMe ? "You" : `Open ${name}'s profile`}
                disabled={isMe}
                className="inline-flex items-center gap-1.5"
              >
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                    isMe
                      ? "bg-[#455d3b] text-white"
                      : isSignedUp
                      ? "bg-[#edf2eb] text-[#3f5a3a]"
                      : "bg-neutral-100 text-neutral-400"
                  }`}
                >
                  {initial}
                </span>
                <span className="text-xs font-medium text-neutral-700">
                  {isMe ? "You" : name}
                </span>
              </button>
              {isHost && (
                <span className="text-[9px] uppercase tracking-wide font-semibold text-neutral-500 px-1">
                  Host
                </span>
              )}
              {!isMe && isSignedUp && state === "friends" && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-[#edf2eb] text-[#3f5a3a] text-[10px] font-medium px-1.5 py-0.5 border border-[#c5d4c2]">
                  <Check size={10} />
                  Friends
                </span>
              )}
              {!isMe && isSignedUp && state === "incoming" && (
                <button
                  type="button"
                  onClick={() => acceptRequestFrom(p.user_id)}
                  disabled={acting}
                  className="rounded-full bg-[#455d3b] text-white text-[10px] font-medium px-2 py-0.5 disabled:opacity-50"
                >
                  {acting ? "…" : "Accept"}
                </button>
              )}
              {!isMe && isSignedUp && state === "outgoing" && (
                <span className="rounded-full bg-white border border-neutral-200 text-neutral-500 text-[10px] font-medium px-2 py-0.5">
                  Requested
                </span>
              )}
              {!isMe && isSignedUp && state === "none" && (
                <button
                  type="button"
                  onClick={() => sendRequestTo(p.user_id)}
                  disabled={acting}
                  className="rounded-full bg-[#455d3b] text-white text-[10px] font-medium px-2 py-0.5 disabled:opacity-50"
                >
                  {acting ? "…" : "Add"}
                </button>
              )}
              {!isMe && !isSignedUp && (
                <span className="text-[9px] uppercase tracking-wide font-semibold text-neutral-400 px-1">
                  Guest
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
