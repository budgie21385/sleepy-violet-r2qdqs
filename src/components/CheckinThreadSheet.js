// Comment thread on a check-in. Opened from Activity items (a friend's
// check-in, or "commented on your check-in"). Visibility is enforced by
// activity_comments RLS: the audience is the CHECK-IN OWNER's friends — a
// commenter's own friends see nothing (see activity_comments_table.sql).
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Send, ChevronLeft, ChevronRight, UserPlus, Plus, Settings, Home, Download } from "lucide-react";

const TAG_SEARCH_THRESHOLD = 8; // chips-only below this many friends
const GRID_CAP = 9; // photos shown before "show more"
const AVATAR_CAP = 5; // faces shown before "+N"

// Hours while fresh, then calendar-correct days (Mark, July 23: "flips to
// date"). Shares lib/checkins' ladder so Been, the card and the drawer can't
// disagree — the old 24/48h arithmetic called yesterday evening "today".
function whenLine(ts) {
  return whenAgo(ts);
}
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";
import { timeAgoShort, whenAgo, FRESH_MS } from "../lib/checkins";
import {
  searchPlaces,
  addGooglePlace,
  createPersonalPlace,
} from "../lib/venueSearch";
import { acceptFriendRequest } from "../lib/friendships";
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
  MAX_PHOTOS_PER_BATCH,
} from "../lib/photos";
import {
  REACTION_SET,
  fetchReactionsMany,
  summarizeReactions,
  toggleReaction,
} from "../lib/reactions";
import { Camera } from "lucide-react";
import { sendPush } from "../lib/push";

// Always-visible palette (Mark's design, July 24): all six emojis render as
// round chips every time — tapping one reacts/swaps, tapping yours again
// removes it. Two glance signals: a count badge on any emoji that's been
// used, and olive fill on the one YOU picked. "See reactions ›" appears
// once anyone has reacted and opens the who-list sheet (onSeeWho).
// One swappable reaction per person per target (see lib/reactions.js).
function ReactionBar({ counts, mine, onTap, disabled, onSeeWho }) {
  const total = REACTION_SET.reduce((s, e) => s + (counts[e] || 0), 0);
  return (
    <div>
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
              className={`relative flex h-9 w-9 items-center justify-center rounded-full border text-lg active:scale-90 transition disabled:opacity-50 ${
                isMine
                  ? "bg-[#455d3b] border-[#455d3b]"
                  : "border-neutral-200 bg-white"
              }`}
            >
              {e}
              {n > 0 && (
                <span
                  className={`absolute -top-1 -right-1 flex h-4 min-w-[16px] items-center justify-center rounded-full border border-white px-1 text-[9px] font-semibold ${
                    isMine
                      ? "bg-[#2f3f29] text-white"
                      : "bg-neutral-200 text-neutral-600"
                  }`}
                >
                  {n}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {total > 0 && onSeeWho && (
        <button
          type="button"
          onClick={onSeeWho}
          className="mt-2 text-xs font-medium text-[#455d3b]"
        >
          See reactions ›
        </button>
      )}
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

  const autoLightboxDone = useRef(false);

  useEffect(() => {
    // Re-sync if the same mounted card switches to another check-in.
    setLabelValue(thread.label || "");
    setLabelEdit(false);
    autoLightboxDone.current = false; // new thread → new photo target
  }, [thread.activityId, thread.label]);

  // Self-heal the title: openers don't all carry the label (mount-prop
  // parity strikes again) — the DB is the truth, fetch it once per thread.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("activities")
        .select("label")
        .eq("id", thread.activityId)
        .maybeSingle();
      if (!cancelled && data?.label) setLabelValue(data.label);
    })();
    return () => {
      cancelled = true;
    };
  }, [thread.activityId]);

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
      const { error: tagErr } = await supabase
        .from("activity_tags")
        .update({ status: "removed", responded_at: new Date().toISOString() })
        .in("activity_id", clusterIds)
        .eq("tagged_user_id", userId);
      if (tagErr) console.error("Leave: tag removal failed:", tagErr);
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
        // Joined-through shards detach automatically (joined_from is
        // ON DELETE SET NULL — leave_night.sql). And crucially: an
        // RLS-filtered delete returns SUCCESS WITH ZERO ROWS, so we must
        // count what actually died, not just check for errors.
        const { data: deleted, error: delErr } = await supabase
          .from("activities")
          .delete()
          .eq("id", myShardId)
          .select("id");
        if (delErr) throw delErr;
        if (!deleted || deleted.length === 0) {
          throw new Error("delete removed 0 rows — RLS policy refused it");
        }
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

  // Deep-link a photo (Activity: "reacted to your PHOTO" / "commented on
  // your PHOTO") — the card opens with that photo's lightbox already up.
  // Lives BELOW the photos/lightbox declarations: referencing them earlier
  // is a TDZ crash at render (the July 23 white screen).
  useEffect(() => {
    if (autoLightboxDone.current || !thread.photoId) return;
    const target = photos.find((p) => p.id === thread.photoId);
    if (target) {
      autoLightboxDone.current = true;
      setLightbox(target);
    }
  }, [photos, thread.photoId]);
  const [photoComments, setPhotoComments] = useState(null); // null = loading
  const [photoBody, setPhotoBody] = useState("");
  const [photoSending, setPhotoSending] = useState(false);
  // SAVE THE ORIGINAL TO THE CAMERA ROLL (Mark, July 31: "I want it to
  // download as an image and save in Photos on iPhone and Android").
  //
  // A Content-Disposition download does NOT do that. On iOS it lands in Files,
  // never Photos; on Android it goes to the Downloads folder. The only web API
  // that reaches the camera roll is the SHARE SHEET with a File attached —
  // navigator.share({ files }) gives iOS "Save Image" and Android "Save to
  // Photos". So: sign → fetch the bytes → wrap in a File → share, with an
  // <a download> fallback for desktop and any browser without file sharing.
  //
  // Two things to know if this misbehaves. (1) iOS requires share() to happen
  // under transient user activation, which survives a short await but can
  // lapse on a big video — hence the fallback on NotAllowedError rather than
  // an error message. (2) A cancelled share sheet throws AbortError; that's
  // the user changing their mind, not a failure, so it stays silent.
  // iOS is the only platform that NEEDS the sheet, so it's the only one that
  // gets it. Android's <a download> writes to Downloads, which the media
  // scanner surfaces in Gallery and Photos — a real one-tap save, no sheet.
  const isIOS =
    typeof navigator !== "undefined" &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      // iPadOS 13+ reports as a Mac; the touch points give it away.
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

  // The filename is the sheet's header — the ONE part of that system view we
  // control — so it says what the file is rather than "flanit-74". Also what
  // lands in Files or Downloads, where a row id would be useless.
  function saveFilename(row) {
    const ext = (row.orig_path.split(".").pop() || "jpg").toLowerCase();
    const place = (trail[0]?.name || thread.venueName || "Flanit")
      .replace(/[\\/:*?"<>|]/g, "") // illegal in filenames
      .slice(0, 40);
    const when = new Date(row.created_at || thread.timestamp || Date.now())
      .toLocaleDateString("en-AU", { day: "numeric", month: "short" });
    return `${place} — ${when}.${ext}`;
  }

  const [downloading, setDownloading] = useState(false);
  async function downloadOriginal(row) {
    if (!row?.orig_path || downloading) return;
    setDownloading(true);
    try {
      const filename = saveFilename(row);
      const { data, error } = await supabase.storage
        .from("checkin-photos")
        .createSignedUrl(row.orig_path, 60);
      if (error || !data?.signedUrl) throw error || new Error("no url");

      const resp = await fetch(data.signedUrl);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const type = blob.type || (row.kind === "video" ? "video/mp4" : "image/jpeg");
      const file = new File([blob], filename, { type });

      if (isIOS && navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file] });
          setDownloading(false);
          return;
        } catch (shareErr) {
          if (shareErr?.name === "AbortError") {
            setDownloading(false);
            return; // they closed the sheet — not a failure
          }
          // Activation can lapse on a big file; fall through to a download
          // rather than telling them something broke.
          console.warn("Share failed, falling back to download:", shareErr);
        }
      }

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      if (!isIOS) showToast?.("Saved to your photos");
    } catch (e) {
      console.error("Save original failed:", e);
      showToast?.("Couldn't save that one");
    }
    setDownloading(false);
  }

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
  // "See reactions ›" who-list sheet. null = closed. Target: { commentId }
  // for a comment, else { photoId } (null photoId = the check-in itself).
  // Renders above the lightbox.
  const [reactSheet, setReactSheet] = useState(null);
  // Close on thread switch or lightbox flips — the target went stale.
  // (Effect sits BELOW both states it reads — TDZ rule, see 05-log.)
  useEffect(() => {
    setReactSheet(null);
  }, [thread.activityId, lightbox?.id]);

  // Lock the page behind while the card is up — drags on non-scrolling
  // card areas were panning the Activity list underneath (Mark, July 24).
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);
  // In-flight tiles come from the MODULE-LEVEL store (lib/photos), not local
  // state — so closing and reopening the card still shows "Uploading…" for
  // anything mid-flight, and finishing uploads refresh any mounted card.
  const fileInputRef = useRef(null);
  const listRef = useRef(null);
  const isOwner = thread.ownerId === userId;
  const uploadTargetId = isOwner ? thread.activityId : myActivityId;
  // COLLECT LINK (July 24) — one shared, revocable link per check-in that
  // lets ANYONE (no app, no account) drop photos onto this night. Shard
  // rule: the link belongs to YOUR shard (uploadTargetId), so on a shared
  // night each participant manages their own. null = loading, false = none.
  const [collectLink, setCollectLink] = useState(null);
  const [collectBusy, setCollectBusy] = useState(false);
  // QR for the collect link (July 25, Mark) — the in-person door: print it
  // on a table card, stick it on the fridge, hold up your phone. Same lazy
  // `qrcode` import the install page uses, so it costs nothing until a link
  // actually exists.
  const [collectQr, setCollectQr] = useState(null);
  // CHECK-IN SETTINGS (July 25): ONE guest permission on the night's ROOT
  // shard, default ON, enforced in RLS (private_nights.sql). Adding friends
  // and handing out a collect link are the same act — bringing someone in —
  // so they share a switch (Mark's call). Owner opens it from the cog.
  const [nightPerms, setNightPerms] = useState(null); // {rootId, ownerId, canInvite}
  const [permBusy, setPermBusy] = useState(false);
  const iAmRootOwner = nightPerms?.ownerId === userId;
  const mayInvite = !nightPerms || iAmRootOwner || nightPerms.canInvite;
  const mayShareLink = mayInvite;

  useEffect(() => {
    if (view !== "settings" || !uploadTargetId) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("checkin_collect_links")
        .select("id, token, revoked")
        .eq("activity_id", uploadTargetId)
        .eq("revoked", false)
        .maybeSingle();
      if (!cancelled) setCollectLink(data || false);
    })();
    return () => {
      cancelled = true;
    };
  }, [view, uploadTargetId]);

  async function collectAction(kind) {
    // kind: "mint" | "revoke" | "rotate". Rotate = revoke + mint.
    if (collectBusy || !uploadTargetId) return;
    setCollectBusy(true);
    try {
      if (kind !== "mint" && collectLink) {
        const { data: gone, error } = await supabase
          .from("checkin_collect_links")
          .update({ revoked: true })
          .eq("id", collectLink.id)
          .select("id");
        if (error) throw error;
        // RLS-filtered updates return success with ZERO rows — check.
        if (!gone || gone.length === 0) throw new Error("revoke matched 0 rows");
        setCollectLink(false);
        if (kind === "revoke") showToast?.("Link turned off");
      }
      if (kind !== "revoke") {
        const token = (
          crypto.randomUUID?.() ||
          `${Date.now()}${Math.random().toString(36).slice(2)}`
        ).replace(/-/g, "");
        const { data: row, error } = await supabase
          .from("checkin_collect_links")
          .insert({ activity_id: uploadTargetId, token })
          .select("id, token, revoked")
          .single();
        if (error) throw error;
        setCollectLink(row);
        if (kind === "rotate") showToast?.("New link — old one is dead");
      }
    } catch (e) {
      console.error("Collect link action failed:", e);
      showToast?.("Couldn't do that");
    }
    setCollectBusy(false);
  }

  function collectUrl() {
    return collectLink ? `https://flanit.co/c/${collectLink.token}` : "";
  }

  useEffect(() => {
    if (!collectLink?.token) {
      setCollectQr(null);
      return;
    }
    let cancelled = false;
    import("qrcode")
      .then((QR) =>
        (QR.toDataURL || QR.default.toDataURL)(
          `https://flanit.co/c/${collectLink.token}`,
          {
            width: 320,
            margin: 1,
            color: { dark: "#2f3f29", light: "#ffffff" },
          }
        )
      )
      .then((url) => {
        if (!cancelled) setCollectQr(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [collectLink?.token]);

  function shareCollectLink() {
    if (!collectLink) return;
    // url as its OWN field (July 25): Messenger and friends were linkifying
    // just the domain out of the text blob and landing people on flanit.co
    // instead of the /c/ page.
    if (navigator.share) {
      navigator
        .share({
          title: "Add your photos",
          text: `Add your photos from ${thread.venueName} 📸`,
          url: collectUrl(),
        })
        .catch(() => {});
    } else {
      navigator.clipboard?.writeText(collectUrl());
      showToast?.("Link copied");
    }
  }
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

  // THE TRAIL (July 31) — a night can hop venues, so the header names all of
  // them in the order they happened, not just the root's. Built from the same
  // cluster: every activity in the tree contributes its venue, deduped, so a
  // friend's twin at the same place adds nothing while a genuine second stop
  // does. Empty until it resolves; one venue renders exactly as it always did.
  const [trail, setTrail] = useState([]);
  // When the night's most recent leg happened — the anchor "add a place" uses
  // to decide between "now" and "just after the last stop".
  const [lastLegAt, setLastLegAt] = useState(null);
  useEffect(() => {
    if (clusterIds.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data: acts } = await supabase
        .from("activities")
        .select("venue_id, created_at")
        .in("id", clusterIds)
        .order("created_at", { ascending: true });
      const ordered = (acts || []).filter((a) => a.venue_id);
      if (!cancelled && ordered.length > 0) {
        setLastLegAt(ordered[ordered.length - 1].created_at);
      }
      if (ordered.length === 0) {
        if (!cancelled) setTrail([]);
        return;
      }
      const vids = Array.from(new Set(ordered.map((a) => a.venue_id)));
      const { data: vens } = await supabase
        .from("venues")
        .select("*")
        .in("id", vids);
      if (cancelled) return;
      const byId = new Map((vens || []).map((v) => [v.id, v]));
      const out = [];
      for (const a of ordered) {
        const v = byId.get(a.venue_id);
        if (v && !out.some((x) => x.id === v.id)) out.push(v);
      }
      setTrail(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [clusterKey]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // The cluster walk already put the root first in clusterIds.
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
      const { data: root } = await supabase
        .from("activities")
        .select("id, user_id, guests_can_invite, is_album")
        .eq("id", rootId)
        .maybeSingle();
      if (!cancelled && root) {
        setNightPerms({
          rootId: root.id,
          ownerId: root.user_id,
          canInvite: root.guests_can_invite !== false,
          // ALBUM lives on the NIGHT (Aug 21, Mark) — the root's flag.
          isAlbum: root.is_album === true,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [thread.activityId, clusterKey]);

  // NIGHT ALBUM (Aug 21, Mark: "Albums kind of feel like they are their own
  // thing"). Plain check-in = record only (people, comments, no photos).
  // The album is the explicit upgrade: night-level, any participant can
  // create it. Photos already existing = the album already exists in spirit.
  // (No `pending` here — it's declared further down (TDZ), and uploads can
  // only start from album mode anyway, so the flag already covers it.)
  const albumNight =
    (nightPerms?.isAlbum ?? false) || (photos && photos.length > 0);
  const [albumBusy, setAlbumBusy] = useState(false);
  async function createAlbum() {
    if (albumBusy) return;
    setAlbumBusy(true);
    const { error } = await supabase.rpc("create_night_album", {
      p_activity_id: thread.activityId,
    });
    setAlbumBusy(false);
    if (error) {
      console.error("Create album failed:", error);
      showToast?.("Couldn't create the album");
      return;
    }
    setNightPerms((prev) => (prev ? { ...prev, isAlbum: true } : prev));
    showToast?.("Album ready — add your photos");
  }

  async function togglePerm() {
    if (!nightPerms || permBusy || !iAmRootOwner) return;
    const next = !nightPerms.canInvite;
    setPermBusy(true);
    const { data: rows, error } = await supabase
      .from("activities")
      .update({ guests_can_invite: next })
      .eq("id", nightPerms.rootId)
      .select("id");
    setPermBusy(false);
    // RLS-filtered updates return success with ZERO rows — check both.
    if (error || !rows || rows.length === 0) {
      console.error("Permission toggle failed:", error);
      showToast?.("Couldn't change that");
      return;
    }
    setNightPerms((prev) => ({ ...prev, canInvite: next }));
  }

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
      // Push doctrine (July 25, Mark-approved): photo/comment reactions are
      // applause FOR THE AUTHOR — push them alone. A CARD-level reaction has
      // no single author (the card IS the night) — push every participant.
      // Never depends on which shard anchored the view (the old bug).
      if (comment || photo) {
        const target = comment ? comment.user_id : photo.user_id;
        if (target && target !== userId) {
          sendPush(
            target,
            `${emoji} on your ${comment ? "comment" : "photo"}`,
            `Someone reacted ${emoji} at ${thread.venueName}`
          );
        }
      } else {
        const targets =
          nightPeople.length > 0
            ? nightPeople.map((p) => p.id)
            : [thread.ownerId];
        for (const t of new Set(targets)) {
          if (t && t !== userId) {
            sendPush(
              t,
              `${emoji} on the check-in`,
              `Someone reacted ${emoji} at ${thread.venueName}`
            );
          }
        }
      }
    } catch (e) {
      console.error("Reaction failed:", e);
      showToast?.("Couldn't react");
    }
    setReacting(false);
  }

  // Per-comment reactions — miniature of the card doctrine (July 24):
  // chips toggle your reaction, the dashed ⊕ circle opens the six-emoji
  // palette for THAT comment (one at a time), and "N reacted ›" opens the
  // same who-list sheet. Nothing but chips/palette ever reacts.
  const [openReactFor, setOpenReactFor] = useState(null);
  function commentReactionRow(c) {
    const { counts, mine } = summarizeReactions(reactions, userId, null, c.id);
    const entries = Object.entries(counts);
    const total = entries.reduce((s, [, n]) => s + n, 0);
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
          aria-label={openReactFor === c.id ? "Close" : "Add reaction"}
          onClick={() => setOpenReactFor(openReactFor === c.id ? null : c.id)}
          className="flex h-5 w-5 items-center justify-center rounded-full border border-dashed border-neutral-300 text-neutral-400 active:scale-90 transition"
        >
          {openReactFor === c.id ? <X size={11} /> : <Plus size={11} />}
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
        {total > 0 && (
          <button
            type="button"
            onClick={() => setReactSheet({ photoId: null, commentId: c.id })}
            className="text-[11px] font-medium text-[#455d3b] px-0.5"
          >
            {total} reacted ›
          </button>
        )}
      </div>
    );
  }

  // Resolve uploader + reactor profiles for any rows we haven't seen yet
  // (reactors feed the "See reactions" sheet — anyone who can see the card
  // can react, so they're not always in nightPeople).
  useEffect(() => {
    const ids = Array.from(
      new Set([
        ...photos.map((p) => p.user_id),
        ...reactions.map((r) => r.user_id),
      ])
    ).filter((id) => id && !mediaProfiles[id]);
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

  // Friendship status — powers the Add friend buttons AND the card-view
  // add-host banner, so it loads on OPEN, not when the people view does
  // (July 25: banner showed "Add friend" against a pending incoming
  // request until "View all" was tapped). One cheap query per thread.
  useEffect(() => {
    if (!userId) return;
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
        // Direction matters (July 25, Mark: MB had already REQUESTED — the
        // card offered "Add friend" instead of completing the handshake):
        // they asked → Accept; I asked → Requested.
        else if (r.status === "pending" && !map[other])
          map[other] = r.requester_id === userId ? "pending_out" : "pending_in";
      }
      setFriendState(map);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, thread.activityId]);

  async function addFriendFromAlbum(otherId) {
    setFriendState((prev) => ({ ...prev, [otherId]: "pending_out" }));
    const { error } = await supabase
      .from("friendships")
      .insert({ requester_id: userId, addressee_id: otherId, status: "pending" });
    if (error && error.code !== "23505") {
      setFriendState((prev) => ({ ...prev, [otherId]: "none" }));
      showToast?.("Couldn't send that");
      return;
    }
    sendPush(
      otherId,
      "New friend request",
      `Someone from ${thread.label || thread.venueName} wants to add you`
    );
  }

  // They already asked — one tap completes the handshake (their request was
  // consent #1, this tap is #2).
  async function acceptFriendFromAlbum(otherId) {
    setFriendState((prev) => ({ ...prev, [otherId]: "friend" }));
    // Row-count check lives in acceptFriendRequest — an RLS-filtered update
    // returns success with ZERO rows, so "no rows" is the real failure.
    const ok = await acceptFriendRequest(userId, otherId);
    if (!ok) {
      setFriendState((prev) => ({ ...prev, [otherId]: "pending_in" }));
      showToast?.("Couldn't accept that");
      return;
    }
    showToast?.("You're friends now");
  }

  // Delete your OWN media (bytes count toward YOUR credit — so you can
  // always take them back). Two-tap: arm, then confirm.
  const [deleteArm, setDeleteArm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function removeMedia() {
    if (!lightbox || deleting) return;
    setDeleting(true);
    try {
      if (lightbox.user_id === userId) {
        // Own media: client-side path (RLS delete_own + own-folder storage).
        await deleteCheckinPhoto(lightbox);
      } else {
        // Guest media on YOUR shard (via_link): the objects live in the
        // guest's uid folder — only the service role can remove them.
        const { data: sess } = await supabase.auth.getSession();
        const resp = await fetch("/api/delete-media", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${sess?.session?.access_token || ""}`,
          },
          body: JSON.stringify({ photoId: lightbox.id }),
        });
        if (!resp.ok) throw new Error(`delete-media ${resp.status}`);
      }
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
    // Comments are conversation — the whole card hears (July 25 doctrine).
    {
      const body = `${(me?.display_name || "Someone").split(" ")[0]}: ${text.slice(0, 80)}`;
      const targets = new Set(
        nightPeople.length > 0
          ? nightPeople.map((p) => p.id)
          : [lightbox.user_id]
      );
      targets.add(lightbox.user_id); // photo owner always included
      for (const t of targets) {
        if (t && t !== userId) {
          sendPush(t, "New comment on a photo", body);
        }
      }
    }
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
    const files = Array.from(fileList || []).slice(0, MAX_PHOTOS_PER_BATCH);
    const promises = [];
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
        return null; // count only landed uploads for the push
      });
      promises.push(promise);
      trackUpload({ key, activityId: uploadTargetId, isVideo, preview }, promise);
      if (isVideo) {
        // Frame grab lands in ~a second — long before the bytes do.
        makeVideoPreviewUrl(file)
          .then((url) => updateUploadPreview(key, url))
          .catch(() => {});
      }
    }
    // Tell the night (July 25 — in-app adds were silent while via-link
    // uploads pushed): once the batch lands, everyone else on the night
    // hears about it.
    if (promises.length > 0 && nightPeople.length > 1) {
      Promise.all(promises).then((rows) => {
        const landed = rows.filter(Boolean).length;
        if (landed === 0) return;
        const meProfile = nightPeople.find((p) => p.id === userId);
        const nm = meProfile?.display_name || "Someone";
        const body = `${nm} added ${landed} ${
          landed === 1 ? "photo" : "photos"
        } at ${thread.venueName}`;
        for (const p of nightPeople) {
          if (p.id !== userId) sendPush(p.id, "📸 New photos", body);
        }
      });
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
        .in(
          "activity_id",
          Array.from(
            new Set([thread.activityId, uploadTargetId].filter(Boolean))
          )
        )
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
  }, [thread.activityId, uploadTargetId, tagRefresh]);

  // ADD A PLACE (July 31) — "we went somewhere else". Creates a check-in at the
  // new venue owned by WHOEVER TAPS, chained to this night through joined_from,
  // so the cluster merge folds it into this card and the leg lands in that
  // person's Been and on their map. Any participant may do it — they were
  // there, and adding a place isn't an invitation, so guests_can_invite (which
  // governs bringing PEOPLE in) deliberately doesn't gate it.
  const [placeQ, setPlaceQ] = useState("");
  const [placeResults, setPlaceResults] = useState([]);
  const [placeGoogle, setPlaceGoogle] = useState([]);
  const [placeBusy, setPlaceBusy] = useState(null); // place_id | "saving"
  const [placeBlurred, setPlaceBlurred] = useState(false);

  useEffect(() => {
    if (view !== "place") return;
    const q = placeQ.trim();
    if (q.length < 2) {
      setPlaceResults([]);
      setPlaceGoogle([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const { venues, google } = await searchPlaces(q, userId);
      if (cancelled) return;
      setPlaceResults(venues);
      setPlaceGoogle(google);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [placeQ, view]);

  async function addPlace(venue) {
    if (!venue || !userId || placeBusy === "saving") return;
    setPlaceBusy("saving");
    // Anchor the leg to the NIGHT, not to the tap. Adding it live (you're at
    // the next bar) means `now` is right; adding it the morning after would
    // otherwise stamp the leg ~14h adrift, breaking the trail order and making
    // the card say "yesterday" and "14h ago" about one evening. Beyond a 12h
    // reach we place it just after the last known leg instead.
    const base = new Date(lastLegAt || thread.timestamp || Date.now()).getTime();
    const within12h = Math.abs(Date.now() - base) < 12 * 60 * 60 * 1000;
    const ts = within12h ? new Date() : new Date(base + 60 * 60 * 1000);
    const rootId = nightPerms?.rootId || clusterIds[0] || thread.activityId;
    const { data: inserted, error } = await supabase
      .from("activities")
      .insert({
        user_id: userId,
        kind: "checkin",
        venue_id: venue.id,
        joined_from: rootId,
        created_at: ts.toISOString(),
      })
      .select("id")
      .single();
    setPlaceBusy(null);
    if (error || !inserted) {
      console.error("Add place failed:", error);
      showToast?.("Couldn't add that place");
      return;
    }
    setPlaceQ("");
    setPlaceResults([]);
    setPlaceGoogle([]);
    setView("card");
    // Pull the new leg into the cluster so the trail and album update now.
    setClusterIds((prev) =>
      prev.includes(inserted.id) ? prev : [...prev, inserted.id]
    );
    // The card's content belongs to the whole card (the July 25 doctrine) — a
    // new venue changes the night's header for everyone on it, so everyone
    // hears. Note this can reach someone who went home before the last stop:
    // by "one night, one guest list" they're still on the card, which is the
    // same reason they can see its photos.
    const myName = nightPeople.find((p) => p.id === userId)?.display_name;
    for (const p of nightPeople || []) {
      if (p.id === userId) continue;
      sendPush(
        p.id,
        "The night moved on 🍸",
        `${myName || "Someone"} added ${venue.name}`,
        "/"
      );
    }
    showToast?.(`Added ${venue.name} to this night`);
  }

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
    // Tags land on MY shard (July 25): activity_tags RLS is "tag into your
    // OWN check-in", so a participant tagging the anchor shard was always
    // rejected. Tagging my own shard invites my friend into the NIGHT —
    // they accept, their twin joins the graph, they appear on this card.
    const tagTarget = uploadTargetId || thread.activityId;
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
        .eq("activity_id", tagTarget)
        .eq("tagged_user_id", friendId);
    } else {
      const { error } = await supabase
        .from("activity_tags")
        .insert({ activity_id: tagTarget, tagged_user_id: friendId });
      if (error && error.code === "23505") {
        // They already self-requested (joined) — your tag is the second
        // consent. Complete it, no nudges either way.
        await supabase
          .from("activity_tags")
          .update({ status: "accepted", responded_at: new Date().toISOString() })
          .eq("activity_id", tagTarget)
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
          `${thread.label || thread.venueName} — accept to add it to your Been list`
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
    // Keep the newest comment in view as the list grows — but only in the
    // expanded comments view. listRef now scrolls the WHOLE card body
    // (July 24), so auto-scrolling in card view would leap past the grid.
    if (view !== "comments") return;
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [comments, view]);

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
    // Comments are conversation — the whole card hears (July 25 doctrine).
    {
      const body = `${(me?.display_name || "Someone").split(" ")[0]}: ${text.slice(0, 80)}`;
      const targets = new Set(
        nightPeople.length > 0
          ? nightPeople.map((p) => p.id)
          : [thread.ownerId]
      );
      targets.add(thread.ownerId);
      for (const t of targets) {
        if (t && t !== userId) {
          sendPush(t, "New comment", body);
        }
      }
    }
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
              <p className="text-sm font-semibold">
                {thread.ownerName} at{" "}
                {trail.length > 1 ? (
                  trail.map((v, i) => (
                    <span key={v.id}>
                      {i > 0 && (
                        <span className="font-normal text-neutral-400"> → </span>
                      )}
                      {/* Personal places have no address or coords, so there's
                          no venue card worth opening — plain text. */}
                      {onOpenVenue && v.source !== "personal" ? (
                        <button
                          type="button"
                          onClick={() => onOpenVenue(v)}
                          className="underline decoration-[#455d3b]/40 underline-offset-2"
                        >
                          {v.name}
                        </button>
                      ) : (
                        v.name
                      )}
                    </span>
                  ))
                ) : thread.venueObj &&
                  onOpenVenue &&
                  thread.venueObj.source !== "personal" ? (
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
              {/* Sits under the trail, not in the crowded avatar row — it's
                  about places, and that's where the places are. Any
                  participant, per the rule that adding a place isn't an
                  invitation. */}
              {(isOwner || uploadTargetId) && (
                <button
                  type="button"
                  onClick={() => setView("place")}
                  className="mt-0.5 text-[11px] font-medium text-[#455d3b]"
                >
                  + we went somewhere else
                </button>
              )}
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
                  {(isOwner || uploadTargetId) && mayInvite && (
                    <button
                      type="button"
                      onClick={openTagPicker}
                      className="ml-auto mr-0.5 inline-flex items-center gap-1 rounded-full border border-neutral-200 px-2.5 py-1 text-xs font-medium text-[#455d3b] active:scale-95 transition"
                    >
                      <UserPlus size={13} /> add more
                    </button>
                  )}
                  {(isOwner || uploadTargetId) && (
                    <button
                      type="button"
                      aria-label="Check-in settings"
                      onClick={() => setView("settings")}
                      className={`${
                        (isOwner || uploadTargetId) && mayInvite
                          ? "ml-1"
                          : "ml-auto"
                      } mr-0.5 inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 active:scale-95 transition`}
                    >
                      <Settings size={13} />
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
              {/* COVER LINE (Aug 21, Mark): in album mode, the night's first
                  comment doubles as the album's cover copy — the words that
                  were said become the caption of the memory. */}
              {albumNight && comments && comments.length > 0 && comments[0].body && (
                <p className="mt-1 text-xs italic text-neutral-600 truncate">
                  “{comments[0].body}”
                </p>
              )}
          </div>
        </div>

        {/* Add-people view (Mark's mock): friends as ROWS with Add buttons,
            not a chip cloud. Collect link section lands here in Stage 2. */}
        {view === "add" && (isOwner || uploadTargetId) && (
          <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            <button
              type="button"
              onClick={() => setView("card")}
              className="mb-3 text-xs font-medium text-[#455d3b]"
            >
              ‹ Back
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
        {/* ADD A PLACE — same search as the add-a-night form (lib/venueSearch),
            so anywhere Google knows counts, not just venues already on Flanit. */}
        {view === "place" && (isOwner || uploadTargetId) && (
          <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            <button
              type="button"
              onClick={() => setView("card")}
              className="mb-3 text-xs font-medium text-[#455d3b]"
            >
              ‹ Back
            </button>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              Where else did the night go?
            </p>
            <input
              value={placeQ}
              onChange={(e) => {
                setPlaceQ(e.target.value);
                setPlaceBlurred(false);
              }}
              onBlur={() => setPlaceBlurred(true)}
              placeholder="Search for the place, or type your own"
              className="w-full rounded-full border border-neutral-200 px-4 py-2.5 text-base focus:outline-none focus:border-[#455d3b]"
            />
            <div className="mt-2 space-y-1">
              {placeResults.map((v) => (
                <button
                  key={v.id}
                  type="button"
                  disabled={placeBusy === "saving"}
                  onClick={() => addPlace(v)}
                  className="w-full flex items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-neutral-50 active:scale-[0.99] transition disabled:opacity-50"
                >
                  <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                    {v.name}
                  </span>
                  {v.suburb && (
                    <span className="text-[11px] text-neutral-400 shrink-0">
                      {v.suburb}
                    </span>
                  )}
                </button>
              ))}
              {placeGoogle.length > 0 && (
                <>
                  <p className="px-2 pt-2 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                    More places
                  </p>
                  {placeGoogle.map((r) => (
                    <button
                      key={r.place_id}
                      type="button"
                      disabled={!!placeBusy}
                      onClick={async () => {
                        setPlaceBusy(r.place_id);
                        try {
                          const v = await addGooglePlace(r.place_id);
                          setPlaceBusy(null);
                          await addPlace(v);
                        } catch (e) {
                          console.error("Google place add failed:", e);
                          setPlaceBusy(null);
                          showToast?.("Couldn't add that place");
                        }
                      }}
                      className="w-full flex items-center gap-2.5 rounded-xl px-2 py-2 text-left hover:bg-neutral-50 active:scale-[0.99] transition disabled:opacity-50"
                    >
                      <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                        {r.name}
                      </span>
                      <span className="text-[11px] text-neutral-400 shrink-0 truncate max-w-[110px]">
                        {placeBusy === r.place_id ? "Adding…" : r.address || ""}
                      </span>
                    </button>
                  ))}
                </>
              )}
              {/* Name-only place — a house, a park, someone's backyard. Its own
                  block, emphasised once they've tapped out with no match. */}
              {placeQ.trim().length >= 2 && (
                <div
                  className={`mt-2 rounded-xl border p-2.5 transition ${
                    placeBlurred && placeResults.length === 0
                      ? "border-[#455d3b] bg-[#edf2eb]"
                      : "border-neutral-200 bg-white"
                  }`}
                >
                  <button
                    type="button"
                    disabled={!!placeBusy}
                    onClick={async () => {
                      setPlaceBusy("personal");
                      const v = await createPersonalPlace(placeQ, userId);
                      setPlaceBusy(null);
                      if (v) await addPlace(v);
                      else showToast?.("Couldn't add that place");
                    }}
                    className="w-full flex items-center gap-2.5 text-left active:scale-[0.99] transition disabled:opacity-50"
                  >
                    <Home size={15} className="shrink-0 text-[#455d3b]" />
                    <span className="flex-1 min-w-0 truncate text-sm font-medium text-neutral-900">
                      {placeBusy === "personal"
                        ? "Adding…"
                        : `Use "${placeQ.trim()}"`}
                    </span>
                  </button>
                  <p className="mt-1 pl-[25px] text-[11px] leading-snug text-neutral-500">
                    A place of your own — just a name. No address, and it won't
                    appear on the map.
                  </p>
                </div>
              )}
            </div>
            <p className="mt-3 text-[10px] text-neutral-400">
              It joins this night's album and lands in your Been list.
            </p>
          </div>
        )}
        {/* SETTINGS (July 25, Mark: a cog next to "add more") — the photo
            link lives here, plus the owner's two guest switches. Check-ins
            are mini-events: most people never open this. */}
        {view === "settings" && (
          <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            <button
              type="button"
              onClick={() => setView("card")}
              className="mb-3 text-xs font-medium text-[#455d3b]"
            >
              ‹ Back
            </button>
            {mayShareLink && !albumNight ? (
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                  Anyone else — collect photos
                </p>
                <p className="mb-3 text-xs text-neutral-500">
                  Create the album first — the link and QR live here once it
                  exists.
                </p>
                <button
                  type="button"
                  disabled={albumBusy}
                  onClick={createAlbum}
                  className="w-full rounded-full bg-[#455d3b] py-2.5 text-sm font-medium text-white active:scale-[0.99] transition disabled:opacity-50"
                >
                  {albumBusy ? "Creating…" : "Create album"}
                </button>
              </div>
            ) : mayShareLink ? (
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                Anyone else — collect photos
              </p>
              <p className="mb-3 text-xs text-neutral-500">
                One link for the group chat. No app or account needed — their
                photos land right here, visible to your friends.
              </p>
              {collectLink === null && (
                <p className="text-xs text-neutral-400">Loading…</p>
              )}
              {collectLink === false && (
                <button
                  type="button"
                  disabled={collectBusy}
                  onClick={() => collectAction("mint")}
                  className="w-full rounded-full bg-[#455d3b] py-2.5 text-sm font-medium text-white active:scale-[0.99] transition disabled:opacity-50"
                >
                  {collectBusy ? "Creating…" : "Create collect link"}
                </button>
              )}
              {collectLink && (
                <>
                  <div className="flex items-center gap-2 rounded-2xl border border-neutral-200 px-3 py-2">
                    <span className="flex-1 truncate text-xs text-neutral-600">
                      flanit.co/c/{collectLink.token}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        navigator.clipboard?.writeText(collectUrl());
                        showToast?.("Link copied");
                      }}
                      className="shrink-0 rounded-full bg-[#455d3b] px-3 py-1 text-[11px] font-medium text-white active:scale-95 transition"
                    >
                      Copy
                    </button>
                  </div>
                  {/* QR: the in-person door. Long-press saves it on a
                      phone; "Save image" opens it full-size for printing. */}
                  {collectQr && (
                    <div className="mt-3 flex flex-col items-center">
                      <img
                        src={collectQr}
                        alt="QR code for the photo link"
                        className="h-40 w-40 rounded-2xl border border-neutral-200 bg-white p-2"
                      />
                      <a
                        href={collectQr}
                        download={`flanit-photos-${collectLink.token.slice(0, 8)}.png`}
                        className="mt-1.5 text-[11px] font-medium text-[#455d3b] underline underline-offset-2"
                      >
                        Save the QR
                      </a>
                      <p className="mt-0.5 text-[10px] text-neutral-400 text-center">
                        Stick it on a table — anyone can scan and add photos.
                      </p>
                    </div>
                  )}
                  <div className="mt-2 flex gap-2">
                    <button
                      type="button"
                      onClick={shareCollectLink}
                      className="flex-1 rounded-full border border-[#455d3b] py-2 text-xs font-medium text-[#455d3b] active:scale-95 transition"
                    >
                      Share
                    </button>
                    <button
                      type="button"
                      disabled={collectBusy}
                      onClick={() => collectAction("rotate")}
                      className="flex-1 rounded-full border border-neutral-200 py-2 text-xs font-medium text-neutral-600 active:scale-95 transition disabled:opacity-50"
                    >
                      New link
                    </button>
                    <button
                      type="button"
                      disabled={collectBusy}
                      onClick={() => collectAction("revoke")}
                      className="flex-1 rounded-full border border-neutral-200 py-2 text-xs font-medium text-red-500 active:scale-95 transition disabled:opacity-50"
                    >
                      Turn off
                    </button>
                  </div>
                  <p className="mt-1.5 text-[10px] text-neutral-400">
                    Up to 10 photos per guest · you can delete anything a
                    guest adds · "New link" kills the old one.
                  </p>
                </>
              )}
            </div>
            ) : (
              <p className="text-xs text-neutral-500">
                {thread.ownerName} is keeping the photo link to themselves for
                this one.
              </p>
            )}
            {iAmRootOwner && (
              <div className="mt-6 border-t border-neutral-100 pt-4">
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                  Guests
                </p>
                <p className="mb-3 text-xs text-neutral-500">
                  Everyone here can always add photos, comment and react.
                </p>
                <button
                  type="button"
                  disabled={permBusy}
                  onClick={togglePerm}
                  className="flex w-full items-start gap-3 rounded-2xl border border-neutral-100 bg-white px-3 py-2.5 text-left active:scale-[0.99] transition disabled:opacity-50"
                >
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-neutral-900">
                      Let guests invite others
                    </span>
                    <span className="block text-[11px] text-neutral-500">
                      They can add their own friends and hand out the photo
                      link. Turn this off to keep the guest list yours.
                    </span>
                  </span>
                  <span
                    className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition ${
                      nightPerms?.canInvite ? "bg-[#455d3b]" : "bg-neutral-200"
                    }`}
                  >
                    <span
                      className={`h-4 w-4 rounded-full bg-white transition ${
                        nightPerms?.canInvite ? "translate-x-4" : ""
                      }`}
                    />
                  </span>
                </button>
              </div>
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
        {/* ONE SCROLLER for the whole night (July 24 — Mark: "you can only
            see one comment at a time"). The fixed-height card was stacking
            grid + join + reactions as rigid rows and giving comments only
            the leftover sliver; drags on the non-scrolling grid panned the
            page behind. Now everything between header and input scrolls as
            one region. overscroll-contain stops chaining to the page. */}
        {(view === "card" || view === "comments") && (
        <div
          ref={listRef}
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain"
        >
        {/* ADD-HOST banner (July 25, Mark): anyone ON the night (came via a
            collect link / join) who isn't friends with the card's owner yet
            gets the ask right here — below the header, above the album. */}
        {view === "card" &&
          thread.ownerId &&
          thread.ownerId !== userId &&
          (joined === true || !!myActivityId) &&
          friendState[thread.ownerId] !== "friend" && (
            <div className="mx-4 mt-3 flex items-center gap-3 rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] p-3">
              <p className="flex-1 min-w-0 text-xs text-[#2f3f29]">
                {friendState[thread.ownerId] === "pending_in"
                  ? `${thread.ownerName} already asked to be friends — accept?`
                  : `You were at ${thread.venueName} with ${thread.ownerName} — add them as a friend?`}
              </p>
              <button
                type="button"
                disabled={friendState[thread.ownerId] === "pending_out"}
                onClick={() =>
                  friendState[thread.ownerId] === "pending_in"
                    ? acceptFriendFromAlbum(thread.ownerId)
                    : addFriendFromAlbum(thread.ownerId)
                }
                className="shrink-0 rounded-full bg-[#455d3b] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60 active:scale-95 transition"
              >
                {friendState[thread.ownerId] === "pending_in"
                  ? "Accept"
                  : friendState[thread.ownerId] === "pending_out"
                  ? "Requested"
                  : "Add friend"}
              </button>
            </div>
          )}
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
              {/* Camera = album mode only (Aug 21, Mark: a plain check-in
                  is the record; the album is the explicit upgrade). Plain
                  nights get the Create-album tile in its place. */}
              {uploadTargetId && albumNight && (
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
              {uploadTargetId && !albumNight && (
                <button
                    type="button"
                    disabled={albumBusy}
                    onClick={createAlbum}
                    className="aspect-square rounded-lg border border-dashed border-[#a8b89a] bg-[#edf2eb]/60 flex flex-col items-center justify-center gap-1 text-[#455d3b] active:scale-95 transition disabled:opacity-50"
                  >
                    <Camera size={20} />
                    <span className="text-[10px] font-medium text-center leading-tight">
                      {albumBusy ? "Creating…" : "Create album"}
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
                      `They're at ${thread.label || thread.venueName} with you`
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
                      `They're at ${thread.label || thread.venueName} too — add them to your check-in?`
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
            onSeeWho={() => setReactSheet({ photoId: null })}
          />
        </div>
        )}
        {view === "comments" && photos.length > 0 && (
          <div className="px-4 pt-3">
            <button
              type="button"
              onClick={() => setView("card")}
              className="mb-2 text-xs font-medium text-[#455d3b]"
            >
              ‹ Back
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
        <div className="px-5 py-3">
          {comments === null && (
            <p className="text-xs text-neutral-400 text-center py-4">Loading…</p>
          )}
          {/* Empty thread = just the line (July 25, Mark: don't show the
              owner block at all). It dated from when an empty card was bare;
              the owner now appears in the header AND the avatar row, and it
              rendered inconsistently anyway — only some openers passed
              ownerProfile. */}
          {comments !== null && comments.length === 0 && (
            <div className="py-4 text-center">
              <p className="text-sm text-neutral-500">
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
        </div>
        )}
        {/* People view — the album's cast, split into your friends and
            "others in the album" with Add friend (graph growth, per mock).
            Lives OUTSIDE the card/comments scroller (own view, own scroll). */}
        {view === "people" && (
          <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
            <button
              type="button"
              onClick={() => setView("card")}
              className="mb-3 text-xs font-medium text-[#455d3b]"
            >
              ‹ Back
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
                              disabled={friendState[p.id] === "pending_out"}
                              onClick={() =>
                                friendState[p.id] === "pending_in"
                                  ? acceptFriendFromAlbum(p.id)
                                  : addFriendFromAlbum(p.id)
                              }
                              className="shrink-0 rounded-full bg-[#455d3b] text-white text-xs font-medium px-3 py-1.5 disabled:opacity-50"
                            >
                              {friendState[p.id] === "pending_in"
                                ? "Accept"
                                : friendState[p.id] === "pending_out"
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
              {/* DOWNLOAD THE ORIGINAL (July 31, Mark's call: "make it explicit
                  and useful"). Storage RLS has always allowed a night
                  participant to read orig_path — the same clause covers both
                  paths — but nothing in the app ever asked for it, so people
                  got the 1280px derivative via long-press and no way to the
                  full file. That's the worst of both: permitted but hidden,
                  and 1280px is only ~4in at 300dpi, which fails exactly the
                  print case (weddings, parties) this album is for. */}
              {lightbox.orig_path && (
                <button
                  type="button"
                  disabled={downloading}
                  onClick={() => downloadOriginal(lightbox)}
                  className="absolute bottom-2 right-2 inline-flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white active:scale-95 transition disabled:opacity-70"
                >
                  {downloading ? (
                    <>
                      <span className="h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      Preparing…
                    </>
                  ) : (
                    <>
                      <Download size={14} /> Save image
                    </>
                  )}
                </button>
              )}
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
            {/* iOS only: the share sheet is coming and it isn't ours, so say
                what to tap before it lands. Shown while the file downloads —
                the wait and the instruction share the same beat. Android saves
                straight to Downloads (Gallery picks it up), no sheet, no hint. */}
            {downloading && isIOS && (
              <div className="shrink-0 border-t border-[#cdd9c6] bg-[#edf2eb] px-4 py-2.5">
                <p className="text-xs leading-snug text-[#2f3f29]">
                  <strong className="font-medium">Choose "Save Image"</strong> to
                  put it in your camera roll.
                </p>
              </div>
            )}
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
                {(lightbox.user_id === userId ||
                  (lightbox.via_link &&
                    lightbox.activity_id === uploadTargetId)) && (
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
                onSeeWho={() => setReactSheet({ photoId: lightbox.id })}
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-2">
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
      {/* "See reactions ›" who-list. z-3850: above the lightbox (3800),
          below ProfileLookupScreen (3900) so profile tap-throughs land on
          top and Back returns here. Stays open under the profile, same as
          the card itself. */}
      {reactSheet && (
        <div
          className="fixed inset-0 z-[3850] bg-black/40 flex items-end"
          onClick={() => setReactSheet(null)}
        >
          <div
            className="w-full max-h-[60%] rounded-t-2xl bg-white flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-5 pt-4 pb-2">
              <p className="text-sm font-semibold text-neutral-900">
                Reactions
              </p>
              <button
                type="button"
                onClick={() => setReactSheet(null)}
                aria-label="Close"
                className="p-1 text-neutral-400"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-6">
              {(() => {
                const rows = reactions.filter((r) => {
                  const pid = r.photo_id ?? null;
                  const cid = r.comment_id ?? null;
                  if (reactSheet.commentId) return cid === reactSheet.commentId;
                  return pid === reactSheet.photoId && cid === null;
                });
                if (rows.length === 0)
                  return (
                    <p className="py-2 text-xs text-neutral-400">
                      No reactions yet.
                    </p>
                  );
                return (
                  <div className="space-y-1">
                    {rows.map((r) => {
                      const p = mediaProfiles[r.user_id] || null;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => onOpenProfile?.(r.user_id)}
                          className="flex w-full items-center gap-3 rounded-xl px-1 py-2 text-left active:bg-neutral-50"
                        >
                          <FriendAvatar profile={p} small />
                          <span className="flex-1 min-w-0 truncate text-sm text-neutral-900">
                            {r.user_id === userId
                              ? "You"
                              : p?.display_name || p?.username || "Someone"}
                          </span>
                          <span className="text-lg">{r.emoji}</span>
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
}
