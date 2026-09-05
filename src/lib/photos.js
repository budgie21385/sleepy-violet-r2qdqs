// Check-in photo pipeline (client side). Design: the ORIGINAL file is
// uploaded untouched (download/print later); a web-size derivative is
// generated here via canvas and is what the app displays. Both live in the
// PRIVATE checkin-photos bucket — reads happen through short-lived signed
// URLs gated by storage RLS (visibility inherits the check-in's audience).
// bytes (orig + web) are recorded per uploader for the future quota model.
import { supabase } from "../supabaseClient";

const BUCKET = "checkin-photos";
// NO LIFETIME CAP (July 25, Mark's call): a night is a night — the camera
// tile never disappears. This is only a per-BATCH sanity limit, so one
// accidental "select all" in the picker can't queue 400 uploads at once.
// The real brake will be the per-user storage quota (bytes are already
// tracked per uploader in activity_photos).
export const MAX_PHOTOS_PER_BATCH = 30;
const WEB_MAX_DIM = 1280;
const WEB_QUALITY = 0.8;
export const SIGNED_URL_TTL = 60 * 60; // seconds
// No client-side transcode exists, so videos upload as-is under a hard cap
// (~30-60s of phone footage). Bucket limit raised to match (checkin_videos.sql).
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

// Force a COMPLETE read of the picked file (July 25 — desktop uploads from
// cloud-synced folders (OneDrive placeholders) can stream partial bytes;
// the browser "decodes" the truncated JPEG into a solid green block and
// both the derivative and the original upload corrupt). arrayBuffer()
// makes the OS hydrate the file fully, or fail cleanly.
async function materializeFile(file) {
  const bytes = await file.arrayBuffer();
  return new Blob([bytes], { type: file.type || "application/octet-stream" });
}

// Downscale to a web-friendly JPEG. iOS converts HEIC to JPEG on file input,
// so canvas decoding is dependable in practice.
async function makeWebDerivative(file) {
  const stable = await materializeFile(file);
  const url = URL.createObjectURL(stable);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    if (!img.width || !img.height) throw new Error("image decoded empty");
    const scale = Math.min(1, WEB_MAX_DIM / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    // White under transparency — PNG screenshots were going black on JPEG.
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
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

  // ORIGINAL: photos try R2 first (stage 1); videos keep TUS on Supabase.
  let finalOrigPath = origPath;
  let origStore = "sb";
  try {
    if (isVideo) {
      const r2VidPath = await uploadVideoViaR2(activityId, file, onProgress);
      if (r2VidPath) {
        finalOrigPath = r2VidPath;
        origStore = "r2";
      } else {
        await uploadResumable(origPath, file, file.type || "video/mp4", onProgress);
      }
    } else {
      // Same full-read guard as uploadCheckinPhoto.
      const stableOrig = await materializeFile(file);
      const r2Path = await putOriginalViaR2(activityId, file, stableOrig);
      if (r2Path) {
        finalOrigPath = r2Path;
        origStore = "r2";
      } else {
        const { error: origErr } = await supabase.storage
          .from(BUCKET)
          .upload(origPath, stableOrig, { contentType: file.type || "image/jpeg" });
        if (origErr) throw origErr;
      }
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
      p_orig_path: finalOrigPath,
      p_bytes: (file.size || 0) + (webBlob.size || 0),
      p_kind: isVideo ? "video" : "photo",
      // Only sent on the R2 path — the old 5-arg RPC stays callable until
      // r2_stage1.sql swaps it (R2 can't be live before that runs).
      ...(origStore === "r2" ? { p_orig_store: "r2" } : {}),
    }
  );
  if (rpcErr) {
    await supabase.storage
      .from(BUCKET)
      .remove(origStore === "sb" ? [webPath, finalOrigPath] : [webPath]);
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

// R2 STAGE 1 (Aug 30): photo ORIGINALS go to Cloudflare R2 when the pipe is
// live — the server mints a presigned PUT (own-uid path, derived from the
// verified JWT) and the bytes go straight there. ANY failure, or R2 env
// unset, returns null and the caller falls back to Supabase — the app can
// never break on a missing bucket. Videos keep TUS on Supabase this stage.
async function putOriginalViaR2(activityId, file, stableOrig) {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return null;
    const resp = await fetch("/api/sign-upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ activityId, ext: extOf(file) }),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (json.store !== "r2" || !json.url || !json.path) return null;
    const put = await fetch(json.url, {
      method: "PUT",
      headers: {
        "Content-Type": json.contentType || file.type || "image/jpeg",
      },
      body: stableOrig,
    });
    if (!put.ok) return null;
    return json.path;
  } catch {
    return null;
  }
}

// R2 STAGE 2 (Sep 5): VIDEO originals via S3 multipart — resumability
// rebuilt without TUS. The server initiates/completes; each 6MB part goes
// straight to R2 on a presigned URL with per-part retries and backoff, so
// a locked phone resumes where it left off (completed parts persist on R2
// until the upload completes or aborts). Returns the R2 key, or null on
// ANY failure — the caller falls back to Supabase TUS, same doctrine as
// photos. Requires the bucket CORS to EXPOSE the ETag header.
const PART_SIZE = 6 * 1024 * 1024;
async function uploadVideoViaR2(activityId, file, onProgress) {
  async function api(bodyObj, token) {
    const resp = await fetch("/api/multipart", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(bodyObj),
    });
    if (!resp.ok) throw new Error(`multipart api ${resp.status}`);
    return resp.json();
  }
  let token;
  let init = null;
  try {
    const { data: sess } = await supabase.auth.getSession();
    token = sess?.session?.access_token;
    if (!token) return null;
    init = await api(
      {
        action: "init",
        activityId,
        ext: extOf(file),
        contentType: file.type || "video/mp4",
      },
      token
    );
    if (init.store !== "r2" || !init.path || !init.uploadId) return null;

    const total = file.size || 0;
    const partCount = Math.max(1, Math.ceil(total / PART_SIZE));
    const parts = [];
    for (let i = 0; i < partCount; i++) {
      const partNumber = i + 1;
      const chunk = file.slice(i * PART_SIZE, Math.min(total, (i + 1) * PART_SIZE));
      let etag = null;
      // Per-part retry with backoff — this loop IS the resume: a wake-up
      // after suspension just retries the part that was in flight.
      for (let attempt = 0; attempt < 6 && !etag; attempt++) {
        try {
          if (attempt > 0) {
            await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * 2 ** attempt)));
            // Presigned URLs may have aged out during a long suspension —
            // mint a fresh one each retry.
          }
          const { url } = await api(
            {
              action: "sign_part",
              path: init.path,
              uploadId: init.uploadId,
              partNumber,
            },
            token
          );
          const put = await fetch(url, { method: "PUT", body: chunk });
          if (!put.ok) throw new Error(`part ${partNumber} HTTP ${put.status}`);
          etag = put.headers.get("ETag") || put.headers.get("etag");
          if (!etag) throw new Error("no ETag (bucket CORS must expose it)");
        } catch (e) {
          if (attempt === 5) throw e;
        }
      }
      parts.push({ PartNumber: partNumber, ETag: etag });
      onProgress?.(Math.min(total, (i + 1) * PART_SIZE), total);
    }
    await api(
      { action: "complete", path: init.path, uploadId: init.uploadId, parts },
      token
    );
    return init.path;
  } catch (e) {
    console.error("R2 multipart failed, falling back to TUS:", e?.message);
    // Best-effort abort so R2 doesn't hold orphan parts.
    if (init?.path && init?.uploadId && token) {
      api({ action: "abort", path: init.path, uploadId: init.uploadId }, token).catch(() => {});
    }
    return null;
  }
}

// Signed GETs for R2-stored originals (download button, future zip export).
// 'sb' rows keep signing through Supabase storage as they always have.
export async function signR2Originals(photoIds) {
  try {
    const { data: sess } = await supabase.auth.getSession();
    const token = sess?.session?.access_token;
    if (!token) return {};
    const resp = await fetch("/api/sign-original", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ ids: photoIds }),
    });
    if (!resp.ok) return {};
    const json = await resp.json();
    return json.urls || {};
  } catch {
    return {};
  }
}

// Upload one photo (original + derivative) onto the user's own check-in.
// Returns the inserted activity_photos row. Throws on failure — partial
// uploads are cleaned up best-effort.
export async function uploadCheckinPhoto(userId, activityId, file) {
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const base = `${userId}/${activityId}/${stamp}`;
  const origPath = `${base}_orig.${extOf(file)}`;
  const webPath = `${base}_web.jpg`;

  // Full-read guard: the ORIGINAL uploads from materialized bytes too, so
  // a cloud-placeholder file can't send a truncated heirloom copy.
  const stableOrig = await materializeFile(file);
  const webBlob = await makeWebDerivative(file);

  const { error: webErr } = await supabase.storage
    .from(BUCKET)
    .upload(webPath, webBlob, { contentType: "image/jpeg" });
  if (webErr) throw webErr;

  // ORIGINAL → R2 when the pipe is live (stage 1), Supabase otherwise.
  let finalOrigPath = origPath;
  let origStore = "sb";
  const r2Path = await putOriginalViaR2(activityId, file, stableOrig);
  if (r2Path) {
    finalOrigPath = r2Path;
    origStore = "r2";
  } else {
    const { error: origErr } = await supabase.storage
      .from(BUCKET)
      .upload(origPath, stableOrig, { contentType: file.type || "image/jpeg" });
    if (origErr) {
      await supabase.storage.from(BUCKET).remove([webPath]);
      throw origErr;
    }
  }

  const { data: row, error: insErr } = await supabase
    .from("activity_photos")
    .insert({
      activity_id: activityId,
      user_id: userId,
      web_path: webPath,
      orig_path: finalOrigPath,
      bytes: (file.size || 0) + (webBlob.size || 0),
      // Only written on the R2 path — keeps this insert valid before
      // r2_stage1.sql runs (R2 can't be live before the column exists,
      // since flipping it on is part of the same rollout step).
      ...(origStore === "r2" ? { orig_store: "r2" } : {}),
    })
    .select("*")
    .single();
  if (insErr) {
    // R2 orphans (rare: insert failed after a successful PUT) get reaped by
    // a future janitor pass; the sb objects we can clean now.
    await supabase.storage
      .from(BUCKET)
      .remove(origStore === "sb" ? [webPath, origPath] : [webPath]);
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

  // ORIGINAL → R2 multipart when the pipe is live (stage 2), TUS otherwise.
  let finalOrigPath = origPath;
  let origStore = "sb";
  const r2Path = await uploadVideoViaR2(activityId, file, onProgress);
  if (r2Path) {
    finalOrigPath = r2Path;
    origStore = "r2";
  } else {
    try {
      await uploadResumable(origPath, file, file.type || "video/mp4", onProgress);
    } catch (origErr) {
      await supabase.storage.from(BUCKET).remove([webPath]);
      throw origErr;
    }
  }

  const { data: row, error: insErr } = await supabase
    .from("activity_photos")
    .insert({
      activity_id: activityId,
      user_id: userId,
      web_path: webPath,
      orig_path: finalOrigPath,
      bytes: (file.size || 0) + (thumbBlob.size || 0),
      kind: "video",
      ...(origStore === "r2" ? { orig_store: "r2" } : {}),
    })
    .select("*")
    .single();
  if (insErr) {
    await supabase.storage
      .from(BUCKET)
      .remove(origStore === "sb" ? [webPath, origPath] : [webPath]);
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
  // Videos also need a playable URL for their original — STORE-AWARE
  // (Sep 5, stage 2): sb originals sign through Supabase as ever, r2 ones
  // through our API.
  const vidRows = rows.filter((r) => r.kind === "video");
  let vidByPath = new Map();
  let r2VidById = {};
  if (vidRows.length > 0) {
    const sbVids = vidRows.filter((r) => (r.orig_store || "sb") !== "r2");
    if (sbVids.length > 0) {
      const { data: signedV } = await supabase.storage
        .from(BUCKET)
        .createSignedUrls(sbVids.map((r) => r.orig_path), SIGNED_URL_TTL);
      vidByPath = new Map(
        (signedV || [])
          .filter((s) => s.signedUrl)
          .map((s) => [s.path, s.signedUrl])
      );
    }
    const r2Vids = vidRows.filter((r) => (r.orig_store || "sb") === "r2");
    if (r2Vids.length > 0) {
      r2VidById = await signR2Originals(r2Vids.map((r) => r.id));
    }
  }
  return rows.map((r) => ({
    ...r,
    url: urlByPath.get(r.web_path) || null,
    videoUrl:
      r.kind === "video"
        ? (r.orig_store || "sb") === "r2"
          ? r2VidById[r.id] || null
          : vidByPath.get(r.orig_path) || null
        : null,
  }));
}

// Delete one of your own photos (row + storage objects). R2-stored
// originals route through api/delete-media — only the server holds the R2
// key, and the endpoint already allows uploader self-delete.
export async function deleteCheckinPhoto(row) {
  if ((row.orig_store || "sb") === "r2") {
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess?.session?.access_token;
      const resp = await fetch("/api/delete-media", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ photoId: row.id }),
      });
      if (resp.ok) return;
    } catch (e) {
      console.error("R2 delete route failed:", e);
    }
    // Endpoint unavailable → at least remove the row + web derivative; the
    // R2 orphan waits for the janitor pass.
    await supabase.from("activity_photos").delete().eq("id", row.id);
    await supabase.storage.from(BUCKET).remove([row.web_path]);
    return;
  }
  await supabase.from("activity_photos").delete().eq("id", row.id);
  await supabase.storage.from(BUCKET).remove([row.web_path, row.orig_path]);
}
