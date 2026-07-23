// Comment thread on a check-in. Opened from Activity items (a friend's
// check-in, or "commented on your check-in"). Visibility is enforced by
// activity_comments RLS: the audience is the CHECK-IN OWNER's friends — a
// commenter's own friends see nothing (see activity_comments_table.sql).
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Send, ChevronLeft, ChevronRight, UserPlus } from "lucide-react";

const TAG_SEARCH_THRESHOLD = 8; // chips-only below this many friends
const GRID_CAP = 9; // photos shown before "show more"
const AVATAR_CAP = 5; // faces shown before "+N"

// "3h" while fresh, then dates (Mark, July 23: "flips to date").
function whenLine(ts) {
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 24 * 60 * 60 * 1000) return timeAgoShort(ts);
  const d = new Date(ts);
  if (ms < 48 * 60 * 60 * 1000) return "yesterday";
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}),
  });
}
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";
import { timeAgoShort, FRESH_MS } from "../lib/checkins";
import {
  fetchCheckinPhotosMany,
  uploadCheckinMedia,
  deleteCheckinPhoto,
  trackUpload,
  getInflightFor,
  subscribeUploads,
  updateUploadPreview,
  updateUploadProgress,
  makeVideoPreviewUrl,
  MAX_PHOTOS_PER_CHECKIN,
} from "../lib/photos";
import {
  REACTION_SET,
  fetchReactionsMany,
  summarizeReactions,
  toggleReaction,
} from "../lib/reactions";
import { Camera } from "lucide-react";
import { sendPush } from "../lib/push";

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
  // Owner can edit the "what's on" title from the card (past nights included).
  const [labelValue, setLabelValue] = useState(thread.label || "");
  const [labelEdit, setLabelEdit] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelSaving, setLabelSaving] = useState(false);

  useEffect(() => {
    // Re-sync if the same mounted card switches to another check-in.
    setLabelValue(thread.label || "");
    setLabelEdit(false);
  }, [thread.activityId, thread.label]);

  async function saveLabel() {
    if (labelSaving) return;
    const text = labelDraft.trim().slice(0, 80);
    setLabelSaving(true);
    const { error } = await supabase
      .from("activities")
      .update({ label: text || null })
      .eq("id", thread.activityId);
    setLabelSaving(false);
    if (error) {
      console.error("Label update failed:", error);
      showToast?.("Couldn't save that");
      return;
    }
    setLabelValue(text);
    setLabelEdit(false);
  }

  // Owner's from-the-card tagging (Add a night / forgot in the moment).
  const [tagFriends, setTagFriends] = useState(null); // null = not loaded
  const [taggedIds, setTaggedIds] = useState(() => new Set());
  const [tagStatusById, setTagStatusById] = useState({}); // uid → pending|accepted
  // Card views (July 23 redesign): card | comments (expanded) | people.
  const [view, setView] = useState("card");
  const [photosExpanded, setPhotosExpanded] = useState(false);
  const [nightPeople, setNightPeople] = useState([]); // profiles in the night
  const [friendState, setFriendState] = useState({}); // uid → friend|pending|none
  const [leaveArm, setLeaveArm] = useState(false); // two-tap "remove myself"
  const [leaving, setLeaving] = useState(false);

  // Remove yourself from the night: delete YOUR shard (check-in + media +
  // its Been entry) and strip your name off every other shard's with-line.
  // Other people's shards stay untouched; if you were the root, theirs
  // detach into their own nights.
  async function leaveNight() {
    if (leaving) return;
    setLeaving(true);
    try {
      const myShardId = isOwner ? thread.activityId : myActivityId;
      await supabase
        .from("activity_tags")
        .update({ status: "removed", responded_at: new Date().toISOString() })
        .in("activity_id", clusterIds)
        .eq("tagged_user_id", userId);
      if (myShardId) {
        // Storage first (raw row deletes would orphan the files).
        const mine = photos.filter(
          (p) => p.user_id === userId && p.activity_id === myShardId
        );
        for (const m of mine) {
          try {
            await deleteCheckinPhoto(m);
          } catch {}
        }
        // Detach any shards that joined THROUGH yours before deleting.
        await supabase
          .from("activities")
          .update({ joined_from: null })
          .eq("joined_from", myShardId);
        await supabase.from("activities").delete().eq("id", myShardId);
      }
      showToast?.("You've left this check-in");
      onClose();
    } catch (e) {
      console.error("Leave night failed:", e);
      showToast?.("Couldn't do that");
    }
    setLeaving(false);
    setLeaveArm(false);
  }
  const [tagQ, setTagQ] = useState("");
  const [tagRefresh, setTagRefresh] = useState(0);
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
  // Uploader profiles for attribution — the strip is the whole night's
  // media, so every tile/lightbox names its author.
  const [mediaProfiles, setMediaProfiles] = useState({});
  // Lightbox holds the full photo ROW — it's a mini-thread now (photo +
  // its own reactions + its own comments), not just a big image.
  const [lightbox, setLightbox] = useState(null);
  const [photoComments, setPhotoComments] = useState(null); // null = loading
  const [photoBody, setPhotoBody] = useState("");
  const [photoSending, setPhotoSending] = useState(false);
  const touchX = useRef(null); // lightbox swipe start
  // Flip between the night's photos without leaving the lightbox — comments
  // and reactions re-key off lightbox.id automatically.
  const lightboxIdx = lightbox
    ? photos.findIndex((p) => p.id === lightbox.id)
    : -1;
  function stepLightbox(dir) {
    if (lightboxIdx < 0) return;
    const next = photos[lightboxIdx + dir];
    if (next) setLightbox(next);
  }
  // One flat row set for the whole check-in (check-in level + every photo);
  // summarizeReactions() slices per target.
  const [reactions, setReactions] = useState([]);
  const [reacting, setReacting] = useState(false);
  // In-flight tiles come from the MODULE-LEVEL store (lib/photos), not local
  // state — so closing and reopening the card still shows "Uploading…" for
  // anything mid-flight, and finishing uploads refresh any mounted card.
  const fileInputRef = useRef(null);
  const listRef = useRef(null);
  const isOwner = thread.ownerId === userId;
  const uploadTargetId = isOwner ? thread.activityId : myActivityId;
  // THE NIGHT GRAPH (July 23 — Mark: nights are defined by INVITATIONS, not
  // venue coincidence). The card merges shards connected to this one through
  // joined_from edges: walk UP to the night's root, then collect the tree
  // below it. Two groups at the same pub never merge. RLS still trims every
  // row to what the viewer may see.
  const [clusterIds, setClusterIds] = useState([thread.activityId]);
  const clusterKey = clusterIds.join(",");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Walk up joined_from to the root (bounded).
      let rootId = thread.activityId;
      for (let hop = 0; hop < 4; hop++) {
        const { data: row } = await supabase
          .from("activities")
          .select("joined_from")
          .eq("id", rootId)
          .maybeSingle();
        if (row?.joined_from) rootId = row.joined_from;
        else break;
      }
      // Collect the tree below the root (two levels covers real nights).
      const ids = new Set([rootId, thread.activityId]);
      const { data: l1 } = await supabase
        .from("activities")
        .select("id")
        .eq("joined_from", rootId);
      (l1 || []).forEach((r) => ids.add(r.id));
      if (l1 && l1.length > 0) {
        const { data: l2 } = await supabase
          .from("activities")
          .select("id")
          .in("joined_from", l1.map((r) => r.id));
        (l2 || []).forEach((r) => ids.add(r.id));
      }
      if (!cancelled) setClusterIds(Array.from(ids));
    })();
    return () => {
      cancelled = true;
    };
  }, [thread.activityId]);
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

  async function react(emoji, photo = null, comment = null) {
    if (reacting) return;
    setReacting(true);
    try {
      await toggleReaction({
        activityId: comment
          ? comment.activity_id || thread.activityId
          : photo
          ? photo.activity_id
          : thread.activityId,
        photoId: photo ? photo.id : null,
        commentId: comment ? comment.id : null,
        userId,
        emoji,
      });
      setReactions(await fetchReactionsMany(contentIds()));
      // Notify whoever owns the thing that got the emoji.
      const target = comment
        ? comment.user_id
        : photo
        ? photo.user_id
        : thread.ownerId;
      sendPush(
        target,
        `${emoji} on your ${comment ? "comment" : photo ? "photo" : "check-in"}`,
        `Someone reacted ${emoji} at ${thread.venueName}`
      );
    } catch (e) {
      console.error("Reaction failed:", e);
      showToast?.("Couldn't react");
    }
    setReacting(false);
  }

  // Per-comment reactions: existing emoji render as tiny count chips; the
  // "React" toggle opens the six-emoji row for THAT comment (one at a time).
  const [openReactFor, setOpenReactFor] = useState(null);
  function commentReactionRow(c) {
    const { counts, mine } = summarizeReactions(reactions, userId, null, c.id);
    const entries = Object.entries(counts);
    return (
      <div className="mt-1 flex items-center gap-1 flex-wrap">
        {entries.map(([e, n]) => (
          <button
            key={e}
            type="button"
            disabled={reacting}
            onClick={() => react(e, null, c)}
            className={`flex items-center gap-0.5 rounded-full border px-1.5 py-0.5 text-[11px] active:scale-90 transition disabled:opacity-50 ${
              mine === e
                ? "bg-[#edf2eb] border-[#455d3b] text-[#455d3b]"
                : "border-neutral-200 text-neutral-600"
            }`}
          >
            {e} {n}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setOpenReactFor(openReactFor === c.id ? null : c.id)}
          className="text-[11px] text-neutral-400 px-1"
        >
          {openReactFor === c.id ? "close" : entries.length === 0 ? "react" : "+"}
        </button>
        {openReactFor === c.id &&
          REACTION_SET.map((e) => (
            <button
              key={`pick_${e}`}
              type="button"
              disabled={reacting}
              onClick={() => {
                react(e, null, c);
                setOpenReactFor(null);
              }}
              className="text-sm active:scale-90 transition disabled:opacity-50"
            >
              {e}
            </button>
          ))}
      </div>
    );
  }

  // Resolve uploader profiles for any media rows we haven't seen yet.
  useEffect(() => {
    const ids = Array.from(new Set(photos.map((p) => p.user_id))).filter(
      (id) => id && !mediaProfiles[id]
    );
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", ids);
      if (!cancelled && data?.length) {
        setMediaProfiles((prev) => ({
          ...prev,
          ...Object.fromEntries(data.map((p) => [p.id, p])),
        }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [photos]);

  // Everyone in the night: shard owners + accepted tags → the avatar row
  // and the people view ("Others in the album" = friend discovery).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [actsRes, tagsRes] = await Promise.all([
        supabase.from("activities").select("user_id").in("id", clusterIds),
        supabase
          .from("activity_tags")
          .select("tagged_user_id")
          .in("activity_id", clusterIds)
          .eq("status", "accepted"),
      ]);
      const ids = new Set([
        ...(actsRes.data || []).map((a) => a.user_id),
        ...(tagsRes.data || []).map((t) => t.tagged_user_id),
      ]);
      if (thread.ownerId) ids.add(thread.ownerId);
      const arr = Array.from(ids);
      if (arr.length === 0) {
        if (!cancelled) setNightPeople([]);
        return;
      }
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", arr);
      if (!cancelled) setNightPeople(profs || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [clusterKey]);

  // Friendship status per night-person — powers the Add friend buttons.
  useEffect(() => {
    if (view !== "people" || nightPeople.length === 0 || !userId) return;
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id, status")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
      if (cancelled) return;
      const map = {};
      for (const r of rows || []) {
        const other = r.requester_id === userId ? r.addressee_id : r.requester_id;
        if (r.status === "accepted") map[other] = "friend";
        else if (r.status === "pending" && !map[other]) map[other] = "pending";
      }
      setFriendState(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [view, nightPeople.length, userId]);

  async function addFriendFromAlbum(otherId) {
    setFriendState((prev) => ({ ...prev, [otherId]: "pending" }));
    const { error } = await supabase
      .from("friendships")
      .insert({ requester_id: userId, addressee_id: otherId, status: "pending" });
    if (error && error.code !== "23505") {
      setFriendState((prev) => ({ ...prev, [otherId]: "none" }));
      showToast?.("Couldn't send that");
      return;
    }
    sendPush(otherId, "New friend request", "Someone from your night wants to add you");
  }

  // Delete your OWN media (bytes count toward YOUR credit — so you can
  // always take them back). Two-tap: arm, then confirm.
  const [deleteArm, setDeleteArm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function removeMedia() {
    if (!lightbox || deleting) return;
    setDeleting(true);
    try {
      await deleteCheckinPhoto(lightbox);
      setPhotos((prev) => prev.filter((p) => p.id !== lightbox.id));
      setLightbox(null);
    } catch (e) {
      console.error("Delete failed:", e);
      showToast?.("Couldn't delete that");
    }
    setDeleting(false);
    setDeleteArm(false);
  }

  // Photo comments load when the lightbox opens (its own little thread).
  useEffect(() => {
    if (!lightbox) return;
    let cancelled = false;
    setPhotoComments(null);
    setPhotoBody("");
    setDeleteArm(false);
    (async () => {
      const { data: rows } = await supabase
        .from("activity_comments")
        .select("id, activity_id, user_id, body, created_at")
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
      .select("id, activity_id, user_id, body, created_at")
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
    sendPush(
      lightbox.user_id,
      "New comment on your photo",
      `${(me?.display_name || "Someone").split(" ")[0]}: ${text.slice(0, 80)}`
    );
  }

  const pending = getInflightFor(
    Array.from(new Set([...clusterIds, ...(myActivityId ? [myActivityId] : []), thread.activityId]))
  );

  // Any upload starting/finishing anywhere re-renders this card and, on
  // finishes, re-pulls the strip — covers cards remounted mid-upload.
  useEffect(() => {
    let cancelled = false;
    const unsub = subscribeUploads(async () => {
      if (cancelled) return;
      const rows = await fetchCheckinPhotosMany(contentIds());
      if (!cancelled) {
        setPhotos(
          rows
            .filter((r) => r.url)
            .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
        );
      }
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [clusterKey, myActivityId]);

  // Fire-and-forget: tiles appear instantly, bytes move in the background
  // (a 50MB video on a phone uplink takes what it takes — the card just
  // shouldn't make you watch). The store keeps tiles alive across close/reopen.
  function addPhotos(fileList) {
    if (!uploadTargetId) return;
    const files = Array.from(fileList || []).slice(
      0,
      Math.max(0, MAX_PHOTOS_PER_CHECKIN - myPhotoCount - pending.length)
    );
    for (const file of files) {
      const key = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const isVideo = (file.type || "").startsWith("video/");
      const preview = isVideo ? null : URL.createObjectURL(file);
      const promise = uploadCheckinMedia(userId, uploadTargetId, file, (pct) =>
        updateUploadProgress(key, pct)
      ).catch((e) => {
        console.error("Media upload failed:", e);
        showToast?.(
          e?.code === "too_big"
            ? "Videos can be up to 50MB"
            : "Couldn't upload that"
        );
      });
      trackUpload({ key, activityId: uploadTargetId, isVideo, preview }, promise);
      if (isVideo) {
        // Frame grab lands in ~a second — long before the bytes do.
        makeVideoPreviewUrl(file)
          .then((url) => updateUploadPreview(key, url))
          .catch(() => {});
      }
    }
  }

  const joinEligible =
    !!onCheckIn &&
    !!thread.venueObj &&
    thread.ownerId !== userId &&
    Date.now() - new Date(thread.timestamp).getTime() < FRESH_MS;

  // "Am I part of this NIGHT?" — edge-based (July 23): my shard is whichever
  // check-in of MINE sits in this night's graph. An independent check-in at
  // the same venue is a different night and grants nothing here.
  useEffect(() => {
    if (isOwner || !userId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("activities")
        .select("id")
        .in("id", clusterIds)
        .eq("user_id", userId)
        .limit(1);
      if (cancelled) return;
      setMyActivityId(data?.[0]?.id ?? null);
      setJoined((data || []).length > 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwner, userId, clusterKey]);

  // "with JD and Bianca" — tags on this check-in (pending + accepted render;
  // removed never does). taggedIds feeds the owner's add-friends picker.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rawTags } = await supabase
        .from("activity_tags")
        .select("tagged_user_id, status, requested_by")
        .eq("activity_id", thread.activityId)
        .neq("status", "removed");
      // Pending SELF-requests (joiner asking on) render nowhere until the
      // owner accepts — their card, their consent.
      const tags = (rawTags || []).filter(
        (t) => !(t.status === "pending" && t.requested_by === t.tagged_user_id)
      );
      const statusById = Object.fromEntries(
        (tags || []).map((t) => [t.tagged_user_id, t.status])
      );
      const ids = Object.keys(statusById);
      if (!cancelled) {
        setTaggedIds(new Set(ids));
        setTagStatusById(statusById);
      }
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
          .map((p) => ({
            name: (p.display_name || "").split(" ")[0],
            pending: statusById[p.id] === "pending",
          }))
          .filter((w) => w.name)
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [thread.activityId, tagRefresh]);

  // Owner can tag friends FROM the card — serves "+ Add a night" and any
  // check-in where tagging was skipped in the moment. Same consent flow:
  // the friend gets the nudge; accepting creates THEIR twin for that night,
  // which the cluster merge folds back into this very card.
  async function openTagPicker() {
    setView((v) => (v === "add" ? "card" : "add"));
    if (tagFriends !== null) return;
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
      setTagFriends([]);
      return;
    }
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, display_name, username, avatar_url")
      .in("id", ids)
      .order("display_name", { ascending: true });
    setTagFriends(profs || []);
  }

  async function toggleTag(friendId) {
    const isTagged = taggedIds.has(friendId);
    setTaggedIds((prev) => {
      const next = new Set(prev);
      if (isTagged) next.delete(friendId);
      else next.add(friendId);
      return next;
    });
    if (isTagged) {
      await supabase
        .from("activity_tags")
        .delete()
        .eq("activity_id", thread.activityId)
        .eq("tagged_user_id", friendId);
    } else {
      const { error } = await supabase
        .from("activity_tags")
        .insert({ activity_id: thread.activityId, tagged_user_id: friendId });
      if (error && error.code === "23505") {
        // They already self-requested (joined) — your tag is the second
        // consent. Complete it, no nudges either way.
        await supabase
          .from("activity_tags")
          .update({ status: "accepted", responded_at: new Date().toISOString() })
          .eq("activity_id", thread.activityId)
          .eq("tagged_user_id", friendId);
        sendPush(friendId, "You're on the check-in 🎉", `Added at ${thread.venueName}`);
      } else if (error) {
        console.error("Tag failed:", error);
        setTaggedIds((prev) => {
          const next = new Set(prev);
          next.delete(friendId);
          return next;
        });
      } else {
        sendPush(
          friendId,
          "You've been checked in",
          `${thread.venueName} — accept to add the night to your Been list`
        );
      }
    }
    setTagRefresh((n) => n + 1); // re-derive the "with" line
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from("activity_comments")
        .select("id, activity_id, user_id, body, created_at")
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
      .select("id, activity_id, user_id, body, created_at")
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
    sendPush(
      thread.ownerId,
      "New comment",
      `${(me?.display_name || "Someone").split(" ")[0]}: ${text.slice(0, 80)}`
    );
  }

  // PORTAL to body: rendered inside a parent overlay (e.g. Been at z-2500)
  // this card's z-3600 would only count within that parent's stacking
  // context — root-level chrome like the +FAB (z-3060) would draw over it.
  return createPortal(
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
          // FIXED height (Mark: like the venue card) — the card must not
          // resize as views/content change.
          height: "calc(100% - 100px)",
        }}
      >
        <div className="px-5 pt-3 pb-2.5 border-b border-neutral-100">
          <div className="flex items-start justify-between">
            <div className="min-w-0 flex-1">
              {/* Title as the headline (Mark's mock): the label leads; a
                  bare card shows the owner's tiny "add a title" instead. */}
              {labelValue ? (
                <button
                  type="button"
                  disabled={!isOwner}
                  onClick={() => {
                    setLabelDraft(labelValue);
                    setLabelEdit((v) => !v);
                  }}
                  className="block w-full text-left text-lg font-semibold tracking-tight leading-snug truncate"
                >
                  {labelValue}
                </button>
              ) : (
                isOwner && (
                  <button
                    type="button"
                    onClick={() => {
                      setLabelDraft("");
                      setLabelEdit((v) => !v);
                    }}
                    className="text-[11px] font-medium text-[#455d3b]"
                  >
                    add a title
                  </button>
                )
              )}
              {/* Title editor lives in the TITLE's slot (Mark: not under the
                  names/venue). */}
              {labelEdit && isOwner && (
                <div className="mb-1 mt-0.5 flex items-center gap-2 rounded-full border border-neutral-200 pl-3 pr-1 py-1">
                  <input
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && saveLabel()}
                    placeholder="What was on?"
                    maxLength={80}
                    autoFocus
                    className="flex-1 min-w-0 bg-transparent text-base focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="Save title"
                    disabled={labelSaving}
                    onClick={saveLabel}
                    className="w-7 h-7 shrink-0 rounded-full bg-[#455d3b] text-white flex items-center justify-center text-xs disabled:opacity-50 active:scale-95 transition"
                  >
                    ✓
                  </button>
                </div>
              )}
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
          {/* Avatar row spans the FULL header width so "add more" sits flush
              with the card's right edge (Mark's alignment note). */}
          <div>
              {/* Avatar row — the night's people; +N overflows to View all. */}
              {nightPeople.length > 0 && (
                <div className="mt-1.5 flex items-center gap-1">
                  {nightPeople.slice(0, AVATAR_CAP).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onOpenProfile?.(p.id)}
                      className="active:scale-95 transition"
                    >
                      <FriendAvatar profile={p} small />
                    </button>
                  ))}
                  {nightPeople.length > AVATAR_CAP && (
                    <button
                      type="button"
                      onClick={() => setView("people")}
                      className="ml-0.5 flex h-7 min-w-7 items-center justify-center rounded-full bg-[#edf2eb] px-1.5 text-[11px] font-medium text-[#455d3b]"
                    >
                      +{nightPeople.length - AVATAR_CAP}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setView(view === "people" ? "card" : "people")}
                    className="ml-1 text-[11px] font-medium text-neutral-400"
                  >
                    View all
                  </button>
                  {isOwner && (
                    <button
                      type="button"
                      onClick={openTagPicker}
                      className="ml-auto mr-0.5 inline-flex items-center gap-1 rounded-full border border-neutral-200 px-2.5 py-1 text-xs font-medium text-[#455d3b] active:scale-95 transition"
                    >
                      <UserPlus size={13} /> add more
                    </button>
                  )}
                </div>
              )}
              <p className="text-[11px] text-neutral-500">
                {whenLine(thread.timestamp)} · only{" "}
                {thread.ownerName === "You"
                  ? "your"
                  : `${thread.ownerName}'s`}{" "}
                friends see this
              </p>
          </div>
        </div>

        {/* Add-people view (Mark's mock): friends as ROWS with Add buttons,
            not a chip cloud. Collect link section lands here in Stage 2. */}
        {view === "add" && isOwner && (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <button
              type="button"
              onClick={() => setView("card")}
              className="mb-3 text-xs font-medium text-[#455d3b]"
            >
              ‹ Back to the night
            </button>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              Friends on Flanit
            </p>
            {tagFriends === null && (
              <p className="text-xs text-neutral-400">Loading friends…</p>
            )}
            {tagFriends !== null && tagFriends.length === 0 && (
              <p className="text-xs text-neutral-400">
                No friends on Flanit yet.
              </p>
            )}
            {tagFriends !== null && tagFriends.length > 0 && (
              <>
                {tagFriends.length > TAG_SEARCH_THRESHOLD && (
                  <input
                    value={tagQ}
                    onChange={(e) => setTagQ(e.target.value)}
                    placeholder="Search friends"
                    className="mb-3 w-full rounded-full border border-neutral-200 px-4 py-2 text-base focus:outline-none focus:border-[#455d3b]"
                  />
                )}
                <div className="space-y-2.5">
                  {tagFriends
                    .filter((f) => {
                      const q = tagQ.trim().toLowerCase();
                      return (
                        !q ||
                        (f.display_name || "").toLowerCase().includes(q) ||
                        (f.username || "").toLowerCase().includes(q)
                      );
                    })
                    .map((f) => {
                      const on = taggedIds.has(f.id);
                      const accepted = tagStatusById[f.id] === "accepted";
                      return (
                        <div key={f.id} className="flex items-center gap-3">
                          <FriendAvatar profile={f} small />
                          <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                            {f.display_name || "Someone"}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleTag(f.id)}
                            className={`shrink-0 rounded-full text-xs font-medium px-3 py-1.5 active:scale-95 transition ${
                              on && accepted
                                ? "bg-[#455d3b] text-white"
                                : on
                                ? "border border-[#455d3b] text-[#455d3b]"
                                : "bg-[#455d3b] text-white"
                            }`}
                          >
                            {on ? (accepted ? "Added ✓" : "Invited") : "Add"}
                          </button>
                        </div>
                      );
                    })}
                </div>
                <p className="mt-1.5 text-[10px] text-neutral-400">
                  They'll be asked before their friends see anything.
                </p>
              </>
            )}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          multiple
          className="hidden"
          onChange={(e) => {
            addPhotos(e.target.files);
            e.target.value = "";
          }}
        />
        {/* Photo GRID (July 23 redesign) — 3-up album, capped with a
            "+N more" tile; a small strip in the expanded-comments view. */}
        {view === "card" && (photos.length > 0 || uploadTargetId) && (
          <div className="px-4 pt-3">
            <div className="grid grid-cols-3 gap-1.5">
              {(photosExpanded
                ? photos
                : photos.slice(
                    0,
                    photos.length > GRID_CAP ? GRID_CAP - 1 : GRID_CAP
                  )
              ).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setLightbox(p)}
                  className="relative aspect-square active:scale-95 transition"
                >
                  <img
                    src={p.url}
                    alt=""
                    className="h-full w-full rounded-lg object-cover"
                  />
                  {p.kind === "video" && (
                    <span className="absolute inset-0 flex items-center justify-center">
                      <span className="w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center text-sm">
                        ▶
                      </span>
                    </span>
                  )}
                  <span className="absolute bottom-1 left-1 rounded-full ring-2 ring-white">
                    <FriendAvatar profile={mediaProfiles[p.user_id]} small />
                  </span>
                </button>
              ))}
              {!photosExpanded && photos.length > GRID_CAP && (
                <button
                  type="button"
                  onClick={() => setPhotosExpanded(true)}
                  className="relative aspect-square rounded-lg overflow-hidden active:scale-95 transition"
                >
                  <img
                    src={photos[GRID_CAP - 1].url}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute inset-0 flex items-center justify-center bg-black/55 text-white text-sm font-medium">
                    +{photos.length - (GRID_CAP - 1)} more
                  </span>
                </button>
              )}
              {pending.map((p) => (
                <div key={p.key} className="relative aspect-square">
                  {p.preview ? (
                    <img
                      src={p.preview}
                      alt=""
                      className="h-full w-full rounded-lg object-cover opacity-60"
                    />
                  ) : (
                    <span className="flex h-full w-full rounded-lg bg-neutral-800/80 text-white items-center justify-center text-lg">
                      {p.isVideo ? "▶" : "…"}
                    </span>
                  )}
                  <span className="absolute inset-0 flex items-center justify-center">
                    <span className="rounded-full bg-black/45 px-2 py-0.5 text-[10px] font-medium text-white">
                      {p.progress != null
                        ? `Uploading ${p.progress}%`
                        : "Uploading…"}
                    </span>
                  </span>
                </div>
              ))}
              {uploadTargetId &&
                myPhotoCount + pending.length < MAX_PHOTOS_PER_CHECKIN && (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="aspect-square rounded-lg border border-dashed border-neutral-300 flex flex-col items-center justify-center gap-1 text-neutral-500 active:scale-95 transition"
                  >
                    <Camera size={20} />
                    <span className="text-[10px] font-medium">
                      {myPhotoCount + pending.length === 0
                        ? "Add photos"
                        : "More"}
                    </span>
                  </button>
                )}
            </div>
          </div>
        )}
        {view === "card" && joinEligible && joined === false && (
          <div className="px-5 pt-3">
            <button
              type="button"
              onClick={async () => {
                onClose();
                // Second arg = the night-graph edge: joining links your new
                // check-in into THIS night (July 23 model).
                const act = await onCheckIn(thread.venueObj, thread.activityId);
                if (act) {
                  // If the owner ALREADY tagged you (nudge unseen), your join
                  // is the second consent — auto-accept, no questions asked.
                  // Otherwise: a SELF-REQUESTED tag the owner accepts or
                  // declines; until accepted it renders nowhere.
                  const { data: existingTag } = await supabase
                    .from("activity_tags")
                    .select("id, status, requested_by")
                    .eq("activity_id", thread.activityId)
                    .eq("tagged_user_id", userId)
                    .maybeSingle();
                  if (existingTag && existingTag.requested_by !== userId) {
                    if (existingTag.status !== "accepted") {
                      await supabase
                        .from("activity_tags")
                        .update({
                          status: "accepted",
                          responded_at: new Date().toISOString(),
                        })
                        .eq("id", existingTag.id);
                    }
                    // Reciprocal: your shard says "with [owner]" too.
                    await supabase.from("activity_tags").upsert(
                      {
                        activity_id: act.id,
                        tagged_user_id: thread.ownerId,
                        status: "accepted",
                        responded_at: new Date().toISOString(),
                      },
                      {
                        onConflict: "activity_id,tagged_user_id",
                        ignoreDuplicates: true,
                      }
                    );
                    sendPush(
                      thread.ownerId,
                      "You're together 🎉",
                      `They joined your night at ${thread.venueName}`
                    );
                  } else if (!existingTag) {
                    await supabase.from("activity_tags").upsert(
                      {
                        activity_id: thread.activityId,
                        tagged_user_id: userId,
                        requested_by: userId,
                        status: "pending",
                      },
                      {
                        onConflict: "activity_id,tagged_user_id",
                        ignoreDuplicates: true,
                      }
                    );
                    sendPush(
                      thread.ownerId,
                      "Someone's here too",
                      `They joined your night at ${thread.venueName} — add them to your check-in?`
                    );
                  }
                }
              }}
              className="w-full rounded-full bg-[#455d3b] py-2.5 text-sm font-medium text-white active:scale-[0.99] transition"
            >
              I'm here too — join {thread.ownerName}
            </button>
          </div>
        )}
        {view === "card" && joinEligible && joined === true && (
          <div className="px-5 pt-3">
            <p className="w-full rounded-full bg-[#edf2eb] border border-[#cdd9c6] py-2.5 text-center text-sm font-medium text-[#455d3b]">
              You're here too ✓
            </p>
          </div>
        )}
        {/* Reactions on the check-in itself — one swappable per person. */}
        {view === "card" && (
        <div className="px-5 pt-3">
          <ReactionBar
            counts={summarizeReactions(reactions, userId, null).counts}
            mine={summarizeReactions(reactions, userId, null).mine}
            disabled={reacting}
            onTap={(e) => react(e, null)}
          />
        </div>
        )}
        {/* People view — the album's cast, split into your friends and
            "others in the album" with Add friend (graph growth, per mock). */}
        {view === "people" && (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <button
              type="button"
              onClick={() => setView("card")}
              className="mb-3 text-xs font-medium text-[#455d3b]"
            >
              ‹ Back to the night
            </button>
            {(() => {
              const others = nightPeople.filter(
                (p) => p.id !== userId && friendState[p.id] !== "friend"
              );
              const friendsHere = nightPeople.filter(
                (p) => p.id === userId || friendState[p.id] === "friend"
              );
              return (
                <>
                  {friendsHere.length > 0 && (
                    <>
                      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                        Your friends
                      </p>
                      <div className="space-y-2 mb-4">
                        {friendsHere.map((p) => (
                          <div key={p.id} className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => onOpenProfile?.(p.id)}
                              className="flex items-center gap-3 flex-1 min-w-0 text-left"
                            >
                              <FriendAvatar profile={p} small />
                              <span className="truncate text-sm text-neutral-800">
                                {p.display_name || "Someone"}
                                {p.id === userId ? " (you)" : ""}
                              </span>
                            </button>
                            {p.id === userId && (
                              <button
                                type="button"
                                disabled={leaving}
                                onClick={() =>
                                  leaveArm ? leaveNight() : setLeaveArm(true)
                                }
                                className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium active:scale-95 transition disabled:opacity-50 ${
                                  leaveArm
                                    ? "border-red-500 bg-red-500 text-white"
                                    : "border-neutral-200 text-neutral-500"
                                }`}
                              >
                                {leaving
                                  ? "Leaving…"
                                  : leaveArm
                                  ? "Really leave?"
                                  : "Remove"}
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  {others.length > 0 && (
                    <>
                      <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                        Others in the album
                      </p>
                      <div className="space-y-2">
                        {others.map((p) => (
                          <div key={p.id} className="flex items-center gap-3">
                            <button
                              type="button"
                              onClick={() => onOpenProfile?.(p.id)}
                              className="flex items-center gap-3 flex-1 min-w-0 text-left"
                            >
                              <FriendAvatar profile={p} small />
                              <span className="truncate text-sm text-neutral-800">
                                {p.display_name || "Someone"}
                              </span>
                            </button>
                            <button
                              type="button"
                              disabled={friendState[p.id] === "pending"}
                              onClick={() => addFriendFromAlbum(p.id)}
                              className="shrink-0 rounded-full bg-[#455d3b] text-white text-xs font-medium px-3 py-1.5 disabled:opacity-50"
                            >
                              {friendState[p.id] === "pending"
                                ? "Requested"
                                : "Add friend"}
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                </>
              );
            })()}
          </div>
        )}
        {view === "comments" && photos.length > 0 && (
          <div className="px-4 pt-3">
            <button
              type="button"
              onClick={() => setView("card")}
              className="mb-2 text-xs font-medium text-[#455d3b]"
            >
              ‹ Back to the night
            </button>
            <div className="flex gap-1.5 overflow-x-auto pb-1">
              {photos.map((p) => (
                <button
                  key={`mini_${p.id}`}
                  type="button"
                  onClick={() => setLightbox(p)}
                  className="shrink-0"
                >
                  <img
                    src={p.url}
                    alt=""
                    className="h-14 w-14 rounded-lg object-cover"
                  />
                </button>
              ))}
            </div>
          </div>
        )}
        {(view === "card" || view === "comments") && (
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
            {(view === "comments"
              ? comments || []
              : (comments || []).slice(-2)
            ).map((c) => (
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
                  {commentReactionRow(c)}
                </div>
              </div>
            ))}
          </div>
          {view === "card" && (comments || []).length > 2 && (
            <button
              type="button"
              onClick={() => setView("comments")}
              className="mt-3 w-full text-center text-xs font-medium text-[#455d3b]"
            >
              See more comments ({comments.length})
            </button>
          )}
        </div>
        )}

        {(view === "card" || view === "comments") && (
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
        )}
      </div>
      {lightbox && (
        // One floating card — the photo with its reactions + comments
        // attached directly beneath it, centered and detached from the
        // screen edges (Mark: too many things rising from the bottom).
        <div className="fixed inset-0 z-[3800] flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close photo"
            onClick={() => setLightbox(null)}
            className="absolute inset-0 bg-black/85"
          />
          <div className="relative w-full max-w-sm max-h-[90%] flex flex-col bg-white rounded-3xl overflow-hidden shadow-2xl">
            <div
              className="relative shrink-0 bg-black"
              onTouchStart={(e) => {
                touchX.current = e.touches[0]?.clientX ?? null;
              }}
              onTouchEnd={(e) => {
                if (touchX.current === null) return;
                const dx =
                  (e.changedTouches[0]?.clientX ?? touchX.current) -
                  touchX.current;
                touchX.current = null;
                if (Math.abs(dx) > 40) stepLightbox(dx < 0 ? 1 : -1);
              }}
            >
              {lightbox.kind === "video" && lightbox.videoUrl ? (
                <video
                  src={lightbox.videoUrl}
                  poster={lightbox.url || undefined}
                  controls
                  playsInline
                  autoPlay
                  className="w-full max-h-[50vh] object-contain"
                />
              ) : (
                <img
                  src={lightbox.url}
                  alt=""
                  className="w-full max-h-[50vh] object-contain"
                />
              )}
              <button
                type="button"
                aria-label="Close photo"
                onClick={() => setLightbox(null)}
                className="absolute top-2 right-2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center"
              >
                <X size={16} />
              </button>
              {photos.length > 1 && (
                <>
                  <span className="absolute top-2 left-2 rounded-full bg-black/50 px-2 py-0.5 text-[11px] font-medium text-white">
                    {lightboxIdx + 1}/{photos.length}
                  </span>
                  {lightboxIdx > 0 && (
                    <button
                      type="button"
                      aria-label="Previous photo"
                      onClick={() => stepLightbox(-1)}
                      className="absolute left-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center active:scale-90 transition"
                    >
                      <ChevronLeft size={18} />
                    </button>
                  )}
                  {lightboxIdx < photos.length - 1 && (
                    <button
                      type="button"
                      aria-label="Next photo"
                      onClick={() => stepLightbox(1)}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/50 text-white flex items-center justify-center active:scale-90 transition"
                    >
                      <ChevronRight size={18} />
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="px-4 pt-3 pb-1">
              <div className="flex items-center gap-2 mb-2">
                <button
                  type="button"
                  onClick={() => onOpenProfile?.(lightbox.user_id)}
                  className="flex items-center gap-2 flex-1 min-w-0 text-left"
                >
                  <FriendAvatar
                    profile={mediaProfiles[lightbox.user_id]}
                    small
                  />
                  <span className="truncate text-xs text-neutral-700">
                    <span className="font-medium">
                      {lightbox.user_id === userId
                        ? "Your"
                        : `${
                            (
                              mediaProfiles[lightbox.user_id]?.display_name ||
                              "Someone"
                            ).split(" ")[0]
                          }'s`}
                    </span>{" "}
                    {lightbox.kind === "video" ? "video" : "photo"} ·{" "}
                    {timeAgoShort(lightbox.created_at)}
                  </span>
                </button>
                {lightbox.user_id === userId && (
                  <button
                    type="button"
                    disabled={deleting}
                    onClick={() =>
                      deleteArm ? removeMedia() : setDeleteArm(true)
                    }
                    className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium active:scale-95 transition disabled:opacity-50 ${
                      deleteArm
                        ? "border-red-500 bg-red-500 text-white"
                        : "border-neutral-200 text-neutral-500"
                    }`}
                  >
                    {deleting
                      ? "Deleting…"
                      : deleteArm
                      ? "Really delete?"
                      : "Delete"}
                  </button>
                )}
              </div>
              <ReactionBar
                counts={summarizeReactions(reactions, userId, lightbox.id).counts}
                mine={summarizeReactions(reactions, userId, lightbox.id).mine}
                disabled={reacting}
                onTap={(e) => react(e, lightbox)}
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-2">
              {photoComments === null && (
                <p className="text-xs text-neutral-400 py-1">Loading…</p>
              )}
              {photoComments !== null && photoComments.length === 0 && (
                <p className="text-xs text-neutral-400 py-1">
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
                      {commentReactionRow(c)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            <div className="px-3 py-2.5 border-t border-neutral-100 flex items-center gap-2">
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
    </div>,
    document.body
  );
}
