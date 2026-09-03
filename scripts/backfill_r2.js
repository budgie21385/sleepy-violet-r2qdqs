// R2 BACKFILL (Aug 30, 2026 — stage 1). Copies existing PHOTO originals
// from the Supabase checkin-photos bucket to R2, verifies the byte count,
// then flips the row's orig_store to 'r2'. Resumable by construction: it
// only ever selects rows still marked 'sb', so rerunning after any failure
// picks up where it left off. Supabase objects are NOT deleted here — that
// is the explicit stage-4 retirement step, after a safety window.
//
// Run LOCALLY (never in the app), after r2_stage1.sql:
//   node scripts/backfill_r2.js
// Env (shell, per-run — the July key rule, nothing stored):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Optional: DRY_RUN=1 (report only), BATCH=25
const { createClient } = require("@supabase/supabase-js");
const { S3Client, PutObjectCommand, HeadObjectCommand } = require("@aws-sdk/client-s3");

const need = (k) => {
  if (!process.env[k]) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
  return process.env[k];
};

const supa = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"));
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${need("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
  },
});
const BUCKET_R2 = need("R2_BUCKET");
const BUCKET_SB = "checkin-photos";
const BATCH = Number(process.env.BATCH || 25);
const DRY = !!process.env.DRY_RUN;

async function main() {
  let moved = 0;
  let failed = 0;
  for (;;) {
    const { data: rows, error } = await supa
      .from("activity_photos")
      .select("id, orig_path, bytes")
      .eq("orig_store", "sb")
      .eq("kind", "photo")
      .order("id", { ascending: true })
      .limit(BATCH);
    if (error) throw error;
    if (!rows || rows.length === 0) break;

    for (const row of rows) {
      try {
        const { data: blob, error: dlErr } = await supa.storage
          .from(BUCKET_SB)
          .download(row.orig_path);
        if (dlErr || !blob) throw dlErr || new Error("download empty");
        const buf = Buffer.from(await blob.arrayBuffer());
        if (buf.length === 0) throw new Error("zero bytes");

        if (DRY) {
          console.log(`[dry] would move #${row.id} ${row.orig_path} (${buf.length}b)`);
          continue;
        }

        await r2.send(
          new PutObjectCommand({
            Bucket: BUCKET_R2,
            Key: row.orig_path, // same key — nothing else needs to change
            Body: buf,
            ContentType: blob.type || "image/jpeg",
          })
        );
        // Verify before flipping: the copy must exist and match.
        const head = await r2.send(
          new HeadObjectCommand({ Bucket: BUCKET_R2, Key: row.orig_path })
        );
        if (Number(head.ContentLength) !== buf.length) {
          throw new Error(`size mismatch: r2=${head.ContentLength} local=${buf.length}`);
        }

        const { error: upErr } = await supa
          .from("activity_photos")
          .update({ orig_store: "r2" })
          .eq("id", row.id)
          .eq("orig_store", "sb");
        if (upErr) throw upErr;
        moved++;
        console.log(`moved #${row.id} ${row.orig_path} (${buf.length}b)`);
      } catch (e) {
        failed++;
        console.error(`FAILED #${row.id} ${row.orig_path}: ${e.message}`);
      }
    }
    if (DRY) break; // one page is enough for a dry run report
  }
  console.log(`\nDone. moved=${moved} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
