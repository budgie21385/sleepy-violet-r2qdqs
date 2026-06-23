// The full-screen map surface: clustered emoji markers over a Leaflet map, the
// All/My List toggle, the independent map filter sheet, and the tap-to-open
// venue sheet. Extracted from App.js; App.js is the only consumer.
import { useState, useMemo, useEffect } from "react";
import { createPortal } from "react-dom";
import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import { SlidersHorizontal, X } from "lucide-react";
import {
  MELBOURNE_CENTER,
  MELBOURNE_ZOOM,
  VIBE_OPTIONS,
  getVenueEmoji,
  venueMatchesAreas,
  venueMatchesVibe,
  isVenueOpenNow,
  getTodayDayKey,
} from "../lib/venueLogic";
import {
  MapFilterGroup,
  MapFilterChip,
  MapFilterSection,
  SearchableChips,
  MapAreaFilter,
} from "./MapFilters";
import { MapVenueSheet } from "./MapVenueSheet";

function createEmojiIcon(emoji) {
  return L.divIcon({
    html: `<div style="font-size:24px;line-height:1;text-align:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.25));">${emoji}</div>`,
    className: "venue-emoji-icon",
    iconSize: [32, 32],
    iconAnchor: [16, 32],
  });
}

function MapResizer() {
  const map = useMap();
  useEffect(() => {
    const timer = setTimeout(() => {
      map.invalidateSize();
      map.setView(MELBOURNE_CENTER, MELBOURNE_ZOOM);
    }, 100);
    return () => clearTimeout(timer);
  }, [map]);
  return null;
}

export function MapScreen({ venues, savedIds, onSave, onUnsave, onHide, hiddenIds, areas = [] }) {
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [mapFilter, setMapFilter] = useState("all");
  const [showFilters, setShowFilters] = useState(false);
  // Map-only filter state. Deliberately LOCAL to MapScreen and independent of
  // the App-level swipe/match filters — toggling these never touches the match
  // setup, and vice versa.
  const [fVibes, setFVibes] = useState([]);
  const [fCuisines, setFCuisines] = useState([]);
  const [fAreas, setFAreas] = useState([]); // [{ name, lat, lng }]
  const [fOpenNow, setFOpenNow] = useState(false);
  const [fMinRating, setFMinRating] = useState(0);
  const [fPrices, setFPrices] = useState([]); // price_level numbers 1..4

  const MAP_AREA_RADIUS_KM = 3;

  // Uses the cleaned cuisine_bucket (backfilled from the taxonomy), not the raw
  // Google 'cuisine'. Venues with no real cuisine (formats/junk) have a null
  // bucket and simply don't appear under any cuisine chip.
  const cuisineOptions = useMemo(
    () => Array.from(new Set(venues.map((v) => v.cuisine_bucket).filter(Boolean))).sort(),
    [venues]
  );

  const activeCount =
    fVibes.length +
    fCuisines.length +
    fAreas.length +
    fPrices.length +
    (fOpenNow ? 1 : 0) +
    (fMinRating > 0 ? 1 : 0);

  const plottable = useMemo(
    () =>
      venues.filter(
        (v) =>
          !(hiddenIds && hiddenIds.has(v.id)) &&
          Number.isFinite(Number(v.latitude)) &&
          Number.isFinite(Number(v.longitude))
      ),
    [venues, hiddenIds]
  );

  const displayedPlottable = useMemo(() => {
    const todayKey = getTodayDayKey();
    let list =
      mapFilter === "my_list" && savedIds
        ? plottable.filter((v) => savedIds.has(v.id))
        : plottable;
    if (fAreas.length > 0)
      list = list.filter((v) => venueMatchesAreas(v, fAreas, MAP_AREA_RADIUS_KM));
    if (fCuisines.length > 0)
      list = list.filter((v) => fCuisines.includes(v.cuisine_bucket));
    if (fVibes.length > 0)
      list = list.filter((v) =>
        fVibes.some((vibe) => venueMatchesVibe(v, vibe, todayKey))
      );
    if (fOpenNow) list = list.filter((v) => isVenueOpenNow(v));
    if (fMinRating > 0) list = list.filter((v) => Number(v.rating) >= fMinRating);
    if (fPrices.length > 0)
      list = list.filter((v) => fPrices.includes(Number(v.price_level)));
    return list;
  }, [plottable, mapFilter, savedIds, fAreas, fCuisines, fVibes, fOpenNow, fMinRating, fPrices]);

  const toggleVibe = (v) =>
    setFVibes((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const toggleCuisine = (c) =>
    setFCuisines((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const togglePrice = (p) =>
    setFPrices((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  const toggleArea = (a) =>
    setFAreas((p) =>
      p.some((x) => x.name === a.name)
        ? p.filter((x) => x.name !== a.name)
        : [...p, { name: a.name, lat: a.lat, lng: a.lng }]
    );
  const clearAll = () => {
    setFVibes([]);
    setFCuisines([]);
    setFAreas([]);
    setFOpenNow(false);
    setFMinRating(0);
    setFPrices([]);
  };

  const chips = [
    ...fAreas.map((a) => ({
      key: "area:" + a.name,
      label: a.name,
      onRemove: () => setFAreas((p) => p.filter((x) => x.name !== a.name)),
    })),
    ...fVibes.map((v) => ({
      key: "vibe:" + v,
      label: v,
      onRemove: () => setFVibes((p) => p.filter((x) => x !== v)),
    })),
    ...fCuisines.map((c) => ({
      key: "cui:" + c,
      label: c,
      onRemove: () => setFCuisines((p) => p.filter((x) => x !== c)),
    })),
    ...(fOpenNow
      ? [{ key: "open", label: "Open now", onRemove: () => setFOpenNow(false) }]
      : []),
    ...(fMinRating > 0
      ? [{ key: "rating", label: `${fMinRating}★+`, onRemove: () => setFMinRating(0) }]
      : []),
    ...[...fPrices]
      .sort((a, b) => a - b)
      .map((p) => ({
        key: "price:" + p,
        label: "$".repeat(p),
        onRemove: () => setFPrices((prev) => prev.filter((x) => x !== p)),
      })),
  ];

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Position of the open card within the venues currently shown on the map, so
  // swiping the card steps venue-to-venue through that (filtered) set.
  const selectedIndex =
    selectedVenue != null
      ? displayedPlottable.findIndex((v) => v.id === selectedVenue.id)
      : -1;
  const hasNext = selectedIndex >= 0 && selectedIndex < displayedPlottable.length - 1;
  const hasPrev = selectedIndex > 0;

  return (
    <div className="fixed inset-0 z-[1500] bg-white">
      <div className="absolute top-0 left-0 right-0 z-[2000] bg-white/95 backdrop-blur border-b border-neutral-100">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex gap-0.5 bg-neutral-100 rounded-full p-0.5">
            <button
              type="button"
              onClick={() => setMapFilter("all")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                mapFilter === "all"
                  ? "bg-white text-[#455d3b] shadow-sm"
                  : "text-neutral-500"
              }`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setMapFilter("my_list")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                mapFilter === "my_list"
                  ? "bg-white text-[#455d3b] shadow-sm"
                  : "text-neutral-500"
              }`}
            >
              My List
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowFilters(true)}
              aria-label="Filters"
              className={`relative w-9 h-9 rounded-full flex items-center justify-center transition ${
                activeCount > 0
                  ? "bg-[#455d3b] text-white"
                  : "bg-white border border-neutral-200 text-neutral-600"
              }`}
            >
              <SlidersHorizontal size={16} />
              {activeCount > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-red-600 text-white text-[9px] font-medium flex items-center justify-center border-2 border-white">
                  {activeCount}
                </span>
              )}
            </button>
            <span className="text-sm font-medium text-neutral-700 whitespace-nowrap">
              {displayedPlottable.length}{" "}
              {displayedPlottable.length === 1 ? "place" : "places"}
            </span>
          </div>
        </div>
        {chips.length > 0 && (
          <div className="flex items-center gap-2 px-4 pb-2 overflow-x-auto">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={c.onRemove}
                className="shrink-0 inline-flex items-center gap-1 text-xs bg-[#edf2eb] text-[#455d3b] rounded-full pl-3 pr-2 py-1"
              >
                {c.label}
                <X size={12} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        className="absolute left-0 right-0 bottom-0"
        style={{ top: chips.length > 0 ? 96 : 56 }}
      >
        <MapContainer
          center={MELBOURNE_CENTER}
          zoom={MELBOURNE_ZOOM}
          style={{ height: "100%", width: "100%" }}
        >
          <MapResizer />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          />
          <MarkerClusterGroup
            chunkedLoading
            disableClusteringAtZoom={17}
            spiderfyOnMaxZoom={true}
            showCoverageOnHover={false}
            maxClusterRadius={60}
          >
            {displayedPlottable.map((venue) => (
              <Marker
                key={venue.id}
                position={[Number(venue.latitude), Number(venue.longitude)]}
                icon={createEmojiIcon(getVenueEmoji(venue))}
                eventHandlers={{
                  click: () => setSelectedVenue(venue),
                }}
              />
            ))}
          </MarkerClusterGroup>
        </MapContainer>
      </div>
      {selectedVenue && (
        <MapVenueSheet
          venue={selectedVenue}
          onClose={() => setSelectedVenue(null)}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
          hasNext={hasNext}
          hasPrev={hasPrev}
          onNext={() =>
            hasNext && setSelectedVenue(displayedPlottable[selectedIndex + 1])
          }
          onPrev={() =>
            hasPrev && setSelectedVenue(displayedPlottable[selectedIndex - 1])
          }
        />
      )}
      {showFilters &&
        createPortal(
          <div className="fixed inset-0 z-[3200]">
            <button
              type="button"
              aria-label="Close filters"
              onClick={() => setShowFilters(false)}
              className="absolute inset-0 bg-black/30"
            />
            <div className="absolute left-0 right-0 bottom-0 max-h-[85%] flex flex-col bg-white rounded-t-3xl shadow-2xl">
              <div className="px-5 pt-3 pb-2 border-b border-neutral-100">
                <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
                <div className="flex items-center justify-between">
                  <h2 className="text-base font-semibold">Filters</h2>
                  {activeCount > 0 && (
                    <button
                      type="button"
                      onClick={clearAll}
                      className="text-xs font-medium text-red-600"
                    >
                      Clear all
                    </button>
                  )}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-5 py-2">
                {areas.length > 0 && (
                  <MapFilterSection
                    title="Area"
                    summary={fAreas.length ? `${fAreas.length} selected` : "Any"}
                    accent={fAreas.length > 0}
                  >
                    <MapAreaFilter areas={areas} selected={fAreas} onToggle={toggleArea} />
                  </MapFilterSection>
                )}

                {cuisineOptions.length > 0 && (
                  <MapFilterSection
                    title="Cuisine"
                    summary={fCuisines.length ? `${fCuisines.length} selected` : "Any"}
                    accent={fCuisines.length > 0}
                  >
                    <SearchableChips
                      options={cuisineOptions}
                      selected={fCuisines}
                      onToggle={toggleCuisine}
                      placeholder="Search cuisine"
                    />
                  </MapFilterSection>
                )}

                <div className="space-y-5 pt-4">
                  <MapFilterGroup title="Vibe">
                    {VIBE_OPTIONS.map((v) => (
                      <MapFilterChip
                        key={v}
                        on={fVibes.includes(v)}
                        label={v}
                        onClick={() => toggleVibe(v)}
                      />
                    ))}
                  </MapFilterGroup>

                  <MapFilterGroup title="Minimum rating">
                    {[0, 4, 4.5].map((r) => (
                      <MapFilterChip
                        key={r}
                        on={fMinRating === r}
                        label={r === 0 ? "Any" : `${r}★+`}
                        onClick={() => setFMinRating(r)}
                      />
                    ))}
                  </MapFilterGroup>

                  <MapFilterGroup title="Price">
                    {[1, 2, 3, 4].map((p) => (
                      <MapFilterChip
                        key={p}
                        on={fPrices.includes(p)}
                        label={"$".repeat(p)}
                        onClick={() => togglePrice(p)}
                      />
                    ))}
                  </MapFilterGroup>

                  <div className="flex items-center justify-between pt-1">
                    <span className="text-sm font-medium text-neutral-800">
                      Open now
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={fOpenNow}
                      onClick={() => setFOpenNow((v) => !v)}
                      className={`relative w-11 h-6 rounded-full transition ${
                        fOpenNow ? "bg-[#455d3b]" : "bg-neutral-300"
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                          fOpenNow ? "right-0.5" : "left-0.5"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>

              <div className="px-5 py-3 border-t border-neutral-100">
                <button
                  type="button"
                  onClick={() => setShowFilters(false)}
                  className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white"
                >
                  Show {displayedPlottable.length}{" "}
                  {displayedPlottable.length === 1 ? "place" : "places"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
