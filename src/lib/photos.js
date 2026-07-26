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
// even for videos. Wrapped in a 6s watchdog: iOS occasionally never fires
// the seek event, which used to hang the WHOLE upload before a single byte
// moved. On timeout/failure a plain dark thumbnail ships instead.
async function makeVideoThumb(file) {
  try {
    return await Promise.race([
      grabVideoFrame(file),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("thumb timeout")), 6000)
      ),
    ]);
  } catch (e) {
    console.warn("Video thumb fallback:", e?.message);
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#2a2a2a";
    ctx.fillRect(0, 0, 320, 180);
    const blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8)
    );
    if (!blob) throw new Error("fallback thumb failed");
    return blob;
  }
}

async function grabVideoFrame(file) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  try {
    video.preload = "auto";
    video.playsInline = true;
    video.muted = true;
    video.src = url;
    // iOS Safari: waiting on loadedmetadata + seeked HANGS (the seek event
    // never fires — Mark's phone log: "thumb timeout"). The reliable recipe:
    // wait for a DECODED frame (loadeddata), nudge the decoder with
    // play-then-pause (allowed: muted + playsInline), and treat the seek as
    // best-effort with its own short timeout.
    await new Promise((resolve, reject) => {
      video.onloadeddata = resolve;
      video.onerror = () => reject(new Error("video decode failed"));
      video.load();
    });
    try {
      await video.play();
      video.pause();
    } catch {
      /* decode nudge only — a refusal is fine */
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 1200); // seek is a nice-to-have
      video.onseeked = () => {
        clearTimeout(t);
        resolve();
      };
      try {
        video.currentTime = Math.min(0.5, (video.duration || 1) / 2);
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    if (!video.videoWidth) throw new Error("no decoded frame");
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
    video.removeAttribute("src");
    video.load(); // release the decoder before revoking (iOS holds it)
    URL.revokeObjectURL(url);
  }
}

// VIA-LINK upload (collect links, July 24). Storage objects land in the
// GUEST's own uid folder (existing storage write policy covers anon-auth
// users), but the ROW attaches to the LINK OWNER's activity through the
// add_photo_via_link RPC — the only path past the own-activity insert RLS.
// Revocation + per-guest/per-link caps are enforced inside the RPC at
// insert time, so a revoked link dies even for an already-open page.
// Returns { id, url, kind } — url is the signed web derivative for the
// guest's own-thumbnails confirmation strip.
export async function uploadViaCollectLink(userId, token, activityId, file, onProgress) {
  const isVideo = (file.type || "").startsWith("video/");
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const base = `${userId}/${activityId}/${stamp}`;
  const origPath = `${base}_orig.${extOf(file)}`;
  const webPath = `${base}_web.jpg`;

  let webBlob;
  if (isVideo) {
    if ((file.size || 0) > MAX_VIDEO_BYTES) {
      const err = new Error("Video over the 50MB limit");
      err.code = "too_big";
      throw err;
    }
    webBlob = await makeVideoThumb(file);
  } else {
    webBlob = await makeWebDerivative(file);
  }

  const { error: webErr } = await supabase.storage
    .from(BUCKET)
    .upload(webPath, webBlob, { contentType: "image/jpeg" });
  if (webErr) throw webErr;

  try {
    if (isVideo) {
      await uploadResumable(origPath, file, file.type || "video/mp4", onProgress);
    } else {
      const { error: origErr } = await supabase.storage
        .from(BUCKET)
        .upload(origPath, file, { contentType: file.type || "image/jpeg" });
      if (origErr) throw origErr;
    }
  } catch (origErr) {
    await supabase.storage.from(BUCKET).remove([webPath]);
    throw origErr;
  }

  const { data: newId, error: rpcErr } = await supabase.rpc(
    "add_photo_via_link",
    {
      p_token: token,
      p_web_path: webPath,
      p_orig_path: origPath,
      p_bytes: (file.size || 0) + (webBlob.size || 0),
      p_kind: isVideo ? "video" : "photo",
    }
  );
  if (rpcErr) {
    await supabase.storage.from(BUCKET).remove([webPath, origPath]);
    throw rpcErr;
  }
  const { data: signed } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(webPath, SIGNED_URL_TTL);
  return {
    id: newId,
    url: signed?.signedUrl || null,
    kind: isVideo ? "video" : "photo",
  };
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

// Resumable (TUS) upload for big files: goes up in 6MB chunks, retries with
// backoff, and RESUMES where it left off after a suspension — a locked phone
// or app switch no longer restarts a 50MB transfer from zero (Mark's video
// died exactly this way; single PUTs don't survive it).
async function uploadResumable(path, file, contentType, onProgress) {
  // Diagnostics silenced July 25 (video uploads field-verified). Flip to
  // console.log if the stuck-video hunt ever reopens.
  const log = () => {};
  log("tus: importing client");
  const mod = await import("tus-js-client");
  const Upload = mod.Upload || mod.default?.Upload;
  if (!Upload) throw new Error("tus-js-client not available");
  const { data: sess } = await supabase.auth.getSession();
  const token = sess?.session?.access_token;
  if (!token) throw new Error("No session for upload");
  log("tus: starting", { path, size: file.size, type: contentType });
  await new Promise((resolve, reject) => {
    const upload = new Upload(file, {
      endpoint: `${process.env.REACT_APP_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 2000, 5000, 10000, 20000],
      chunkSize: 6 * 1024 * 1024, // Supabase requires 6MB multiples
      headers: { authorization: `Bearer ${token}`, "x-upsert": "false" },
      metadata: {
        bucketName: BUCKET,
        objectName: path,
        contentType: contentType || "application/octet-stream",
        cacheControl: "3600",
      },
      onShouldRetry: (err) => {
        log("tus: retrying after error", err?.message || err);
        return true;
      },
      onProgress: (sent, total) => {
        log("tus: progress", sent, "/", total);
        if (onProgress && total > 0)
          onProgress(Math.min(99, Math.round((sent / total) * 100)));
      },
      onError: (err) => {
        log("tus: FAILED", err?.message || err);
        reject(err);
      },
      onSuccess: () => {
        log("tus: done", path);
        resolve();
      },
    });
    // Resume a previous attempt of the same file if one exists. A rejected
    // lookup used to dangle this promise forever — now it just starts fresh.
    upload
      .findPreviousUploads()
      .then((prev) => {
        if (prev.length > 0) upload.resumeFromPreviousUpload(prev[0]);
        upload.start();
        log("tus: request sent");
      })
      .catch(() => {
        upload.start();
        log("tus: request sent (no resume lookup)");
      });
  });
}

// Upload a video: JPEG thumbnail to web_path (what strips render), the
// untouched video to orig_path (resumable), kind='video'. Throws
// {code:'too_big'} over the cap so callers can toast a friendly limit.
export async function uploadCheckinVideo(userId, activityId, file, onProgress) {
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

  try {
    await uploadResumable(origPath, file, file.type || "video/mp4", onProgress);
  } catch (origErr) {
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
// onProgress (0-100) currently only fires for videos (TUS reports progress;
// plain photo PUTs don't).
export function uploadCheckinMedia(userId, activityId, file, onProgress) {
  return (file.type || "").startsWith("video/")
    ? uploadCheckinVideo(userId, activityId, file, onProgress)
    : uploadCheckinPhoto(userId, activityId, file);
}

// ---- In-flight upload store (module scope) ----
// Uploads outlive the card that started them (SPA — the page stays open),
// but component-local "Uploading…" tiles died on unmount, so a closed and
// reopened card showed nothing until the upload finished (Mark's report).
// This registry keeps pending entries + notifies subscribers on every
// start/finish, so ANY mounted card can render the right tiles.
const inflightUploads = new Map(); // key -> {key, activityId, isVideo, preview}
const uploadListeners = new Set();
function notifyUploadListeners() {
  uploadListeners.forEach((cb) => {
    try {
      cb();
    } catch {}
  });
}

// Register an upload + its promise; auto-removes and re-notifies when done.
export function trackUpload(entry, promise) {
  inflightUploads.set(entry.key, entry);
  notifyUploadListeners();
  promise.finally(() => {
    inflightUploads.delete(entry.key);
    notifyUploadListeners();
  });
}

// A pending tile's preview can arrive AFTER enqueue (video thumbnails are
// generated async) — patch the entry and re-notify so tiles upgrade live.
export function updateUploadPreview(key, preview) {
  const e = inflightUploads.get(key);
  if (e) {
    e.preview = preview;
    notifyUploadListeners();
  }
}

// Local preview frame for a video file (object URL) — shows in pending tiles
// well before the actual bytes finish uploading. Uses the raw grab (no gray
// fallback): if the frame can't be read the tile just keeps its ▶.
export async function makeVideoPreviewUrl(file) {
  const blob = await grabVideoFrame(file);
  return URL.createObjectURL(blob);
}

// Live progress for the pending tiles ("Uploading 43%").
export function updateUploadProgress(key, progress) {
  const e = inflightUploads.get(key);
  if (e) {
    e.progress = progress;
    notifyUploadListeners();
  }
}

export function getInflightFor(activityIds) {
  const ids = new Set(activityIds || []);
  return Array.from(inflightUploads.values()).filter((e) =>
    ids.has(e.activityId)
  );
}

export function subscribeUploads(cb) {
  uploadListeners.add(cb);
  return () => uploadListeners.delete(cb);
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
