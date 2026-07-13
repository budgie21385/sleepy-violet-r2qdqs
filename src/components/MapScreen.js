// The full-screen map surface: clustered emoji markers over a Leaflet map, the
// All/My List toggle, the independent map filter sheet, and the tap-to-open
// venue sheet. Extracted from App.js; App.js is the only consumer.
import { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import { SlidersHorizontal, Search, X } from "lucide-react";
import {
  MELBOURNE_CENTER,
  MELBOURNE_ZOOM,
  OCCASION_OPTIONS,
  AMENITY_FILTERS,
  getVenueEmoji,
  venueMatchesAreas,
  venueMatchesOccasions,
  venueMatchesPrice,
  venueMatchesAmenities,
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
import { AddVenueSheet } from "./AddVenueSheet";
import { supabase } from "../supabaseClient";

function createEmojiIcon(emoji) {
  return L.divIcon({
    html: `<div style="font-size:24px;line-height:1;text-align:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.25));">${emoji}</div>`,
    className: "venue-emoji-icon",
    iconSize: [32, 32],
    iconAnchor: [16, 32],
  });
}

// --- Friends mode helpers ------------------------------------------------

const esc = (s) =>
  String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

function timeAgoShort(ts) {
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 15) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return "1d";
}

const FRESH_MS = 3 * 60 * 60 * 1000; // "is at" window, matches Activity copy

// One pin per venue: up to 3 stacked friend avatars + a "Name · 2h" label.
// Fresh (<3h) check-ins get the olive ring; older-today pins fade.
function createFriendsIcon(group) {
  const fresh = group.entries.some(
    (e) => Date.now() - new Date(e.created_at).getTime() < FRESH_MS
  );
  const ring = fresh ? "#455d3b" : "#b5b2ab";
  const shown = group.entries.slice(0, 3);
  const avatars = shown
    .map((e, i) => {
      const style = `width:30px;height:30px;border-radius:50%;border:2px solid ${ring};box-shadow:0 1px 3px rgba(0,0,0,0.3);${i > 0 ? "margin-left:-9px;" : ""}`;
      if (e.profile?.avatar_url) {
        return `<img src="${esc(e.profile.avatar_url)}" style="${style}object-fit:cover;background:#fff;" />`;
      }
      const initial = esc(
        (e.profile?.display_name || "?").trim().charAt(0).toUpperCase()
      );
      return `<div style="${style}background:#455d3b;color:#fff;display:flex;align-items:center;justify-content:center;font:600 13px sans-serif;">${initial}</div>`;
    })
    .join("");
  const first = (group.entries[0].profile?.display_name || "A friend").split(" ")[0];
  const extra = group.entries.length > 1 ? ` +${group.entries.length - 1}` : "";
  const label = `${esc(first)}${extra} · ${timeAgoShort(group.entries[0].created_at)}`;
  return L.divIcon({
    html: `<div style="display:flex;flex-direction:column;align-items:center;${fresh ? "" : "opacity:0.6;"}">
      <div style="display:flex;">${avatars}</div>
      <div style="margin-top:2px;background:#fff;border-radius:9999px;padding:1px 7px;font:600 10px sans-serif;color:${fresh ? "#455d3b" : "#6b6a65"};box-shadow:0 1px 2px rgba(0,0,0,0.25);white-space:nowrap;">${label}</div>
    </div>`,
    className: "friend-checkin-icon",
    iconSize: [90, 52],
    iconAnchor: [45, 48],
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

// Lifts the map's current viewport bounds into React state so the place count
// and the card's venue-to-venue swipe only cover what's actually on screen
// (zoom acts as an implicit filter — a CBD zoom shouldn't swipe to Preston).
function BoundsWatcher({ onBounds }) {
  const map = useMapEvents({
    moveend: () => onBounds(map.getBounds()),
    zoomend: () => onBounds(map.getBounds()),
  });
  useEffect(() => {
    onBounds(map.getBounds());
  }, [map, onBounds]);
  return null;
}

// Hands the Leaflet map instance up to MapScreen so search results can
// fly-to a pin (and, later, card swipes can keep the active pin in view).
function MapRef({ mapRef }) {
  const map = useMap();
  useEffect(() => {
    mapRef.current = map;
    return () => {
      if (mapRef.current === map) mapRef.current = null;
    };
  }, [map, mapRef]);
  return null;
}

export function MapScreen({ venues, savedIds, onSave, onUnsave, onHide, onCheckIn, hiddenIds, areas = [], onVenueAdded, showToast, searchOpen, onSearchOpenChange, userId }) {
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [mapFilter, setMapFilter] = useState("all");
  const [mapBounds, setMapBounds] = useState(null); // current Leaflet viewport
  // Search sheet visibility lives in App (controlled) so the FAB's "Check in"
  // shortcut can open it too; falls back to local state when uncontrolled.
  const [localSearch, setLocalSearch] = useState(false);
  const showSearch = searchOpen ?? localSearch;
  const setShowSearch = onSearchOpenChange ?? setLocalSearch;
  const mapRef = useRef(null);

  // Search-sheet tap on a pool venue: fly the map to the pin and open its
  // card. Also used after a Google add so the new venue is immediately shown.
  function flyToVenue(venue) {
    const lat = Number(venue.latitude);
    const lng = Number(venue.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && mapRef.current) {
      mapRef.current.flyTo(
        [lat, lng],
        Math.max(mapRef.current.getZoom(), 16),
        { duration: 0.8 }
      );
    }
    setSelectedVenue(venue);
  }
  const [showFilters, setShowFilters] = useState(false);
  // Map-only filter state. Deliberately LOCAL to MapScreen and independent of
  // the App-level swipe/match filters — toggling these never touches the match
  // setup, and vice versa.
  const [fOccasions, setFOccasions] = useState([]); // "What are you after?" chips
  const [fCuisines, setFCuisines] = useState([]);
  const [fAreas, setFAreas] = useState([]); // [{ name, lat, lng }]
  const [fOpenNow, setFOpenNow] = useState(false);
  const [fMinRating, setFMinRating] = useState(0);
  const [fPrices, setFPrices] = useState([]); // price_level numbers 1..4
  const [fAmenities, setFAmenities] = useState([]); // amenity column keys

  const MAP_AREA_RADIUS_KM = 3;

  // Uses the cleaned cuisine_bucket (backfilled from the taxonomy), not the raw
  // Google 'cuisine'. Venues with no real cuisine (formats/junk) have a null
  // bucket and simply don't appear under any cuisine chip.
  const cuisineOptions = useMemo(
    () => Array.from(new Set(venues.map((v) => v.cuisine_bucket).filter(Boolean))).sort(),
    [venues]
  );

  const activeCount =
    fOccasions.length +
    fCuisines.length +
    fAreas.length +
    fPrices.length +
    fAmenities.length +
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

  // --- Friends mode data ---------------------------------------------------
  // Lazy: fetched when the Friends segment is selected. Latest check-in per
  // friend from the last 24h; venue objects come from the already-loaded pool
  // (a friend's RLS-hidden manual venue simply doesn't pin).
  const [friendCheckins, setFriendCheckins] = useState(null); // null = loading
  useEffect(() => {
    if (mapFilter !== "friends" || !userId) return;
    let cancelled = false;
    setFriendCheckins(null);
    (async () => {
      const { data: fr } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id")
        .eq("status", "accepted")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
      const friendIds = Array.from(
        new Set(
          (fr || []).map((f) =>
            f.requester_id === userId ? f.addressee_id : f.requester_id
          )
        )
      );
      if (friendIds.length === 0) {
        if (!cancelled) setFriendCheckins([]);
        return;
      }
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: rows } = await supabase
        .from("activities")
        .select("user_id, venue_id, created_at")
        .eq("kind", "checkin")
        .in("user_id", friendIds)
        .gte("created_at", dayAgo)
        .order("created_at", { ascending: false });
      // Latest check-in per friend = where they ARE (not their whole trail).
      const latestByUser = new Map();
      for (const r of rows || []) {
        if (!latestByUser.has(r.user_id)) latestByUser.set(r.user_id, r);
      }
      const latest = Array.from(latestByUser.values());
      let profById = {};
      if (latest.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", latest.map((r) => r.user_id));
        profById = Object.fromEntries((profs || []).map((p) => [p.id, p]));
      }
      if (cancelled) return;
      setFriendCheckins(
        latest.map((r) => ({ ...r, profile: profById[r.user_id] || null }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [mapFilter, userId]);

  // Group visible check-ins by venue — the per-viewer "Mark and John are at X"
  // clustering. One pin per venue, entries newest-first.
  const friendPins = useMemo(() => {
    if (mapFilter !== "friends" || !friendCheckins) return [];
    const venueById = new Map(plottable.map((v) => [v.id, v]));
    const groups = new Map();
    for (const c of friendCheckins) {
      const venue = venueById.get(c.venue_id);
      if (!venue) continue; // RLS-hidden or unmappable venue
      if (!groups.has(venue.id)) groups.set(venue.id, { venue, entries: [] });
      groups.get(venue.id).entries.push(c);
    }
    return Array.from(groups.values());
  }, [mapFilter, friendCheckins, plottable]);

  const displayedPlottable = useMemo(() => {
    if (mapFilter === "friends") return friendPins.map((g) => g.venue);
    const todayKey = getTodayDayKey();
    let list =
      mapFilter === "my_list" && savedIds
        ? plottable.filter((v) => savedIds.has(v.id))
        : plottable;
    if (fAreas.length > 0)
      list = list.filter((v) => venueMatchesAreas(v, fAreas, MAP_AREA_RADIUS_KM));
    if (fCuisines.length > 0)
      list = list.filter((v) => fCuisines.includes(v.cuisine_bucket));
    if (fOccasions.length > 0)
      list = list.filter((v) => venueMatchesOccasions(v, fOccasions, todayKey));
    if (fOpenNow) list = list.filter((v) => isVenueOpenNow(v));
    if (fMinRating > 0) list = list.filter((v) => Number(v.rating) >= fMinRating);
    if (fPrices.length > 0) list = list.filter((v) => venueMatchesPrice(v, fPrices));
    if (fAmenities.length > 0)
      list = list.filter((v) => venueMatchesAmenities(v, fAmenities));
    return list;
  }, [plottable, mapFilter, savedIds, fAreas, fCuisines, fOccasions, fOpenNow, fMinRating, fPrices, fAmenities, friendPins]);

  const toggleOccasion = (v) =>
    setFOccasions((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const toggleCuisine = (c) =>
    setFCuisines((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]));
  const togglePrice = (p) =>
    setFPrices((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  const toggleAmenity = (k) =>
    setFAmenities((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  const toggleArea = (a) =>
    setFAreas((p) =>
      p.some((x) => x.name === a.name)
        ? p.filter((x) => x.name !== a.name)
        : [...p, { name: a.name, lat: a.lat, lng: a.lng }]
    );
  const clearAll = () => {
    setFOccasions([]);
    setFCuisines([]);
    setFAreas([]);
    setFOpenNow(false);
    setFMinRating(0);
    setFPrices([]);
    setFAmenities([]);
  };

  const chips = [
    ...fAreas.map((a) => ({
      key: "area:" + a.name,
      label: a.name,
      onRemove: () => setFAreas((p) => p.filter((x) => x.name !== a.name)),
    })),
    ...fOccasions.map((v) => ({
      key: "occ:" + v,
      label: v,
      onRemove: () => setFOccasions((p) => p.filter((x) => x !== v)),
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
    ...fAmenities.map((k) => ({
      key: "amenity:" + k,
      label: (AMENITY_FILTERS.find((a) => a.key === k) || {}).label || k,
      onRemove: () => setFAmenities((prev) => prev.filter((x) => x !== k)),
    })),
  ];

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  // Venues inside the current viewport — the set the header count and the
  // card's venue-to-venue swipe cover. Markers still render the full filtered
  // set (clustering handles off-screen pins as you pan).
  const inViewPlottable = useMemo(() => {
    if (!mapBounds) return displayedPlottable;
    return displayedPlottable.filter((v) =>
      mapBounds.contains([Number(v.latitude), Number(v.longitude)])
    );
  }, [displayedPlottable, mapBounds]);

  // Position of the open card within the venues currently in view, so swiping
  // the card steps venue-to-venue through what's on screen. The order WRAPS:
  // opening the 3rd venue and swiping right goes 4, 5, …, end, then loops to
  // 1 and 2 — every in-view venue is reachable in one direction regardless of
  // which pin was tapped first. If the user pans away while a card is open the
  // card stays but next/prev simply disable (selectedIndex -1).
  const selectedIndex =
    selectedVenue != null
      ? inViewPlottable.findIndex((v) => v.id === selectedVenue.id)
      : -1;
  const canCycle = selectedIndex >= 0 && inViewPlottable.length > 1;
  const hasNext = canCycle;
  const hasPrev = canCycle;

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
            <button
              type="button"
              onClick={() => setMapFilter("friends")}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${
                mapFilter === "friends"
                  ? "bg-white text-[#455d3b] shadow-sm"
                  : "text-neutral-500"
              }`}
            >
              Friends
            </button>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setShowSearch(true)}
              aria-label="Find a place"
              className="w-9 h-9 rounded-full flex items-center justify-center bg-white border border-neutral-200 text-neutral-600 transition"
            >
              <Search size={16} />
            </button>
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
              {mapFilter === "friends"
                ? `${(friendCheckins || []).length} ${
                    (friendCheckins || []).length === 1 ? "friend" : "friends"
                  } out`
                : `${inViewPlottable.length} ${
                    inViewPlottable.length === 1 ? "place" : "places"
                  }`}
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
          <BoundsWatcher onBounds={setMapBounds} />
          <MapRef mapRef={mapRef} />
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          />
          {mapFilter === "friends" ? (
            // Friend pins: one per venue, avatar stack + name label, no
            // clustering (there are few, and each pin IS the information).
            friendPins.map((group) => (
              <Marker
                key={`f_${group.venue.id}`}
                position={[
                  Number(group.venue.latitude),
                  Number(group.venue.longitude),
                ]}
                icon={createFriendsIcon(group)}
                eventHandlers={{
                  click: () => setSelectedVenue(group.venue),
                }}
              />
            ))
          ) : (
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
          )}
        </MapContainer>
      </div>
      {mapFilter === "friends" && friendCheckins !== null && friendPins.length === 0 && (
        <div className="absolute left-1/2 -translate-x-1/2 z-[2100] max-w-[85%]" style={{ top: 120 }}>
          <div className="rounded-2xl bg-white/95 border border-neutral-100 shadow-lg px-4 py-3 text-center">
            <p className="text-sm font-medium text-neutral-800">
              No friends out in the last 24 hours
            </p>
            <p className="text-xs text-neutral-500 mt-0.5">
              Check in somewhere and get things moving
            </p>
          </div>
        </div>
      )}
      {selectedVenue && (
        <MapVenueSheet
          venue={selectedVenue}
          onClose={() => setSelectedVenue(null)}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
          onCheckIn={onCheckIn}
          hasNext={hasNext}
          hasPrev={hasPrev}
          onNext={() =>
            hasNext &&
            setSelectedVenue(
              inViewPlottable[(selectedIndex + 1) % inViewPlottable.length]
            )
          }
          onPrev={() =>
            hasPrev &&
            setSelectedVenue(
              inViewPlottable[
                (selectedIndex - 1 + inViewPlottable.length) %
                  inViewPlottable.length
              ]
            )
          }
        />
      )}
      {showSearch && (
        <AddVenueSheet
          onClose={() => setShowSearch(false)}
          showToast={showToast}
          onOpenVenue={flyToVenue}
          onAdded={(venue) => {
            onVenueAdded?.(venue);
            flyToVenue(venue);
          }}
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
                  <MapFilterGroup title="What are you after?">
                    {OCCASION_OPTIONS.map((v) => (
                      <MapFilterChip
                        key={v}
                        on={fOccasions.includes(v)}
                        label={v}
                        onClick={() => toggleOccasion(v)}
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

                  <MapFilterGroup title="Must-haves">
                    {AMENITY_FILTERS.map((a) => (
                      <MapFilterChip
                        key={a.key}
                        on={fAmenities.includes(a.key)}
                        label={a.label}
                        onClick={() => toggleAmenity(a.key)}
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
