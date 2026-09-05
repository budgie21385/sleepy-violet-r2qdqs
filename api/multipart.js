// R2 MULTIPART BROKER (Sep 5, 2026 — stage 2: VIDEO originals to R2, path A
// of Mark's ruling: originals kept bit-perfect, one storage system, no
// per-minute meter). R2 has no TUS, so resumability is rebuilt on S3
// multipart: the server initiates and completes; the browser PUTs each part
// straight to R2 via presigned URLs. A suspended phone resumes because
// completed parts live on R2 until the upload completes or aborts — the
// client just retries the parts it hasn't finished.
//
// Trust model mirrors sign-upload: the object key is DERIVED from the
// verified JWT's uid on init, and every later action re-checks the key
// still lives under that uid — nobody can complete or abort someone else's
// upload, or park bytes outside their own folder.
//
// POST { action, ... } with a Supabase JWT:
//   init      { ext, contentType, activityId } → { store, path, uploadId }
//             (store "sb" when R2 env is unset — client falls back to TUS)
//   sign_part { path, uploadId, partNumber }   → { url }
//   complete  { path, uploadId, parts }        → { ok }
//   abort     { path, uploadId }               → { ok }
import { createClient } from "@supabase/supabase-js";
import {
  r2Ready,
  multipartInit,
  presignPart,
  multipartComplete,
  multipartAbort,
} from "./_lib/r2.js";

const SUPABASE_URL =
  process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;

const VIDEO_MIME = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-m4v",
]);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  const body = req.body || {};
  const action = body.action;
  if (action === "init" && !r2Ready()) {
    return res.status(200).json({ store: "sb" });
  }
  if (!r2Ready()) return res.status(500).json({ error: "r2 not configured" });
  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "not configured" });
  }

  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return res.status(401).json({ error: "no token" });
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const uid = userData?.user?.id;
  if (userErr || !uid) return res.status(401).json({ error: "bad token" });

  // Own-folder containment for every non-init action.
  const path = typeof body.path === "string" ? body.path : "";
  if (action !== "init" && !path.startsWith(`${uid}/`)) {
    return res.status(403).json({ error: "not your path" });
  }

  try {
    if (action === "init") {
      const actId = Number(body.activityId);
      if (!Number.isFinite(actId) || actId <= 0) {
        return res.status(400).json({ error: "bad activity" });
      }
      const cleanExt = String(body.ext || "mp4")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
        .slice(0, 5);
      const contentType = VIDEO_MIME.has(body.contentType)
        ? body.contentType
        : "video/mp4";
      const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const key = `${uid}/${actId}/${stamp}_orig.${cleanExt || "mp4"}`;
      const uploadId = await multipartInit(key, contentType);
      return res.status(200).json({ store: "r2", path: key, uploadId });
    }
    if (action === "sign_part") {
      const partNumber = Number(body.partNumber);
      if (!body.uploadId || !Number.isFinite(partNumber) || partNumber < 1 || partNumber > 10000) {
        return res.status(400).json({ error: "bad part" });
      }
      const url = await presignPart(path, body.uploadId, partNumber);
      return res.status(200).json({ url });
    }
    if (action === "complete") {
      const parts = Array.isArray(body.parts)
        ? body.parts
            .map((p) => ({
              PartNumber: Number(p.PartNumber),
              ETag: String(p.ETag || ""),
            }))
            .filter((p) => Number.isFinite(p.PartNumber) && p.ETag)
        : [];
      if (!body.uploadId || parts.length === 0) {
        return res.status(400).json({ error: "bad parts" });
      }
      await multipartComplete(path, body.uploadId, parts);
      return res.status(200).json({ ok: true });
    }
    if (action === "abort") {
      if (!body.uploadId) return res.status(400).json({ error: "bad upload" });
      await multipartAbort(path, body.uploadId);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: "unknown action" });
  } catch (e) {
    console.error(`multipart ${action} failed:`, e.message);
    return res.status(500).json({ error: "multipart failed" });
  }
}
