// R2 UPLOAD DOOR (Aug 30, 2026 — stage 1). Mints a presigned PUT for a
// photo ORIGINAL going to R2. Trust model mirrors the Supabase storage
// policy it replaces: any authenticated user (anon sessions included — the
// collect-link population) may write into their OWN uid folder; the
// DATABASE row is what grants anyone the right to read it back, and that
// insert is still gated by RLS / the collect RPC exactly as before.
//
// POST { activityId, ext } with a Supabase JWT →
//   { store: "r2", path, url }   (client PUTs the bytes straight to R2)
//   { store: "sb" }              (R2 env unset — client falls back)
import { createClient } from "@supabase/supabase-js";
import { r2Ready, presignPut } from "./_lib/r2.js";

const SUPABASE_URL =
  process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;

const MIME_BY_EXT = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
  heif: "image/heif",
  gif: "image/gif",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  if (!r2Ready()) return res.status(200).json({ store: "sb" });
  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "not configured" });
  }

  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return res.status(401).json({ error: "no token" });
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const uid = userData?.user?.id;
  if (userErr || !uid) return res.status(401).json({ error: "bad token" });

  const { activityId, ext } = req.body || {};
  const actId = Number(activityId);
  if (!Number.isFinite(actId) || actId <= 0) {
    return res.status(400).json({ error: "bad activity" });
  }
  const cleanExt = String(ext || "jpg")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 5);
  const contentType = MIME_BY_EXT[cleanExt] || "image/jpeg";

  // Own-folder rule: the path is DERIVED from the verified uid, never taken
  // from the body — same containment the Supabase storage policy enforced.
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const path = `${uid}/${actId}/${stamp}_orig.${cleanExt || "jpg"}`;

  try {
    const url = await presignPut(path, contentType);
    return res.status(200).json({ store: "r2", path, url, contentType });
  } catch (e) {
    console.error("R2 presign PUT failed:", e.message);
    return res.status(200).json({ store: "sb" }); // fall back, never block
  }
}
