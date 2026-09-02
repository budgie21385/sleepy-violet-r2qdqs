// COLLECT-LINK TEASER (Aug 30, 2026) — the /c/ page's "what you're missing".
// Mark's level-2 ruling: after an anon uploads, show a BLURRED grid + count
// of the album so "See all the photos" is a promise with evidence, not a
// bare button. The resolver RPC is deliberately media-free, so this endpoint
// (service role, same pattern as send-push) validates the token itself and
// hands out a few short-lived signed URLs of web derivatives — the client
// blurs them. Own uploads are excluded from the thumbs (the guest already
// sees theirs sharp) but counted in the totals: the numbers stay honest.
//
// GET /api/collect-teaser?token=...&exclude=<uid>
// → { total, people, thumbs: [url, ...] }   (thumbs capped at 4)
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;
const TTL = 60 * 10; // 10 minutes — the exit card's lifetime, not a share

export default async function handler(req, res) {
  const token = (req.query?.token || "").trim();
  const exclude = (req.query?.exclude || "").trim() || null;
  if (!token) return res.status(400).json({ error: "no token" });
  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "not configured" });
  }
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  // Token → night. Unknown/revoked = 404, same no-oracle rule as the RPC.
  const { data: link } = await admin
    .from("checkin_collect_links")
    .select("activity_id, revoked")
    .eq("token", token)
    .maybeSingle();
  if (!link || link.revoked) return res.status(404).json({ error: "gone" });

  // The night's cluster: root + one level of joined_from legs — the same
  // walk every album surface does.
  const { data: rootRow } = await admin
    .from("activities")
    .select("id, joined_from")
    .eq("id", link.activity_id)
    .maybeSingle();
  const rootId = rootRow?.joined_from || link.activity_id;
  const { data: kids } = await admin
    .from("activities")
    .select("id")
    .eq("joined_from", rootId);
  const nightIds = Array.from(
    new Set([rootId, link.activity_id, ...(kids || []).map((k) => k.id)])
  );

  const { data: photos } = await admin
    .from("activity_photos")
    .select("id, user_id, web_path, kind, created_at")
    .in("activity_id", nightIds)
    .order("created_at", { ascending: false })
    .limit(120);
  const rows = photos || [];
  const total = rows.length;
  const people = new Set(rows.map((p) => p.user_id)).size;

  const thumbRows = rows
    .filter((p) => p.web_path && (!exclude || p.user_id !== exclude))
    .slice(0, 4);
  let thumbs = [];
  if (thumbRows.length > 0) {
    const { data: signed } = await admin.storage
      .from("checkin-photos")
      .createSignedUrls(thumbRows.map((p) => p.web_path), TTL);
    thumbs = (signed || [])
      .map((s) => s.signedUrl)
      .filter(Boolean);
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ total, people, thumbs });
}
