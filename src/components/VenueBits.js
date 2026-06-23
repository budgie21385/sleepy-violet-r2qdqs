// The venue card and its presentational pieces. Props-only components extracted
// from App.js; used by the swipe card (VenueCard) and the map sheet.
import { useState, useEffect } from "react";
import { MapPin, ExternalLink } from "lucide-react";
import {
  getTodayDayKey,
  VIBE_OPTIONS,
  venueMatchesVibe,
  getMapsUrl,
} from "../lib/venueLogic";

export function VenueHeroCarousel({ venue }) {
  const images = venue?.image_urls?.length
    ? venue.image_urls
    : venue?.primary_image
      ? [venue.primary_image]
      : [];
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
      img.src = `/api/place-photo?url=${encodeURIComponent(u)}`;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  return (
    <div
      className="relative mb-6 h-[320px] overflow-hidden rounded-[1.75rem] bg-neutral-100"
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <img
        key={currentImage}
        src={`/api/place-photo?url=${encodeURIComponent(currentImage)}`}
        alt={venue.name}
        className={`h-full w-full object-cover transition-opacity duration-300 ease-in-out ${
          isFading ? "opacity-0" : "opacity-100"
        }`}
        onError={(e) => {
          e.currentTarget.style.display = "none";
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />
      <div className="absolute left-4 top-4 rounded-full bg-black/50 backdrop-blur px-3 py-1 text-xs text-white">
        ⭐ {venue.rating}
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
  if (!venue.rating && !venue.review_count) return null;
  return (
    <p className="mt-4 text-sm font-medium text-neutral-700">
      ⭐ {venue.rating || "No rating"}
      {venue.review_count
        ? ` · ${venue.review_count} ${
            Number(venue.review_count) === 1 ? "review" : "reviews"
          }`
        : ""}
    </p>
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
  const todayIndex = new Date().getDay() === 0 ? 6 : new Date().getDay() - 1;
  const today = days[todayIndex];
  return (
    <div className="mt-3 text-sm text-neutral-600">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex w-full items-center justify-between rounded-2xl bg-neutral-50 px-4 py-3 text-left"
      >
        <span>
          <strong>Today:</strong> {today.value || "Hours unavailable"}
        </span>
        <span>{isOpen ? "⌃" : "⌄"}</span>
      </button>
      {isOpen && (
        <div className="mt-2 rounded-2xl bg-neutral-50 px-4 py-3">
          {days.map((day) => (
            <div key={day.label} className="flex justify-between py-1">
              <span className="font-medium">{day.label}</span>
              <span>{day.value || "Hours unavailable"}</span>
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

export function VenueCard({ venue }) {
  return (
    <div className="rounded-[2rem] bg-white p-6 shadow-sm border border-neutral-100">
      <VenueHeroCarousel venue={venue} />
      <div className="mb-8 space-y-3">
        <p className="text-sm leading-6 text-neutral-500">{venue.address}</p>
        <VenueRating venue={venue} />
        <VenueVibes venue={venue} />
        <OpeningHours venue={venue} />
      </div>
      <OpenMapsButton url={getMapsUrl(venue)} />
    </div>
  );
}
