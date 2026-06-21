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

export function venueMatchesAreas(venue, selectedAreas, radiusKm) {
  if (!selectedAreas || selectedAreas.length === 0) return true;
  const lat = Number(venue.latitude);
  const lng = Number(venue.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return selectedAreas.some(
    (area) => getDistanceKm(area.lat, area.lng, lat, lng) <= radiusKm
  );
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
  const price = Number(venue.price_level);
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
