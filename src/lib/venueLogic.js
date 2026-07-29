// Pure venue logic — no React, no Leaflet. Extracted from App.js so the data
// rules (opening hours, distance, vibe matching, emoji) live in one testable
// place. App.js imports what it needs from here.

export const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export const TIME_BANDS = [
  { key: "Morning", start: 6 * 60, end: 11 * 60 },
  { key: "Lunch", start: 11 * 60, end: 14 * 60 + 30 },
  { key: "Afternoon", start: 14 * 60 + 30, end: 17 * 60 },
  { key: "Dinner", start: 17 * 60, end: 22 * 60 },
  { key: "Late night", start: 22 * 60, end: 2 * 60 },
];

export const TIME_BAND_LABELS = TIME_BANDS.map((b) => b.key);

export const VIBE_OPTIONS = [
  "Coffee",
  "Breakfast",
  "Pastry",
  "Sit down meal",
  "Drinks",
  "Afternoon drinks",
  "Cocktails",
  "Wine bar",
  "Pub",
  "Quick bite",
  "Dessert",
  "Date",
];

export const MELBOURNE_CENTER = [-37.8136, 144.9631];
export const MELBOURNE_ZOOM = 12;

export const VIBE_EMOJI_PRIORITY = [
  ["Coffee", "☕"],
  ["Pastry", "🥐"],
  ["Breakfast", "🥞"],
  ["Wine bar", "🍷"],
  ["Cocktails", "🍸"],
  ["Pub", "🍺"],
  ["Dessert", "🍦"],
  ["Date", "🌹"],
  ["Sit down meal", "🍴"],
  ["Drinks", "🍻"],
  ["Quick bite", "🥪"],
  ["Afternoon drinks", "🍻"],
];

export function getVenueEmoji(venue) {
  const todayKey = getTodayDayKey();
  for (const [vibe, emoji] of VIBE_EMOJI_PRIORITY) {
    if (venueMatchesVibe(venue, vibe, todayKey)) return emoji;
  }
  return "📍";
}

// SUBURBS, NOT CIRCLES (July 25, Mark's model — revised same day).
//
// v1 used the suburb's FURTHEST venue as a radius, so a single mislabelled
// row inflated the circle and "Melbourne" swallowed Fitzroy (~2km away).
// Now:
//   radius 0 (default) → EXACT suburb-name match. No geometry, no bleed.
//   radius > 0        → also anything inside the suburb's bounding box,
//                       expanded by that many km — a real "past the border"
//                       without one stray row moving the border.
// A suburb with no venues of its own falls back to a circle around its
// centre so a radius still does something.
export function buildAreaExtents(venues, selectedAreas) {
  const extents = new Map();
  for (const area of selectedAreas || []) {
    const key = (area.name || "").trim().toLowerCase();
    if (!key || extents.has(key)) continue;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    let n = 0;
    for (const v of venues || []) {
      if ((v.suburb || "").trim().toLowerCase() !== key) continue;
      const lat = Number(v.latitude);
      const lng = Number(v.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      // Ignore rows sitting absurdly far from the area centre — they're
      // mislabelled, and they'd drag the box across half the city.
      if (getDistanceKm(area.lat, area.lng, lat, lng) > 8) continue;
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng);
      maxLng = Math.max(maxLng, lng);
      n++;
    }
    extents.set(key, n > 0 ? { minLat, maxLat, minLng, maxLng } : null);
  }
  return extents;
}

export function venueMatchesAreas(venue, selectedAreas, radiusKm = 0, extents = null) {
  if (!selectedAreas || selectedAreas.length === 0) return true;
  const vSuburb = (venue.suburb || "").trim().toLowerCase();
  const lat = Number(venue.latitude);
  const lng = Number(venue.longitude);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  const extra = Number(radiusKm) || 0;

  for (const area of selectedAreas) {
    const key = (area.name || "").trim().toLowerCase();
    // The suburb itself — the whole point of picking a suburb.
    if (vSuburb && vSuburb === key) return true;
    if (extra <= 0 || !hasCoords) continue; // radius 0 = name match only

    const box = extents?.get(key);
    if (box) {
      const dLat = extra / 111;
      const dLng =
        extra / (111 * Math.max(0.2, Math.cos((area.lat * Math.PI) / 180)));
      if (
        lat >= box.minLat - dLat &&
        lat <= box.maxLat + dLat &&
        lng >= box.minLng - dLng &&
        lng <= box.maxLng + dLng
      )
        return true;
    } else if (getDistanceKm(area.lat, area.lng, lat, lng) <= extra) {
      return true; // no venues to trace the suburb — circle from its centre
    }
  }
  return false;
}

export function getMapsUrl(venue) {
  if (venue.maps_url) return venue.maps_url;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${venue.name || ""} ${venue.address || ""}`.trim()
  )}`;
}

export function getDistanceKm(lat1, lng1, lat2, lng2) {
  const earthRadiusKm = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusKm * c;
}

export function getTodayDayKey() {
  return DAY_KEYS[new Date().getDay()];
}

export function getYesterdayDayKey() {
  return DAY_KEYS[(new Date().getDay() + 6) % 7];
}

export function timeStringToMinutes(value) {
  if (!value) return NaN;
  const trimmed = String(value).trim();
  const [h, m] = trimmed.split(":").map((part) => Number(part));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}

export function expandRange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  if (end > start) return [{ start, end }];
  if (end === start) return [];
  return [
    { start, end: 1440 },
    { start: 0, end },
  ];
}

export function venueDayIntervals(venue, dayKey) {
  if (!venue || !dayKey) return [];
  const value = venue[`${dayKey}_hours`];
  if (!value || typeof value !== "string") return [];
  const lower = value.toLowerCase();
  if (lower.includes("closed") || lower.includes("unavailable")) return [];
  const out = [];
  for (const part of value.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const [s, e] = piece.split("-").map((t) => (t || "").trim());
    const start = timeStringToMinutes(s);
    const end = timeStringToMinutes(e);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    out.push(...expandRange(start, end));
  }
  return out;
}

export function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

export function venueOpenInBand(venue, dayKey, band) {
  const venueIntervals = venueDayIntervals(venue, dayKey);
  if (venueIntervals.length === 0) return false;
  const bandIntervals = expandRange(band.start, band.end);
  return venueIntervals.some((vi) =>
    bandIntervals.some((bi) => intervalsOverlap(vi, bi))
  );
}

export function isVenueOpenNow(venue) {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const todayKey = DAY_KEYS[now.getDay()];
  const todayIntervals = venueDayIntervals(venue, todayKey);
  if (todayIntervals.some((r) => minutes >= r.start && minutes < r.end)) {
    return true;
  }
  const yesterdayKey = getYesterdayDayKey();
  const yesterdayValue = venue[`${yesterdayKey}_hours`];
  if (!yesterdayValue || typeof yesterdayValue !== "string") return false;
  for (const part of yesterdayValue.split(",")) {
    const [s, e] = part.trim().split("-").map((t) => (t || "").trim());
    const start = timeStringToMinutes(s);
    const end = timeStringToMinutes(e);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (end < start && minutes >= 0 && minutes < end) return true;
  }
  return false;
}

export function venueMatchesVibe(venue, vibe, dayKey) {
  const type = (venue.type || "").toLowerCase();
  const cuisine = (venue.cuisine || "").toLowerCase();
  const name = (venue.name || "").toLowerCase();
  const price = priceLevelNumber(venue) ?? NaN;
  const rating = Number(venue.rating);
  const isCafe = type.includes("cafe") || type.includes("coffee");
  const isBar = type.includes("bar") || type.includes("pub");
  const isRestaurant = type.includes("restaurant");
  const afternoonBand = TIME_BANDS.find((b) => b.key === "Afternoon");
  const lateBand = TIME_BANDS.find((b) => b.key === "Late night");
  const hasFiniteRating = Number.isFinite(rating);
  const hasFinitePrice = Number.isFinite(price);

  switch (vibe) {
    case "Coffee":
      return isCafe;
    case "Breakfast":
      return (
        isCafe ||
        cuisine.includes("breakfast") ||
        cuisine.includes("brunch")
      );
    case "Pastry":
      return (
        cuisine.includes("bakery") ||
        cuisine.includes("pastry") ||
        cuisine.includes("patisserie") ||
        name.includes("bakery") ||
        name.includes("patisserie")
      );
    case "Sit down meal":
      return isRestaurant || type.includes("pub");
    case "Pub": {
      if (type.includes("pub")) return true;
      if (name.includes("tavern") || name.includes("public house")) return true;
      const trimmedName = name.trim();
      const endsWithHotel =
        trimmedName.endsWith(" hotel") ||
        trimmedName.endsWith("hotel"); // covers single-word names
      if (endsWithHotel) return isBar || isRestaurant;
      return false;
    }
    case "Drinks":
      return isBar || cuisine.includes("wine");
    case "Afternoon drinks":
      return (
        isBar &&
        (afternoonBand ? venueOpenInBand(venue, dayKey, afternoonBand) : true)
      );
    case "Cocktails":
      return (
        type.includes("cocktail") ||
        name.includes("cocktail") ||
        cuisine.includes("cocktail")
      );
    case "Wine bar":
      return (
        name.includes("wine bar") ||
        cuisine.includes("wine bar") ||
        type.includes("wine")
      );
    case "Quick bite":
      return hasFinitePrice && price <= 2 && !type.includes("fine");
    case "Dessert":
      return (
        cuisine.includes("dessert") ||
        cuisine.includes("ice cream") ||
        cuisine.includes("gelato")
      );
    case "Date":
      return (
        isRestaurant &&
        hasFiniteRating &&
        rating >= 4.3 &&
        hasFinitePrice &&
        price >= 2
      );
    default:
      return false;
  }
}

// --- Price level -------------------------------------------------------------
// price_level is stored inconsistently: mostly Google's Places-API-New enum
// strings (PRICE_LEVEL_MODERATE, …), plus a handful of legacy 1-4 numbers.
// Normalise both to a 1..4 number (or null). This is what the price filter and
// the card $-symbols read — using Number() directly (as the old map filter did)
// silently NaN'd on every enum-string row, i.e. almost all of them.
const PRICE_LEVEL_MAP = {
  PRICE_LEVEL_INEXPENSIVE: 1,
  PRICE_LEVEL_MODERATE: 2,
  PRICE_LEVEL_EXPENSIVE: 3,
  PRICE_LEVEL_VERY_EXPENSIVE: 4,
};

export function priceLevelNumber(venue) {
  const raw = venue?.price_level;
  if (raw == null || raw === "") return null;
  if (PRICE_LEVEL_MAP[raw]) return PRICE_LEVEL_MAP[raw];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 4 ? n : null;
}

// "$" / "$$" / "$$$" / "$$$$" — empty string when unknown (caller hides it).
export function formatPriceSymbols(venue) {
  const lvl = priceLevelNumber(venue);
  return lvl ? "$".repeat(lvl) : "";
}

export function venueMatchesPrice(venue, selectedPrices) {
  if (!selectedPrices || selectedPrices.length === 0) return true;
  const lvl = priceLevelNumber(venue);
  return lvl != null && selectedPrices.includes(lvl);
}

// --- Amenities (Google attribute booleans) -----------------------------------
// Filterable amenity set — `key` is the venues column. Shared by the map filter
// panel, the matches/session setup, and the amenity-matching helper. AND
// semantics: a venue must have every selected amenity true.
export const AMENITY_FILTERS = [
  { key: "outdoor_seating", label: "Outdoor seating" },
  { key: "live_music", label: "Live music" },
  { key: "allows_dogs", label: "Dog-friendly" },
  { key: "good_for_groups", label: "Good for groups" },
  { key: "reservable", label: "Reservable" },
  { key: "takeout", label: "Takeaway" },
  { key: "delivery", label: "Delivery" },
  { key: "serves_vegetarian_food", label: "Vegetarian" },
];

export function venueMatchesAmenities(venue, selectedAmenities) {
  if (!selectedAmenities || selectedAmenities.length === 0) return true;
  return selectedAmenities.every((key) => venue?.[key] === true);
}

// --- Occasions ("What are you after?") ---------------------------------------
// The merged Vibe + drink-amenity facet (July 9, 2026 setup redesign — see
// Swipes/04-next.md). Replaces VIBE_OPTIONS on the session setup screen.
// OR semantics across selected occasions, like the old vibe filter.
//
// Three tiers of signal:
//   1. Fact-backed — the July 3 atmosphere data (google_types[] + serves_*
//      booleans). A raw boolean alone over-matches (nearly every restaurant
//      serves_wine), so drink occasions require bar-ish context too.
//   2. Hybrid — facts plus an hours check (Afternoon drinks).
//   3. Judgment — Date night / Sit-down meal / Quick bite stay on the old
//      venueMatchesVibe heuristics (Vibe-v2 LLM pass later).
// Venues without atmosphere data (older user imports) fall back to the old
// heuristics so they don't vanish from filters.

export const OCCASION_OPTIONS = [
  "Coffee",
  "Breakfast",
  "Pastry",
  "Dessert",
  "Cocktails",
  "Wine",
  "Afternoon drinks",
  "Pub",
  "Date night",
  "Sit-down meal",
  "Quick bite",
];

function venueGoogleTypes(venue) {
  return Array.isArray(venue?.google_types) ? venue.google_types : [];
}

function hasType(venue, ...wanted) {
  const types = venueGoogleTypes(venue);
  return wanted.some((t) => types.includes(t));
}

function hasAtmosphereData(venue) {
  return venueGoogleTypes(venue).length > 0;
}

export function venueMatchesOccasion(venue, occasion, dayKey) {
  const facts = hasAtmosphereData(venue);
  const barish =
    hasType(venue, "bar", "pub", "wine_bar", "night_club") ||
    (venue?.type || "").toLowerCase().includes("bar") ||
    (venue?.type || "").toLowerCase().includes("pub");

  switch (occasion) {
    case "Coffee":
      return facts
        ? hasType(venue, "cafe", "coffee_shop") && venue.serves_coffee !== false
        : venueMatchesVibe(venue, "Coffee", dayKey);
    case "Breakfast":
      return facts
        ? venue.serves_breakfast === true ||
            venue.serves_brunch === true ||
            hasType(venue, "breakfast_restaurant", "brunch_restaurant")
        : venueMatchesVibe(venue, "Breakfast", dayKey);
    case "Pastry":
      return (
        hasType(venue, "bakery") || venueMatchesVibe(venue, "Pastry", dayKey)
      );
    case "Dessert":
      return facts
        ? hasType(
            venue,
            "dessert_shop",
            "dessert_restaurant",
            "ice_cream_shop",
            "chocolate_shop"
          ) ||
            (venue.serves_dessert === true && hasType(venue, "cafe", "bakery"))
        : venueMatchesVibe(venue, "Dessert", dayKey);
    case "Cocktails":
      return facts
        ? venue.serves_cocktails === true &&
            (barish || venueMatchesVibe(venue, "Cocktails", dayKey))
        : venueMatchesVibe(venue, "Cocktails", dayKey);
    case "Wine":
      return facts
        ? hasType(venue, "wine_bar") ||
            (venue.serves_wine === true && barish) ||
            venueMatchesVibe(venue, "Wine bar", dayKey)
        : venueMatchesVibe(venue, "Wine bar", dayKey);
    case "Afternoon drinks": {
      const drinky = facts
        ? barish ||
          venue.serves_cocktails === true ||
          venue.serves_wine === true
        : venueMatchesVibe(venue, "Drinks", dayKey);
      const afternoonBand = TIME_BANDS.find((b) => b.key === "Afternoon");
      return (
        drinky &&
        (afternoonBand ? venueOpenInBand(venue, dayKey, afternoonBand) : true)
      );
    }
    case "Pub":
      return hasType(venue, "pub") || venueMatchesVibe(venue, "Pub", dayKey);
    case "Date night":
      return venueMatchesVibe(venue, "Date", dayKey);
    case "Sit-down meal":
      if (venue?.dine_in === false) return false;
      return venueMatchesVibe(venue, "Sit down meal", dayKey);
    case "Quick bite":
      return venueMatchesVibe(venue, "Quick bite", dayKey);
    default:
      return false;
  }
}

export function venueMatchesOccasions(venue, selectedOccasions, dayKey) {
  if (!selectedOccasions || selectedOccasions.length === 0) return true;
  return selectedOccasions.some((o) => venueMatchesOccasion(venue, o, dayKey));
}
