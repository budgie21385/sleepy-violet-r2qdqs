// The full-screen map surface: clustered emoji markers over a Leaflet map, the
// All/My List toggle, the independent map filter sheet, and the tap-to-open
// venue sheet. Extracted from App.js; App.js is the only consumer.
import { useState, useMemo, useEffect, useRef, useCallback } from "react";
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
  buildAreaExtents,
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
import { VenueNightsSheet } from "./VenueNightsSheet";
import { searchPlaces, addGooglePlace } from "../lib/venueSearch";
import { ChevronLeft, MapPin, Plus, Minus } from "lucide-react";
import { spotCategory } from "./SpotSheet";

// Spot pins (Sep 6 — the friend knowledge layer): category emoji in a white
// circle with the olive ring. Deliberately unlike venue emoji pins — a spot
// is a tip, not a place to browse.
function createSpotIcon(category) {
  const c = spotCategory(category);
  return L.divIcon({
    html: `<div style="width:34px;height:34px;border-radius:50%;background:#fff;border:2.5px solid #455d3b;box-shadow:0 1px 3px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;font-size:16px;">${c.emoji}</div>`,
    className: "friend-checkin-icon",
    iconSize: [38, 38],
    iconAnchor: [19, 19],
  });
}
import { AddVenueSheet } from "./AddVenueSheet";
import { supabase } from "../supabaseClient";
import { timeAgoShort, FRESH_MS } from "../lib/checkins";

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
  // "What's on" label rides along on the pin, truncated so pins stay pins.
  const whatsOn = group.entries[0].label
    ? ` · ${group.entries[0].label.length > 16 ? group.entries[0].label.slice(0, 15) + "…" : group.entries[0].label}`
    : "";
  const label = `${esc(first)}${extra}${esc(whatsOn)} · ${timeAgoShort(group.entries[0].created_at)}`;
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

// --- Past lens icons (Sep 6 — the memory map) ----------------------------
// Three pin weights, by how much lives at the venue: one person's one night
// = their avatar; multiple nights/people = an olive cluster chip (repeat
// venues visibly accumulate weight); bare been-marks only = a quiet dot.

function pastAvatarHtml(profile, size, extra = "") {
  const style = `width:${size}px;height:${size}px;border-radius:50%;border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,0.25);${extra}`;
  if (profile?.avatar_url) {
    return `<img src="${esc(profile.avatar_url)}" style="${style}object-fit:cover;background:#fff;" />`;
  }
  const initial = esc(
    (profile?.display_name || "?").trim().charAt(0).toUpperCase()
  );
  return `<div style="${style}background:#455d3b;color:#fff;display:flex;align-items:center;justify-content:center;font:600 ${Math.round(size * 0.42)}px sans-serif;">${initial}</div>`;
}

function createPastSingleIcon(profile) {
  return L.divIcon({
    html: `<div style="display:flex;">${pastAvatarHtml(profile, 30, "border-color:#455d3b;")}</div>`,
    className: "friend-checkin-icon",
    iconSize: [34, 34],
    iconAnchor: [17, 17],
  });
}

function createPastClusterIcon(group) {
  const people = [];
  const seen = new Set();
  for (const n of group.nights) {
    for (const e of n.entries) {
      if (!seen.has(e.user_id)) {
        seen.add(e.user_id);
        people.push(e.profile);
      }
      if (people.length >= 2) break;
    }
    if (people.length >= 2) break;
  }
  const avatars = people
    .map((p, i) => pastAvatarHtml(p, 20, i > 0 ? "margin-left:-8px;" : ""))
    .join("");
  return L.divIcon({
    html: `<div style="display:inline-flex;align-items:center;gap:5px;background:#455d3b;border-radius:9999px;padding:3px 9px 3px 3px;box-shadow:0 1px 3px rgba(0,0,0,0.3);">
      <div style="display:flex;">${avatars}</div>
      <span style="font:600 11px sans-serif;color:#fff;">${group.nights.length}</span>
    </div>`,
    className: "friend-checkin-icon",
    iconSize: [70, 28],
    iconAnchor: [35, 14],
  });
}

function createPastMarkIcon() {
  return L.divIcon({
    html: `<div style="width:18px;height:18px;border-radius:50%;background:#455d3b;border:2px solid #fff;box-shadow:0 1px 2px rgba(0,0,0,0.25);display:flex;align-items:center;justify-content:center;"><div style="width:6px;height:6px;border-radius:50%;background:#fff;"></div></div>`,
    className: "friend-checkin-icon",
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

// One person's whole trail (July 25 — profile "Places" counter): a pin at
// every venue they've checked in, visit count + recency on the label.
function createPersonIcon(group, profile) {
  const style =
    "width:30px;height:30px;border-radius:50%;border:2px solid #455d3b;box-shadow:0 1px 3px rgba(0,0,0,0.3);";
  const avatar = profile?.avatar_url
    ? `<img src="${esc(profile.avatar_url)}" style="${style}object-fit:cover;background:#fff;" />`
    : `<div style="${style}background:#455d3b;color:#fff;display:flex;align-items:center;justify-content:center;font:600 13px sans-serif;">${esc(
        (profile?.display_name || "?").trim().charAt(0).toUpperCase()
      )}</div>`;
  const n = group.visits.length;
  const label = `${n > 1 ? `×${n} · ` : ""}${timeAgoShort(
    group.visits[0].created_at
  )}`;
  return L.divIcon({
    html: `<div style="display:flex;flex-direction:column;align-items:center;">
      <div>${avatar}</div>
      <div style="margin-top:2px;background:#fff;border-radius:9999px;padding:1px 7px;font:600 10px sans-serif;color:#455d3b;box-shadow:0 1px 2px rgba(0,0,0,0.25);white-space:nowrap;">${label}</div>
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

export function MapScreen({ venues, savedIds, onSave, onUnsave, onHide, onCheckIn, onOpenThread, onOpenProfile, hiddenIds, areas = [], onVenueAdded, showToast, searchOpen, onSearchOpenChange, userId, personFilter = null, onPersonFilter, onClearPersonFilter, onFiltersSnapshot, onOpenSpot, spotsRefresh = 0 }) {
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
  // openCard=false for the check-in-only flow — the CheckinSheet is the
  // destination there; a venue card lurking behind it is clutter.
  function flyToVenue(venue, { openCard = true } = {}) {
    const lat = Number(venue.latitude);
    const lng = Number(venue.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lng) && mapRef.current) {
      mapRef.current.flyTo(
        [lat, lng],
        Math.max(mapRef.current.getZoom(), 16),
        { duration: 0.8 }
      );
    }
    if (openCard) setSelectedVenue(venue);
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

  // Suburb-first, same as sessions (July 25) — was a blunt 3km circle,
  // which is why the map and a session showed different places.
  const mapAreaExtents = useMemo(
    () => buildAreaExtents(venues, fAreas),
    [venues, fAreas]
  );

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
        .select("user_id, venue_id, created_at, label")
        .eq("kind", "checkin")
        .in("user_id", friendIds)
        // Presence is the TOGGLE, not the timestamp (Aug, Mark's unified
        // form) — quiet check-ins never pin anyone to the live map.
        .eq("show_live", true)
        .gte("created_at", dayAgo)
        // Upcoming nights don't pin friends to the map before they happen
        // (Aug 1) — a future timestamp reads as fresh and drew a live ring.
        .lte("created_at", new Date().toISOString())
        .order("created_at", { ascending: false });
      // Latest check-in per friend = where they ARE (not their whole trail).
      const latestByUser = new Map();
      for (const r of rows || []) {
        if (!latestByUser.has(r.user_id)) latestByUser.set(r.user_id, r);
      }
      const latest = Array.from(latestByUser.values());
      let profById = {};
      let venById = {};
      if (latest.length > 0) {
        const [profsRes, vensRes] = await Promise.all([
          supabase
            .from("profiles")
            .select("id, display_name, username, avatar_url")
            .in("id", latest.map((r) => r.user_id)),
          // Direct fetch (not the curated pool) — open venue reads mean a
          // friend's check-in at their own manual venue still pins for you.
          supabase
            .from("venues")
            .select("*")
            .in("id", Array.from(new Set(latest.map((r) => r.venue_id)))),
        ]);
        profById = Object.fromEntries(
          (profsRes.data || []).map((p) => [p.id, p])
        );
        venById = Object.fromEntries(
          (vensRes.data || []).map((v) => [v.id, v])
        );
      }
      if (cancelled) return;
      setFriendCheckins(
        latest.map((r) => ({
          ...r,
          profile: profById[r.user_id] || null,
          venue: venById[r.venue_id] || null,
        }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [mapFilter, userId]);

  // --- Past lens data (Sep 6 — the memory map) ---------------------------
  // Friends segment splits into two time lenses: Now = live presence (the
  // 24h/show_live fetch above), Past = every venue with a night among you +
  // your friends, plus bare been-marks (friend-readable since Aug 20, still
  // SILENT — passive visibility only). Zero new SQL: activities read rides
  // can_see_activity, marks ride been_marks_friends_read. No show_live
  // filter here: presence is a choice, memory is not.
  // --- Inline search (Sep 6, new map UI — Mark: no Recent list, typing
  // searches places live). The circle expands to a field; results panel
  // sections lead with YOUR list/been, then friends' venues, then the
  // curated map, then Google places not on the map yet (dashed Add).
  const [searchUi, setSearchUi] = useState(false);
  const [q, setQ] = useState("");
  const [searchRes, setSearchRes] = useState({ venues: [], google: [] });
  const [searching, setSearching] = useState(false);
  const [addingId, setAddingId] = useState(null);
  const searchSeq = useRef(0);
  useEffect(() => {
    if (!searchUi) return;
    const term = q.trim();
    if (term.length < 2) {
      setSearchRes({ venues: [], google: [] });
      setSearching(false);
      return;
    }
    setSearching(true);
    const mySeq = ++searchSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await searchPlaces(term, userId);
        if (mySeq === searchSeq.current) setSearchRes(res);
      } finally {
        if (mySeq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [q, searchUi, userId]);

  function closeSearch() {
    setSearchUi(false);
    setQ("");
    setSearchRes({ venues: [], google: [] });
  }

  // FRIENDS DIRECTORY (Sep 6, Mark: "let me use the search to search my
  // friends and see their maps") — on the Friends view, opening search lists
  // your friends before you type; a tap applies the existing person filter
  // (their whole trail, the profile-Places map). Typing narrows by name.
  const [friendsDir, setFriendsDir] = useState(null); // null = not loaded
  useEffect(() => {
    if (!searchUi || mapFilter !== "friends" || !userId || friendsDir) return;
    let cancelled = false;
    (async () => {
      const { data: fr } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id")
        .eq("status", "accepted")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
      const ids = Array.from(
        new Set(
          (fr || []).map((f) =>
            f.requester_id === userId ? f.addressee_id : f.requester_id
          )
        )
      );
      if (ids.length === 0) {
        if (!cancelled) setFriendsDir([]);
        return;
      }
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", ids);
      if (!cancelled)
        setFriendsDir(
          (profs || []).sort((a, b) =>
            (a.display_name || "").localeCompare(b.display_name || "")
          )
        );
    })();
    return () => {
      cancelled = true;
    };
  }, [searchUi, mapFilter, userId, friendsDir]);

  const friendMatches = useMemo(() => {
    if (mapFilter !== "friends" || !friendsDir) return [];
    const term = q.trim().toLowerCase();
    if (!term) return friendsDir;
    return friendsDir.filter(
      (p) =>
        (p.display_name || "").toLowerCase().includes(term) ||
        (p.username || "").toLowerCase().includes(term)
    );
  }, [mapFilter, friendsDir, q]);

  // Whose map is this? (Mark, Sep 6): Friends/Past pins are FRIENDS ONLY —
  // your own footprint lives under My List's Been lens, as your icon. Either
  // way the tap shows the venue's FULL picture, you and friends together.
  const [friendLens, setFriendLens] = useState("now"); // "now" | "past"
  const [myListLens, setMyListLens] = useState("saved"); // "saved" | "been"
  const [pastGroups, setPastGroups] = useState(null); // null = loading
  const wantPast =
    (mapFilter === "friends" && friendLens === "past") ||
    (mapFilter === "my_list" &&
      (myListLens === "been" || myListLens === "not_been")) ||
    searchUi; // search sections need the been/friends sets too
  useEffect(() => {
    if (!wantPast || !userId) return;
    let cancelled = false;
    setPastGroups(null);
    (async () => {
      const { data: fr } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id")
        .eq("status", "accepted")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
      const everyone = Array.from(
        new Set([
          userId,
          ...(fr || []).map((f) =>
            f.requester_id === userId ? f.addressee_id : f.requester_id
          ),
        ])
      );
      const [actsRes, marksRes] = await Promise.all([
        supabase
          .from("activities")
          .select("id, user_id, venue_id, created_at, label, joined_from, is_album")
          .eq("kind", "checkin")
          .in("user_id", everyone)
          .not("venue_id", "is", null)
          // Upcoming nights are plans, not memories.
          .lte("created_at", new Date().toISOString())
          .order("created_at", { ascending: false })
          .limit(500),
        supabase
          .from("been_marks")
          .select("user_id, venue_id, created_at")
          .in("user_id", everyone)
          .limit(500),
      ]);
      const acts = actsRes.data || [];
      const marks = marksRes.data || [];
      const venueIds = Array.from(
        new Set([...acts.map((a) => a.venue_id), ...marks.map((m) => m.venue_id)])
      );
      if (venueIds.length === 0) {
        if (!cancelled) setPastGroups([]);
        return;
      }
      const profIds = Array.from(
        new Set([...acts.map((a) => a.user_id), ...marks.map((m) => m.user_id)])
      );
      const [profsRes, vensRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", profIds),
        supabase.from("venues").select("*").in("id", venueIds),
      ]);
      if (cancelled) return;
      const profById = Object.fromEntries(
        (profsRes.data || []).map((p) => [p.id, p])
      );
      const venById = Object.fromEntries(
        (vensRes.data || []).map((v) => [v.id, v])
      );
      // Group per venue, then merge shared nights inside each venue via
      // joined_from edges (union toward the topmost ancestor present) — the
      // same edge the card merge uses, scoped to one venue so it stays cheap.
      const byVenue = new Map();
      const ensure = (venueId) => {
        const venue = venById[venueId];
        if (
          !venue ||
          !Number.isFinite(Number(venue.latitude)) ||
          !Number.isFinite(Number(venue.longitude))
        )
          return null;
        if (!byVenue.has(venueId))
          byVenue.set(venueId, { venue, rows: [], marks: [] });
        return byVenue.get(venueId);
      };
      for (const a of acts) {
        const g = ensure(a.venue_id);
        if (g) g.rows.push({ ...a, profile: profById[a.user_id] || null });
      }
      for (const m of marks) {
        const g = ensure(m.venue_id);
        // A mark is redundant next to that person's own check-in there.
        if (g && !g.rows.some((r) => r.user_id === m.user_id))
          g.marks.push({ ...m, profile: profById[m.user_id] || null });
      }
      const groups = [];
      for (const g of byVenue.values()) {
        const byId = new Map(g.rows.map((r) => [r.id, r]));
        const rootOf = (row) => {
          let cur = row;
          const seen = new Set();
          while (
            cur.joined_from &&
            byId.has(cur.joined_from) &&
            !seen.has(cur.id)
          ) {
            seen.add(cur.id);
            cur = byId.get(cur.joined_from);
          }
          return cur.id;
        };
        const nightMap = new Map();
        for (const r of g.rows) {
          const root = rootOf(r);
          if (!nightMap.has(root)) nightMap.set(root, []);
          nightMap.get(root).push(r); // rows arrive newest-first
        }
        const nights = Array.from(nightMap.values()).map((entries) => ({
          key: entries[0].id,
          entries,
        }));
        nights.sort(
          (a, b) =>
            new Date(b.entries[0].created_at) - new Date(a.entries[0].created_at)
        );
        groups.push({ venue: g.venue, nights, marks: g.marks });
      }
      setPastGroups(groups);
    })();
    return () => {
      cancelled = true;
    };
  }, [wantPast, userId]);

  // The map filters apply to the memory layers too (Mark, Sep 6: "all the
  // coffee places my friends have been") — same venue predicates as browse,
  // minus the verified/saved gating (a night there IS the qualification).
  const matchesMapFilters = useCallback((v) => {
    const todayKey = getTodayDayKey();
    if (fAreas.length > 0 && !venueMatchesAreas(v, fAreas, 0, mapAreaExtents))
      return false;
    if (fCuisines.length > 0 && !fCuisines.includes(v.cuisine_bucket))
      return false;
    if (fOccasions.length > 0 && !venueMatchesOccasions(v, fOccasions, todayKey))
      return false;
    if (fOpenNow && !isVenueOpenNow(v)) return false;
    if (fMinRating > 0 && !(Number(v.rating) >= fMinRating)) return false;
    if (fPrices.length > 0 && !venueMatchesPrice(v, fPrices)) return false;
    if (fAmenities.length > 0 && !venueMatchesAmenities(v, fAmenities))
      return false;
    return true;
  }, [fAreas, fCuisines, fOccasions, fOpenNow, fMinRating, fPrices, fAmenities, mapAreaExtents]);

  // The two views over the same data. Friends/Past: only venues where a
  // FRIEND has a night or mark, pin faces friends-only. My List/Been: only
  // venues where YOU have a night or mark, pin is your icon.
  const friendPastPins = useMemo(() => {
    if (!pastGroups) return [];
    return pastGroups
      .filter((g) => matchesMapFilters(g.venue))
      .map((g) => ({
        ...g,
        friendNights: g.nights.filter((n) =>
          n.entries.some((e) => e.user_id !== userId)
        ),
        friendMarks: g.marks.filter((m) => m.user_id !== userId),
      }))
      .filter((g) => g.friendNights.length > 0 || g.friendMarks.length > 0);
  }, [pastGroups, userId, matchesMapFilters]);

  const myBeenPins = useMemo(() => {
    if (!pastGroups) return [];
    return pastGroups
      .filter((g) => matchesMapFilters(g.venue))
      .map((g) => {
        const ownNights = g.nights.filter((n) =>
          n.entries.some((e) => e.user_id === userId)
        );
        const ownMark = g.marks.find((m) => m.user_id === userId) || null;
        const ownProfile =
          ownNights[0]?.entries.find((e) => e.user_id === userId)?.profile ||
          ownMark?.profile ||
          null;
        return { ...g, ownNights, ownMark, ownProfile };
      })
      .filter((g) => g.ownNights.length > 0 || g.ownMark);
  }, [pastGroups, userId, matchesMapFilters]);

  // --- SPOTS (Sep 6 — toilets, study spots, parking; never public) -------
  // Plain select: RLS returns yours + accepted friends' rows, nothing else.
  // Whose-map split (Mark's field call, same as Past): Friends/Spots pins
  // FRIENDS' spots only; your own pin under My List's Spots lens.
  const [spots, setSpots] = useState(null); // null = loading
  const wantSpots =
    (mapFilter === "friends" && friendLens === "spots") ||
    (mapFilter === "my_list" && myListLens === "spots");
  useEffect(() => {
    if (!wantSpots || !userId) return;
    let cancelled = false;
    setSpots(null);
    (async () => {
      const { data: rows } = await supabase
        .from("spots")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(300);
      const pIds = Array.from(new Set((rows || []).map((s) => s.user_id)));
      let pById = {};
      if (pIds.length > 0) {
        const { data: profs } = await supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", pIds);
        pById = Object.fromEntries((profs || []).map((p) => [p.id, p]));
      }
      if (cancelled) return;
      setSpots(
        (rows || [])
          .filter(
            (s) =>
              Number.isFinite(Number(s.lat)) && Number.isFinite(Number(s.lng))
          )
          .map((s) => ({ ...s, profile: pById[s.user_id] || null }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [wantSpots, userId, spotsRefresh]);

  const friendSpots = useMemo(
    () => (spots || []).filter((s) => s.user_id !== userId),
    [spots, userId]
  );
  const mySpots = useMemo(
    () => (spots || []).filter((s) => s.user_id === userId),
    [spots, userId]
  );

  // Search sections read the RAW past data (map filters don't trim search).
  const searchOwnBeen = useMemo(() => {
    const ids = new Set();
    for (const g of pastGroups || []) {
      if (
        g.nights.some((n) => n.entries.some((e) => e.user_id === userId)) ||
        g.marks.some((m) => m.user_id === userId)
      )
        ids.add(g.venue.id);
    }
    return ids;
  }, [pastGroups, userId]);
  const searchFriendInfo = useMemo(() => {
    const map = new Map();
    for (const g of pastGroups || []) {
      const names = [];
      const seen = new Set();
      let nights = 0;
      for (const n of g.nights) {
        const friendEntries = n.entries.filter((e) => e.user_id !== userId);
        if (friendEntries.length === 0) continue;
        nights++;
        for (const e of friendEntries) {
          if (!seen.has(e.user_id)) {
            seen.add(e.user_id);
            names.push(
              (e.profile?.display_name || "A friend").split(" ")[0]
            );
          }
        }
      }
      for (const m of g.marks) {
        if (m.user_id !== userId && !seen.has(m.user_id)) {
          seen.add(m.user_id);
          names.push((m.profile?.display_name || "A friend").split(" ")[0]);
        }
      }
      if (seen.size > 0)
        map.set(g.venue.id, { names: names.slice(0, 2), count: nights || seen.size });
    }
    return map;
  }, [pastGroups, userId]);

  // PERSON FILTER (profile "Places"): the whole trail of ONE friend — every
  // venue they've checked in, grouped per venue with visit counts. RLS
  // trims to friends-only for free.
  const [personPins, setPersonPins] = useState([]);
  useEffect(() => {
    if (!personFilter?.userId) {
      setPersonPins([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from("activities")
        .select("venue_id, created_at, label")
        .eq("kind", "checkin")
        .eq("user_id", personFilter.userId)
        .order("created_at", { ascending: false })
        .limit(200);
      const byVenue = new Map();
      for (const r of rows || []) {
        if (!r.venue_id) continue;
        if (!byVenue.has(r.venue_id)) byVenue.set(r.venue_id, []);
        byVenue.get(r.venue_id).push(r);
      }
      const ids = Array.from(byVenue.keys());
      if (ids.length === 0) {
        if (!cancelled) setPersonPins([]);
        return;
      }
      const { data: vens } = await supabase
        .from("venues")
        .select("*")
        .in("id", ids);
      if (cancelled) return;
      setPersonPins(
        (vens || [])
          .filter(
            (v) =>
              Number.isFinite(Number(v.latitude)) &&
              Number.isFinite(Number(v.longitude))
          )
          .map((v) => ({ venue: v, visits: byVenue.get(v.id) }))
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [personFilter?.userId]);

  // Past-lens tap: one night and nothing else = straight into the card (no
  // list of one); anything richer opens the venue's nights sheet.
  const [nightsSheet, setNightsSheet] = useState(null); // a past group or null
  function openNight(night, venue) {
    const t =
      night.entries.find((e) => e.user_id === userId) || night.entries[0];
    const isSelf = t.user_id === userId;
    onOpenThread?.({
      activityId: t.id,
      ownerId: t.user_id,
      ownerName: isSelf ? "You" : t.profile?.display_name || "A friend",
      ownerProfile: isSelf ? null : t.profile || null,
      venueName: venue.name,
      label: t.label || null,
      venueObj: venue,
      timestamp: t.created_at,
    });
  }
  function handlePastTap(group) {
    if (group.nights.length === 1 && group.marks.length === 0) {
      openNight(group.nights[0], group.venue);
    } else {
      setNightsSheet(group);
    }
  }

  // Group visible check-ins by venue — the per-viewer "Mark and John are at X"
  // clustering. One pin per venue, entries newest-first.
  const friendPins = useMemo(() => {
    if (mapFilter !== "friends" || !friendCheckins) return [];
    const groups = new Map();
    for (const c of friendCheckins) {
      const venue = c.venue; // resolved directly at fetch time
      if (
        !venue ||
        !Number.isFinite(Number(venue.latitude)) ||
        !Number.isFinite(Number(venue.longitude))
      )
        continue;
      if (!groups.has(venue.id)) groups.set(venue.id, { venue, entries: [] });
      groups.get(venue.id).entries.push(c);
    }
    return Array.from(groups.values());
  }, [mapFilter, friendCheckins]);

  const displayedPlottable = useMemo(() => {
    if (mapFilter === "friends") return friendPins.map((g) => g.venue);
    const todayKey = getTodayDayKey();
    // Browse map stays curated even though venue READS are open now: pins are
    // verified venues + your saved ones. A venue you created just to check in
    // (e.g. a concert hall) doesn't clutter your map unless you save it.
    let list =
      mapFilter === "my_list" && savedIds
        ? plottable.filter((v) => savedIds.has(v.id))
        : plottable.filter(
            (v) => v.verified === true || (savedIds && savedIds.has(v.id))
          );
    // My List's third lens (Sep 6, Mark): saved places you HAVEN'T been to —
    // the try-next map. Been = own nights + been-marks (searchOwnBeen).
    if (mapFilter === "my_list" && myListLens === "not_been")
      list = list.filter((v) => !searchOwnBeen.has(v.id));
    if (fAreas.length > 0)
      list = list.filter((v) =>
        venueMatchesAreas(v, fAreas, 0, mapAreaExtents)
      );
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
  }, [plottable, mapFilter, myListLens, searchOwnBeen, savedIds, fAreas, fCuisines, fOccasions, fOpenNow, fMinRating, fPrices, fAmenities, friendPins]);

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

  // MAP → SESSION carry (Aug 21, Mark; viewport added Sep 6): snapshot the
  // active filters AND the venues currently on screen up to App, so starting
  // a session from the map's ⊕ inherits both — "the 6 coffee places I'm
  // looking at ARE the shortlist pool". Ref-stored there, read at FAB time.
  // NOTE: this effect must sit BELOW inViewPlottable's declaration (deps
  // array reads it during render — the TDZ trap class).
  useEffect(() => {
    onFiltersSnapshot?.({
      cuisines: fCuisines,
      areas: fAreas,
      occasions: fOccasions, // "What are you after?" — same chips as sessions
      openNow: fOpenNow,
      prices: fPrices,
      amenities: fAmenities,
      viewIds: inViewPlottable.map((v) => v.id),
      // Where the map is centred — a name-only spot's pin lands here.
      mapCenter: mapBounds
        ? { lat: mapBounds.getCenter().lat, lng: mapBounds.getCenter().lng }
        : null,
    });
  }, [fCuisines, fAreas, fOccasions, fOpenNow, fPrices, fAmenities, inViewPlottable, mapBounds]);

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
      {/* FLOATING CHROME (Sep 6, Mark's new map UI): the white header bar is
          gone — the map runs full-bleed and the controls float on it. Row 1:
          segment pills + the search circle. Row 2: lens pills, active filter
          chips, count. The filter button moved to the bottom-right stack,
          above the plus. */}
      {!searchUi && (
        <div className="absolute top-0 left-0 right-0 z-[2000] px-4 pt-3 pointer-events-none">
          <div className="flex items-center gap-2.5 pointer-events-auto">
            <div className="flex flex-1 min-w-0 gap-0.5 rounded-full bg-white p-1 shadow-[0_2px_10px_rgba(30,27,23,0.14)]">
              {[
                { key: "all", label: "All" },
                { key: "my_list", label: "My List" },
                { key: "friends", label: "Friends" },
              ].map((seg) => (
                <button
                  key={seg.key}
                  type="button"
                  onClick={() => {
                    // A segment tap always answers "whose map" — it clears
                    // any one-friend trail view (Sep 6 field find: Emily's
                    // places survived a switch to My List).
                    if (personFilter) onClearPersonFilter?.();
                    setMapFilter(seg.key);
                  }}
                  className={`h-9 flex-1 rounded-full text-[13.5px] font-medium transition ${
                    mapFilter === seg.key
                      ? "bg-[#455d3b] text-white"
                      : "text-neutral-500"
                  }`}
                >
                  {seg.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setSearchUi(true)}
              aria-label="Search places"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-[#455d3b] shadow-[0_2px_10px_rgba(30,27,23,0.14)] active:scale-95 transition"
            >
              <Search size={17} strokeWidth={1.8} />
            </button>
          </div>
          <div className="mt-2.5 flex items-center gap-2 overflow-x-auto pb-1 pointer-events-auto">
            {(mapFilter === "friends" || mapFilter === "my_list") &&
              !personFilter && (
                <div className="flex shrink-0 gap-0.5 rounded-full bg-white p-[3px] shadow-[0_2px_10px_rgba(30,27,23,0.12)]">
                  {(mapFilter === "friends"
                    ? [
                        { key: "now", label: "Now" },
                        { key: "past", label: "Past" },
                        { key: "spots", label: "Spots" },
                      ]
                    : [
                        { key: "saved", label: "Saved" },
                        { key: "been", label: "Been" },
                        { key: "not_been", label: "Haven't been" },
                        { key: "spots", label: "Spots" },
                      ]
                  ).map((lens) => {
                    const active =
                      mapFilter === "friends"
                        ? friendLens === lens.key
                        : myListLens === lens.key;
                    return (
                      <button
                        key={lens.key}
                        type="button"
                        onClick={() =>
                          mapFilter === "friends"
                            ? setFriendLens(lens.key)
                            : setMyListLens(lens.key)
                        }
                        className={`h-[30px] rounded-full px-3.5 text-[13px] font-medium transition ${
                          active
                            ? "bg-[#edf2eb] text-[#455d3b]"
                            : "text-neutral-500"
                        }`}
                      >
                        {lens.label}
                      </button>
                    );
                  })}
                </div>
              )}
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={c.onRemove}
                className="shrink-0 inline-flex h-8 items-center gap-1.5 rounded-full border border-[#c7d4c0] bg-[#e7ede3] pl-3 pr-2 text-[13px] font-medium text-[#33402c]"
              >
                {c.label}
                <X size={11} />
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Place count — bottom centre above the tab bar (Sep 6, Mark: the
          row-2 tally got cut off once the number grew). */}
      {!searchUi && !personFilter && (
        <div className="absolute left-1/2 -translate-x-1/2 z-[2050] bottom-[104px]">
          <span className="block rounded-full bg-white/95 px-3.5 py-1.5 text-[12.5px] font-medium text-neutral-700 shadow-[0_2px_10px_rgba(30,27,23,0.14)] whitespace-nowrap">
              {mapFilter === "friends" && friendLens === "spots"
                ? `${friendSpots.length} ${
                    friendSpots.length === 1 ? "spot" : "spots"
                  }`
                : mapFilter === "my_list" && myListLens === "spots"
                ? `${mySpots.length} ${
                    mySpots.length === 1 ? "spot" : "spots"
                  }`
                : mapFilter === "friends" && friendLens === "past"
                ? `${friendPastPins.length} ${
                    friendPastPins.length === 1 ? "place" : "places"
                  }`
                : mapFilter === "my_list" && myListLens === "been"
                ? `${myBeenPins.length} ${
                    myBeenPins.length === 1 ? "place" : "places"
                  }`
                : mapFilter === "friends"
                ? `${(friendCheckins || []).length} ${
                    (friendCheckins || []).length === 1 ? "friend" : "friends"
                  } out`
                : `${inViewPlottable.length} ${
                    inViewPlottable.length === 1 ? "place" : "places"
                  }`}
          </span>
        </div>
      )}
      <div className="absolute left-0 right-0 bottom-0 top-0">
        <MapContainer
          center={MELBOURNE_CENTER}
          zoom={MELBOURNE_ZOOM}
          zoomControl={false}
          style={{ height: "100%", width: "100%" }}
        >
          <MapResizer />
          <BoundsWatcher onBounds={setMapBounds} />
          <MapRef mapRef={mapRef} />
          {/* Positron with Mark's CARTO basemaps key (Aug 21 — CARTO began
              watermarking keyless tiles). The key is public + domain-
              restricted, so client code is its home. Keyless OSM fallback
              if the key ever lapses:
              url="https://tile.openstreetmap.org/{z}/{x}/{y}.png" */}
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png?key=cb1_2i1k_1_fe5697f3857f77adc7cfbe45"
          />
          {personFilter ? (
            // One friend's trail — their places, their pins.
            personPins.map((group) => (
              <Marker
                key={`p_${group.venue.id}`}
                position={[
                  Number(group.venue.latitude),
                  Number(group.venue.longitude),
                ]}
                icon={createPersonIcon(group, personFilter.profile)}
                eventHandlers={{
                  click: () => setSelectedVenue(group.venue),
                }}
              />
            ))
          ) : mapFilter === "my_list" && myListLens === "spots" ? (
            // YOUR spots.
            mySpots.map((s) => (
              <Marker
                key={`myspot_${s.id}`}
                position={[Number(s.lat), Number(s.lng)]}
                icon={createSpotIcon(s.category)}
                eventHandlers={{
                  click: () => onOpenSpot?.(s),
                }}
              />
            ))
          ) : mapFilter === "friends" && friendLens === "spots" ? (
            // The friend knowledge layer: FRIENDS' spots only, category
            // emoji pins, tap for the card with directions.
            friendSpots.map((s) => (
              <Marker
                key={`spot_${s.id}`}
                position={[Number(s.lat), Number(s.lng)]}
                icon={createSpotIcon(s.category)}
                eventHandlers={{
                  click: () => onOpenSpot?.(s),
                }}
              />
            ))
          ) : mapFilter === "friends" && friendLens === "past" ? (
            // The friends memory map: every venue where a FRIEND has a night
            // or mark (your own footprint pins under My List's Been lens).
            // Pin weight = what lives there: a friend's avatar, an olive
            // count chip, or a quiet been-mark dot.
            <MarkerClusterGroup
              chunkedLoading
              disableClusteringAtZoom={16}
              spiderfyOnMaxZoom={true}
              showCoverageOnHover={false}
              maxClusterRadius={50}
            >
              {friendPastPins.map((group) => {
                const friendOnly = group.friendNights.map((n) => ({
                  entries: n.entries.filter((e) => e.user_id !== userId),
                }));
                const friendPeople = new Set(
                  friendOnly.flatMap((n) => n.entries.map((e) => e.user_id))
                );
                const icon =
                  friendOnly.length === 0
                    ? createPastMarkIcon()
                    : friendOnly.length === 1 && friendPeople.size === 1
                    ? createPastSingleIcon(friendOnly[0].entries[0].profile)
                    : createPastClusterIcon({ nights: friendOnly });
                return (
                  <Marker
                    key={`past_${group.venue.id}`}
                    position={[
                      Number(group.venue.latitude),
                      Number(group.venue.longitude),
                    ]}
                    icon={icon}
                    eventHandlers={{
                      click: () => handlePastTap(group),
                    }}
                  />
                );
              })}
            </MarkerClusterGroup>
          ) : mapFilter === "my_list" && myListLens === "been" ? (
            // YOUR been map: every venue you've had a night at or ticked the
            // Been pill on, pinned as you. Tap = the full picture, you and
            // friends together.
            <MarkerClusterGroup
              chunkedLoading
              disableClusteringAtZoom={16}
              spiderfyOnMaxZoom={true}
              showCoverageOnHover={false}
              maxClusterRadius={50}
            >
              {myBeenPins.map((group) => {
                const ownOnly = group.ownNights.map((n) => ({
                  entries: n.entries.filter((e) => e.user_id === userId),
                }));
                const icon =
                  ownOnly.length > 1
                    ? createPastClusterIcon({ nights: ownOnly })
                    : createPastSingleIcon(group.ownProfile);
                return (
                  <Marker
                    key={`been_${group.venue.id}`}
                    position={[
                      Number(group.venue.latitude),
                      Number(group.venue.longitude),
                    ]}
                    icon={icon}
                    eventHandlers={{
                      click: () => handlePastTap(group),
                    }}
                  />
                );
              })}
            </MarkerClusterGroup>
          ) : mapFilter === "friends" ? (
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
      {!personFilter && !searchUi && mapFilter === "my_list" && myListLens === "not_been" && pastGroups !== null && displayedPlottable.length === 0 && (
        <div className="absolute left-1/2 -translate-x-1/2 z-[2100] max-w-[85%]" style={{ top: 120 }}>
          <div className="rounded-2xl bg-white/95 border border-neutral-100 shadow-lg px-4 py-3 text-center">
            <p className="text-sm font-medium text-neutral-800">
              You've been to everything on your list
            </p>
            <p className="text-xs text-neutral-500 mt-0.5">
              Save some new spots to try next
            </p>
          </div>
        </div>
      )}
      {personFilter && (
        <div
          className="absolute left-1/2 -translate-x-1/2 z-[2100]"
          style={{ top: 120 }}
        >
          <button
            type="button"
            onClick={onClearPersonFilter}
            className="flex items-center gap-2 rounded-full bg-white/95 border border-neutral-100 shadow-lg px-4 py-2 text-xs font-medium text-neutral-800 active:scale-95 transition"
          >
            {(personFilter.profile?.display_name || "Their").split(" ")[0]}'s
            places · {personPins.length}
            <span className="text-neutral-400">✕</span>
          </button>
        </div>
      )}
      {!personFilter && !searchUi && mapFilter === "friends" && friendLens === "spots" && spots !== null && friendSpots.length === 0 && (
        <div className="absolute left-1/2 -translate-x-1/2 z-[2100] max-w-[85%]" style={{ top: 120 }}>
          <div className="rounded-2xl bg-white/95 border border-neutral-100 shadow-lg px-4 py-3 text-center">
            <p className="text-sm font-medium text-neutral-800">
              No friend spots yet
            </p>
            <p className="text-xs text-neutral-500 mt-0.5">
              Their toilets, study spots and parks will land here
            </p>
          </div>
        </div>
      )}
      {!personFilter && !searchUi && mapFilter === "my_list" && myListLens === "spots" && spots !== null && mySpots.length === 0 && (
        <div className="absolute left-1/2 -translate-x-1/2 z-[2100] max-w-[85%]" style={{ top: 120 }}>
          <div className="rounded-2xl bg-white/95 border border-neutral-100 shadow-lg px-4 py-3 text-center">
            <p className="text-sm font-medium text-neutral-800">
              No spots yet
            </p>
            <p className="text-xs text-neutral-500 mt-0.5">
              Know a good toilet, study spot or park? Add it from the plus
            </p>
          </div>
        </div>
      )}
      {!personFilter && mapFilter === "friends" && friendLens === "now" && friendCheckins !== null && friendPins.length === 0 && (
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
      {!personFilter && mapFilter === "friends" && friendLens === "past" && pastGroups !== null && friendPastPins.length === 0 && (
        <div className="absolute left-1/2 -translate-x-1/2 z-[2100] max-w-[85%]" style={{ top: 120 }}>
          <div className="rounded-2xl bg-white/95 border border-neutral-100 shadow-lg px-4 py-3 text-center">
            <p className="text-sm font-medium text-neutral-800">
              No friend nights on the map yet
            </p>
            <p className="text-xs text-neutral-500 mt-0.5">
              Their check-ins and been spots will live here
            </p>
          </div>
        </div>
      )}
      {!personFilter && mapFilter === "my_list" && myListLens === "been" && pastGroups !== null && myBeenPins.length === 0 && (
        <div className="absolute left-1/2 -translate-x-1/2 z-[2100] max-w-[85%]" style={{ top: 120 }}>
          <div className="rounded-2xl bg-white/95 border border-neutral-100 shadow-lg px-4 py-3 text-center">
            <p className="text-sm font-medium text-neutral-800">
              Nowhere marked been yet
            </p>
            <p className="text-xs text-neutral-500 mt-0.5">
              Check in, or tick Been on a venue you know
            </p>
          </div>
        </div>
      )}
      {/* Zoom stack (left) + the relocated filter button (right, above the
          plus FAB — same sheet, same filters, new home). */}
      {!searchUi && !personFilter && (
        <>
          <div className="absolute left-4 bottom-[140px] z-[2050] w-11 overflow-hidden rounded-xl bg-white shadow-[0_2px_10px_rgba(30,27,23,0.14)]">
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => mapRef.current?.zoomIn()}
              className="flex h-11 w-11 items-center justify-center border-b border-neutral-100 text-[#455d3b] active:bg-neutral-50"
            >
              <Plus size={17} strokeWidth={1.9} />
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => mapRef.current?.zoomOut()}
              className="flex h-11 w-11 items-center justify-center text-[#455d3b] active:bg-neutral-50"
            >
              <Minus size={17} strokeWidth={1.9} />
            </button>
          </div>
          <button
            type="button"
            aria-label="Filters"
            onClick={() => setShowFilters(true)}
            className="absolute right-4 bottom-[140px] z-[2050] flex h-12 w-12 items-center justify-center rounded-full bg-white text-[#455d3b] shadow-[0_2px_10px_rgba(30,27,23,0.16)] active:scale-95 transition"
          >
            <SlidersHorizontal size={17} strokeWidth={1.8} />
            {activeCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 border-white bg-[#c0492f] px-1 text-[11px] font-semibold text-white">
                {activeCount}
              </span>
            )}
          </button>
        </>
      )}

      {/* INLINE SEARCH (Sep 6 — no Recent list; typing searches places live).
          Field bar over the map, results panel beneath, sections leading
          with yours, then friends', then the map, then Google + Add. */}
      {searchUi && (
        <div className="absolute inset-0 z-[2500]">
          <div className="absolute inset-x-0 top-0 px-4 pt-3">
            <div className="flex h-11 items-center gap-1.5 rounded-full bg-white pl-1.5 pr-1.5 shadow-[0_2px_12px_rgba(30,27,23,0.16)]">
              <button
                type="button"
                aria-label="Back to the map"
                onClick={closeSearch}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[#455d3b] active:bg-neutral-100"
              >
                <ChevronLeft size={16} strokeWidth={2} />
              </button>
              {/* text-base: sub-16px inputs make iOS Safari auto-zoom. */}
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={
                  mapFilter === "friends"
                    ? "Search friends or places"
                    : "Search places"
                }
                className="h-11 min-w-0 flex-1 bg-transparent text-base text-neutral-900 placeholder:text-neutral-400 focus:outline-none"
              />
              {q && (
                <button
                  type="button"
                  aria-label="Clear"
                  onClick={() => setQ("")}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 active:bg-neutral-200"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              )}
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 top-[68px] overflow-y-auto overscroll-contain rounded-t-[22px] bg-white px-5 pb-8 shadow-[0_-4px_24px_rgba(30,27,23,0.14)]">
            {(() => {
              const friendSection =
                friendMatches.length > 0 ? (
                  <>
                    <p className="pt-4 pb-0.5 text-[11.5px] font-medium uppercase tracking-[0.1em] text-[#a79e90]">
                      Friends
                    </p>
                    {friendMatches.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          closeSearch();
                          onPersonFilter?.({ userId: p.id, profile: p });
                        }}
                        className="flex w-full items-center gap-3 py-[11px] text-left active:bg-neutral-50"
                      >
                        {p.avatar_url ? (
                          <img
                            src={p.avatar_url}
                            alt=""
                            className="h-[34px] w-[34px] shrink-0 rounded-full object-cover bg-neutral-100"
                          />
                        ) : (
                          <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-[#455d3b] text-[13px] font-semibold text-white">
                            {(p.display_name || "?").trim().charAt(0).toUpperCase()}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[14.5px] text-neutral-900">
                            {p.display_name || p.username || "A friend"}
                          </span>
                          <span className="block truncate text-[12.5px] text-neutral-400">
                            See their places
                          </span>
                        </span>
                      </button>
                    ))}
                  </>
                ) : null;
              if (q.trim().length < 2)
                return (
                  <>
                    {friendSection}
                    {!friendSection && (
                      <p className="pt-6 text-sm text-neutral-400">
                        {mapFilter === "friends"
                          ? "Search friends or places"
                          : "Search places, like Market Lane"}
                      </p>
                    )}
                  </>
                );
              const dbRows = searchRes.venues;
              const sMine = dbRows.filter(
                (v) =>
                  (savedIds && savedIds.has(v.id)) || searchOwnBeen.has(v.id)
              );
              const mineIds = new Set(sMine.map((v) => v.id));
              const sFriends = dbRows.filter(
                (v) => !mineIds.has(v.id) && searchFriendInfo.has(v.id)
              );
              const friendIds = new Set(sFriends.map((v) => v.id));
              const sMap = dbRows.filter(
                (v) => !mineIds.has(v.id) && !friendIds.has(v.id)
              );
              const nothing =
                sMine.length + sFriends.length + sMap.length === 0 &&
                searchRes.google.length === 0;
              const label = (text) => (
                <p className="pt-4 pb-0.5 text-[11.5px] font-medium uppercase tracking-[0.1em] text-[#a79e90]">
                  {text}
                </p>
              );
              const row = (v, badge, sub) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    closeSearch();
                    flyToVenue(v);
                  }}
                  className="flex w-full items-center gap-3 py-[11px] text-left active:bg-neutral-50"
                >
                  <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-neutral-100">
                    <MapPin size={15} className="text-neutral-400" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] text-neutral-900">
                      {v.name}
                    </span>
                    <span className="block truncate text-[12.5px] text-neutral-400">
                      {sub ||
                        [v.cuisine_bucket, v.suburb]
                          .filter(Boolean)
                          .join(" · ") ||
                        "On the map"}
                    </span>
                  </span>
                  {badge}
                </button>
              );
              const chip = (text) => (
                <span className="flex h-6 shrink-0 items-center rounded-full bg-[#e7ede3] px-2.5 text-[11.5px] font-medium text-[#33402c]">
                  {text}
                </span>
              );
              return (
                <>
                  {friendSection}
                  {searching && (
                    <p className="pt-4 text-xs text-neutral-400">Searching…</p>
                  )}
                  {sMine.length > 0 && label("In My List · Been")}
                  {sMine.map((v) =>
                    row(
                      v,
                      chip(searchOwnBeen.has(v.id) ? "Been" : "Saved")
                    )
                  )}
                  {sFriends.length > 0 && label("Friends have been")}
                  {sFriends.map((v) => {
                    const info = searchFriendInfo.get(v.id);
                    return row(
                      v,
                      chip(info.count),
                      [
                        v.cuisine_bucket,
                        v.suburb,
                        info.names.join(", "),
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    );
                  })}
                  {sMap.length > 0 && label("On the curated map")}
                  {sMap.map((v) => row(v, null))}
                  {searchRes.google.length > 0 && label("Not on the map yet")}
                  {searchRes.google.map((r) => (
                    <button
                      key={r.place_id}
                      type="button"
                      disabled={addingId === r.place_id}
                      onClick={async () => {
                        if (addingId) return;
                        setAddingId(r.place_id);
                        try {
                          const venue = await addGooglePlace(r.place_id);
                          onVenueAdded?.(venue, { saved: false });
                          closeSearch();
                          flyToVenue(venue);
                        } catch (e) {
                          console.error("Search add failed:", e);
                          showToast?.("Couldn't add that place");
                        } finally {
                          setAddingId(null);
                        }
                      }}
                      className="flex w-full items-center gap-3 py-[11px] text-left active:bg-neutral-50 disabled:opacity-60"
                    >
                      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full border border-dashed border-neutral-300 bg-neutral-50">
                        <Search size={14} className="text-neutral-400" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[14.5px] text-neutral-900">
                          {r.name}
                        </span>
                        <span className="block truncate text-[12.5px] text-neutral-400">
                          {r.address || "From search"}
                        </span>
                      </span>
                      <span className="flex h-6 shrink-0 items-center gap-1 rounded-full border border-dashed border-[#c7d4c0] px-2.5 text-[11.5px] font-medium text-[#4e5c45]">
                        {addingId === r.place_id ? (
                          "Adding…"
                        ) : (
                          <>
                            <Plus size={9} strokeWidth={2.2} />
                            Add
                          </>
                        )}
                      </span>
                    </button>
                  ))}
                  {!searching && nothing && !friendSection && (
                    <p className="pt-5 text-sm text-neutral-400">
                      Nothing found for "{q.trim()}"
                    </p>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}

      {nightsSheet && (
        <VenueNightsSheet
          group={nightsSheet}
          userId={userId}
          onClose={() => setNightsSheet(null)}
          onOpenNight={(night) => {
            const venue = nightsSheet.venue;
            setNightsSheet(null);
            openNight(night, venue);
          }}
        />
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
          onOpenThread={onOpenThread}
          onOpenProfile={onOpenProfile}
          userId={userId}
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
          onAdded={(venue, opts) => {
            onVenueAdded?.(venue, opts);
            // Check-in-only add: glide the map there but keep the card shut —
            // the confetti sheet is the moment.
            flyToVenue(venue, { openCard: opts?.saved !== false });
          }}
          onCheckInAfterAdd={(venue) => onCheckIn?.(venue)}
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
