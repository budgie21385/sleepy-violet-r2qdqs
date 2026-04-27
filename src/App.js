import React, { useMemo, useState } from "react";
import { MapPin, Shuffle, RotateCcw, Heart, X, ExternalLink } from "lucide-react";

const VENUES = [
  {
    id: 1,
    name: "Elmo’s",
    suburb: "Fitzroy North",
    category: "Restaurant",
    cuisine: "American",
    address: "350 St Georges Rd, Fitzroy North VIC 3068",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Elmo%E2%80%99s%20350%20St%20Georges%20Rd%20Fitzroy%20North%20VIC",
    partnerLikes: true,
  },
  {
    id: 2,
    name: "Doju",
    suburb: "Melbourne",
    category: "Restaurant",
    cuisine: "Modern Asian",
    address: "530 Little Collins St, Melbourne VIC 3000",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Doju%20530%20Little%20Collins%20St%20Melbourne%20VIC",
    partnerLikes: true,
  },
  {
    id: 3,
    name: "Maalu Maalu",
    suburb: "Brunswick",
    category: "Restaurant",
    cuisine: "Sri Lankan",
    address: "246 Sydney Rd, Brunswick VIC 3056",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Maalu%20Maalu%20246%20Sydney%20Rd%20Brunswick%20VIC",
    partnerLikes: true,
  },
  {
    id: 4,
    name: "Maven by Morgan",
    suburb: "Fitzroy",
    category: "Restaurant",
    cuisine: "Modern Australian",
    address: "402 Brunswick St, Fitzroy VIC 3065",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Maven%20by%20Morgan%20402%20Brunswick%20St%20Fitzroy%20VIC",
    partnerLikes: false,
  },
  {
    id: 5,
    name: "Myrtle Wine Bar",
    suburb: "Melbourne",
    category: "Bar",
    cuisine: "Wine Bar",
    address: "17 Warburton Ln, Melbourne VIC 3000",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Myrtle%20Wine%20Bar%2017%20Warburton%20Ln%20Melbourne%20VIC",
    partnerLikes: true,
  },
  {
    id: 6,
    name: "Le Pub and Bottle Shop",
    suburb: "Melbourne",
    category: "Bar",
    cuisine: "Pub",
    address: "380 Little Bourke St, Melbourne VIC 3000",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Le%20Pub%20and%20Bottle%20Shop%20380%20Little%20Bourke%20St%20Melbourne%20VIC",
    partnerLikes: false,
  },
  {
    id: 7,
    name: "Noisy Ritual",
    suburb: "Brunswick East",
    category: "Bar",
    cuisine: "Winery",
    address: "249 Lygon St, Brunswick East VIC 3057",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Noisy%20Ritual%20249%20Lygon%20St%20Brunswick%20East%20VIC",
    partnerLikes: true,
  },
  {
    id: 8,
    name: "Suburbia Bakery",
    suburb: "Fairfield",
    category: "Cafe",
    cuisine: "Bakery",
    address: "177 Grange Rd, Fairfield VIC 3078",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Suburbia%20Bakery%20177%20Grange%20Rd%20Fairfield%20VIC",
    partnerLikes: true,
  },
  {
    id: 9,
    name: "Outer Circle Social Club",
    suburb: "Fairfield",
    category: "Cafe",
    cuisine: "Cafe",
    address: "299 Arthur St, Fairfield VIC 3078",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Outer%20Circle%20Social%20Club%20299%20Arthur%20St%20Fairfield%20VIC",
    partnerLikes: false,
  },
  {
    id: 10,
    name: "HazelBark Patisserie",
    suburb: "Preston",
    category: "Cafe",
    cuisine: "Patisserie",
    address: "8A Clinch Ave, Preston VIC 3072",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=HazelBark%20Patisserie%208A%20Clinch%20Ave%20Preston%20VIC",
    partnerLikes: true,
  },
  {
    id: 11,
    name: "Pieman’s Son",
    suburb: "Heidelberg Heights",
    category: "Cafe",
    cuisine: "Bakery",
    address: "42 Bell St, Heidelberg Heights VIC 3081",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Pieman%E2%80%99s%20Son%2042%20Bell%20St%20Heidelberg%20Heights%20VIC",
    partnerLikes: false,
  },
  {
    id: 12,
    name: "Baketico by Wonder Pies Heidelberg",
    suburb: "Heidelberg Heights",
    category: "Cafe",
    cuisine: "Bakery",
    address: "3/1 Orr St, Heidelberg Heights VIC 3081",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=Baketico%20by%20Wonder%20Pies%20Heidelberg%203%2F1%20Orr%20St%20Heidelberg%20Heights%20VIC",
    partnerLikes: true,
  },
  {
    id: 13,
    name: "To Be Frank Bakery",
    suburb: "Collingwood",
    category: "Cafe",
    cuisine: "Bakery",
    address: "Shop%201%2C%204%20Bedford%20St%20Collingwood%20VIC",
    mapsUrl: "https://www.google.com/maps/search/?api=1&query=To%20Be%20Frank%20Bakery%20Shop%201%204%20Bedford%20St%20Collingwood%20VIC",
    partnerLikes: true,
  },
];

const ALL = "All";
const MATCH_OPTIONS = [1, 2, 3, 4];

function uniqueValues(key) {
  return [ALL, ...Array.from(new Set(VENUES.map((venue) => venue[key]))).sort()];
}

export default function RestaurantSwipeMVP() {
  const [screen, setScreen] = useState("filters");
  const [suburb, setSuburb] = useState(ALL);
  const [category, setCategory] = useState(ALL);
  const [cuisine, setCuisine] = useState(ALL);
  const [matchLimit, setMatchLimit] = useState(3);
  const [cardIndex, setCardIndex] = useState(0);
  const [matches, setMatches] = useState([]);
  const [passed, setPassed] = useState([]);
  const [picked, setPicked] = useState(null);

  const suburbs = useMemo(() => uniqueValues("suburb"), []);
  const categories = useMemo(() => uniqueValues("category"), []);
  const cuisines = useMemo(() => uniqueValues("cuisine"), []);

  const filteredVenues = useMemo(() => {
    return VENUES.filter((venue) => {
      return (
        (suburb === ALL || venue.suburb === suburb) &&
        (category === ALL || venue.category === category) &&
        (cuisine === ALL || venue.cuisine === cuisine)
      );
    });
  }, [suburb, category, cuisine]);

  const currentVenue = filteredVenues[cardIndex];

  function resetSwipe() {
    setCardIndex(0);
    setMatches([]);
    setPassed([]);
    setPicked(null);
    setScreen("filters");
  }

  function startSwiping() {
    setCardIndex(0);
    setMatches([]);
    setPassed([]);
    setPicked(null);
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

    if (currentVenue.partnerLikes) {
      const newMatches = [...matches, currentVenue];
      setMatches(newMatches);

      if (newMatches.length >= matchLimit) {
        setScreen("matches");
        return;
      }
    }

    nextCard();
  }

  function passVenue() {
    if (!currentVenue) return;
    setPassed([...passed, currentVenue]);
    nextCard();
  }

  function pickForUs() {
    if (!matches.length) return;
    const randomMatch = matches[Math.floor(Math.random() * matches.length)];
    setPicked(randomMatch);
  }

  return (
    <div className="min-h-screen bg-[#FAFAFA] text-[#111111] flex items-center justify-center p-4">
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
                className="w-full rounded-2xl bg-[#4CAF50] py-4 font-medium text-white disabled:bg-neutral-300"
              >
                Start swiping
              </button>
            </div>
          </div>
        )}

        {screen === "swipe" && (
          <div>
            <div className="mb-3 flex items-center justify-between text-sm text-neutral-500">
              <span>Matches: {matches.length} / {matchLimit}</span>
              <span>{cardIndex + 1} of {filteredVenues.length}</span>
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
              <div className="mb-5 rounded-3xl bg-[#F0F8F0] p-5 border border-[#DCEEDC]">
                <p className="mb-2 text-sm text-neutral-600">Tonight’s pick</p>
                <h3 className="text-xl font-semibold">{picked.name}</h3>
                <p className="mt-1 text-sm text-neutral-600">{picked.suburb} · {picked.category} · {picked.cuisine}</p>
                <OpenMapsButton url={picked.mapsUrl} />
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
                    <a href={venue.mapsUrl} target="_blank" rel="noreferrer" className="rounded-full bg-white p-2 shadow-sm">
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
                ? "bg-[#4CAF50] text-white"
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

      <OpenMapsButton url={venue.mapsUrl} />

      <div className="mt-5 grid grid-cols-2 gap-3">
        <button onClick={onPass} className="rounded-2xl bg-neutral-100 py-4 font-medium text-neutral-700 active:scale-[0.98] transition">
          <span className="inline-flex items-center justify-center gap-2"><X size={18} /> Pass</span>
        </button>
        <button onClick={onLike} className="rounded-2xl bg-[#EEF8EE] py-4 font-medium text-[#2E7D32] active:scale-[0.98] transition">
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
