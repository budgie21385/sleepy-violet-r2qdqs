// Check-in photo pipeline (client side). Design: the ORIGINAL file is
// uploaded untouched (download/print later); a web-size derivative is
// generated here via canvas and is what the app displays. Both live in the
// PRIVATE checkin-photos bucket — reads happen through short-lived signed
// URLs gated by storage RLS (visibility inherits the check-in's audience).
// bytes (orig + web) are recorded per uploader for the future quota model.
import { supabase } from "../supabaseClient";

const BUCKET = "checkin-photos";
export const MAX_PHOTOS_PER_CHECKIN = 5;
const WEB_MAX_DIM = 1280;
const WEB_QUALITY = 0.8;
export const SIGNED_URL_TTL = 60 * 60; // seconds

// Downscale to a web-friendly JPEG. iOS converts HEIC to JPEG on file input,
// so canvas decoding is dependable in practice.
async function makeWebDerivative(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, WEB_MAX_DIM / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", WEB_QUALITY)
    );
    if (!blob) throw new Error("canvas.toBlob failed");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function extOf(file) {
  const fromName = (file.name || "").split(".").pop()?.toLowerCase();
  if (fromName && fromName.length <= 5) return fromName;
  return (file.type || "image/jpeg").split("/").pop() || "jpg";
}

// Upload one photo (original + derivative) onto the user's own check-in.
// Returns the inserted activity_photos row. Throws on failure — partial
// uploads are cleaned up best-effort.
export async function uploadCheckinPhoto(userId, activityId, file) {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const base = `${userId}/${activityId}/${stamp}`;
  const origPath = `${base}_orig.${extOf(file)}`;
  const webPath = `${base}_web.jpg`;

  const webBlob = await makeWebDerivative(file);

  const { error: webErr } = await supabase.storage
    .from(BUCKET)
    .upload(webPath, webBlob, { contentType: "image/jpeg" });
  if (webErr) throw webErr;

  const { error: origErr } = await supabase.storage
    .from(BUCKET)
    .upload(origPath, file, { contentType: file.type || "image/jpeg" });
  if (origErr) {
    await supabase.storage.from(BUCKET).remove([webPath]);
    throw origErr;
  }

  const { data: row, error: insErr } = await supabase
    .from("activity_photos")
    .insert({
      activity_id: activityId,
      user_id: userId,
      web_path: webPath,
      orig_path: origPath,
      bytes: (file.size || 0) + (webBlob.size || 0),
    })
    .select("*")
    .single();
  if (insErr) {
    await supabase.storage.from(BUCKET).remove([webPath, origPath]);
    throw insErr;
  }
  return row;
}

// Photos for a check-in, with signed display URLs. Returns
// [{ ...row, url }] — url is the web derivative, valid for SIGNED_URL_TTL.
export async function fetchCheckinPhotos(activityId) {
  return fetchCheckinPhotosMany([activityId]);
}

// Same, across a same-night CLUSTER of check-ins (tag-accept twins, joins).
// RLS trims rows the viewer can't see, so passing the whole cluster is safe.
export async function fetchCheckinPhotosMany(activityIds) {
  if (!activityIds || activityIds.length === 0) return [];
  const { data: rows } = await supabase
    .from("activity_photos")
    .select("*")
    .in("activity_id", activityIds)
    .order("created_at", { ascending: true });
  if (!rows || rows.length === 0) return [];
  const { data: signed } = await supabase.storage
    .from(BUCKET)
    .createSignedUrls(rows.map((r) => r.web_path), SIGNED_URL_TTL);
  const urlByPath = new Map(
    (signed || []).filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl])
  );
  return rows.map((r) => ({ ...r, url: urlByPath.get(r.web_path) || null }));
}

// Delete one of your own photos (row + both storage objects).
export async function deleteCheckinPhoto(row) {
  await supabase.from("activity_photos").delete().eq("id", row.id);
  await supabase.storage.from(BUCKET).remove([row.web_path, row.orig_path]);
}
