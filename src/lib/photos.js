// Check-in photo pipeline (client side). Design: the ORIGINAL file is
// uploaded untouched (download/print later); a web-size derivative is
// generated here via canvas and is what the app displays. Both live in the
// PRIVATE checkin-photos bucket — reads happen through short-lived signed
// URLs gated by storage RLS (visibility inherits the check-in's audience).
// bytes (orig + web) are recorded per uploader for the future quota model.
import { supabase } from "../supabaseClient";

const BUCKET = "checkin-photos";
export const MAX_PHOTOS_PER_CHECKIN = 5; // cap covers photos + videos combined
const WEB_MAX_DIM = 1280;
const WEB_QUALITY = 0.8;
export const SIGNED_URL_TTL = 60 * 60; // seconds
// No client-side transcode exists, so videos upload as-is under a hard cap
// (~30-60s of phone footage). Bucket limit raised to match (checkin_videos.sql).
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

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

// Grab a frame as a JPEG thumbnail — strips and lightboxes stay image-fast
// even for videos. Seeks slightly in (frame 0 is often black).
async function makeVideoThumb(file) {
  const url = URL.createObjectURL(file);
  try {
    const video = document.createElement("video");
    video.preload = "auto";
    video.playsInline = true;
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error("video decode failed"));
    });
    await new Promise((resolve) => {
      video.onseeked = resolve;
      video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
    });
    const scale = Math.min(
      1,
      WEB_MAX_DIM / Math.max(video.videoWidth || 1, video.videoHeight || 1)
    );
    const w = Math.max(1, Math.round((video.videoWidth || 1) * scale));
    const h = Math.max(1, Math.round((video.videoHeight || 1) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(video, 0, 0, w, h);
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

// Upload a video: JPEG thumbnail to web_path (what strips render), the
// untouched video to orig_path, kind='video'. Throws {code:'too_big'} over
// the cap so callers can toast a friendly limit.
export async function uploadCheckinVideo(userId, activityId, file) {
  if ((file.size || 0) > MAX_VIDEO_BYTES) {
    const err = new Error("Video over the 50MB limit");
    err.code = "too_big";
    throw err;
  }
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const base = `${userId}/${activityId}/${stamp}`;
  const origPath = `${base}_orig.${extOf(file)}`;
  const webPath = `${base}_web.jpg`;

  const thumbBlob = await makeVideoThumb(file);

  const { error: webErr } = await supabase.storage
    .from(BUCKET)
    .upload(webPath, thumbBlob, { contentType: "image/jpeg" });
  if (webErr) throw webErr;

  const { error: origErr } = await supabase.storage
    .from(BUCKET)
    .upload(origPath, file, { contentType: file.type || "video/mp4" });
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
      bytes: (file.size || 0) + (thumbBlob.size || 0),
      kind: "video",
    })
    .select("*")
    .single();
  if (insErr) {
    await supabase.storage.from(BUCKET).remove([webPath, origPath]);
    throw insErr;
  }
  return row;
}

// One entry point for the file inputs — routes by MIME type.
export function uploadCheckinMedia(userId, activityId, file) {
  return (file.type || "").startsWith("video/")
    ? uploadCheckinVideo(userId, activityId, file)
    : uploadCheckinPhoto(userId, activityId, file);
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
  // Videos also need a playable URL for their original.
  const vidRows = rows.filter((r) => r.kind === "video");
  let vidByPath = new Map();
  if (vidRows.length > 0) {
    const { data: signedV } = await supabase.storage
      .from(BUCKET)
      .createSignedUrls(vidRows.map((r) => r.orig_path), SIGNED_URL_TTL);
    vidByPath = new Map(
      (signedV || [])
        .filter((s) => s.signedUrl)
        .map((s) => [s.path, s.signedUrl])
    );
  }
  return rows.map((r) => ({
    ...r,
    url: urlByPath.get(r.web_path) || null,
    videoUrl: r.kind === "video" ? vidByPath.get(r.orig_path) || null : null,
  }));
}

// Delete one of your own photos (row + both storage objects).
export async function deleteCheckinPhoto(row) {
  await supabase.from("activity_photos").delete().eq("id", row.id);
  await supabase.storage.from(BUCKET).remove([row.web_path, row.orig_path]);
}
