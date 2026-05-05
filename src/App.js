import './styles.css';
import React, { useEffect, useMemo, useState } from "react";
import { MapPin, Shuffle, RotateCcw, Heart, X, ExternalLink } from "lucide-react";
import { supabase } from "./supabaseClient";

const ALL = "All";
const MATCH_OPTIONS = [1, 2, 3, 4];
const AREA_CHIPS = [
  { name: "Melbourne", lat: -37.8136, lng: 144.9631 },
  { name: "Fitzroy", lat: -37.7984, lng: 144.9783 },
  { name: "Collingwood", lat: -37.8021, lng: 144.9882 },
  { name: "Brunswick", lat: -37.7663, lng: 144.9614 },
  { name: "Northcote", lat: -37.7699, lng: 144.9998 },
  { name: "Fairfield", lat: -37.7797, lng: 145.0174 },
  { name: "Thornbury", lat: -37.759603621460016, lng: 145.00023000954627 },
];

const RADIUS_OPTIONS = [1, 3, 5, 10];

export default function RestaurantSwipeMVP() {
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState(null);
  const [currentUser, setCurrentUser] = useState("mark");
  const [markLikes, setMarkLikes] = useState([]);
  const [partnerLikes, setPartnerLikes] = useState([]);
  const [markPasses, setMarkPasses] = useState([]);
  const [partnerPasses, setPartnerPasses] = useState([]);

  const [screen, setScreen] = useState("filters");
  const [suburb, setSuburb] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [selectedCuisines, setSelectedCuisines] = useState([]);
  const [areaSearch, setAreaSearch] = useState("");
  const [selectedArea, setSelectedArea] = useState(null);
  const [radiusKm, setRadiusKm] = useState(5);
  const [showAreaDropdown, setShowAreaDropdown] = useState(false);
  const [matchLimit, setMatchLimit] = useState(3);
  const [cardIndex, setCardIndex] = useState(0);
  const [matches, setMatches] = useState([]);
  const [passed, setPassed] = useState([]);
  
  useEffect(() => {
  async function loadVenues() {
    const { data, error } = await supabase
      .from("venues")
      .select("*");

    console.log("Supabase venues data:", data);
    console.log("Supabase venues error:", error);

    if (error) {
      console.error("Error loading venues:", error);
    } else {
      const shuffled = [...(data || [])].sort(() => Math.random() - 0.5);
      setVenues(shuffled);
    }

    setLoading(false);
  }

  loadVenues();
}, []);

  
  const suburbs = useMemo(() => {
    return [ALL, ...Array.from(new Set(venues.map((venue) => venue.suburb))).filter(Boolean).sort()];
  }, [venues]);

  const categories = useMemo(() => {
    return [ALL, ...Array.from(new Set(venues.map((venue) => venue.type))).filter(Boolean).sort()];
  }, [venues]);

  const cuisines = useMemo(() => {
  const availableVenues = venues.filter((venue) => {
    const matchesCategory =
      category === ALL || venue.type === category;

    let matchesArea = true;

    if (selectedArea && venue.latitude && venue.longitude) {
      const distance = getDistanceKm(
        selectedArea.lat,
        selectedArea.lng,
        venue.latitude,
        venue.longitude
      );

      matchesArea = distance <= radiusKm;
    }

    return matchesCategory && matchesArea;
  });

  return [
    ALL,
    ...Array.from(
      new Set(availableVenues.map((venue) => venue.cuisine))
    )
      .filter(Boolean)
      .sort(),
  ];
}, [venues, category, selectedArea, radiusKm]);
  useEffect(() => {
  setSelectedCuisines((currentSelected) =>
    currentSelected.filter((cuisine) => cuisines.includes(cuisine))
  );
}, [cuisines]);

const filteredVenues = useMemo(() => {
  return venues.filter((venue) => {
    const matchesCategory =
      category === ALL || venue.type === category;

    const matchesCuisine =
      selectedCuisines.length === 0 ||
      selectedCuisines.includes(venue.cuisine);

    let matchesArea = true;

    if (selectedArea) {
      const lat = Number(venue.latitude);
      const lng = Number(venue.longitude);

      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        matchesArea = false;
      } else {
        const distance = getDistanceKm(
          selectedArea.lat,
          selectedArea.lng,
          lat,
          lng
        );

        matchesArea = distance <= radiusKm;
      }
    }

    return matchesArea && matchesCategory && matchesCuisine;
  });
}, [venues, selectedArea, radiusKm, category, selectedCuisines]);

const currentUserSwipedIds = currentUser === "mark"
  ? [...markLikes, ...markPasses]
  : [...partnerLikes, ...partnerPasses];

const currentVenue = filteredVenues.find(
  (venue) => !currentUserSwipedIds.includes(venue.id)
);

const currentUserSwipedCount = currentUserSwipedIds.length;
  function resetSwipe() {
    setCardIndex(0);
    setMatches([]);
    setPassed([]);
    setPicked(null);
    setScreen("filters");

    setCurrentUser("mark");
    setMarkLikes([]);
    setPartnerLikes([]);
    setMarkPasses([]);
    setPartnerPasses([]);
  }

  function startSwiping() {
    setCardIndex(0);
    setMatches([]);
    setPassed([]);
    setPicked(null);
    setMarkLikes([]);
    setPartnerLikes([]);
    setMarkPasses([]);
    setPartnerPasses([]);
    setCurrentUser("mark");
    setScreen("swipe");
    
  }

  function nextCard() {
    const nextIndex = cardIndex + 1;
    if (nextIndex >= filteredVenues.length) {
      setScreen("matches");
      return;
    }
    setCardIndex(nextIndex);
  }

 function likeVenue() {
  if (!currentVenue) return;

  const venueId = currentVenue.id;

  const otherUserLikes = currentUser === "mark" ? partnerLikes : markLikes;
  const isMatch = otherUserLikes.includes(venueId);

  if (currentUser === "mark") {
    setMarkLikes((prev) => [...prev, venueId]);
  } else {
    setPartnerLikes((prev) => [...prev, venueId]);
  }

  if (isMatch && !matches.some((match) => match.id === venueId)) {
    const newMatches = [...matches, currentVenue];
    setMatches(newMatches);

    if (newMatches.length >= matchLimit) {
      setScreen("matches");
    }
  }
}

function passVenue() {
  if (!currentVenue) return;

  const venueId = currentVenue.id;

  if (currentUser === "mark") {
    setMarkPasses((prev) => [...prev, venueId]);
  } else {
    setPartnerPasses((prev) => [...prev, venueId]);
  }
}

  function pickForUs() {
    if (!matches.length) return;
    const randomMatch = matches[Math.floor(Math.random() * matches.length)];
    setPicked(randomMatch);
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
        Loading venues...
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center justify-between">
          <div>
            <p className="text-sm text-neutral-500">Dinner picker</p>
            <h1 className="text-2xl font-semibold tracking-tight">Where should we go?</h1>
          </div>
          {screen !== "filters" && (
            <button
              onClick={resetSwipe}
              className="rounded-full bg-white p-3 shadow-sm border border-neutral-100"
              aria-label="Reset"
            >
              <RotateCcw size={18} />
            </button>
          )}
        </div>

        {screen === "filters" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <div className="space-y-5">
              <AreaFilter
                areaSearch={areaSearch}
                setAreaSearch={setAreaSearch}
                selectedArea={selectedArea}
                setSelectedArea={setSelectedArea}
                radiusKm={radiusKm}
                setRadiusKm={setRadiusKm}
                showAreaDropdown={showAreaDropdown}
                setShowAreaDropdown={setShowAreaDropdown}
              />
              <SelectField label="Type" value={category} onChange={setCategory} options={categories} />
              <MultiSelectChips
                label="Cuisine"
                options={cuisines.filter((item) => item !== ALL)}
                selected={selectedCuisines}
                setSelected={setSelectedCuisines}
              />
              <MatchLimitField value={matchLimit} onChange={setMatchLimit} />

              <div className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600">
                {filteredVenues.length} places available with these filters.
              </div>

              <button
                onClick={startSwiping}
                disabled={!filteredVenues.length}
                className="w-full rounded-2xl bg-[#455d3b] py-4 font-medium text-white disabled:bg-neutral-300"
              >
                Start swiping
              </button>
            </div>
          </div>
        )}

        {screen === "swipe" && (
          <div>
          <UserToggle currentUser={currentUser} setCurrentUser={setCurrentUser} />
            <div className="mb-3 flex items-center justify-between text-sm text-neutral-500">
              <span>Matches: {matches.length} / {matchLimit}</span>
              <span>{currentUserSwipedCount + 1} of {filteredVenues.length}</span>
            </div>

            {currentVenue ? (
              <VenueCard venue={currentVenue} onLike={likeVenue} onPass={passVenue} />
            ) : (
              <EmptyState title="No more places" text="You’ve reached the end of this list." action={() => setScreen("matches")} actionText="View matches" />
            )}
          </div>
        )}

        {screen === "matches" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <div className="mb-5">
              <p className="text-sm text-neutral-500">Finished</p>
              <h2 className="text-2xl font-semibold tracking-tight">
                {matches.length ? `You’ve got ${matches.length} match${matches.length > 1 ? "es" : ""}` : "No matches yet"}
              </h2>
            </div>

            {picked ? (
              <div className="mb-5 rounded-3xl bg-[#edf2eb] p-5 border border-[#c5d4c2]">
                <p className="mb-2 text-sm text-neutral-600">Tonight’s pick</p>
                <h3 className="text-xl font-semibold">{picked.name}</h3>
                <p className="mt-1 text-sm text-neutral-600">{picked.suburb} · {picked.category} · {picked.cuisine}</p>
                <OpenMapsButton url={picked.maps_url} />
              </div>
            ) : null}

            <div className="space-y-3">
              {matches.map((venue) => (
                <div key={venue.id} className="rounded-2xl bg-neutral-50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{venue.name}</h3>
                      <p className="text-sm text-neutral-600">{venue.suburb} · {venue.type} · {venue.cuisine}</p>
                    </div>
                    <a href={venue.maps_url} target="_blank" rel="noreferrer" className="rounded-full bg-white p-2 shadow-sm">
                      <ExternalLink size={16} />
                    </a>
                  </div>
                </div>
              ))}
            </div>

            {matches.length ? (
              <button onClick={pickForUs} className="mt-5 w-full rounded-2xl bg-[#111111] py-4 font-medium text-white">
                <span className="inline-flex items-center gap-2"><Shuffle size={18} /> Pick for us</span>
              </button>
            ) : (
              <button onClick={resetSwipe} className="mt-5 w-full rounded-2xl bg-[#111111] py-4 font-medium text-white">
               Try different filters
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function getMapsUrl(venue) {
  if (venue.maps_url) return venue.maps_url;

  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${venue.name || ""} ${venue.address || ""}`.trim()
  )}`;
}

function getDistanceKm(lat1, lng1, lat2, lng2) {
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

function UserToggle({ currentUser, setCurrentUser }) {
  return (
    <div className="mb-4 rounded-3xl bg-white p-3 shadow-sm border border-neutral-100">
      <p className="mb-2 text-sm font-medium text-neutral-700">Who is swiping?</p>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setCurrentUser("mark")}
          className={`rounded-2xl py-3 font-medium transition ${
            currentUser === "mark"
              ? "bg-[#455d3b] text-white"
              : "bg-neutral-50 text-neutral-700 border border-neutral-100"
          }`}
        >
          Mark
        </button>

        <button
          type="button"
          onClick={() => setCurrentUser("partner")}
          className={`rounded-2xl py-3 font-medium transition ${
            currentUser === "partner"
              ? "bg-[#455d3b] text-white"
              : "bg-neutral-50 text-neutral-700 border border-neutral-100"
          }`}
        >
          Partner
        </button>
      </div>
    </div>
  );
}

function AreaFilter({
  areaSearch,
  setAreaSearch,
  selectedArea,
  setSelectedArea,
  radiusKm,
  setRadiusKm,
  showAreaDropdown,
  setShowAreaDropdown,
}) {
  const matchingAreas = AREA_CHIPS.filter((area) =>
    area.name.toLowerCase().includes(areaSearch.toLowerCase())
  );

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">
        Where are we going?
      </span>

      <input
        value={areaSearch}
        onFocus={() => setShowAreaDropdown(true)}
        onChange={(event) => {
          setAreaSearch(event.target.value);
          setShowAreaDropdown(true);
       }}
        placeholder="Search suburb or area..."
        className="w-full rounded-2xl bg-neutral-50 px-4 py-4 text-base outline-none border border-neutral-100"
      />

      {showAreaDropdown && (
      <div className="mt-3 flex flex-wrap gap-2">
        {matchingAreas.map((area) => (
          <button
            key={area.name}
            type="button"
             onClick={() => {
              setSelectedArea(area);
              setAreaSearch(area.name);
              setShowAreaDropdown(false);
            }}
            className={`rounded-full px-4 py-2 text-sm font-medium border ${
              selectedArea?.name === area.name
                ? "bg-[#455d3b] text-white border-[#455d3b]"
                : "bg-neutral-50 text-neutral-700 border-neutral-100"
            }`}
          >
            {area.name}
          </button>
        ))}
      </div>
)}

      {selectedArea && (
        <button
          type="button"
          onClick={() => {
            setSelectedArea(null);
            setAreaSearch("");
          }}
          className="mt-2 text-sm text-neutral-500 underline"
        >
          Clear area
        </button>
      )}

      <div className="mt-5">
        <span className="mb-2 block text-sm font-medium text-neutral-700">
          Radius
        </span>

        <div className="grid grid-cols-4 gap-2">
          {RADIUS_OPTIONS.map((radius) => (
            <button
              key={radius}
              type="button"
              onClick={() => setRadiusKm(radius)}
              className={`rounded-2xl py-3 font-medium transition ${
                radiusKm === radius
                  ? "bg-[#455d3b] text-white"
                  : "bg-neutral-50 text-neutral-700 border border-neutral-100"
              }`}
            >
              {radius}km
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function MultiSelectChips({ label, options, selected, setSelected }) {
  const [isOpen, setIsOpen] = useState(false);

  function toggleOption(option) {
    if (option === ALL) {
      setSelected([]);
      setIsOpen(false);
      return;
    }

    if (selected.includes(option)) {
      setSelected(selected.filter((item) => item !== option));
    } else {
      setSelected([...selected, option]);
    }
  }

  const buttonText =
    selected.length === 0
      ? "All"
      : selected.length === 1
      ? selected[0]
      : `${selected.length} selected`;

  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">
        {label}
      </span>

      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full rounded-2xl bg-neutral-50 px-4 py-4 text-left text-base border border-neutral-100"
      >
        {buttonText} <span className="float-right">⌄</span>
      </button>

      {isOpen && (
        <div className="mt-3 flex flex-wrap gap-2 rounded-2xl bg-white p-3 border border-neutral-100 shadow-sm">
          <button
            type="button"
            onClick={() => toggleOption(ALL)}
            className={`rounded-full px-4 py-2 text-sm font-medium border ${
              selected.length === 0
                ? "bg-[#455d3b] text-white border-[#455d3b]"
                : "bg-neutral-50 text-neutral-700 border-neutral-100"
            }`}
          >
            All
          </button>

          {options.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => toggleOption(option)}
              className={`rounded-full px-4 py-2 text-sm font-medium border ${
                selected.includes(option)
                  ? "bg-[#455d3b] text-white border-[#455d3b]"
                  : "bg-neutral-50 text-neutral-700 border-neutral-100"
              }`}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectField({ label, value, onChange, options }) {
  return (
    <label className="block">
      <span className="mb-2 block text-sm font-medium text-neutral-700">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full appearance-none rounded-2xl bg-neutral-50 px-4 py-4 text-base outline-none border border-neutral-100"
      >
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function MatchLimitField({ value, onChange }) {
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">How many matches?</span>
      <div className="grid grid-cols-4 gap-2">
        {MATCH_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onChange(option)}
            className={`rounded-2xl py-3 font-medium transition ${
              value === option
                ? "bg-[#455d3b] text-white"
                : "bg-neutral-50 text-neutral-700 border border-neutral-100"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
    </div>
  );
}

function VenueHeroCarousel({ venue }) {
  const images = venue?.image_urls?.length
    ? venue.image_urls
    : venue?.primary_image
      ? [venue.primary_image]
      : [];

  const [imageIndex, setImageIndex] = useState(0);
  const [isFading, setIsFading] = useState(false);

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
    <div className="relative mb-6 h-[320px] overflow-hidden rounded-[1.75rem] bg-neutral-100">
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

      {/* gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-t from-black/75 via-black/25 to-transparent" />

      {/* rating badge */}
      <div className="absolute left-4 top-4 rounded-full bg-black/50 backdrop-blur px-3 py-1 text-xs text-white">
        ⭐ {venue.rating}
      </div>

      {/* arrows */}
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

      <div className="absolute bottom-0 left-0 right-0 p-5 text-white [text-shadow:0_2px_8px_rgba(0,0,0,0.6)]">
        <p className="text-sm text-white/80 mb-1">
          {venue.type}
        </p>

        <h2 className="text-[28px] font-semibold leading-tight mb-1">
          {venue.name}
        </h2>

        <div className="flex items-center gap-2 text-sm text-white/90">
          <MapPin size={14} className="opacity-80" />
          {venue.suburb}
        </div>
      </div>
    </div>
  );
}

function VenueCard({ venue, onLike, onPass }) {
  return (
    <div className="rounded-[2rem] bg-white p-6 shadow-sm border border-neutral-100">
      <VenueHeroCarousel venue={venue} />

        <div className="mb-8 space-y-3">
        <p className="text-sm leading-6 text-neutral-500">
          {venue.address}
        </p>

        <VenueRating venue={venue} />
        <OpeningHours venue={venue} />
      </div>

      <OpenMapsButton url={getMapsUrl(venue)} />

      <div className="mt-5 grid grid-cols-2 gap-3">
        <button
          type="button"
          onClick={onPass}
          className="rounded-2xl bg-neutral-100 py-4 font-medium text-neutral-700 active:scale-[0.98] transition"
        >
          <span className="inline-flex items-center justify-center gap-2">
            <X size={18} /> Pass
          </span>
        </button>

        <button
          type="button"
          onClick={onLike}
          className="rounded-2xl bg-[#edf2eb] py-4 font-medium text-[#455d3b] active:scale-[0.98] transition"
        >
          <span className="inline-flex items-center justify-center gap-2">
            <Heart size={18} /> Like
          </span>
        </button>
      </div>
    </div>
  );
}

function VenueRating({ venue }) {
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

function OpeningHours({ venue }) {
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

function OpenMapsButton({ url }) {
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

function EmptyState({ title, text, action, actionText }) {
  return (
    <div className="rounded-3xl bg-white p-6 text-center shadow-sm border border-neutral-100">
      <h2 className="text-xl font-semibold">{title}</h2>
      <p className="mt-2 text-neutral-600">{text}</p>
      <button onClick={action} className="mt-5 w-full rounded-2xl bg-[#111111] py-4 font-medium text-white">
        {actionText}
      </button>
    </div>
  );
}
