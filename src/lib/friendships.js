// FRIEND REQUESTS — one implementation, every surface (July 31, 2026).
//
// Mark's rule, and it's the general one: "we shouldn't worry so much about
// where something is sent from, but whether the thing that has been done
// warrants a push — and then push it from all the different surfaces."
//
// A friend request was reachable from four places and only ONE of them pushed
// (the Activity drawer). Profiles — the obvious way to add someone — and the
// participants strip sent the row and nothing else, so the recipient learned
// about it whenever they next opened the app. Same shape as the mount-parity
// bugs (showToast, onOpenProfile, userId): behaviour added at one call site
// and not the others.
//
// The fix is structural rather than four copy-pastes: the write and its push
// live together here, so a new surface can't accidentally ship the quiet
// version. Callers get a result to toast on and never touch the table.
//
// Carries the edge cases that were learned the hard way:
//   * DECLINED rows are immutable under RLS and their unique constraint blocks
//     a fresh insert — delete, then insert (the May 25 re-request fix).
//   * 23505 means a request already exists; that's information, not an error.
//   * Updates are ROW-COUNT-CHECKED: an RLS-filtered update returns success
//     with zero rows, so "no rows" is a real failure, not a silent no-op.
import { supabase } from "../supabaseClient";
import { sendPush } from "./push";

// → "sent" | "already_friends" | "already_sent" | "error"
export async function sendFriendRequest(myId, otherId, fromName) {
  if (!myId || !otherId || myId === otherId) return "error";

  const { data: existing } = await supabase
    .from("friendships")
    .select("id, status")
    .or(
      `and(requester_id.eq.${myId},addressee_id.eq.${otherId}),and(requester_id.eq.${otherId},addressee_id.eq.${myId})`
    )
    .limit(1);
  const row = existing?.[0] || null;

  if (row && row.status === "accepted") return "already_friends";
  if (row && row.status === "declined") {
    await supabase.from("friendships").delete().eq("id", row.id);
  }

  const { error } = await supabase
    .from("friendships")
    .insert({ requester_id: myId, addressee_id: otherId, status: "pending" });

  if (error?.code === "23505") return "already_sent";
  if (error) {
    console.error("Friend request failed:", error);
    return "error";
  }

  sendPush(
    otherId,
    "New friend request",
    fromName ? `${fromName} wants to add you on Flanit` : "Someone wants to add you on Flanit"
  );
  return "sent";
}

// Accept by the OTHER PERSON's id — some surfaces know the uid, not the
// friendship row. Pass `friendshipId` when you have it and we'll use it.
export async function acceptFriendRequest(myId, otherId, friendshipId) {
  if (!myId || !otherId) return false;

  let q = supabase.from("friendships").update({ status: "accepted" });
  q = friendshipId
    ? q.eq("id", friendshipId)
    : q
        .eq("requester_id", otherId)
        .eq("addressee_id", myId)
        .eq("status", "pending");

  const { data: rows, error } = await q.select("requester_id");
  if (error || !rows || rows.length === 0) {
    console.error("Accept friend failed:", error);
    return false;
  }

  sendPush(otherId, "Request accepted 🎉", "You're now friends on Flanit");
  return true;
}

// The toast for a sendFriendRequest result — so every surface says the same
// thing about the same outcome.
export function friendRequestToast(result) {
  switch (result) {
    case "sent":
      return "Request sent";
    case "already_friends":
      return "You're already friends";
    case "already_sent":
      return "Request already sent";
    default:
      return "Couldn't send request";
  }
}
