// Comment thread on a check-in. Opened from Activity items (a friend's
// check-in, or "commented on your check-in"). Visibility is enforced by
// activity_comments RLS: the audience is the CHECK-IN OWNER's friends — a
// commenter's own friends see nothing (see activity_comments_table.sql).
import { useState, useEffect, useRef } from "react";
import { X, Send } from "lucide-react";
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";
import { timeAgoShort, FRESH_MS } from "../lib/checkins";

// The check-in's own view — a check-in is a first-class object (owner, moment,
// label, companions, conversation), NOT a shortcut to the venue card. The
// venue name inside taps through to the card when the caller passes
// venueObj + onOpenVenue.
// thread: { activityId, ownerId?, ownerName, ownerProfile?, venueName,
//           label?, venueObj?, timestamp }
export function CheckinThreadSheet({ thread, userId, onClose, showToast, onOpenProfile, onOpenVenue, onCheckIn }) {
  const [comments, setComments] = useState(null); // null = loading
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [withNames, setWithNames] = useState([]); // tagged companions
  const listRef = useRef(null);

  // "with JD and Bianca" — tags on this check-in (pending + accepted render;
  // removed never does).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: tags } = await supabase
        .from("activity_tags")
        .select("tagged_user_id, status")
        .eq("activity_id", thread.activityId)
        .neq("status", "removed");
      const ids = Array.from(new Set((tags || []).map((t) => t.tagged_user_id)));
      if (ids.length === 0) {
        if (!cancelled) setWithNames([]);
        return;
      }
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", ids);
      if (cancelled) return;
      setWithNames(
        (profs || [])
          .map((p) => (p.display_name || "").split(" ")[0])
          .filter(Boolean)
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [thread.activityId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from("activity_comments")
        .select("id, user_id, body, created_at")
        .eq("activity_id", thread.activityId)
        .order("created_at", { ascending: true });
      let profById = {};
      const ids = Array.from(new Set((rows || []).map((r) => r.user_id)));
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", ids);
        profById = Object.fromEntries((profs || []).map((p) => [p.id, p]));
      }
      if (cancelled) return;
      setComments(
        (rows || []).map((r) => ({ ...r, profile: profById[r.user_id] || null }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [thread.activityId]);

  useEffect(() => {
    // Keep the newest comment in view as the list grows.
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [comments]);

  async function send() {
    const text = body.trim();
    if (!text || sending) return;
    setSending(true);
    const { data: inserted, error } = await supabase
      .from("activity_comments")
      .insert({ activity_id: thread.activityId, user_id: userId, body: text })
      .select("id, user_id, body, created_at")
      .single();
    setSending(false);
    if (error) {
      console.error("Comment failed:", error);
      showToast?.("Couldn't post that");
      return;
    }
    setBody("");
    // Own profile for the optimistic append — display data only.
    const { data: me } = await supabase
      .from("profiles")
      .select("id, display_name, username, avatar_url")
      .eq("id", userId)
      .maybeSingle();
    setComments((prev) => [...(prev || []), { ...inserted, profile: me || null }]);
  }

  return (
    <div className="fixed inset-0 z-[3600]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="absolute left-0 right-0 bottom-0 max-h-[75%] flex flex-col bg-white rounded-t-3xl shadow-2xl">
        <div className="px-5 pt-3 pb-2 border-b border-neutral-100">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold truncate">
                {thread.ownerName} at{" "}
                {thread.venueObj && onOpenVenue ? (
                  <button
                    type="button"
                    onClick={() => onOpenVenue(thread.venueObj)}
                    className="underline decoration-[#455d3b]/40 underline-offset-2"
                  >
                    {thread.venueName}
                  </button>
                ) : (
                  thread.venueName
                )}
                {thread.label ? ` · ${thread.label}` : ""}
              </p>
              {withNames.length > 0 && (
                <p className="text-xs text-neutral-700">
                  with{" "}
                  {withNames.length === 1
                    ? withNames[0]
                    : `${withNames.slice(0, -1).join(", ")} and ${withNames[withNames.length - 1]}`}
                </p>
              )}
              <p className="text-[11px] text-neutral-500">
                {timeAgoShort(thread.timestamp)} · only {thread.ownerName}'s
                friends see this
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-100"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Join — presence begets presence. Only on someone else's FRESH
            check-in with a known venue: one tap closes this thread and runs
            your own check-in there (dupe-guarded, confetti sheet and all). */}
        {onCheckIn &&
          thread.venueObj &&
          thread.ownerId !== userId &&
          Date.now() - new Date(thread.timestamp).getTime() < FRESH_MS && (
            <div className="px-5 pt-3">
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onCheckIn(thread.venueObj);
                }}
                className="w-full rounded-full bg-[#455d3b] py-2.5 text-sm font-medium text-white active:scale-[0.99] transition"
              >
                I'm here too — join {thread.ownerName}
              </button>
            </div>
          )}
        <div ref={listRef} className="flex-1 overflow-y-auto px-5 py-3">
          {comments === null && (
            <p className="text-xs text-neutral-400 text-center py-4">Loading…</p>
          )}
          {comments !== null && comments.length === 0 && (
            <div className="py-4 text-center">
              {thread.ownerProfile ? (
                <button
                  type="button"
                  onClick={() => onOpenProfile?.(thread.ownerId)}
                  className="inline-flex flex-col items-center gap-2 active:scale-95 transition"
                >
                  <FriendAvatar profile={thread.ownerProfile} />
                  <span className="text-sm font-medium text-neutral-800">
                    {thread.ownerProfile.display_name || thread.ownerName}
                  </span>
                  {thread.ownerProfile.username && (
                    <span className="-mt-1.5 text-xs text-neutral-500">
                      @{thread.ownerProfile.username}
                    </span>
                  )}
                </button>
              ) : null}
              <p className="text-sm text-neutral-500 mt-2">
                No comments yet — say something.
              </p>
            </div>
          )}
          <div className="space-y-3">
            {(comments || []).map((c) => (
              <div key={c.id} className="flex items-start gap-2.5">
                <button
                  type="button"
                  aria-label="View profile"
                  onClick={() => onOpenProfile?.(c.user_id)}
                  className="shrink-0 active:scale-95 transition"
                >
                  <FriendAvatar profile={c.profile} small />
                </button>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-neutral-500">
                    <button
                      type="button"
                      onClick={() => onOpenProfile?.(c.user_id)}
                      className="font-medium text-neutral-800"
                    >
                      {c.profile?.display_name || "Someone"}
                    </button>{" "}
                    · {timeAgoShort(c.created_at)}
                  </p>
                  <p className="text-sm text-neutral-900 break-words">{c.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="px-4 py-3 border-t border-neutral-100 flex items-center gap-2">
          {/* text-base: sub-16px inputs make iOS Safari auto-zoom on focus. */}
          <input
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            placeholder="Add a comment"
            maxLength={500}
            className="flex-1 rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b]"
          />
          <button
            type="button"
            onClick={send}
            disabled={sending || !body.trim()}
            aria-label="Send"
            className="w-10 h-10 shrink-0 rounded-full bg-[#455d3b] text-white flex items-center justify-center disabled:opacity-40 active:scale-95 transition"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
