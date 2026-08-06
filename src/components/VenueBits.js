// The venue card and its presentational pieces. Props-only components extracted
// from App.js; used by the swipe card (VenueCard) and the map sheet.
import { useState, useEffect } from "react";
import {
  MapPin,
  ExternalLink,
  Trees,
  Martini,
  Wine,
  Music,
  Dog,
  Users,
  CalendarCheck,
} from "lucide-react";
import {
  getTodayDayKey,
  VIBE_OPTIONS,
  venueMatchesVibe,
  getMapsUrl,
  formatPriceSymbols,
} from "../lib/venueLogic";
import { useVenueDetails } from "../lib/venueDetails";

// BEEN PILL (July 31, design A/F). Lives beside the rating badge, borrowing
// its exact pill language so it reads as native. Three states:
//   not been    → dark glass "✕ Not been" (quiet — the default shouldn't shout)
//   been        → solid olive "Been" / "Been ×N" (N = real check-in visits)
//   no viewer   → nothing (anon /v/ readers, guest decks)
// `onToggle` present = tappable (the card); absent = display-only (the swipe
// deck passes a ONE-WAY handler instead — see App.js).
export function BeenPill({ been, visitCount, onToggle }) {
  const label = visitCount >= 2 ? `Been ×${visitCount}` : "Been";
  const cls = been
    ? "bg-[#455d3b] text-white"
    : "bg-black/50 backdrop-blur text-white/85";
  const body = been ? (
    <>✓ {label}</>
  ) : (
    <>✕ Not been</>
  );
  if (!onToggle) {
    // Display-only: absence IS the not-been state (a "Not been" badge on
    // every unfamiliar deck card would label the majority case).
    return been ? (
      <span className={`rounded-full px-3 py-1 text-xs ${cls}`}>{body}</span>
    ) : null;
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation(); // the hero tap advances the carousel
        onToggle();
      }}
      className={`rounded-full px-3 py-1 text-xs active:scale-95 transition ${cls}`}
    >
      {body}
    </button>
  );
}

export function VenueHeroCarousel({ venue, disableSwipe = false, beenPill = null }) {
  // Prefer CDN-cached photos (fast — served from Supabase Storage). Fall back to
  // the live /api/place-photo Google proxy for venues not cached yet.
  const cdn = venue?.image_cdn_urls;
  const usingCdn = Array.isArray(cdn) && cdn.length > 0;
  const images = usingCdn
    ? cdn
    : venue?.image_urls?.length
      ? venue.image_urls
      : venue?.primary_image
        ? [venue.primary_image]
        : [];
  const photoSrc = (u) =>
    usingCdn ? u : `/api/place-photo?url=${encodeURIComponent(u)}`;
  // image_attributions is a parallel array to image_urls. Each entry is
  // either null (no attribution) or an array of authorAttributions
  // objects ({displayName, uri, photoUri}) — same shape as Places API.
  // Google Places ToS requires displaying these alongside the image.
  const attributions = venue?.image_attributions || [];
  const [imageIndex, setImageIndex] = useState(0);
  const [isFading, setIsFading] = useState(false);
  const [touchStartX, setTouchStartX] = useState(null);
  const [touchEndX, setTouchEndX] = useState(null);
  function handleTouchStart(e) {
    setTouchStartX(e.targetTouches[0].clientX);
  }
  function handleTouchMove(e) {
    setTouchEndX(e.targetTouches[0].clientX);
  }
  function handleTouchEnd() {
    if (touchStartX === null || touchEndX === null) return;
    const distance = touchStartX - touchEndX;
    if (distance > 50) {
      nextImage({ stopPropagation: () => {} });
    }
    if (distance < -50) {
      previousImage({ stopPropagation: () => {} });
    }
    setTouchStartX(null);
    setTouchEndX(null);
  }
  // Warm the browser cache for every photo of this venue up front so flipping
  // the carousel is instant (the proxy + CDN cache the bytes; this just kicks
  // the fetches off ahead of the user tapping ›).
  useEffect(() => {
    if (images.length <= 1) return;
    images.forEach((u) => {
      const img = new Image();
      img.src = photoSrc(u);
    });
  }, [venue?.id]);

  if (!images.length) return null;
  const currentImage = images[imageIndex];
  function changeImage(direction, e) {
    e.stopPropagation();
    if (images.length <= 1 || isFading) return;
    setIsFading(true);
    setTimeout(() => {
      setImageIndex((current) => {
        if (direction === "next") {
          return current === images.length - 1 ? 0 : current + 1;
        }
        return current === 0 ? images.length - 1 : current - 1;
      });
      setIsFading(false);
    }, 150);
  }
  function nextImage(e) {
    changeImage("next", e);
  }
  function previousImage(e) {
    changeImage("previous", e);
  }
  // Tapping the photo advances to the next one — works on every venue card
  // (map, session, results, share page). On the map card swipe is reserved for
  // venue navigation, so tap is the only way to change photos there; elsewhere
  // it works alongside the arrows + swipe.
  function handleHeroTap() {
    if (images.length > 1) {
      nextImage({ stopPropagation: () => {} });
    }
  }
  return (
    <div
      className="relative mb-6 h-[320px] overflow-hidden rounded-[1.75rem] bg-neutral-100"
      onTouchStart={disableSwipe ? undefined : handleTouchStart}
      onTouchMove={disableSwipe ? undefined : handleTouchMove}
      onTouchEnd={disableSwipe ? undefined : handleTouchEnd}
      onClick={handleHeroTap}
    >
      <img
        key={currentImage}
        src={photoSrc(currentImage)}
        alt={venue.name}
        className={`h-full w-full object-cover transition-opacity duration-300 ease-in-out ${
          isFading ? "opacity-0" : "opacity-100"
        }`}
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />
      <div className="absolute left-4 top-4 flex items-center gap-1.5">
        <div className="rounded-full bg-black/50 backdrop-blur px-3 py-1 text-xs text-white">
          ⭐ {venue.rating}
        </div>
        {beenPill}
      </div>
      {images.length > 1 && (
        <>
          <button
            type="button"
            onClick={previousImage}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-white/50 text-3xl font-light leading-none hover:text-white/80 transition"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={nextImage}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/50 text-3xl font-light leading-none hover:text-white/80 transition"
          >
            ›
          </button>
          <div className="absolute right-4 top-4 rounded-full bg-black/50 backdrop-blur px-3 py-1 text-xs text-white">
            {imageIndex + 1} / {images.length}
          </div>
        </>
      )}
      {/* Google Places ToS — attribution for the currently-shown image. */}
      <PhotoAttribution attribution={attributions[imageIndex]} />
      <div className="absolute bottom-0 left-0 right-0 p-5 text-white [text-shadow:0_2px_8px_rgba(0,0,0,0.6)]">
        <p className="text-sm text-white/80 mb-1">{venue.type}</p>
        <h2 className="text-[28px] font-semibold leading-tight mb-1">
          {venue.name}
        </h2>
       <div className="flex items-center gap-2 text-sm text-white/90">
          <MapPin size={14} className="opacity-80 shrink-0" />
          <span className="truncate">{venue.suburb}</span>
        </div>
      </div>
    </div>
  );
}

// Renders a small "Photo: <name>" overlay on a hero image. attribution
// can be: null/undefined (hidden), an array of {displayName, uri} objects
// (first one rendered), or already a single string (legacy). Linkified
// when uri is present per Places ToS recommendation.
function PhotoAttribution({ attribution }) {
  if (!attribution) return null;
  // attribution may be an array (modern Places shape) or a single object
  // (defensive). Pick the first author.
  const author = Array.isArray(attribution) ? attribution[0] : attribution;
  if (!author) return null;
  const name = typeof author === "string" ? author : author.displayName;
  if (!name) return null;
  const uri = typeof author === "object" ? author.uri : null;
  const cls =
    "absolute right-3 bottom-24 text-[10px] text-white/70 [text-shadow:0_1px_2px_rgba(0,0,0,0.8)] pointer-events-auto";
  const inner = `Photo: ${name}`;
  if (uri) {
    return (
      <a
        href={uri}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
        className={`${cls} hover:text-white/90 underline-offset-2 hover:underline`}
      >
        {inner}
      </a>
    );
  }
  return <span className={cls}>{inner}</span>;
}

export function VenueRating({ venue }) {
  const price = formatPriceSymbols(venue);
  if (!venue.rating && !venue.review_count && !price) return null;
  return (
    <p className="mt-4 text-sm font-medium text-neutral-700">
      ⭐ {venue.rating || "No rating"}
      {venue.review_count
        ? ` · ${venue.review_count} ${
            Number(venue.review_count) === 1 ? "review" : "reviews"
          }`
        : ""}
      {price ? <span className="text-[#2f6f3b]">{` · ${price}`}</span> : ""}
    </p>
  );
}

// Google's one-line editorial description, shown under the rating. Hidden when
// the venue has no summary (~70% of venues).
export function VenueEditorial({ venue }) {
  const text = (venue.editorial_summary || "").trim();
  if (!text) return null;
  return <p className="text-sm italic leading-6 text-neutral-600">{text}</p>;
}

// Outlined amenity badges — the experiential attributes only (the mundane ones
// like restroom/takeaway live in the filters, not here). Shows only the ones
// that are true; capped so the row never sprawls.
const AMENITY_BADGES = [
  { key: "outdoor_seating", label: "Outdoor seating", Icon: Trees },
  { key: "serves_cocktails", label: "Cocktails", Icon: Martini },
  { key: "serves_wine", label: "Wine", Icon: Wine },
  { key: "live_music", label: "Live music", Icon: Music },
  { key: "allows_dogs", label: "Dog-friendly", Icon: Dog },
  { key: "good_for_groups", label: "Good for groups", Icon: Users },
  { key: "reservable", label: "Reservable", Icon: CalendarCheck },
];

export function VenueAmenities({ venue, max = 6 }) {
  const active = AMENITY_BADGES.filter((a) => venue[a.key] === true).slice(0, max);
  if (active.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {active.map(({ key, label, Icon }) => (
        <span
          key={key}
          className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700"
        >
          <Icon size={13} className="shrink-0 text-[#5a7a4c]" />
          {label}
        </span>
      ))}
    </div>
  );
}

// Snippet of the top Google review. reviews is a jsonb array of
// {rating, text, author, published, relative}; supabase-js returns it parsed,
// but guard for a stringified value just in case.
export function VenueReview({ venue }) {
  let reviews = venue.reviews;
  if (typeof reviews === "string") {
    try {
      reviews = JSON.parse(reviews);
    } catch {
      reviews = [];
    }
  }
  if (!Array.isArray(reviews)) return null;
  const r = reviews.find((x) => x && String(x.text || "").trim());
  if (!r) return null;
  const text = String(r.text).trim();
  const snippet = text.length > 180 ? `${text.slice(0, 180).trimEnd()}…` : text;
  const stars = Number(r.rating);
  return (
    <div className="rounded-2xl bg-neutral-50 px-4 py-3">
      {Number.isFinite(stars) && stars > 0 ? (
        <p className="mb-1 text-xs text-amber-500">
          {"★".repeat(Math.round(stars))}
        </p>
      ) : null}
      <p className="text-sm leading-6 text-neutral-600">“{snippet}”</p>
      {r.author || r.relative ? (
        <p className="mt-1 text-xs text-neutral-400">
          {r.author}
          {r.author && r.relative ? " · " : ""}
          {r.relative}
        </p>
      ) : null}
    </div>
  );
}

export function VenueVibes({ venue }) {
  const todayKey = getTodayDayKey();
  const vibes = VIBE_OPTIONS.filter((v) => venueMatchesVibe(venue, v, todayKey));
  if (vibes.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {vibes.map((v) => (
        <span
          key={v}
          className="rounded-full bg-[#edf2eb] px-2.5 py-1 text-xs font-medium text-[#455d3b] border border-[#c5d4c2]"
        >
          {v}
        </span>
      ))}
    </div>
  );
}

// "08:45" → minutes since midnight (525). Returns null if unparseable.
function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec((s || "").trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}
// minutes → "8:45am" / "10pm" (drops ":00"). 1440 (24:00) → "12am".
function minTo12h(min) {
  if (min == null) return "";
  const h = Math.floor(min / 60) % 24;
  const mm = min % 60;
  const ampm = h < 12 ? "am" : "pm";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === 0 ? `${h12}${ampm}` : `${h12}:${String(mm).padStart(2, "0")}${ampm}`;
}
// "08:45-15:30 · 18:00-22:00" → "8:45am–3:30pm · 6pm–10pm".
function formatDayValue(value) {
  if (!value) return null;
  return value
    .split("·")
    .map((r) => {
      const [a, b] = r.split("-").map((x) => x.trim());
      const o = hhmmToMin(a);
      const c = hhmmToMin(b);
      if (o == null || c == null) return r.trim();
      return `${minTo12h(o)}–${minTo12h(c)}`;
    })
    .join(" · ");
}
function parseRanges(value) {
  if (!value) return [];
  return value
    .split("·")
    .map((r) => {
      const [a, b] = r.split("-").map((x) => x.trim());
      const o = hhmmToMin(a);
      const c = hhmmToMin(b);
      return o == null || c == null ? null : [o, c];
    })
    .filter(Boolean);
}
// Open/closed status for today's value relative to `nowMin`. Handles ranges
// that wrap past midnight (close <= open).
function computeStatus(value, nowMin) {
  const ranges = parseRanges(value);
  if (!ranges.length) return { closedToday: true };
  for (const [o, c] of ranges) {
    const within = c > o ? nowMin >= o && nowMin < c : nowMin >= o || nowMin < c;
    if (within) return { open: true, until: c };
  }
  const upcoming = ranges
    .map(([o]) => o)
    .filter((o) => o > nowMin)
    .sort((a, b) => a - b);
  return { open: false, next: upcoming.length ? upcoming[0] : null };
}

export function OpeningHours({ venue }) {
  const [isOpen, setIsOpen] = useState(false);
  const days = [
    { label: "Mon", value: venue.monday_hours },
    { label: "Tue", value: venue.tuesday_hours },
    { label: "Wed", value: venue.wednesday_hours },
    { label: "Thu", value: venue.thursday_hours },
    { label: "Fri", value: venue.friday_hours },
    { label: "Sat", value: venue.saturday_hours },
    { label: "Sun", value: venue.sunday_hours },
  ];
  // Hide the whole section when we have no hours at all for any day.
  if (!days.some((d) => d.value)) return null;

  const todayIndex = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
  const today = days[todayIndex];
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const status = computeStatus(today.value, nowMin);

  let statusLabel;
  let statusClass;
  if (status.open) {
    statusLabel = `Open · Closes ${minTo12h(status.until)}`;
    statusClass = "text-[#2f6f3b]";
  } else if (status.closedToday) {
    statusLabel = "Closed today";
    statusClass = "text-neutral-500";
  } else if (status.next != null) {
    statusLabel = `Closed · Opens ${minTo12h(status.next)}`;
    statusClass = "text-neutral-500";
  } else {
    statusLabel = "Closed";
    statusClass = "text-neutral-500";
  }

  return (
    <div className="mt-3 text-sm text-neutral-600">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between rounded-2xl bg-neutral-50 px-4 py-3 text-left"
      >
        <span className="flex flex-col">
          <span className={`font-medium ${statusClass}`}>{statusLabel}</span>
          {today.value && (
            <span className="text-neutral-500">{formatDayValue(today.value)}</span>
          )}
        </span>
        <span>{isOpen ? "⌃" : "⌄"}</span>
      </button>
      {isOpen && (
        <div className="mt-2 rounded-2xl bg-neutral-50 px-4 py-3">
          {days.map((day, i) => (
            <div
              key={day.label}
              className={`flex justify-between py-1 ${
                i === todayIndex ? "font-medium text-neutral-800" : ""
              }`}
            >
              <span>{day.label}</span>
              <span>{formatDayValue(day.value) || "Closed"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function OpenMapsButton({ url }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="mt-4 flex w-full items-center justify-center gap-2 rounded-2xl border border-neutral-200 bg-white py-4 font-medium text-neutral-800"
    >
      Open in Maps <ExternalLink size={17} />
    </a>
  );
}

export function VenueCard({ venue: venueLight, beenPill = null }) {
  // Hydrate the heavy tail (photos/reviews/editorial) on demand — the
  // bootstrap only ships light columns now. Body below is unchanged.
  const venue = useVenueDetails(venueLight);
  return (
    <div className="rounded-[2rem] bg-white p-6 shadow-sm border border-neutral-100">
      <VenueHeroCarousel venue={venue} beenPill={beenPill} />
      <div className="mb-8 space-y-3">
        <VenueRating venue={venue} />
        <OpeningHours venue={venue} />
        <VenueEditorial venue={venue} />
        <p className="text-sm leading-6 text-neutral-500">{venue.address}</p>
        <VenueVibes venue={venue} />
        <VenueAmenities venue={venue} />
        <VenueReview venue={venue} />
      </div>
      <OpenMapsButton url={getMapsUrl(venue)} />
    </div>
  );
}
