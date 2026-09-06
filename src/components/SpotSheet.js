// SPOT SHEET (Sep 6, 2026) — the tap card for a spot (the friend knowledge
// layer: toilets, study spots, parking). Title, where, how to get there,
// details, photos, who added it and when, Open in Google Maps (directions
// are the whole point), two-tap delete for your own. Opened from the map's
// Spots lens and from the drawer's spot_added item.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Trash2, ExternalLink, Bookmark, Send } from "lucide-react";
import { timeAgoShort } from "../lib/checkins";
import { REACTION_SET } from "../lib/reactions";
import { supabase } from "../supabaseClient";
import { signSpotPhotos, deleteSpotPhotos } from "../lib/photos";
import { FriendAvatar } from "./FriendAvatar";

export const SPOT_CATEGORIES = {
  toilet: { emoji: "🚻", label: "Toilet" },
  study: { emoji: "📚", label: "Study spot" },
  parking: { emoji: "🅿️", label: "Parking" },
  other: { emoji: "📍", label: "Spot" },
};

export function spotCategory(cat) {
  return SPOT_CATEGORIES[cat] || SPOT_CATEGORIES.other;
}

function mapsUrl(spot) {
  if (Number.isFinite(Number(spot.lat)) && Number.isFinite(Number(spot.lng))) {
    return `https://www.google.com/maps/search/?api=1&query=${spot.lat},${spot.lng}`;
  }
  if (spot.place_name) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
      `${spot.place_name} Melbourne`
    )}`;
  }
  return null;
}

export function SpotSheet({ spot, userId, onClose, onDeleted, onChanged, showToast }) {
  const [photoUrls, setPhotoUrls] = useState({});
  const [profile, setProfile] = useState(spot.profile || null);
  const [deleteArm, setDeleteArm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Social (Sep 6): likes + comments for anyone in the circle; save-to-my-
  // map for friends. All silent — the layer stays quiet by doctrine.
  const [reactions, setReactions] = useState([]); // [{user_id, emoji}]
  const [saved, setSaved] = useState(false);
  const [comments, setComments] = useState(null); // null = loading
  const [commentBody, setCommentBody] = useState("");
  const [sending, setSending] = useState(false);
  const [acting, setActing] = useState(false);
  const isMine = spot.user_id === userId;
  const cat = spotCategory(spot.category);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (spot.photo_paths?.length) {
        const urls = await signSpotPhotos(spot.photo_paths);
        if (!cancelled) setPhotoUrls(urls);
      }
      if (!spot.profile && spot.user_id) {
        const { data } = await supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .eq("id", spot.user_id)
          .maybeSingle();
        if (!cancelled && data) setProfile(data);
      }
      const [likesRes, savesRes, commentsRes] = await Promise.all([
        supabase
          .from("spot_reactions")
          .select("user_id, emoji")
          .eq("spot_id", spot.id),
        userId
          ? supabase
              .from("spot_saves")
              .select("spot_id")
              .eq("spot_id", spot.id)
              .eq("user_id", userId)
          : Promise.resolve({ data: [] }),
        supabase
          .from("spot_comments")
          .select("*")
          .eq("spot_id", spot.id)
          .order("created_at", { ascending: true })
          .limit(100),
      ]);
      if (cancelled) return;
      setReactions(likesRes.data || []);
      setSaved((savesRes.data || []).length > 0);
      const rows = commentsRes.data || [];
      const pIds = Array.from(new Set(rows.map((c) => c.user_id)));
      let pById = {};
      if (pIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", pIds);
        pById = Object.fromEntries((profs || []).map((p) => [p.id, p]));
      }
      if (cancelled) return;
      setComments(rows.map((c) => ({ ...c, profile: pById[c.user_id] || null })));
    })();
    return () => {
      cancelled = true;
    };
  }, [spot, userId]);

  // The app's ONE reaction contract: one emoji per person, tap yours to
  // remove it, tap another to switch.
  const myReaction = reactions.find((r) => r.user_id === userId)?.emoji || null;
  const reactionCounts = reactions.reduce((acc, r) => {
    acc[r.emoji] = (acc[r.emoji] || 0) + 1;
    return acc;
  }, {});

  async function react(emoji) {
    if (acting || !userId) return;
    setActing(true);
    try {
      if (myReaction === emoji) {
        await supabase
          .from("spot_reactions")
          .delete()
          .eq("spot_id", spot.id)
          .eq("user_id", userId);
        setReactions((prev) => prev.filter((r) => r.user_id !== userId));
      } else {
        await supabase
          .from("spot_reactions")
          .upsert(
            { spot_id: spot.id, user_id: userId, emoji },
            { onConflict: "spot_id,user_id" }
          );
        setReactions((prev) => [
          ...prev.filter((r) => r.user_id !== userId),
          { user_id: userId, emoji },
        ]);
      }
    } catch (e) {
      console.error("Spot reaction failed:", e);
    } finally {
      setActing(false);
    }
  }

  async function toggleSave() {
    if (acting || !userId || isMine) return;
    setActing(true);
    try {
      if (saved) {
        await supabase
          .from("spot_saves")
          .delete()
          .eq("spot_id", spot.id)
          .eq("user_id", userId);
        setSaved(false);
        showToast?.("Removed from your map");
      } else {
        await supabase
          .from("spot_saves")
          .insert({ spot_id: spot.id, user_id: userId });
        setSaved(true);
        showToast?.("On your map, under My List");
      }
      onChanged?.();
    } catch (e) {
      console.error("Spot save failed:", e);
      showToast?.("Couldn't update that");
    } finally {
      setActing(false);
    }
  }

  async function sendComment() {
    const body = commentBody.trim();
    if (!body || sending || !userId) return;
    setSending(true);
    try {
      const { data, error } = await supabase
        .from("spot_comments")
        .insert({ spot_id: spot.id, user_id: userId, body })
        .select("*")
        .single();
      if (error) throw error;
      setComments((prev) => [...(prev || []), { ...data, profile: null, mine: true }]);
      setCommentBody("");
    } catch (e) {
      console.error("Spot comment failed:", e);
      showToast?.("Couldn't send that");
    } finally {
      setSending(false);
    }
  }

  async function doDelete() {
    setDeleting(true);
    try {
      await supabase.from("spots").delete().eq("id", spot.id);
      await deleteSpotPhotos(spot.photo_paths);
      showToast?.("Spot removed");
      onDeleted?.(spot.id);
      onClose();
    } catch (e) {
      console.error("Spot delete failed:", e);
      showToast?.("Couldn't remove that spot");
      setDeleting(false);
    }
  }

  const gmaps = mapsUrl(spot);
  const addedName = isMine
    ? "You"
    : (profile?.display_name || "A friend").split(" ")[0];
  const addedDate = new Date(spot.created_at).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
  });

  return createPortal(
    <div className="fixed inset-0 z-[3300]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="absolute left-0 right-0 bottom-0 max-h-[80%] flex flex-col rounded-t-3xl bg-white shadow-2xl">
        <div className="px-5 pt-3 pb-2">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#edf2eb] px-2.5 py-0.5 text-[11.5px] font-medium text-[#455d3b]">
                {cat.emoji} {cat.label}
              </span>
              <h2 className="mt-1.5 text-base font-semibold leading-tight">
                {spot.title}
              </h2>
              {spot.place_name && (
                <p className="text-xs text-neutral-500 mt-0.5">
                  {spot.place_name}
                </p>
              )}
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 active:bg-neutral-200"
            >
              <X size={13} strokeWidth={2} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-5 pb-6">
          {spot.directions && (
            <div className="mt-2 rounded-2xl bg-neutral-50 px-4 py-3">
              <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
                How to get there
              </p>
              <p className="mt-1 text-sm leading-snug text-neutral-800">
                {spot.directions}
              </p>
            </div>
          )}
          {spot.details && (
            <p className="mt-3 text-sm text-neutral-700">{spot.details}</p>
          )}
          {spot.photo_paths?.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-1.5">
              {spot.photo_paths.map((p) =>
                photoUrls[p] ? (
                  <img
                    key={p}
                    src={photoUrls[p]}
                    alt=""
                    className="aspect-square w-full rounded-xl object-cover bg-neutral-100"
                  />
                ) : (
                  <div
                    key={p}
                    className="aspect-square w-full rounded-xl bg-neutral-100"
                  />
                )
              )}
            </div>
          )}
          <div className="mt-4 flex items-center gap-2.5">
            <FriendAvatar profile={isMine ? null : profile} small />
            <p className="min-w-0 flex-1 text-xs text-neutral-500">
              Added by <span className="font-medium text-neutral-700">{addedName}</span> · {addedDate}
            </p>
            {!isMine && (
              <button
                type="button"
                disabled={acting}
                onClick={toggleSave}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition active:scale-95 disabled:opacity-60 ${
                  saved
                    ? "border-[#455d3b] bg-[#edf2eb] text-[#455d3b]"
                    : "border-neutral-200 bg-white text-neutral-500"
                }`}
              >
                <Bookmark
                  size={13}
                  strokeWidth={1.8}
                  fill={saved ? "#455d3b" : "none"}
                />
                {saved ? "On your map" : "Add to my map"}
              </button>
            )}
          </div>

          {/* reactions — the app's one palette, same contract as photos and
              comments: always visible, yours highlighted, tap to switch. */}
          <div className="mt-4 flex justify-between border-t border-neutral-100 pt-3.5">
            {REACTION_SET.map((e) => {
              const n = reactionCounts[e] || 0;
              const isMineE = myReaction === e;
              return (
                <button
                  key={e}
                  type="button"
                  disabled={acting}
                  onClick={() => react(e)}
                  className={`relative flex h-11 w-11 items-center justify-center rounded-full border text-[19px] transition active:scale-90 disabled:opacity-50 ${
                    isMineE
                      ? "border-[#455d3b] bg-[#edf2eb]"
                      : "border-transparent bg-neutral-100"
                  }`}
                >
                  {e}
                  {n > 0 && (
                    <span
                      className={`absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border border-white px-1 text-[10px] font-semibold ${
                        isMineE
                          ? "bg-[#455d3b] text-white"
                          : "bg-neutral-700 text-white"
                      }`}
                    >
                      {n}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* comments */}
          <div className="mt-3 border-t border-neutral-100 pt-3">
            <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">
              {comments === null
                ? "Comments"
                : comments.length === 0
                ? "No comments yet"
                : comments.length === 1
                ? "1 comment"
                : `${comments.length} comments`}
            </p>
            <div className="mt-2 space-y-3">
              {(comments || []).map((c) => (
                <div key={c.id} className="flex items-start gap-2.5">
                  <FriendAvatar
                    profile={c.user_id === userId ? null : c.profile}
                    small
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-[11.5px] text-neutral-400">
                      <span className="font-medium text-neutral-600">
                        {c.user_id === userId
                          ? "You"
                          : (c.profile?.display_name || "A friend").split(" ")[0]}
                      </span>{" "}
                      · {timeAgoShort(c.created_at)}
                    </p>
                    <p className="mt-0.5 break-words text-sm text-neutral-800">
                      {c.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2">
              {/* text-base: sub-16px inputs make iOS Safari auto-zoom. */}
              <input
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendComment()}
                placeholder="Comment on this spot"
                maxLength={300}
                className="h-11 min-w-0 flex-1 rounded-full border border-neutral-200 bg-neutral-50 px-4 text-base focus:border-[#455d3b] focus:outline-none placeholder:text-neutral-400"
              />
              <button
                type="button"
                aria-label="Send"
                disabled={sending || !commentBody.trim()}
                onClick={sendComment}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#455d3b] text-white active:scale-95 transition disabled:opacity-40"
              >
                <Send size={15} strokeWidth={1.6} />
              </button>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2">
            {gmaps && (
              <a
                href={gmaps}
                target="_blank"
                rel="noreferrer"
                className="flex flex-1 items-center justify-center gap-2 rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white active:scale-[0.99] transition"
              >
                <ExternalLink size={14} />
                Open in Google Maps
              </a>
            )}
            {isMine && (
              <button
                type="button"
                disabled={deleting}
                onClick={() => (deleteArm ? doDelete() : setDeleteArm(true))}
                className={`flex h-[46px] items-center justify-center rounded-full transition disabled:opacity-60 ${
                  deleteArm
                    ? "bg-red-500 px-4 text-xs font-medium text-white"
                    : "w-[46px] bg-neutral-100 text-neutral-500"
                }`}
              >
                {deleting ? (
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                ) : deleteArm ? (
                  "Really remove?"
                ) : (
                  <Trash2 size={16} strokeWidth={1.8} />
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
