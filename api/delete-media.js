// Owner moderation for via-link guest media (July 24, 2026 — collect links).
//   POST { photoId } with a Supabase JWT.
// The caller may delete a photo row iff they OWN the activity it's attached
// to AND the row arrived via a collect link (family-event moderation right).
// Own media keeps deleting client-side (RLS delete_own + own-folder storage);
// this endpoint exists because storage objects live in the GUEST's uid
// folder, which only the service role can remove on the owner's behalf.
//
// Env (Vercel): SUPABASE_SERVICE_ROLE_KEY, REACT_APP_SUPABASE_URL (or SUPABASE_URL).
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;
const BUCKET = "checkin-photos";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "not configured" });
  }

  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return res.status(401).json({ error: "no token" });

  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const actor = userData?.user;
  if (userErr || !actor) return res.status(401).json({ error: "bad token" });

  const { photoId } = req.body || {};
  if (!photoId) return res.status(400).json({ error: "photoId required" });

  const { data: photo } = await admin
    .from("activity_photos")
    .select("id, activity_id, user_id, web_path, orig_path, via_link")
    .eq("id", photoId)
    .maybeSingle();
  if (!photo) return res.status(404).json({ error: "not found" });

  // Authorization: the ACTIVITY OWNER moderates via-link media on their
  // own check-in. (Uploaders delete their own media client-side.)
  const { data: act } = await admin
    .from("activities")
    .select("user_id")
    .eq("id", photo.activity_id)
    .maybeSingle();
  const isActivityOwner = act?.user_id === actor.id;
  const isUploader = photo.user_id === actor.id;
  if (!(isUploader || (isActivityOwner && photo.via_link))) {
    return res.status(403).json({ error: "not yours to delete" });
  }

  await admin.storage.from(BUCKET).remove([photo.web_path, photo.orig_path]);
  const { error: delErr } = await admin
    .from("activity_photos")
    .delete()
    .eq("id", photo.id);
  if (delErr) return res.status(500).json({ error: delErr.message });

  return res.status(200).json({ deleted: photo.id });
}
