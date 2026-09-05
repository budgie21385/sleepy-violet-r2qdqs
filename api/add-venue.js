// Add-a-venue backend. One endpoint, three actions (POST JSON):
//   { action: "search",  q }        → Google Places Autocomplete suggestions
//   { action: "details", placeId }  → Place Details for the confirm card
//   { action: "add",     placeId }  → dedupe → insert enriched venue → save to list
//
// All actions require a signed-in user (Authorization: Bearer <supabase jwt>) —
// anon guests included, but no unauthenticated scraping of our Google quota.
// The insert runs with the service role (the venues table deliberately has no
// client INSERT policy) after validating the JWT, so `created_by` is always the
// real caller. Mirrors import_to_supabase.js's pipeline for a single place:
// dedupe by google_place_id, then match_venue_candidate; insert with
// cuisine_bucket derived from types; cache up to 3 photos to the CDN bucket;
// upsert saved_venues. New venues arrive with the full July 3 atmosphere set.
//
// Env (Vercel): GOOGLE_API_KEY, SUPABASE_SERVICE_ROLE_KEY, and the Supabase URL
// via REACT_APP_SUPABASE_URL (already set for api/share.js) or SUPABASE_URL.
import { createClient } from "@supabase/supabase-js";
import { deriveCuisineBucket } from "./_lib/cuisineBucket.js";
import { r2VenuesReady, r2PutPublic, R2_VENUES_PUBLIC_BASE } from "./_lib/r2.js";

const MAX_PHOTOS = 3; // matches Swipes/cacheVenuePhotos.js
const BUCKET = "venue-photos";

const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "formattedAddress",
  "location",
  "rating",
  "userRatingCount",
  "priceLevel",
  "primaryTypeDisplayName",
  "regularOpeningHours",
  "photos",
  "editorialSummary",
  "reviews",
  "priceRange",
  "googleMapsUri",
  "types",
  "servesBreakfast",
  "servesBrunch",
  "servesLunch",
  "servesDinner",
  "servesCoffee",
  "servesBeer",
  "servesWine",
  "servesCocktails",
  "servesDessert",
  "servesVegetarianFood",
  "outdoorSeating",
  "reservable",
  "goodForGroups",
  "goodForChildren",
  "allowsDogs",
  "liveMusic",
  "takeout",
  "delivery",
  "dineIn",
  "restroom",
  "menuForChildren",
].join(",");

function supabaseUrl() {
  return process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;
}

function serviceClient() {
  return createClient(supabaseUrl(), process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
}

async function requireUser(req, supabase) {
  const auth = req.headers.authorization || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!jwt) return null;
  const { data, error } = await supabase.auth.getUser(jwt);
  if (error || !data?.user) return null;
  return data.user;
}

async function autocomplete(q, key) {
  const resp = await fetch(
    "https://places.googleapis.com/v1/places:autocomplete",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key },
      body: JSON.stringify({
        input: q,
        includedRegionCodes: ["au"],
        // Bias toward Melbourne — matches the app's current single-city pool.
        locationBias: {
          circle: {
            center: { latitude: -37.8136, longitude: 144.9631 },
            radius: 50000,
          },
        },
      }),
    }
  );
  if (!resp.ok) throw new Error(`autocomplete HTTP ${resp.status}`);
  const json = await resp.json();
  return (json.suggestions || [])
    .map((s) => s.placePrediction)
    .filter(Boolean)
    .map((p) => ({
      place_id: p.placeId,
      name: p.structuredFormat?.mainText?.text || p.text?.text || "",
      address: p.structuredFormat?.secondaryText?.text || "",
    }));
}

async function fetchPlace(placeId, key) {
  const resp = await fetch(
    `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
    { headers: { "X-Goog-Api-Key": key, "X-Goog-FieldMask": DETAILS_FIELD_MASK } }
  );
  if (!resp.ok) throw new Error(`place details HTTP ${resp.status}`);
  return resp.json();
}

// Key-less Google photo media URL. The stored copy must never carry the key
// (the /api/place-photo proxy re-adds it at serve time).
function photoMediaUrl(photoName, maxWidthPx) {
  return `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidthPx}`;
}

// Card-friendly summary for the confirm step.
function placeToCard(place) {
  const photoName = place.photos?.[0]?.name || null;
  return {
    place_id: place.id,
    name: place.displayName?.text || "",
    address: place.formattedAddress || "",
    rating: place.rating ?? null,
    review_count: place.userRatingCount ?? null,
    price_level: place.priceLevel ?? null,
    cuisine: place.primaryTypeDisplayName?.text || "",
    open_now: place.regularOpeningHours?.openNow ?? null,
    // Proxied so the client never sees the key; proxy adds it.
    photo_url: photoName
      ? `/api/place-photo?url=${encodeURIComponent(photoMediaUrl(photoName, 800))}`
      : null,
  };
}

const b = (v) => (v === true ? true : v === false ? false : null);

function extractReviews(place) {
  return (place.reviews || []).slice(0, 5).map((r) => ({
    rating: r.rating ?? null,
    text: r.text?.text || r.originalText?.text || "",
    author: r.authorAttribution?.displayName || "",
    published: r.publishTime || "",
    relative: r.relativePublishTimeDescription || "",
  }));
}

function inferType(types) {
  if (!Array.isArray(types)) return "restaurant";
  if (types.includes("cafe") || types.includes("coffee_shop")) return "cafe";
  if (types.includes("bar") || types.includes("night_club")) return "bar";
  if (types.includes("bakery")) return "cafe";
  return "restaurant";
}

// Suburb from "123 Foo St, Suburb VIC 3000, Australia" — second-to-last chunk,
// state/postcode stripped.
function extractSuburb(address) {
  const parts = String(address || "").split(",").map((s) => s.trim());
  if (parts.length < 2) return "";
  const chunk = parts[parts.length - 2] || "";
  return chunk.replace(/\b(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\b/g, "").replace(/\d{4}/g, "").trim();
}

// Google periods → per-day "HH:MM-HH:MM" strings (comma-joined so the app's
// venueDayIntervals parser reads them directly).
function decomposeOpeningHours(regularOpeningHours) {
  const dayKey = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const out = {};
  for (const d of dayKey) out[`${d}_hours`] = null;
  const periods = regularOpeningHours?.periods;
  if (!Array.isArray(periods)) return out;
  const buckets = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  for (const p of periods) {
    const d = p?.open?.day;
    if (typeof d !== "number") continue;
    const oh = String(p.open.hour ?? 0).padStart(2, "0");
    const om = String(p.open.minute ?? 0).padStart(2, "0");
    const ch = p.close?.hour;
    const cm = p.close?.minute;
    const range =
      ch == null
        ? `${oh}:${om}-24:00`
        : `${oh}:${om}-${String(ch).padStart(2, "0")}:${String(cm ?? 0).padStart(2, "0")}`;
    buckets[d].push(range);
  }
  for (let d = 0; d < 7; d++) {
    if (buckets[d].length > 0) out[`${dayKey[d]}_hours`] = buckets[d].join(", ");
  }
  return out;
}

// Download up to MAX_PHOTOS photos and cache them publicly. R2 first
// (Sep 5 — the July 10 storage-squeeze cap died with the migration; up to
// 10 photos now), Supabase public bucket as the fallback while the R2
// venue env is unset. Non-blocking failures — a venue without CDN photos
// falls back to the proxy.
async function cachePhotos(supabase, key, venueId, photoNames) {
  const useR2 = r2VenuesReady();
  const cap = useR2 ? 10 : MAX_PHOTOS;
  const cdnUrls = [];
  for (let i = 0; i < Math.min(photoNames.length, cap); i++) {
    try {
      // 800px (July 25, derivatives pass): plenty for a max-w-sm card at
      // 2-3x DPR, and ~40% fewer bytes than the old 1000px pulls.
      const resp = await fetch(`${photoMediaUrl(photoNames[i], 800)}&key=${key}`);
      if (!resp.ok) continue;
      const buf = Buffer.from(await resp.arrayBuffer());
      const path = useR2 ? `venues/${venueId}/${i}.jpg` : `${venueId}/${i}.jpg`;
      if (useR2) {
        await r2PutPublic(path, buf, "image/jpeg");
        cdnUrls.push(`${R2_VENUES_PUBLIC_BASE}/${path}`);
      } else {
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(path, buf, { contentType: "image/jpeg", upsert: true });
        if (error) continue;
        const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
        if (data?.publicUrl) cdnUrls.push(data.publicUrl);
      }
    } catch {
      // skip this photo
    }
  }
  return cdnUrls;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.GOOGLE_API_KEY;
  if (!key || !process.env.SUPABASE_SERVICE_ROLE_KEY || !supabaseUrl()) {
    return res.status(500).json({ error: "Server not configured" });
  }

  try {
    const { action, q, placeId, save } = req.body || {};
    // save=false → "check in here" flow: the venue row is created (it must
    // exist for the check-in FK) but is NOT added to the user's list — going
    // somewhere and curating your map are different intents.
    const saveToList = save !== false;
    const supabase = serviceClient();

    const user = await requireUser(req, supabase);
    if (!user) return res.status(401).json({ error: "Sign in required" });

    if (action === "search") {
      if (!q || String(q).trim().length < 2) return res.json({ results: [] });
      const results = await autocomplete(String(q).trim(), key);
      return res.json({ results });
    }

    if (action === "details") {
      if (!placeId) return res.status(400).json({ error: "Missing placeId" });
      const place = await fetchPlace(placeId, key);
      return res.json({ card: placeToCard(place) });
    }

    if (action === "add") {
      if (!placeId) return res.status(400).json({ error: "Missing placeId" });

      // Dedupe 1: same Google place already in the pool.
      const { data: existing } = await supabase
        .from("venues")
        .select("*")
        .eq("google_place_id", placeId)
        .maybeSingle();
      if (existing) {
        if (saveToList) {
          await supabase.from("saved_venues").upsert(
            { user_id: user.id, venue_id: existing.id },
            { onConflict: "user_id,venue_id", ignoreDuplicates: true }
          );
        }
        return res.json({ venue: existing, existing: true });
      }

      const place = await fetchPlace(placeId, key);
      const name = place.displayName?.text || "";
      const lat = place.location?.latitude ?? null;
      const lng = place.location?.longitude ?? null;

      // Dedupe 2: name + location match (catches broadsheet rows that predate
      // google_place_id). On a hit, backfill the place id for next time.
      if (name && lat != null && lng != null) {
        const { data: matchData } = await supabase.rpc("match_venue_candidate", {
          p_name: name,
          p_lat: lat,
          p_lng: lng,
        });
        const match = matchData?.[0];
        if (match && (match.confidence === "exact" || match.confidence === "likely")) {
          await supabase
            .from("venues")
            .update({ google_place_id: placeId })
            .eq("id", match.venue_id)
            .or("google_place_id.is.null,google_place_id.eq.");
          if (saveToList) {
            await supabase.from("saved_venues").upsert(
              { user_id: user.id, venue_id: match.venue_id },
              { onConflict: "user_id,venue_id", ignoreDuplicates: true }
            );
          }
          const { data: matched } = await supabase
            .from("venues")
            .select("*")
            .eq("id", match.venue_id)
            .single();
          return res.json({ venue: matched, existing: true });
        }
      }

      // Insert the new venue — same shape as the importer + atmosphere columns.
      const photoNames = (place.photos || []).map((p) => p.name).filter(Boolean);
      const imageUrls = photoNames
        .slice(0, MAX_PHOTOS)
        .map((n) => photoMediaUrl(n, 1000));
      const row = {
        name,
        suburb: extractSuburb(place.formattedAddress),
        address: place.formattedAddress || "",
        latitude: lat,
        longitude: lng,
        rating: place.rating ?? null,
        review_count: place.userRatingCount ?? null,
        price_level: place.priceLevel ?? null,
        cuisine: place.primaryTypeDisplayName?.text || "",
        cuisine_bucket: deriveCuisineBucket(
          place.types,
          place.primaryTypeDisplayName?.text
        ),
        type: inferType(place.types),
        primary_image: imageUrls[0] || null,
        image_urls: imageUrls,
        image_attributions: [],
        google_place_id: placeId,
        source: "manual",
        created_by: user.id,
        verified: false,
        editorial_summary: place.editorialSummary?.text ?? null,
        reviews: extractReviews(place),
        price_range: place.priceRange ?? null,
        google_maps_uri: place.googleMapsUri ?? null,
        google_types: Array.isArray(place.types) ? place.types : [],
        serves_breakfast: b(place.servesBreakfast),
        serves_brunch: b(place.servesBrunch),
        serves_lunch: b(place.servesLunch),
        serves_dinner: b(place.servesDinner),
        serves_coffee: b(place.servesCoffee),
        serves_beer: b(place.servesBeer),
        serves_wine: b(place.servesWine),
        serves_cocktails: b(place.servesCocktails),
        serves_dessert: b(place.servesDessert),
        serves_vegetarian_food: b(place.servesVegetarianFood),
        outdoor_seating: b(place.outdoorSeating),
        reservable: b(place.reservable),
        good_for_groups: b(place.goodForGroups),
        good_for_children: b(place.goodForChildren),
        allows_dogs: b(place.allowsDogs),
        live_music: b(place.liveMusic),
        takeout: b(place.takeout),
        delivery: b(place.delivery),
        dine_in: b(place.dineIn),
        restroom: b(place.restroom),
        menu_for_children: b(place.menuForChildren),
        atmosphere_backfilled: true,
        ...decomposeOpeningHours(place.regularOpeningHours),
      };

      const { data: inserted, error: insErr } = await supabase
        .from("venues")
        .insert(row)
        .select("*")
        .single();
      if (insErr) throw insErr;

      // Cache photos to the CDN bucket; non-blocking.
      let venue = inserted;
      if (photoNames.length > 0) {
        const cdnUrls = await cachePhotos(supabase, key, inserted.id, photoNames);
        if (cdnUrls.length > 0) {
          const { data: updated } = await supabase
            .from("venues")
            .update({ image_cdn_urls: cdnUrls })
            .eq("id", inserted.id)
            .select("*")
            .single();
          if (updated) venue = updated;
        }
      }

      if (saveToList) {
        await supabase.from("saved_venues").upsert(
          { user_id: user.id, venue_id: venue.id },
          { onConflict: "user_id,venue_id", ignoreDuplicates: true }
        );
      }

      return res.json({ venue, existing: false });
    }

    return res.status(400).json({ error: "Unknown action" });
  } catch (e) {
    console.error("add-venue error:", e);
    return res.status(500).json({ error: "Something went wrong" });
  }
}
