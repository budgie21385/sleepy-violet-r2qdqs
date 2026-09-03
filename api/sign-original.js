// R2 READ DOOR (Aug 30, 2026 — stage 1). Presigned GETs for photo
// originals that live on R2. Authorization is the DATABASE's, not ours:
// the rows are re-queried with the CALLER's JWT so activity_photos RLS
// trims anything they can't see, and only survivors get signed (the July
// plan's note — "storage RLS is not load-bearing here; the row gate is").
//
// POST { ids: [photoId, ...] } with a Supabase JWT →
//   { urls: { [photoId]: signedUrl } }   (r2 rows only; 'sb' rows are the
//   client's to sign through Supabase storage as it always has)
import { createClient } from "@supabase/supabase-js";
import { r2Ready, presignGet } from "./_lib/r2.js";

const SUPABASE_URL =
  process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;
const ANON_KEY = process.env.REACT_APP_SUPABASE_ANON_KEY;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  if (!r2Ready()) return res.status(200).json({ urls: {} });
  if (!SUPABASE_URL || !ANON_KEY) {
    return res.status(500).json({ error: "not configured" });
  }

  const jwt = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return res.status(401).json({ error: "no token" });

  const ids = (req.body?.ids || [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 50);
  if (ids.length === 0) return res.status(200).json({ urls: {} });

  // Anon key + the caller's JWT = the caller's own eyes. RLS does the work.
  const asCaller = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
  const { data: rows, error } = await asCaller
    .from("activity_photos")
    .select("id, orig_path, orig_store")
    .in("id", ids)
    .eq("orig_store", "r2");
  if (error) {
    console.error("sign-original row check failed:", error.message);
    return res.status(500).json({ error: "query failed" });
  }

  const urls = {};
  for (const r of rows || []) {
    if (!r.orig_path) continue;
    try {
      urls[r.id] = await presignGet(r.orig_path, 3600);
    } catch (e) {
      console.error("R2 presign GET failed:", e.message);
    }
  }
  return res.status(200).json({ urls });
}
