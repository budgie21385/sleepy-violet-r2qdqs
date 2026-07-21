// Reactions on check-ins and individual photos. Model (Mark, July 17): ONE
// SWAPPABLE reaction per person per target — tap another emoji to swap, tap
// your current one to remove. Set chosen for the Gen Z night-out register
// (💀/😭 are laughs, 👀 is "spotted", never 😂).
// Visibility inherits the check-in owner's audience (activity_reactions RLS
// rides can_see_activity) — see checkin_reactions.sql.
import { supabase } from "../supabaseClient";

export const REACTION_SET = ["🔥", "💀", "😭", "👀", "🫶", "🍻"];

// All reactions for a check-in (both the check-in itself and its photos, one
// query). Returns raw rows: { id, activity_id, photo_id, user_id, emoji }.
export async function fetchReactions(activityId) {
  return fetchReactionsMany([activityId]);
}

// Cluster variant — same-night twins share one card, so reactions load
// across all of them (RLS trims what the viewer can't see).
export async function fetchReactionsMany(activityIds) {
  if (!activityIds || activityIds.length === 0) return [];
  const { data } = await supabase
    .from("activity_reactions")
    .select("id, activity_id, photo_id, comment_id, user_id, emoji")
    .in("activity_id", activityIds);
  return data || [];
}

// rows → { counts: { emoji: n }, mine: emoji|null } for ONE target.
// Targets: check-in (no photoId/commentId), a photo, or a comment.
// Older rows may predate comment_reactions.sql (no comment_id field) —
// treat undefined as null throughout.
export function summarizeReactions(rows, userId, photoId = null, commentId = null) {
  const forTarget = rows.filter((r) => {
    const pid = r.photo_id ?? null;
    const cid = r.comment_id ?? null;
    if (commentId !== null) return cid === commentId;
    if (photoId !== null) return pid === photoId && cid === null;
    return pid === null && cid === null;
  });
  const counts = {};
  let mine = null;
  for (const r of forTarget) {
    counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    if (r.user_id === userId) mine = r.emoji;
  }
  return { counts, mine };
}

// One-swappable toggle. Same emoji as mine → remove; different → swap;
// none yet → insert. Returns the fresh row set for the activity.
export async function toggleReaction({
  activityId,
  photoId = null,
  commentId = null,
  userId,
  emoji,
}) {
  let q = supabase
    .from("activity_reactions")
    .select("id, emoji")
    .eq("activity_id", activityId)
    .eq("user_id", userId);
  q = photoId === null ? q.is("photo_id", null) : q.eq("photo_id", photoId);
  q =
    commentId === null ? q.is("comment_id", null) : q.eq("comment_id", commentId);
  const { data: existing } = await q.limit(1);
  const cur = existing?.[0] || null;

  if (cur && cur.emoji === emoji) {
    await supabase.from("activity_reactions").delete().eq("id", cur.id);
  } else if (cur) {
    await supabase
      .from("activity_reactions")
      .update({ emoji, created_at: new Date().toISOString() })
      .eq("id", cur.id);
  } else {
    const { error } = await supabase.from("activity_reactions").insert({
      activity_id: activityId,
      photo_id: photoId,
      comment_id: commentId,
      user_id: userId,
      emoji,
    });
    if (error) throw error;
  }
  return fetchReactions(activityId);
}
