import './styles.css';
import React, { useEffect, useMemo, useState } from "react";
import { MapPin, Shuffle, RotateCcw, Heart, X, ExternalLink } from "lucide-react";
import { supabase } from "./supabaseClient";

const ALL = "All";
const MATCH_OPTIONS = [1, 2, 3, 4];

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
  const [cuisine, setCuisine] = useState(ALL);
  const [matchLimit, setMatchLimit] = useState(3);
  const [cardIndex, setCardIndex] = useState(0);
  const [matches, setMatches] = useState([]);
  const [passed, setPassed] = useState([]);
  
  useEffect(() => {
    async function loadVenues() {
      const { data, error } = await supabase
        .from("venues")
        .select("*")
        .order("name", { ascending: true });

      if (error) {
        console.error("Error loading venues:", error);
      } else {
        setVenues(data || []);
      }

      setLoading(false);
    }

    loadVenues();
  }, []);

  const suburbs = useMemo(() => {
    return [ALL, ...Array.from(new Set(venues.map((venue) => venue.suburb))).filter(Boolean).sort()];
  }, [venues]);

  const categories = useMemo(() => {
    return [ALL, ...Array.from(new Set(venues.map((venue) => venue.category))).filter(Boolean).sort()];
  }, [venues]);

  const cuisines = useMemo(() => {
    return [ALL, ...Array.from(new Set(venues.map((venue) => venue.cuisine))).filter(Boolean).sort()];
  }, [venues]);

  const filteredVenues = useMemo(() => {
    return venues.filter((venue) => {
      return (
        (suburb === ALL || venue.suburb === suburb) &&
        (category === ALL || venue.category === category) &&
        (cuisine === ALL || venue.cuisine === cuisine)
      );
    });
  }, [venues, suburb, category, cuisine]);

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
              <SelectField label="Area" value={suburb} onChange={setSuburb} options={suburbs} />
              <SelectField label="Type" value={category} onChange={setCategory} options={categories} />
              <SelectField label="Cuisine" value={cuisine} onChange={setCuisine} options={cuisines} />
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
                      <p className="text-sm text-neutral-600">{venue.suburb} · {venue.category} · {venue.cuisine}</p>
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
              ? "bg-[#4CAF50] text-white"
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
              ? "bg-[#4CAF50] text-white"
              : "bg-neutral-50 text-neutral-700 border border-neutral-100"
          }`}
        >
          Partner
        </button>
      </div>
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

function VenueCard({ venue, onLike, onPass }) {
  return (
    <div className="rounded-[2rem] bg-white p-6 shadow-sm border border-neutral-100">
      <div className="mb-12">
        <p className="mb-2 text-sm text-neutral-500">{venue.category} · {venue.cuisine}</p>
        <h2 className="text-3xl font-semibold tracking-tight">{venue.name}</h2>
        <p className="mt-3 flex items-center gap-2 text-neutral-600">
          <MapPin size={17} /> {venue.suburb}
        </p>
        <p className="mt-4 text-sm leading-6 text-neutral-500">{venue.address}</p>
      </div>

      <OpenMapsButton url={venue.maps_url} />

      <div className="mt-5 grid grid-cols-2 gap-3">
        <button onClick={onPass} className="rounded-2xl bg-neutral-100 py-4 font-medium text-neutral-700 active:scale-[0.98] transition">
          <span className="inline-flex items-center justify-center gap-2"><X size={18} /> Pass</span>
        </button>
        <button onClick={onLike} className="rounded-2xl bg-[#edf2eb] py-4 font-medium text-[#455d3b] active:scale-[0.98] transition">
          <span className="inline-flex items-center justify-center gap-2"><Heart size={18} /> Like</span>
        </button>
      </div>
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
