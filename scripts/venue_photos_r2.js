// VENUE PHOTOS → PUBLIC R2 (Sep 5, 2026). The July 10 storage squeeze
// capped venue photos at 3 to stay inside Supabase's free plan; R2 killed
// that constraint. This script re-fetches every venue's Google Place
// Details, downloads up to MAX_PHOTOS photos at 800px, uploads them to the
// PUBLIC flanit-venues bucket, and updates image_cdn_urls (public R2 URLs),
// image_urls (keyless Google media URLs, provenance) and
// image_attributions. The app renders image_cdn_urls everywhere already —
// zero client changes.
//
// Resumable: venues whose image_cdn_urls already hold MAX_PHOTOS R2 URLs
// are skipped, so rerunning after any failure picks up where it left off.
//
// Run LOCALLY (per-run shell keys, nothing stored):
//   node scripts/venue_photos_r2.js
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_KEY,
//      R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
//      R2_VENUES_BUCKET (flanit-venues), R2_VENUES_PUBLIC_BASE (pub-….r2.dev)
// Optional: MAX_PHOTOS (default 10), MAX_WIDTH (default 800), DRY_RUN=1,
//           BATCH (default 20)
const { createClient } = require("@supabase/supabase-js");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const need = (k) => {
  if (!process.env[k]) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
  return process.env[k];
};

const supa = createClient(need("SUPABASE_URL"), need("SUPABASE_SERVICE_ROLE_KEY"));
const GOOGLE_KEY = need("GOOGLE_KEY");
const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${need("R2_ACCOUNT_ID")}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: need("R2_ACCESS_KEY_ID"),
    secretAccessKey: need("R2_SECRET_ACCESS_KEY"),
  },
});
const BUCKET = need("R2_VENUES_BUCKET");
const PUBLIC_BASE = need("R2_VENUES_PUBLIC_BASE").replace(/\/$/, "");
const MAX_PHOTOS = Number(process.env.MAX_PHOTOS || 10);
const MAX_WIDTH = Number(process.env.MAX_WIDTH || 800);
const BATCH = Number(process.env.BATCH || 20);
const DRY = !!process.env.DRY_RUN;

async function fetchPlacePhotos(placeId) {
  const id = placeId.startsWith("places/") ? placeId : `places/${placeId}`;
  const resp = await fetch(`https://places.googleapis.com/v1/${id}`, {
    headers: {
      "X-Goog-Api-Key": GOOGLE_KEY,
      "X-Goog-FieldMask": "photos",
    },
  });
  if (!resp.ok) throw new Error(`details HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.photos || []).slice(0, MAX_PHOTOS);
}

async function downloadPhoto(photoName) {
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${MAX_WIDTH}&key=${GOOGLE_KEY}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`media HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 1000) throw new Error("suspiciously small photo");
  return { buf, type: resp.headers.get("content-type") || "image/jpeg" };
}

function doneAlready(v) {
  const cdn = Array.isArray(v.image_cdn_urls) ? v.image_cdn_urls : [];
  return (
    cdn.length >= MAX_PHOTOS && cdn.every((u) => u.startsWith(PUBLIC_BASE))
  );
}

async function main() {
  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let lastId = 0;
  for (;;) {
    const { data: venues, error } = await supa
      .from("venues")
      .select("id, name, google_place_id, image_cdn_urls")
      .not("google_place_id", "is", null)
      .gt("id", lastId)
      .order("id", { ascending: true })
      .limit(BATCH);
    if (error) throw error;
    if (!venues || venues.length === 0) break;
    for (const v of venues) {
      lastId = v.id;
      if (doneAlready(v)) {
        skipped++;
        continue;
      }
      try {
        const photos = await fetchPlacePhotos(v.google_place_id);
        if (photos.length === 0) {
          console.log(`#${v.id} ${v.name}: no photos on Google`);
          skipped++;
          continue;
        }
        if (DRY) {
          console.log(`[dry] #${v.id} ${v.name}: would cache ${photos.length} photos`);
          continue;
        }
        const cdnUrls = [];
        const srcUrls = [];
        const attributions = [];
        for (let i = 0; i < photos.length; i++) {
          const { buf, type } = await downloadPhoto(photos[i].name);
          const key = `venues/${v.id}/${i}.jpg`;
          await r2.send(
            new PutObjectCommand({
              Bucket: BUCKET,
              Key: key,
              Body: buf,
              ContentType: type,
            })
          );
          cdnUrls.push(`${PUBLIC_BASE}/${key}`);
          srcUrls.push(`https://places.googleapis.com/v1/${photos[i].name}/media`);
          if (photos[i].authorAttributions?.length) {
            attributions.push(photos[i].authorAttributions);
          }
        }
        const { error: upErr } = await supa
          .from("venues")
          .update({
            image_cdn_urls: cdnUrls,
            image_urls: srcUrls,
            image_attributions: attributions,
            primary_image: cdnUrls[0] || null,
          })
          .eq("id", v.id);
        if (upErr) throw upErr;
        updated++;
        console.log(`#${v.id} ${v.name}: ${cdnUrls.length} photos → R2`);
      } catch (e) {
        failed++;
        console.error(`FAILED #${v.id} ${v.name}: ${e.message}`);
      }
    }
    if (DRY && updated + skipped + failed >= BATCH) break; // one page's report is enough
  }
  console.log(`\nDone. updated=${updated} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
