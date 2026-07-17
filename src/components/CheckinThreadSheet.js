// Comment thread on a check-in. Opened from Activity items (a friend's
// check-in, or "commented on your check-in"). Visibility is enforced by
// activity_comments RLS: the audience is the CHECK-IN OWNER's friends — a
// commenter's own friends see nothing (see activity_comments_table.sql).
import { useState, useEffect, useRef } from "react";
import { X, Send } from "lucide-react";
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";
import { timeAgoShort, FRESH_MS, DUPE_MS } from "../lib/checkins";
import {
  fetchCheckinPhotosMany,
  uploadCheckinPhoto,
  MAX_PHOTOS_PER_CHECKIN,
} from "../lib/photos";
import {
  REACTION_SET,
  fetchReactionsMany,
  summarizeReactions,
  toggleReaction,
} from "../lib/reactions";
import { Camera } from "lucide-react";

// One tap-bar: 🔥 💀 😭 👀 🫶 🍻 with counts; yours is highlighted. One
// swappable reaction per person per target (see lib/reactions.js).
function ReactionBar({ counts, mine, onTap, disabled }) {
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {REACTION_SET.map((e) => {
        const n = counts[e] || 0;
        const isMine = mine === e;
        return (
          <button
            key={e}
            type="button"
            disabled={disabled}
            onClick={() => onTap(e)}
            className={`flex items-center gap-1 rounded-full border px-2 py-1 text-sm active:scale-90 transition disabled:opacity-50 ${
              isMine
                ? "bg-[#edf2eb] border-[#455d3b]"
                : "border-neutral-200 bg-white"
            }`}
          >
            <span>{e}</span>
            {n > 0 && (
              <span
                className={`text-[11px] font-medium ${
                  isMine ? "text-[#455d3b]" : "text-neutral-500"
                }`}
              >
                {n}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

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
  // Whether the VIEWER already has a recent check-in at this venue —
  // null = still checking (render neither state to avoid a wrong flash).
  // myActivityId = that check-in's id: on a friend's card, YOUR uploads
  // attach to YOUR check-in (photos always live on your own object; the
  // strip below merges both so the card reads as the shared night).
  const [joined, setJoined] = useState(null);
  const [myActivityId, setMyActivityId] = useState(null);
  // Photos (signed web-derivative URLs) + tap-to-enlarge. Owner adds to the
  // thread's check-in ("add last night's photos" path); a joined viewer adds
  // to their own parallel check-in.
  const [photos, setPhotos] = useState([]);
  // Lightbox holds the full photo ROW — it's a mini-thread now (photo +
  // its own reactions + its own comments), not just a big image.
  const [lightbox, setLightbox] = useState(null);
  const [photoComments, setPhotoComments] = useState(null); // null = loading
  const [photoBody, setPhotoBody] = useState("");
  const [photoSending, setPhotoSending] = useState(false);
  // One flat row set for the whole check-in (check-in level + every photo);
  // summarizeReactions() slices per target.
  const [reactions, setReactions] = useState([]);
  const [reacting, setReacting] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);
  const listRef = useRef(null);
  const isOwner = thread.ownerId === userId;
  const uploadTargetId = isOwner ? thread.activityId : myActivityId;
  // THE SHARED NIGHT: a tag-accept creates a twin check-in with the SAME
  // timestamp, and a join creates a sibling — content (comments/photos/
  // reactions) can land on any of them. The card merges the whole same-night
  // cluster at this venue so it never opens "the wrong twin" (Mark hit this:
  // photo + comments lived on the twin, card showed the bare one). RLS still
  // trims every row to what the viewer may see — merging widens nothing.
  const [clusterIds, setClusterIds] = useState([thread.activityId]);
  const clusterKey = clusterIds.join(",");

  useEffect(() => {
    let cancelled = false;
    if (!thread.venueObj) {
      setClusterIds([thread.activityId]);
      return;
    }
    (async () => {
      const SAME_NIGHT_MS = 12 * 60 * 60 * 1000;
      const ref = new Date(thread.timestamp).getTime();
      const { data } = await supabase
        .from("activities")
        .select("id")
        .eq("venue_id", thread.venueObj.id)
        .eq("kind", "checkin")
        .gte("created_at", new Date(ref - SAME_NIGHT_MS).toISOString())
        .lte("created_at", new Date(ref + SAME_NIGHT_MS).toISOString());
      if (cancelled) return;
      setClusterIds(
        Array.from(
          new Set([thread.activityId, ...(data || []).map((r) => r.id)])
        )
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [thread.activityId, thread.venueObj?.id, thread.timestamp]);
  // Cap applies per check-in — only count photos on the one I'd upload to.
  const myPhotoCount = photos.filter(
    (p) => p.activity_id === uploadTargetId
  ).length;

  // All IDs content could hang off: the cluster plus the viewer's own
  // check-in (which may sit outside a null-venueObj cluster).
  function contentIds() {
    return Array.from(
      new Set([...clusterIds, ...(myActivityId ? [myActivityId] : [])])
    );
  }

  useEffect(() => {
    let cancelled = false;
    fetchCheckinPhotosMany(contentIds()).then((rows) => {
      if (cancelled) return;
      setPhotos(
        rows
          .filter((r) => r.url)
          .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      );
    });
    return () => {
      cancelled = true;
    };
  }, [clusterKey, myActivityId]);

  useEffect(() => {
    let cancelled = false;
    fetchReactionsMany(contentIds()).then((rows) => {
      if (!cancelled) setReactions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [clusterKey, myActivityId]);

  async function react(emoji, photo = null) {
    if (reacting) return;
    setReacting(true);
    try {
      await toggleReaction({
        activityId: photo ? photo.activity_id : thread.activityId,
        photoId: photo ? photo.id : null,
        userId,
        emoji,
      });
      setReactions(await fetchReactionsMany(contentIds()));
    } catch (e) {
      console.error("Reaction failed:", e);
      showToast?.("Couldn't react");
    }
    setReacting(false);
  }

  // Photo comments load when the lightbox opens (its own little thread).
  useEffect(() => {
    if (!lightbox) return;
    let cancelled = false;
    setPhotoComments(null);
    setPhotoBody("");
    (async () => {
      const { data: rows } = await supabase
        .from("activity_comments")
        .select("id, user_id, body, created_at")
        .eq("photo_id", lightbox.id)
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
      setPhotoComments(
        (rows || []).map((r) => ({ ...r, profile: profById[r.user_id] || null }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [lightbox?.id]);

  async function sendPhotoComment() {
    const text = photoBody.trim();
    if (!text || photoSending || !lightbox) return;
    setPhotoSending(true);
    // Photo comments hang off the photo's OWN activity (a joined viewer's
    // photo belongs to their check-in) so visibility follows the uploader.
    const { data: inserted, error } = await supabase
      .from("activity_comments")
      .insert({
        activity_id: lightbox.activity_id,
        photo_id: lightbox.id,
        user_id: userId,
        body: text,
      })
      .select("id, user_id, body, created_at")
      .single();
    setPhotoSending(false);
    if (error) {
      console.error("Photo comment failed:", error);
      showToast?.("Couldn't post that");
      return;
    }
    setPhotoBody("");
    const { data: me } = await supabase
      .from("profiles")
      .select("id, display_name, username, avatar_url")
      .eq("id", userId)
      .maybeSingle();
    setPhotoComments((prev) => [
      ...(prev || []),
      { ...inserted, profile: me || null },
    ]);
  }

  async function addPhotos(fileList) {
    if (!uploadTargetId) return;
    const files = Array.from(fileList || []).slice(
      0,
      MAX_PHOTOS_PER_CHECKIN - myPhotoCount
    );
    if (files.length === 0) return;
    setUploading(true);
    for (const file of files) {
      try {
        await uploadCheckinPhoto(userId, uploadTargetId, file);
      } catch (e) {
        console.error("Photo upload failed:", e);
        showToast?.("Couldn't upload a photo");
      }
    }
    const rows = await fetchCheckinPhotosMany(
      Array.from(new Set([...contentIds(), uploadTargetId]))
    );
    setPhotos(
      rows
        .filter((r) => r.url)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    );
    setUploading(false);
  }

  const joinEligible =
    !!onCheckIn &&
    !!thread.venueObj &&
    thread.ownerId !== userId &&
    Date.now() - new Date(thread.timestamp).getTime() < FRESH_MS;

  // "Was I there the SAME NIGHT as this check-in?" — window is relative to
  // the check-in's moment, not to now (a DUPE_MS-from-now check went stale
  // the instant your own check-in aged past 4h). Same-night = ±12h.
  useEffect(() => {
    if (isOwner || !thread.venueObj || !userId) return;
    let cancelled = false;
    (async () => {
      const SAME_NIGHT_MS = 12 * 60 * 60 * 1000;
      const ref = new Date(thread.timestamp).getTime();
      const { data } = await supabase
        .from("activities")
        .select("id, created_at")
        .eq("user_id", userId)
        .eq("venue_id", thread.venueObj.id)
        .eq("kind", "checkin")
        .gte("created_at", new Date(ref - SAME_NIGHT_MS).toISOString())
        .lte("created_at", new Date(ref + SAME_NIGHT_MS).toISOString())
        .order("created_at", { ascending: false })
        .limit(1);
      if (cancelled) return;
      // joined still means "currently there" for the join-button state.
      setJoined(
        (data || []).some(
          (a) => Date.now() - new Date(a.created_at).getTime() < DUPE_MS
        )
      );
      setMyActivityId(data?.[0]?.id ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner, userId, thread.venueObj?.id, thread.timestamp]);

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
        .in("activity_id", contentIds()) // the shared night, not one twin
        .is("photo_id", null) // photo comments live in their lightbox thread
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
  }, [clusterKey, myActivityId]);

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
      {/* Floating card, same geometry as the venue card — a check-in is a
          first-class object and its view should carry itself like one. */}
      <div
        className="absolute left-0 right-0 mx-auto max-w-sm flex flex-col bg-white rounded-3xl border border-neutral-100 shadow-2xl overflow-hidden"
        style={{
          bottom: 80,
          width: "calc(100% - 1.5rem)",
          maxHeight: "calc(100% - 100px)",
        }}
      >
        <div className="px-5 pt-4 pb-2 border-b border-neutral-100">
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
                {timeAgoShort(thread.timestamp)} · only{" "}
                {thread.ownerName === "You"
                  ? "your"
                  : `${thread.ownerName}'s`}{" "}
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

        {/* Photo strip — the owner's photos plus, if the viewer joined this
            check-in, their own. The camera tile shows for whoever has a
            check-in to hang photos on (owner always; joined viewer via
            their own parallel check-in). */}
        {(photos.length > 0 || uploadTargetId) && (
          <div className="px-5 pt-3">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addPhotos(e.target.files);
                e.target.value = "";
              }}
            />
            <div className="flex gap-2 overflow-x-auto pb-1">
              {photos.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setLightbox(p)}
                  className="shrink-0 active:scale-95 transition"
                >
                  <img
                    src={p.url}
                    alt=""
                    className="h-24 w-24 rounded-xl object-cover"
                  />
                </button>
              ))}
              {uploadTargetId && myPhotoCount < MAX_PHOTOS_PER_CHECKIN && (
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="h-24 w-24 shrink-0 rounded-xl border border-dashed border-neutral-300 flex flex-col items-center justify-center gap-1 text-neutral-500 active:scale-95 transition disabled:opacity-50"
                >
                  <Camera size={20} />
                  <span className="text-[10px] font-medium">
                    {uploading ? "Uploading…" : myPhotoCount === 0 ? "Add photos" : "More"}
                  </span>
                </button>
              )}
            </div>
          </div>
        )}
        {joinEligible && joined === false && (
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
        {joinEligible && joined === true && (
          <div className="px-5 pt-3">
            <p className="w-full rounded-full bg-[#edf2eb] border border-[#cdd9c6] py-2.5 text-center text-sm font-medium text-[#455d3b]">
              You're here too ✓
            </p>
          </div>
        )}
        {/* Reactions on the check-in itself — one swappable per person. */}
        <div className="px-5 pt-3">
          <ReactionBar
            counts={summarizeReactions(reactions, userId, null).counts}
            mine={summarizeReactions(reactions, userId, null).mine}
            disabled={reacting}
            onTap={(e) => react(e, null)}
          />
        </div>
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
      {lightbox && (
        <div className="fixed inset-0 z-[3800] bg-black/85 flex flex-col">
          {/* Tap the photo area to close; the panel below is its thread. */}
          <button
            type="button"
            aria-label="Close photo"
            onClick={() => setLightbox(null)}
            className="flex-1 min-h-0 flex items-center justify-center p-3"
          >
            <img
              src={lightbox.url}
              alt=""
              className="max-h-full max-w-full rounded-2xl object-contain"
            />
          </button>
          <div className="shrink-0 max-h-[45%] flex flex-col bg-white rounded-t-3xl">
            <div className="px-5 pt-3 pb-2">
              <ReactionBar
                counts={summarizeReactions(reactions, userId, lightbox.id).counts}
                mine={summarizeReactions(reactions, userId, lightbox.id).mine}
                disabled={reacting}
                onTap={(e) => react(e, lightbox)}
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-5 pb-2">
              {photoComments === null && (
                <p className="text-xs text-neutral-400 py-2">Loading…</p>
              )}
              {photoComments !== null && photoComments.length === 0 && (
                <p className="text-xs text-neutral-400 py-2">
                  No comments on this photo yet.
                </p>
              )}
              <div className="space-y-2.5">
                {(photoComments || []).map((c) => (
                  <div key={c.id} className="flex items-start gap-2.5">
                    <FriendAvatar profile={c.profile} small />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-neutral-500">
                        <span className="font-medium text-neutral-800">
                          {c.profile?.display_name || "Someone"}
                        </span>{" "}
                        · {timeAgoShort(c.created_at)}
                      </p>
                      <p className="text-sm text-neutral-900 break-words">
                        {c.body}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-4 py-3 border-t border-neutral-100 flex items-center gap-2">
              {/* text-base: sub-16px inputs make iOS Safari auto-zoom. */}
              <input
                value={photoBody}
                onChange={(e) => setPhotoBody(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendPhotoComment()}
                placeholder="Comment on this photo"
                maxLength={500}
                className="flex-1 rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b]"
              />
              <button
                type="button"
                onClick={sendPhotoComment}
                disabled={photoSending || !photoBody.trim()}
                aria-label="Send"
                className="w-10 h-10 shrink-0 rounded-full bg-[#455d3b] text-white flex items-center justify-center disabled:opacity-40 active:scale-95 transition"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
