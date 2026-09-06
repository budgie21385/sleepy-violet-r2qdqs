// SPOT SHEET (Sep 6, 2026) — the tap card for a spot (the friend knowledge
// layer: toilets, study spots, parking). Title, where, how to get there,
// details, photos, who added it and when, Open in Google Maps (directions
// are the whole point), two-tap delete for your own. Opened from the map's
// Spots lens and from the drawer's spot_added item.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Trash2, ExternalLink } from "lucide-react";
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

export function SpotSheet({ spot, userId, onClose, onDeleted, showToast }) {
  const [photoUrls, setPhotoUrls] = useState({});
  const [profile, setProfile] = useState(spot.profile || null);
  const [deleteArm, setDeleteArm] = useState(false);
  const [deleting, setDeleting] = useState(false);
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
    })();
    return () => {
      cancelled = true;
    };
  }, [spot]);

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
            <p className="text-xs text-neutral-500">
              Added by <span className="font-medium text-neutral-700">{addedName}</span> · {addedDate}
            </p>
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
