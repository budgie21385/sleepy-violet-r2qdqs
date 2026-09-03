// Horizontal strip of session participants with inline friend actions
// (Add / Accept / Friends / Guest). Differentiates signed-up vs anonymous
// guests via the get_account_user_ids RPC. Shared by the results boards.
// Extracted from App.js.
//
// VOTE SPLIT (Sep 3, Mark's markup rounds): on a RUNNING concurrent session
// the strip groups people under VOTED / STILL TO VOTE — the absence lives
// where the people are, not just in the banner. Still-to-vote holds, by
// name: joined-but-unsubmitted participants AND invited friends who haven't
// joined (session_invites, inviter-read policy). Only headcount the host
// filled by link-share with no invite behind it falls back to the ghost
// "N yet to join" chip. Ended sessions render the flat row of who came.
import { useState, useEffect, useMemo } from "react";
import { supabase } from "../supabaseClient";
import { Check } from "lucide-react";
import {
  sendFriendRequest,
  acceptFriendRequest,
  friendRequestToast,
} from "../lib/friendships";

export function ParticipantsStrip({
  participants = [],
  userId,
  hostUserId,
  onOpenProfile,
  showToast,
  // Vote-split mode: party size incl. host + the session to read invites of.
  expectedTotal = 0,
  sessionId = null,
  voteSplit = false,
}) {
  const [friendshipByOtherId, setFriendshipByOtherId] = useState(() => new Map());
  const [profileExistsSet, setProfileExistsSet] = useState(() => new Set());
  const [chipActingOn, setChipActingOn] = useState(null);
  const [signedUpIds, setSignedUpIds] = useState(() => new Set());
  const [avatarById, setAvatarById] = useState(() => new Map());
  // Invited-but-not-joined friends: [{ user_id, display_name }]
  const [invitedPending, setInvitedPending] = useState([]);

  const participantIdsKey = participants
    .map((p) => p.user_id)
    .filter(Boolean)
    .join("|");

  useEffect(() => {
    if (!voteSplit || !sessionId) {
      setInvitedPending([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: inv } = await supabase
        .from("session_invites")
        .select("invitee_id")
        .eq("session_id", sessionId);
      const joined = new Set(participants.map((p) => p.user_id));
      const pendingIds = (inv || [])
        .map((r) => r.invitee_id)
        .filter((id) => id && !joined.has(id));
      if (pendingIds.length === 0) {
        if (!cancelled) setInvitedPending([]);
        return;
      }
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", pendingIds);
      if (cancelled) return;
      const nameById = new Map(
        (profs || []).map((p) => [p.id, p.display_name])
      );
      setInvitedPending(
        pendingIds.map((id) => ({
          user_id: id,
          display_name: nameById.get(id) || "A friend",
        }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [voteSplit, sessionId, participantIdsKey]);

  const otherIds = useMemo(
    () =>
      [...participants, ...invitedPending]
        .map((p) => p.user_id)
        .filter((id) => id && id !== userId),
    [participants, invitedPending, userId]
  );

  async function loadFriendshipState() {
    if (!userId || otherIds.length === 0) {
      setFriendshipByOtherId(new Map());
      setProfileExistsSet(new Set());
      setSignedUpIds(new Set());
      setAvatarById(new Map());
      return;
    }
    const [friendshipsRes, profilesRes, accountsRes] = await Promise.all([
      supabase
        .from("friendships")
        .select("id, requester_id, addressee_id, status")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
      supabase.from("profiles").select("id, avatar_url").in("id", otherIds),
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
    setAvatarById(
      new Map(
        (profilesRes.data || [])
          .filter((r) => r.avatar_url)
          .map((r) => [r.id, r.avatar_url])
      )
    );
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

  // Shared with the profile, the drawer and the album (July 31) — this mount
  // didn't even import push, so a request from a session's participants strip
  // arrived silently.
  async function sendRequestTo(otherId) {
    if (!userId || !otherId) return;
    setChipActingOn(otherId);
    const result = await sendFriendRequest(userId, otherId);
    setChipActingOn(null);
    showToast?.(friendRequestToast(result));
    if (result !== "error") await loadFriendshipState();
  }

  async function acceptRequestFrom(otherId) {
    const row = friendshipByOtherId.get(otherId);
    if (!row) return;
    setChipActingOn(otherId);
    const ok = await acceptFriendRequest(userId, otherId, row.id);
    setChipActingOn(null);
    showToast?.(ok ? "Friend added" : "Couldn't accept");
    if (ok) await loadFriendshipState();
  }

  if (participants.length === 0) return null;

  function renderChip(p) {
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
          {avatarById.get(p.user_id) ? (
            <img
              src={avatarById.get(p.user_id)}
              alt={name}
              className="h-6 w-6 rounded-full object-cover"
            />
          ) : (
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
          )}
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
  }

  if (!voteSplit) {
    return (
      <div className="bg-white border-b border-neutral-100 px-4 py-3">
        <p className="text-xs text-neutral-500 mb-1.5">
          {participants.length === 1
            ? "Just you"
            : `${participants.length} people`}
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          {participants.map(renderChip)}
        </div>
      </div>
    );
  }

  // Vote-split render. Voted = submitted; still = joined-but-unsubmitted +
  // invited-but-unjoined; ghost = expected headcount with nobody behind it.
  const voted = participants.filter((p) => p.submitted_at);
  const notYet = participants.filter((p) => !p.submitted_at);
  const ghostCount = Math.max(
    0,
    expectedTotal - participants.length - invitedPending.length
  );
  const stillCount = notYet.length + invitedPending.length + ghostCount;
  return (
    <div className="bg-white border-b border-neutral-100 px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-[#7c8f6f] mb-1.5">
        Voted
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        {voted.length > 0 ? (
          voted.map(renderChip)
        ) : (
          <span className="text-xs text-neutral-400">No one yet</span>
        )}
      </div>
      {stillCount > 0 && (
        <>
          <p className="mt-2.5 text-[10px] font-semibold uppercase tracking-wide text-[#b3a17c] mb-1.5">
            Still to vote
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            {notYet.map(renderChip)}
            {invitedPending.map(renderChip)}
            {ghostCount > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-neutral-300 bg-white pl-1 pr-2.5 py-1">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-neutral-50 text-xs text-neutral-400">
                  ?
                </span>
                <span className="text-xs font-medium text-neutral-400">
                  {ghostCount === 1
                    ? "1 more to join"
                    : `${ghostCount} more to join`}
                </span>
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
