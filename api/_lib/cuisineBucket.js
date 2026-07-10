// COPY of Swipes/cuisineBucket.js (source of truth) — keep in sync if the taxonomy
// changes. ESM export for the Vercel serverless runtime.
// Derive a clean `cuisine_bucket` from a Google Places venue's types[] array
// (falling back to primary_type_display). Mirrors the one-off backfill logic
// (gen_backfill.py + cuisine-taxonomy.xlsx) so new scrapes land clean without
// needing another backfill.
//
// Returns a bucket string, or null for venue FORMATS (cafe / bar / pub /
// bakery / dessert) and NON-FOOD — those have no cuisine and filter by `type`.
//
// Decisions baked in (per Mark): dish-styles (Pizza / BBQ / Burgers / Seafood /
// Steakhouse / Chicken) are their own buckets; regions stay split; BBQ splits by
// co-occurring origin (American BBQ, Korean BBQ, …); Deli → Sandwiches.
//
// Why types[] over primary_type_display: the specific national type is usually
// in types[] even when the primary label is generic ("Restaurant", "Takeout
// Restaurant"). e.g. types=[barbecue_restaurant, american_restaurant] →
// "American BBQ" even though primary said "Takeout Restaurant".

// Most-specific cuisine/dish types (snake_case) → bucket. Order = priority
// (national cuisines before dish-styles before the generic Asian fallback).
const TYPE_BUCKET = [
  // --- national / regional cuisines ---
  ["italian_restaurant", "Italian"],
  ["french_restaurant", "French"],
  ["greek_restaurant", "Greek"],
  ["spanish_restaurant", "Spanish"],
  ["mediterranean_restaurant", "Mediterranean"],
  ["lebanese_restaurant", "Lebanese"],
  ["turkish_restaurant", "Middle Eastern"],
  ["persian_restaurant", "Middle Eastern"],
  ["middle_eastern_restaurant", "Middle Eastern"],
  ["falafel_restaurant", "Middle Eastern"],
  ["mexican_restaurant", "Mexican"],
  ["taco_restaurant", "Mexican"],
  ["brazilian_restaurant", "Latin American"],
  ["latin_american_restaurant", "Latin American"],
  ["american_restaurant", "American"],
  ["diner", "American"],
  ["cantonese_restaurant", "Chinese"],
  ["dim_sum_restaurant", "Chinese"],
  ["hot_pot_restaurant", "Chinese"],
  ["dumpling_restaurant", "Chinese"],
  ["szechuan_restaurant", "Chinese"],
  ["chinese_restaurant", "Chinese"],
  ["ramen_restaurant", "Japanese"],
  ["sushi_restaurant", "Japanese"],
  ["tonkatsu_restaurant", "Japanese"],
  ["japanese_restaurant", "Japanese"],
  ["korean_restaurant", "Korean"],
  ["thai_restaurant", "Thai"],
  ["vietnamese_restaurant", "Vietnamese"],
  ["indonesian_restaurant", "Indonesian"],
  ["filipino_restaurant", "Filipino"],
  ["malaysian_restaurant", "Malaysian"],
  ["singaporean_restaurant", "Singaporean"],
  ["burmese_restaurant", "Burmese"],
  ["sri_lankan_restaurant", "Sri Lankan"],
  ["nepalese_restaurant", "Indian"],
  ["pakistani_restaurant", "Indian"],
  ["indian_restaurant", "Indian"],
  ["ethiopian_restaurant", "African"],
  ["african_restaurant", "African"],
  ["portuguese_restaurant", "European (other)"],
  ["polish_restaurant", "European (other)"],
  ["german_restaurant", "European (other)"],
  ["austrian_restaurant", "European (other)"],
  ["european_restaurant", "European (other)"],
  ["vegan_restaurant", "Vegetarian & Vegan"],
  ["vegetarian_restaurant", "Vegetarian & Vegan"],
  // Modern Australian — low priority (a more specific national type wins, e.g.
  // Doju is australian_restaurant + korean_restaurant → Korean).
  ["australian_restaurant", "Modern Australian"],
  ["bistro", "Modern Australian"],
  // --- dish-styles (their own chips) ---
  ["pizza_restaurant", "Pizza"],
  ["hamburger_restaurant", "Burgers"],
  ["steak_house", "Steakhouse"],
  ["seafood_restaurant", "Seafood"],
  ["oyster_bar_restaurant", "Seafood"],
  ["chicken_restaurant", "Chicken"],
  ["sandwich_shop", "Sandwiches"],
  ["bagel_shop", "Sandwiches"],
  ["deli", "Sandwiches"],
  ["bar_and_grill", "BBQ & Grill"],
  // --- generic Asian fallback (only after specific national types) ---
  ["asian_fusion_restaurant", "Asian (generic)"],
  ["asian_restaurant", "Asian (generic)"],
];

// barbecue_restaurant + co-occurring origin → split BBQ label.
const BBQ_ORIGIN = [
  ["american_restaurant", "American BBQ"],
  ["korean_restaurant", "Korean BBQ"],
  ["brazilian_restaurant", "Brazilian BBQ"],
  ["japanese_restaurant", "Japanese BBQ"],
  ["chinese_restaurant", "Chinese BBQ"],
];

// Fallback when types[] is missing/empty: map the display string. Only the
// cuisine/dish cases (formats/non-food → null anyway).
const DISPLAY_BUCKET = {
  "Italian Restaurant": "Italian",
  "Pizza Restaurant": "Pizza",
  "French Restaurant": "French",
  "Greek Restaurant": "Greek",
  "Spanish Restaurant": "Spanish",
  "Mediterranean Restaurant": "Mediterranean",
  "Lebanese Restaurant": "Lebanese",
  "Middle Eastern Restaurant": "Middle Eastern",
  "Falafel Restaurant": "Middle Eastern",
  "Mexican Restaurant": "Mexican",
  "Taco Restaurant": "Mexican",
  "Latin American Restaurant": "Latin American",
  "American Restaurant": "American",
  "Diner": "American",
  "Hamburger Restaurant": "Burgers",
  "Barbecue Restaurant": "BBQ & Grill",
  "Steak House": "Steakhouse",
  "Seafood Restaurant": "Seafood",
  "Oyster Bar Restaurant": "Seafood",
  "Chicken Restaurant": "Chicken",
  "Chinese Restaurant": "Chinese",
  "Cantonese Restaurant": "Chinese",
  "Dumpling Restaurant": "Chinese",
  "Hot Pot Restaurant": "Chinese",
  "Japanese Restaurant": "Japanese",
  "Ramen Restaurant": "Japanese",
  "Sushi Restaurant": "Japanese",
  "Tonkatsu Restaurant": "Japanese",
  "Korean Restaurant": "Korean",
  "Thai Restaurant": "Thai",
  "Vietnamese Restaurant": "Vietnamese",
  "Indonesian Restaurant": "Indonesian",
  "Filipino Restaurant": "Filipino",
  "Indian Restaurant": "Indian",
  "Sri Lankan Restaurant": "Sri Lankan",
  "Ethiopian Restaurant": "African",
  "European Restaurant": "European (other)",
  "Polish Restaurant": "European (other)",
  "Australian Restaurant": "Modern Australian",
  "Bistro": "Modern Australian",
  "Vegan Restaurant": "Vegetarian & Vegan",
  "Vegetarian Restaurant": "Vegetarian & Vegan",
  "Sandwich Shop": "Sandwiches",
  "Bagel Shop": "Sandwiches",
  "Asian Restaurant": "Asian (generic)",
  "Asian Fusion Restaurant": "Asian (generic)",
};

function deriveCuisineBucket(types, primaryTypeDisplay) {
  const set = new Set(Array.isArray(types) ? types : []);

  // BBQ split by co-occurring origin.
  if (set.has("barbecue_restaurant")) {
    for (const [t, label] of BBQ_ORIGIN) if (set.has(t)) return label;
    return "BBQ & Grill";
  }

  // Most-specific cuisine/dish from types[].
  for (const [t, bucket] of TYPE_BUCKET) if (set.has(t)) return bucket;

  // Fallback to the display string when types[] carried nothing specific.
  if (primaryTypeDisplay && DISPLAY_BUCKET[primaryTypeDisplay]) {
    return DISPLAY_BUCKET[primaryTypeDisplay];
  }

  // Format (cafe/bar/pub/bakery…), non-food, or generic "Restaurant" → no
  // cuisine bucket. These filter by `type`, not cuisine.
  return null;
}

export { deriveCuisineBucket };
