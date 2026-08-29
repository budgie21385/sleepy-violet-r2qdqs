import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './styles.css';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  TIME_BANDS,
  TIME_BAND_LABELS,
  OCCASION_OPTIONS,
  AMENITY_FILTERS,
  venueMatchesAreas,
  buildAreaExtents,
  orderGroupDeck,
  getTodayDayKey,
  venueOpenInBand,
  isVenueOpenNow,
  venueMatchesVibe,
  venueMatchesOccasions,
  venueMatchesPrice,
  venueMatchesAmenities,
} from "./lib/venueLogic";
import {
  MapFilterGroup,
  MapFilterChip,
  MapFilterSection,
  SearchableChips,
  MapAreaFilter,
} from "./components/MapFilters";
import { VenueCard, BeenPill } from "./components/VenueBits";
import { fetchBeenState, markBeen } from "./lib/been";
import { EmptyState } from "./components/EmptyState";
import { MapVenueSheet } from "./components/MapVenueSheet";
import { MapScreen } from "./components/MapScreen";
import { FloatingActionButton, Toast, BottomTabBar } from "./components/Chrome";
import { ImportGoogleMapsScreen } from "./components/ImportGoogleMapsScreen";
import { ParticipantsStrip } from "./components/ParticipantsStrip";
import { CuratedResultsBoard } from "./components/CuratedResultsBoard";
import { SessionResultsView, ConfettiBurst } from "./components/SessionResultsView";
import { OnboardingScreen } from "./components/OnboardingScreen";
import { GuestHome } from "./components/GuestHome";
import {
  sendFriendRequest,
  acceptFriendRequest,
  friendRequestToast,
} from "./lib/friendships";
import { AddHostFriendCard } from "./components/AddHostFriendCard";
import { ActivityDrawer } from "./components/ActivityDrawer";
import { EventsScreen } from "./components/EventsScreen";
import { FriendAvatar } from "./components/FriendAvatar";
import { CheckinThreadSheet } from "./components/CheckinThreadSheet";
import { CheckinSheet } from "./components/CheckinSheet";
import { BeenScreen, CheckinHistoryRow } from "./components/BeenScreen";
import { performCheckIn } from "./lib/checkins";
// DropdownField retired here July 31 (the segmented advanced row replaced the
// last three) — it lives on in SessionFields for any future consumer.
import { AreaCheckbox } from "./components/SessionFields";
import { realName } from "./lib/names";
import { readDismissed } from "./lib/dismissed";
import { CheckinForm } from "./components/CheckinForm";
import { SessionPeople } from "./components/SessionPeople";
import { AlbumPrompt } from "./components/AlbumPrompt";

// Local yyyy-mm-dd — never toISOString().slice(0,10), that's the UTC date
// and Melbourne runs 10h ahead (the "right now album on yesterday" bug).
function localDateStrApp(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}
import { ALL, MATCH_OPTIONS, RADIUS_OPTIONS } from "./lib/constants";
import { Shuffle, RotateCcw, Heart, X, Search, Locate, LogOut, Users, Check, ArrowLeft, Trash2, MoreVertical, Clock, Download, Upload, UserPlus, UserMinus, Camera, HeartHandshake, ListChecks, MapPin as MapPinIcon } from "lucide-react";
import { supabase } from "./supabaseClient";
import { prefetchVenueDetails } from "./lib/venueDetails";
import { sendPush } from "./lib/push";
import { QRCodeSVG } from "qrcode.react";
import { Turnstile } from "@marsidev/react-turnstile";

// Cloudflare Turnstile site key (public — safe to commit). Bot/captcha
// gate on the three Supabase Auth entry points: host magic-link signin,
// anonymous guest signin, and the anon→email upgrade. The matching
// secret key is held in Supabase Auth → Captcha Protection. If captcha
// is disabled server-side the token is simply ignored, so this widget
// is safe to render before the Supabase side is enabled.
const TURNSTILE_SITE_KEY = "0x4AAAAAADTF1P7KXWBPldrU";
 
// Session/filter constants moved to ./lib/constants.js (imported at the top).
 
// Venue logic + shared constants moved to ./lib/venueLogic.js (imported above).

// createEmojiIcon, MapResizer, MapScreen moved to ./components/MapScreen.js.

function SignInScreen({ inviteHandle }) {
  // "landing" = brand + tagline + Get started CTA
  // "email"   = magic-link email form
  // When inviteHandle is set we entered via /u/@handle — show that context on
  // the landing card and use the current URL as the magic-link redirect so
  // the user lands back on the same invite path post-confirmation. (Local-
  // Storage is the real source of truth — see App-level URL parser — but the
  // redirect helps the new-tab case too.)
  const [view, setView] = useState("landing");
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [captchaToken, setCaptchaToken] = useState(null);
  const turnstileRef = useRef(null);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);

  async function sendMagicLink(e) {
    e.preventDefault();
    if (!email.trim()) return;
    if (!captchaToken) return;
    setSending(true);
    setMessage("");

    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: inviteHandle
          ? `${window.location.origin}/u/@${inviteHandle}`
          : window.location.origin,
        captchaToken,
      },
    });

    // Turnstile tokens are single-use; reset for any retry.
    turnstileRef.current?.reset();
    setCaptchaToken(null);
    setSending(false);
    if (error) {
      setMessage("Couldn't send the code. " + error.message);
    } else {
      setCodeSent(true);
    }
  }

  // Verify the emailed 6-digit code in this browser (no link bounce). Existing
  // users use type 'email'; brand-new signups may need 'signup' — try both.
  async function verifyCode(e) {
    e.preventDefault();
    const c = code.trim();
    if (!c) return;
    setVerifying(true);
    setMessage("");
    const addr = email.trim();
    let { error } = await supabase.auth.verifyOtp({ email: addr, token: c, type: "email" });
    if (error) {
      const retry = await supabase.auth.verifyOtp({ email: addr, token: c, type: "signup" });
      error = retry.error;
    }
    setVerifying(false);
    if (error) {
      setMessage("That code didn't work — check it and try again.");
    }
    // On success, onAuthStateChange signs them in and the app re-renders.
  }

  if (view === "landing") {
    return (
      <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-6">
        <div className="w-full max-w-sm text-center flex flex-col items-center">
          {/* Logo lives at public/flanit-logo.svg and is served as a
              static asset by the React app. */}
          <img
            src="/flanit-logo.svg"
            alt="Flanit"
            className="w-56 h-auto mb-10"
          />
          <h1 className="text-3xl font-semibold tracking-tight leading-tight max-w-[18rem]">
            A place to discover your city with friends.
          </h1>
          {inviteHandle && (
            <div className="mt-6 rounded-2xl bg-white border border-[#c5d4c2] px-4 py-3 text-sm text-neutral-700">
              You're joining to connect with <span className="font-medium">@{inviteHandle}</span>.
            </div>
          )}
          <button
            type="button"
            onClick={() => setView("email")}
            className="mt-10 inline-flex items-center justify-center gap-2 rounded-full bg-[#455d3b] px-7 py-3.5 text-base font-medium text-white active:scale-[0.98] transition shadow-sm"
          >
            {inviteHandle ? "Sign up to continue →" : "Get started →"}
          </button>
        </div>
      </div>
    );
  }

  // view === "email"
  return (
    <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <button
          type="button"
          onClick={() => {
            setView("landing");
            setMessage("");
            setCodeSent(false);
            setCode("");
          }}
          className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-600 hover:text-neutral-900"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
          {!codeSent ? (
            <>
              <h2 className="text-xl font-semibold tracking-tight mb-2">
                Sign in
              </h2>
              <p className="text-sm text-neutral-600 mb-4">
                Pop in your email and we'll send you a 6-digit code.
              </p>
              <form onSubmit={sendMagicLink} className="space-y-3">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  disabled={sending}
                  required
                  className="w-full rounded-2xl bg-neutral-50 px-4 py-4 text-base outline-none border border-neutral-100"
                />
                <div className="flex justify-center">
                  <Turnstile
                    ref={turnstileRef}
                    siteKey={TURNSTILE_SITE_KEY}
                    onSuccess={setCaptchaToken}
                    onExpire={() => setCaptchaToken(null)}
                    onError={() => setCaptchaToken(null)}
                    options={{ theme: "light", appearance: "interaction-only" }}
                  />
                </div>
                <button
                  type="submit"
                  disabled={sending || !email.trim() || !captchaToken}
                  className="w-full rounded-2xl bg-[#455d3b] py-4 font-medium text-white disabled:bg-neutral-300"
                >
                  {sending ? "Sending..." : "Email me a code"}
                </button>
                {message && (
                  <p className="text-sm text-neutral-700 text-center">{message}</p>
                )}
              </form>
            </>
          ) : (
            <>
              <h2 className="text-xl font-semibold tracking-tight mb-2">
                Enter your code
              </h2>
              <p className="text-sm text-neutral-600 mb-4">
                We emailed a 6-digit code to{" "}
                <span className="font-medium">{email.trim()}</span>.
              </p>
              <form onSubmit={verifyCode} className="space-y-3">
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="123456"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 8));
                    if (message) setMessage("");
                  }}
                  className="w-full rounded-2xl bg-neutral-50 px-4 py-4 text-center text-lg tracking-[0.3em] outline-none border border-neutral-100 focus:border-[#455d3b]"
                />
                <button
                  type="submit"
                  disabled={verifying || code.length < 6}
                  className="w-full rounded-2xl bg-[#455d3b] py-4 font-medium text-white disabled:bg-neutral-300"
                >
                  {verifying ? "Checking…" : "Confirm"}
                </button>
                {message && (
                  <p className="text-sm text-red-600 text-center">{message}</p>
                )}
              </form>
              <button
                type="button"
                onClick={() => {
                  setCodeSent(false);
                  setCode("");
                  setMessage("");
                }}
                className="mt-3 w-full text-center text-xs text-neutral-500"
              >
                Wrong email or no code? <span className="font-medium text-[#455d3b]">Start over</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function RestaurantSwipeMVP() {
  const [venues, setVenues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [session, setSession] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [picked, setPicked] = useState(null);
  const [currentUser, setCurrentUser] = useState("mark");
  const [markLikes, setMarkLikes] = useState([]);
  const [partnerLikes, setPartnerLikes] = useState([]);
  const [markPasses, setMarkPasses] = useState([]);
  const [partnerPasses, setPartnerPasses] = useState([]);
  const [tab, setTab] = useState(
    () =>
      (typeof window !== "undefined" && localStorage.getItem("flanit_tab")) ||
      "matches"
  );
  // Persist the active tab so a page refresh stays on the current tab.
  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("flanit_tab", tab);
  }, [tab]);
  const [screen, setScreen] = useState("session_setup");
  const [matchMode, setMatchMode] = useState("solo");
  const [matchSource, setMatchSource] = useState("all");
  const [eventDate, setEventDate] = useState(null);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [selectedCuisines, setSelectedCuisines] = useState([]);
  const [areas, setAreas] = useState([]);
  const [areasLoading, setAreasLoading] = useState(true);
  const [expandedRegions, setExpandedRegions] = useState(() => new Set());
  const [areaSearch, setAreaSearch] = useState("");
  const [selectedAreas, setSelectedAreas] = useState([]);
  // 0 = whole suburb (Mark, July 25). Radius extends past the border.
  const [radiusKm, setRadiusKm] = useState(0);
  const [showAreaDropdown, setShowAreaDropdown] = useState(false);
  const [openNow, setOpenNow] = useState(false);
  const [selectedTimes, setSelectedTimes] = useState([]);
  // "What are you after?" — the merged Vibe + drink-amenity facet (July 9,
  // 2026 setup redesign). Old sessions' filters jsonb may still carry
  // selectedVibes; the guest queue keeps a legacy read path for those.
  const [selectedOccasions, setSelectedOccasions] = useState([]);
  const [selectedPrices, setSelectedPrices] = useState([]); // price levels 1..4
  const [selectedAmenities, setSelectedAmenities] = useState([]); // amenity keys
  // MAP → SESSION FILTER CARRY (Aug 21, Mark: "if someone has created a
  // filter set on the maps and then clicks the plus... carry over the
  // filters"). MapScreen snapshots its local filter state up here; starting
  // a session FROM THE MAP copies the overlapping facets into session
  // filters. Only NON-EMPTY facets copy (session filters are sticky by
  // design — an empty map facet shouldn't wipe a saved preference), and
  // the map's min-rating has no session twin, so it stays behind.
  const mapFiltersRef = useRef(null);
  function carryMapFilters() {
    const f = mapFiltersRef.current;
    if (tab !== "map" || !f) return;
    if (f.cuisines?.length) setSelectedCuisines(f.cuisines);
    if (f.areas?.length) {
      // Map areas may be bare {name, lat, lng} — re-key onto the areas rows
      // the session picker uses, matched by name; unknowns pass through.
      setSelectedAreas(
        f.areas.map((fa) => areas.find((a) => a.name === fa.name) || fa)
      );
    }
    if (f.occasions?.length) setSelectedOccasions(f.occasions);
    if (f.prices?.length) setSelectedPrices(f.prices);
    if (f.amenities?.length) setSelectedAmenities(f.amenities);
    if (f.openNow) setOpenNow(true);
  }
  // Default 1 (Mark, July 24): one match ends a Right Now session — most
  // groups only need the one answer.
  const [matchLimit, setMatchLimit] = useState(1);
  // GROUP MATCH RULES (July 31, Mark). expectedOthers is "how many friends are
  // joining" — the first input in setup, and it DRIVES the rules: a match is
  // unanimous (expected_others + 1 likers, enforced in get_session_matches),
  // groups of 3+ swipe a deterministic 30-venue deck, and the Matches target
  // is forced to 1 (one unanimous venue IS the plan). Pairs keep today's
  // behaviour exactly.
  // 0 = UNSET (Aug 21, Mark) — not a valid party size, a "you haven't
  // answered yet" marker. The stepper pulses and Start stays dead until
  // it's ≥ 1: this number drives unanimity + everyone's-in, and a silently
  // wrong default is the most damaging misconfiguration in the app.
  const [expectedOthers, setExpectedOthers] = useState(0);
  // Session time limit (default 3 HOURS — Aug 1, Mark; the original 30-min
  // default was his July 31 spec when the clock was purely a dead-session
  // safety net, but now it drives real end states and 30 min proved twitchy
  // for how groups actually coordinate). Up to 3 days, in See-more filters.
  // Timeout is how a session that never reaches unanimity ends: the likes go
  // to the host to make the call.
  const SESSION_DURATIONS = [
    [30, "30 mins"],
    [120, "2 hours"],
    [180, "3 hours"],
    [480, "8 hours"],
    [1440, "1 day"],
    [4320, "3 days"],
  ];
  const [sessionTimeoutMins, setSessionTimeoutMins] = useState(180);
  const [sessionExpiresAt, setSessionExpiresAt] = useState(null);
  // When the live session was created — duration changes recompute expiry
  // from HERE (duration is a property of the session, not an increment).
  const [sessionCreatedAt, setSessionCreatedAt] = useState(null);
  // SCHEDULER → ALBUM handoff (Aug 1): "Set up the album" carries the decided
  // venue + chosen date into the Been add form, prefilled. "" date = tonight.
  // THE ONE FORM's open-state (Aug, Mark: "It should stay on the same page
  // you are on") — CheckinForm overlays whatever is on screen; no tab
  // switch, no navigation. {venue?, date, time, mode, invitees}.
  const [checkinForm, setCheckinForm] = useState(null);
  // "Create an album?" after a check-in saves (Aug 21) — holds the thread
  // object while the person decides; either answer opens the card.
  const [albumPromptFor, setAlbumPromptFor] = useState(null);
  const [albumPromptBusy, setAlbumPromptBusy] = useState(false);
  // Been list refresh signal — a night created from the overlay should be
  // there when Been next renders.
  const [beenRefresh, setBeenRefresh] = useState(0);
  function scheduleNight(venue, dateStr, inviteeIds, opts = {}) {
    if (!venue) return;
    // invitees: session friends to auto-tag onto the created night (Aug 1).
    // mode "now" = the venue-card check-in door (Right now preselected);
    // default "date" = album/backdate doors — admin, never presence.
    // time: the plan's clock time, so a 7pm plan makes a 7pm card (Aug).
    setCheckinForm({
      venue,
      date: dateStr || localDateStrApp(),
      time: opts.time || "",
      mode: opts.mode === "now" ? "now" : "date",
      invitees: inviteeIds || [],
      album: opts.album === true, // scheduler door: born-album, no re-ask
    });
  }
  // Which advanced pill's options are open: "matches" | "radius" | "time" |
  // null (all collapsed — the segment labels carry the current values).
  const [advTab, setAdvTab] = useState(null);
  useEffect(() => {
    if (expectedOthers >= 2 && matchLimit !== 1) setMatchLimit(1);
  }, [expectedOthers, matchLimit]);
  // Setup filters: Suburbs / Time of day / What are you after lead;
  // everything else folds into "See more" (Cuisine on top).
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [cardIndex, setCardIndex] = useState(0);
  const [matches, setMatches] = useState([]);
  const [passed, setPassed] = useState([]);
  const [profile, setProfile] = useState(null);
  const [savedVenueIds, setSavedVenueIds] = useState(() => new Set());
  // BEEN STATE for the swipe deck (July 31) — marks + per-venue check-in
  // counts, fetched once (own rows only, cheap) so each card reads state with
  // zero queries. The full venue card self-fetches instead (MapVenueSheet).
  const [beenState, setBeenState] = useState({ marked: new Set(), visits: new Map() });
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid || session.user.is_anonymous) return;
    let cancelled = false;
    fetchBeenState(uid).then((s) => {
      if (!cancelled) setBeenState(s);
    });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, session?.user?.is_anonymous]);
  function deckMarkBeen(venueId) {
    // Optimistic; one-way. No toast — the pill flipping IS the feedback.
    setBeenState((prev) => ({
      ...prev,
      marked: new Set([...prev.marked, venueId]),
    }));
    markBeen(session?.user?.id, venueId);
  }
  const [hiddenVenueIds, setHiddenVenueIds] = useState(() => new Set());
  const [isGuest, setIsGuest] = useState(false);
  // Lightweight global toast surface. Set the message to render; auto-clears
  // after a couple of seconds via the Toast component's own timer. Used by
  // the FAB stubs for "Coming soon" actions in D.1.
  const [toastMessage, setToastMessage] = useState(null);
  const showToast = (msg) => setToastMessage(msg);
  // Lifted from ProfileTab so the FAB on either Profile or Map can trigger
  // the same Import from Google Maps overlay. The overlay itself renders at
  // App level (below) and is full-screen, so it covers whatever tab is active.
  const [showImport, setShowImport] = useState(false);
  // Map search sheet — controlled here so the FAB's "Check in" shortcut can
  // open it from any tab (jump to map → search → venue card → Check in pill).
  const [mapSearchOpen, setMapSearchOpen] = useState(false);
  // Comment thread opened from a venue card's check-in strip or the
  // checked-in pill (the Activity tab renders its own sheet internally).
  const [threadCheckin, setThreadCheckin] = useState(null);
  // Profile → album hops (July 25): the profile stays MOUNTED but invisible
  // while the card is up (visibility, not unmount — unmounting refetched
  // the whole page on return, Mark: "it reloads their page"). Closing the
  // card just unhides it: state, data and scroll all survive.
  const [lookupHidden, setLookupHidden] = useState(false);
  // Profile "Places" counter → the map wearing one friend's trail.
  const [mapPersonFilter, setMapPersonFilter] = useState(null); // {userId, profile}
  // Post-check-in sheet (what's-on label + tag friends) — its own layer over
  // the venue card, opened on every FRESH check-in. { venue, activity }.
  const [checkinSheet, setCheckinSheet] = useState(null);
  // Find Friends sheet — opened by the FAB's Add friend option AND by the
  // FriendsScreen header + icon. Lifted to App level for that shared access.
  const [showFindFriends, setShowFindFriends] = useState(false);
  // Profile lookup overlay — set to a user_id to open. Lifted from ProfileTab
  // so FindFriendsSheet search results can also open profiles.
  const [lookupUserId, setLookupUserId] = useState(null);
  // Activity tab notifications. Derived from existing tables for D.1 — no
  // dedicated notifications table yet. unreadCount drives the tab's red badge.
  const [unreadCount, setUnreadCount] = useState(0);
  // Session id to deep-link into from a tapped notification — opens that
  // session's Your Sessions detail / results board.
  const [notifSessionId, setNotifSessionId] = useState(null);
  // Venue to show in an app-level MapVenueSheet card — e.g. tapping a
  // "You're going to X" decision notification opens that venue's card directly.
  const [cardVenue, setCardVenue] = useState(null);
  // The card's layer follows its ORIGIN (Aug 20, Mark: strip-tap opened the
  // thread UNDER the card): base 3100 lets a thread (3600) stack above;
  // opened FROM a thread it takes 3700 to sit above that thread instead.
  const [cardVenueZ, setCardVenueZ] = useState(3100);
  // Post-signup onboarding (pattern B). Every real account without a username
  // gets the screen — the old came-from-guest deferral is gone (July 31,
  // Mark): gate signups were sailing past with an email-local-part name and
  // no photo. onboardingDismissed persists once-ever so we don't re-pop it
  // every session for someone who skipped.
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    try {
      return !!localStorage.getItem("flanit_onboarding_seen");
    } catch {
      return false;
    }
  });
  function dismissOnboarding() {
    setOnboardingDismissed(true);
    try {
      localStorage.setItem("flanit_onboarding_seen", "1");
    } catch {
      /* ignore */
    }
  }
  // Drives the skip-nudges (Profile-tab dot, Activity item, Profile card): a
  // real signed-in user who's still missing a username or photo.
  const profileIncomplete = !!(
    session?.user?.id &&
    session.user.is_anonymous === false &&
    profile &&
    (!profile.username || !profile.avatar_url)
  );

  // NIGHT DEEP-LINK (July 25, collect links): /?night=<activityId> — set by
  // the /c/ landing after a claim/upload — opens the check-in card once the
  // session is ready. New accounts complete ONBOARDING first (the effect
  // simply waits: it re-runs when profile/onboardingDismissed change), then
  // land on the night with the album loaded.
  const [pendingNightId, setPendingNightId] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get("night") || null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!pendingNightId || !session?.user?.id) return;
    // Mirrors the onboarding gate exactly (came-from-guest deferral removed
    // July 31) — if onboarding is up, wait; the effect re-runs when it's done.
    const needsOnboarding =
      !isGuest &&
      !onboardingDismissed &&
      session.user.is_anonymous === false &&
      profile &&
      !profile.username;
    if (needsOnboarding) return; // onboarding screen is up — wait for it
    let cancelled = false;
    (async () => {
      const { data: act } = await supabase
        .from("activities")
        .select("id, user_id, venue_id, label, created_at")
        .eq("id", Number(pendingNightId))
        .maybeSingle();
      if (cancelled) return;
      if (!act) {
        setPendingNightId(null);
        return;
      }
      const [ownerRes, venueRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .eq("id", act.user_id)
          .maybeSingle(),
        act.venue_id
          ? supabase.from("venues").select("*").eq("id", act.venue_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      if (cancelled) return;
      const ownerProf = ownerRes.data || null;
      const v = venueRes.data || null;
      setThreadCheckin({
        activityId: act.id,
        ownerId: act.user_id,
        ownerName:
          act.user_id === session.user.id
            ? "You"
            : ownerProf?.display_name || "A friend",
        ownerProfile: ownerProf,
        venueName: v?.name || "a spot",
        label: act.label || null,
        venueObj: v,
        timestamp: act.created_at,
      });
      setPendingNightId(null);
      try {
        window.history.replaceState({}, "", "/");
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [pendingNightId, session?.user?.id, profile, onboardingDismissed]);
  // VENUE DEEP-LINK (July 31): /?v=<venueId>[&save=1] — set by the CTAs on the
  // public /v/<id> card. Sending someone a specific bar and landing them on
  // whatever tab they were last on threw the venue away; this opens the card
  // they were actually sent, and &save=1 puts it on their list on arrival.
  //
  // get_public_venue is SECURITY DEFINER, so host-imported venues outside this
  // viewer's pool still resolve. Waits on onboarding exactly like the night
  // deep-link above — the effect re-runs when profile/onboardingDismissed move.
  const [pendingVenue, setPendingVenue] = useState(() => {
    try {
      const p = new URLSearchParams(window.location.search);
      const id = p.get("v");
      return id ? { id: Number(id), save: p.get("save") === "1" } : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!pendingVenue?.id || !session?.user?.id) return;
    // Mirrors the onboarding gate (came-from-guest deferral removed July 31).
    const needsOnboarding =
      !isGuest &&
      !onboardingDismissed &&
      session.user.is_anonymous === false &&
      profile &&
      !profile.username;
    if (needsOnboarding) return; // onboarding screen is up — wait for it
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc("get_public_venue", {
        p_venue_id: pendingVenue.id,
      });
      if (cancelled) return;
      const v = (data && data[0]) || null;
      if (v) {
        setCardVenueZ(3100);
        setCardVenue(v);
        // Keep it in the pool so the card's save/hide controls read correctly.
        setVenues((prev) => (prev.some((x) => x.id === v.id) ? prev : [...prev, v]));
        if (pendingVenue.save) await saveVenue(v.id);
      }
      if (cancelled) return;
      setPendingVenue(null);
      try {
        window.history.replaceState({}, "", "/");
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
    // saveVenue is a stable component function; the deep-link inputs are the
    // real deps. (No eslint-disable here — this project's config has no
    // react-hooks plugin, so disabling a rule it doesn't define is itself the
    // error that fails the build.)
  }, [pendingVenue, session?.user?.id, profile, onboardingDismissed]);

  // Friend-invite landing — set when the URL is /u/@<handle>. We resolve the
  // handle to a user_id once session + profile are loaded, then push it into
  // lookupUserId so ProfileLookupScreen takes over. localStorage backs it up
  // so a magic-link sign-in that loses the URL still resumes correctly.
  const [friendInviteHandle, setFriendInviteHandle] = useState(null);
  const [guestSessionId, setGuestSessionId] = useState(null);
  const [guestSessionData, setGuestSessionData] = useState(null);
  const [guestLoading, setGuestLoading] = useState(true);
  const [guestHostProfile, setGuestHostProfile] = useState(null);
  const [joining, setJoining] = useState(false);
  const [guestName, setGuestName] = useState("");
  const [guestStage, setGuestStage] = useState("splash");
  // Whether this guest has already submitted (read from the DB on load) — lets a
  // refresh restore the results view instead of bouncing back to the splash.
  const [guestSubmittedAt, setGuestSubmittedAt] = useState(undefined);
  const [guestShortlistIds, setGuestShortlistIds] = useState([]);
  // Full venue rows for the curated shortlist, fetched via SECURITY DEFINER
  // RPC so guests can see host-imported (unverified) venues that the general
  // venues query's RLS (verified OR own) would otherwise hide.
  const [guestShortlistVenues, setGuestShortlistVenues] = useState([]);
  // Host's final pick for this session — polled on the guest "Sent" screen.
  const [guestDecidedVenueId, setGuestDecidedVenueId] = useState(null);
  // The plan's WHEN (decided_for, Aug 1) — shown wherever the decision shows.
  const [guestDecidedFor, setGuestDecidedFor] = useState(null);
  // Host's saved list ("My List") for a concurrent source='list' session.
  const [guestListVenues, setGuestListVenues] = useState([]);
  const [guestLikes, setGuestLikes] = useState([]);
  const [guestPasses, setGuestPasses] = useState([]);
  const [guestCardIndex, setGuestCardIndex] = useState(0);
  // Concurrent-mode reconciliation. sessionMatches is the raw RPC payload
  // (one row per venue with like_count + liker_user_ids); sessionParticipants
  // gives us a uid -> display_name map for labelling matches "You + Sarah".
  const [sessionMatches, setSessionMatches] = useState([]);
  // When a session expires with NO unanimous match, the boards fall back to
  // get_session_likes (every liked venue, best first). This flag records that
  // the rows are VOTES, not matches — the reveal copy must not call a 1/3
  // near-miss "a match" (July 31 end-state matrix).
  const [resultsAreVotes, setResultsAreVotes] = useState(false);
  const [sessionParticipants, setSessionParticipants] = useState([]);
  // Guest sign-up flow (anon -> email). guestSignupEmail is the field value,
  // guestSignupSent flips to true after updateUser succeeds, guestSignupError
  // surfaces any updateUser error inline.
  const [guestSignupEmail, setGuestSignupEmail] = useState("");
  const [guestSignupSent, setGuestSignupSent] = useState(false);
  const [guestSignupError, setGuestSignupError] = useState("");
  const [guestSigningUp, setGuestSigningUp] = useState(false);
  // Email OTP code flow: the 6-digit code the user types back in (works in any
  // browser, incl. an in-app browser), the claim token we hold to migrate their
  // anon picks after they verify, and the verify-in-progress flag.
  const [guestSignupCode, setGuestSignupCode] = useState("");
  const [guestClaimToken, setGuestClaimToken] = useState(null);
  const [guestVerifying, setGuestVerifying] = useState(false);
  // Dev-only override so we can visually verify the matches-reveal UI on
  // localhost without going through the real magic-link confirmation flow
  // (Resend's dev sender can only deliver to verified addresses).
  const [devRevealOverride, setDevRevealOverride] = useState(false);
  // Cloudflare Turnstile tokens for the two anon-side Supabase Auth calls:
  // guestCaptchaToken gates signInAnonymously on the splash; guestSignupCaptchaToken
  // gates the updateUser email-upgrade on the end-of-game signup form.
  // Tokens are single-use — reset the widget after each submission.
  const [guestCaptchaToken, setGuestCaptchaToken] = useState(null);
  const [guestSignupCaptchaToken, setGuestSignupCaptchaToken] = useState(null);
  const guestCaptchaRef = useRef(null);
  const guestSignupCaptchaRef = useRef(null);

useEffect(() => {
    // Parse window.location.pathname for two known shapes:
    //   /s/<uuid>     — guest session invite landing
    //   /u/@<handle>  — friend invite landing (Phase D.1 task #11)
    //
    // For /u/@handle we set friendInviteHandle (and stash in localStorage so
    // the magic-link round trip survives). The actual handle → user_id
    // resolution happens in a separate useEffect once session is loaded.
    const path = window.location.pathname;

    // First: check for /u/@handle. URL-decode the path so %40 encodings of
    // the @ work the same as a literal @.
    const decodedPath = (() => {
      try { return decodeURIComponent(path); } catch { return path; }
    })();
    const handleMatch = decodedPath.match(/^\/u\/@?([A-Za-z0-9_]{2,30})\/?$/);
    if (handleMatch) {
      const handle = handleMatch[1].toLowerCase();
      setFriendInviteHandle(handle);
      try {
        localStorage.setItem("flanit_pending_invite_handle", handle);
      } catch {}
      setGuestLoading(false);
      return;
    }

    // Second: check for resumed invite from localStorage (magic-link return)
    try {
      const stashed = localStorage.getItem("flanit_pending_invite_handle");
      if (stashed) {
        setFriendInviteHandle(stashed.toLowerCase());
      }
    } catch {}

    // Third: existing /s/<uuid> guest session path.
    const match = path.match(
      /^\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i
    );

    if (!match) {
      setGuestLoading(false);
      return;
    }

    const sessionId = match[1];
    setIsGuest(true);
    setGuestSessionId(sessionId);

    let cancelled = false;
    supabase
      .from("match_sessions")
      .select("id, host_user_id, mode, source_type, filters, target_matches, expected_others, event_at, expires_at, status, name, created_at")
      .eq("id", sessionId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch guest session:", error);
        }
        setGuestSessionData(data || null);
        setGuestLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!guestSessionId || !guestSessionData?.host_user_id) {
      setGuestHostProfile(null);
      return;
    }
    let cancelled = false;
    supabase
      .rpc("get_session_host_profile", { p_session_id: guestSessionId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch host profile:", error);
          setGuestHostProfile(null);
          return;
        }
        // RPC returns a table → array. Take the first row.
        setGuestHostProfile(Array.isArray(data) ? data[0] || null : data || null);
      });
    return () => {
      cancelled = true;
    };
  }, [guestSessionId, guestSessionData?.host_user_id]);

  useEffect(() => {
    // Clear unless we're a guest in an OPEN curated session (the shortlist
    // RPC returns nothing until the host hits "Done & send"; concurrent
    // sessions have no shortlist — guests swipe the captured filter set).
    if (
      !isGuest ||
      !guestSessionId ||
      guestSessionData?.mode !== "curated" ||
      guestSessionData?.status !== "open"
    ) {
      setGuestShortlistIds([]);
      setGuestShortlistVenues([]);
      return;
    }
    let cancelled = false;
    // Full venue rows via SECURITY DEFINER RPC — bypasses venues RLS so
    // host-imported (unverified) shortlist venues aren't dropped for guests.
    supabase
      .rpc("get_session_shortlist_venues", { p_session_id: guestSessionId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch shortlist venues:", error);
          setGuestShortlistIds([]);
          setGuestShortlistVenues([]);
          return;
        }
        setGuestShortlistVenues(data || []);
        setGuestShortlistIds((data || []).map((v) => v.id));
      });
    return () => {
      cancelled = true;
    };
  }, [isGuest, guestSessionId, guestSessionData?.mode, guestSessionData?.status]);

  // Poll for the host's final pick while a curated guest is on the "Sent"
  // confirmation, so anon guests still on the page see "See you at [venue]"
  // without needing an account.
  useEffect(() => {
    // Both modes now (July 31): a concurrent session's host can decide from
    // the votes after a timeout, and the submitted guest deserves to see it.
    if (!isGuest || guestStage !== "submitted") return;
    if (!guestSessionId) return;
    let cancelled = false;
    function poll() {
      supabase
        .from("match_sessions")
        .select("decided_venue_id, decided_for")
        .eq("id", guestSessionId)
        .single()
        .then(({ data }) => {
          if (cancelled) return;
          setGuestDecidedVenueId(data?.decided_venue_id ?? null);
          setGuestDecidedFor(data?.decided_for ?? null);
        });
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [isGuest, guestStage, guestSessionData?.mode, guestSessionId]);

  // Concurrent + source='list': fetch the host's saved list via SECURITY
  // DEFINER RPC (saved_venues is owner-only RLS) so the guest swipes the
  // host's My List rather than the captured filters.
  useEffect(() => {
    if (
      !isGuest ||
      !guestSessionId ||
      guestSessionData?.mode !== "concurrent" ||
      guestSessionData?.source_type !== "list"
    ) {
      setGuestListVenues([]);
      return;
    }
    let cancelled = false;
    supabase
      .rpc("get_session_list_venues", { p_session_id: guestSessionId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch session list venues:", error);
          setGuestListVenues([]);
          return;
        }
        setGuestListVenues(data || []);
      });
    return () => {
      cancelled = true;
    };
  }, [isGuest, guestSessionId, guestSessionData?.mode, guestSessionData?.source_type]);

  // Fetch session_participants once per concurrent session so the matches
  // screen can label each match with display_names. Re-fetches when a new
  // participant joins (handled by interval polling below).
  useEffect(() => {
    const sessionId = isGuest ? guestSessionId : currentSessionId;
    const mode = isGuest ? guestSessionData?.mode : matchMode;
    if (!sessionId || mode !== "concurrent") {
      setSessionParticipants([]);
      return;
    }
    let cancelled = false;
    async function fetchParticipants() {
      const { data, error } = await supabase
        .from("session_participants")
        .select("user_id, display_name")
        .eq("session_id", sessionId);
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch participants:", error);
        return;
      }
      setSessionParticipants(data || []);
    }
    fetchParticipants();
    // Refresh every 10s so newly-joined participants get labels.
    const interval = setInterval(fetchParticipants, 10000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [isGuest, guestSessionId, currentSessionId, guestSessionData?.mode, matchMode]);

  // Poll get_session_matches every 3s so both host and guest see the match
  // count climb live. Stays active on the end-of-game screens too so late
  // matches from a still-swiping party surface for the party that already
  // finished. Stops when the user navigates away (Done, tab change, etc.).
  //
  // Modes:
  // - Concurrent: host polls on swipe + matches; guest polls on joined +
  //   submitted (both parties are writing per-swipe).
  // - Curated: host polls on invite_share + matches (host's likes were
  //   batched at Done & Send, guest writes per-swipe); guest does NOT poll
  //   during swipe (every guest-like is a match by construction so the
  //   counter uses guestLikes.length directly). Guest still gets a one-shot
  //   refetch on submitted entry.
  useEffect(() => {
    const sessionId = isGuest ? guestSessionId : currentSessionId;
    const mode = isGuest ? guestSessionData?.mode : matchMode;
    let isOnLiveScreen = false;
    if (isGuest) {
      // Guest polls only in concurrent (curated has no need mid-flow).
      isOnLiveScreen =
        mode === "concurrent" &&
        (guestStage === "joined" || guestStage === "submitted");
    } else if (mode === "concurrent") {
      isOnLiveScreen = screen === "swipe" || screen === "matches";
    } else if (mode === "curated") {
      isOnLiveScreen = screen === "invite_share" || screen === "matches";
    }
    if (!sessionId || !isOnLiveScreen) {
      return;
    }
    let cancelled = false;
    async function fetchMatches() {
      const { data, error } = await supabase.rpc("get_session_matches", {
        p_session_id: sessionId,
      });
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch session matches:", error);
        return;
      }
      setSessionMatches(data || []);
    }
    fetchMatches();
    const interval = setInterval(fetchMatches, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [
    isGuest,
    guestSessionId,
    currentSessionId,
    guestSessionData?.mode,
    matchMode,
    guestStage,
    screen,
  ]);

  // ONE BOARD (July 31, Mark: "I think this board is redundant... send them
  // directly to the Sessions Board"). The live end-of-game board was the SAME
  // SessionResultsView the Sessions area mounts, wearing a wrapper (Game over
  // header + Pick for us + Done). Now every Right Now ending routes the host
  // to the Sessions detail via the notifSessionId deep-link — the exact door
  // the Activity drawer and "See the plan" already use. One board, one home.
  // Also kills the waiting-card flash (its render/poll race dies with it).
  function finishSessionToBoard() {
    const sid = currentSessionId;
    setScreen("session_setup");
    setMatches([]);
    setMarkLikes([]);
    setPartnerLikes([]);
    setMarkPasses([]);
    setPartnerPasses([]);
    setSessionMatches([]);
    setResultsAreVotes(false);
    setCurrentSessionId(null);
    setPicked(null);
    setCardIndex(0);
    if (sid) setNotifSessionId(sid);
  }

  // Set the live session's DURATION (Aug 1, Mark: "Duration time: 3 hours" —
  // a property shown and changed in place, not an "extend by" increment).
  // Expiry recomputes from creation, so picking a longer duration extends and
  // a shorter one shortens; if the new expiry is already past, the session
  // simply ends and the existing expiry machinery takes over.
  async function setSessionDuration(mins) {
    if (!currentSessionId || !mins) return;
    const base = new Date(sessionCreatedAt || Date.now()).getTime();
    const next = new Date(base + mins * 60 * 1000).toISOString();
    const { error } = await supabase
      .from("match_sessions")
      .update({ expires_at: next })
      .eq("id", currentSessionId)
      .eq("host_user_id", session?.user?.id);
    if (error) {
      console.error("Duration change failed:", error);
      showToast?.("Couldn't change the duration");
      return;
    }
    setSessionExpiresAt(next);
    setSessionTimeoutMins(mins);
    const lbl =
      SESSION_DURATIONS.find(([v]) => v === mins)?.[1] || `${mins} mins`;
    showToast?.(
      new Date(next).getTime() <= Date.now()
        ? "That time's already up — session ended"
        : `Session set to ${lbl}`
    );
  }

  // Game-end trigger for the host. Concurrent: a live match now goes STRAIGHT
  // to the Sessions board. Curated: no auto-flip — the host opens the results
  // board manually via the "See results" CTA.
  useEffect(() => {
    const target = matchLimit || 0;
    if (!target || sessionMatches.length < target) return;
    if (matchMode === "concurrent" && screen === "swipe") {
      finishSessionToBoard();
    }
    // eslint's exhaustive-deps isn't configured in this repo; the deps below
    // are the real triggers.
  }, [matchMode, screen, matchLimit, sessionMatches.length]);


  // TIME'S UP (July 31) — Right Now runs on a clock now (default 30 min).
  // A group that never reaches unanimity has to end SOMEHOW, and the timeout
  // is how: at expiry the host's game flips to the matches screen, where the
  // likes (fetched below as near-misses when there's no unanimous match) are
  // theirs to decide from. Checked every 15s while the host is swiping.
  useEffect(() => {
    if (matchMode !== "concurrent" || screen !== "swipe") return;
    if (!sessionExpiresAt || !currentSessionId) return;
    const check = () => {
      if (Date.now() < new Date(sessionExpiresAt).getTime()) return;
      // Time's up mid-swipe → the Sessions board, like every other ending.
      // The board does its own likes-fallback when nothing was unanimous.
      finishSessionToBoard();
    };
    const t = setInterval(check, 15000);
    check();
    return () => clearInterval(t);
  }, [matchMode, screen, sessionExpiresAt, currentSessionId, sessionMatches.length]);

  // Refetch reconciliation when the guest hits the submitted screen. Two
  // reasons: (1) curated guests don't get live polling so this is their
  // only fetch; (2) concurrent guests had polling but their last polled
  // snapshot could be stale relative to the host's by up to ~3 seconds
  // (their poll fired before the host's most-recent likes were committed).
  // Without this refetch the host and guest can disagree on the final
  // match list.
  useEffect(() => {
    if (!isGuest) return;
    if (guestStage !== "submitted") return;
    if (!guestSessionId) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc("get_session_matches", {
        p_session_id: guestSessionId,
      });
      if (cancelled) return;
      if (error) {
        console.error("Failed to refetch guest matches:", error);
        return;
      }
      if (data?.length) {
        setSessionMatches(data);
        setResultsAreVotes(false);
        return;
      }
      // Nothing unanimous. If time ran out, fall back to the VOTES so the
      // reveal has something honest to show (flagged — not called matches).
      const expired =
        guestSessionData?.expires_at &&
        Date.now() > new Date(guestSessionData.expires_at).getTime();
      if (expired) {
        const { data: likes } = await supabase.rpc("get_session_likes", {
          p_session_id: guestSessionId,
        });
        if (cancelled) return;
        if (likes?.length) {
          setSessionMatches(likes);
          setResultsAreVotes(true);
          return;
        }
      }
      setSessionMatches([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [isGuest, guestStage, guestSessionId, guestSessionData?.expires_at]);

  // Same refetch on the host side when they transition to the matches
  // screen — applies to both concurrent (last polled snapshot could be a
  // few seconds stale) and curated (host wasn't polling continuously, so
  // a fresh read on entry catches any guest swipes that landed between
  // the last poll and the game-end flip).
  useEffect(() => {
    if (matchMode !== "concurrent" && matchMode !== "curated") return;
    if (screen !== "matches") return;
    if (!currentSessionId) return;
    let cancelled = false;
    supabase
      .rpc("get_session_matches", { p_session_id: currentSessionId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to refetch host matches:", error);
          return;
        }
        setSessionMatches(data || []);
      });
    return () => {
      cancelled = true;
    };
  }, [matchMode, screen, currentSessionId]);

  // LATECOMER CONTEXT for the ended splash (July 31 matrix): what a person
  // arriving after expiry is told depends on what exists — a decided venue
  // (name resolved for signed-in accounts only), votes awaiting the host, or
  // nothing. One fetch when the splash shows a closed/expired session.
  const [splashEnd, setSplashEnd] = useState(null);
  useEffect(() => {
    if (!isGuest || guestStage !== "splash" || !guestSessionId) return;
    const closed =
      guestSessionData?.status === "closed" ||
      (guestSessionData?.expires_at &&
        Date.now() > new Date(guestSessionData.expires_at).getTime());
    if (!closed) return;
    let cancelled = false;
    (async () => {
      const [{ data: sess }, { data: likes }] = await Promise.all([
        supabase
          .from("match_sessions")
          .select("decided_venue_id, decided_for")
          .eq("id", guestSessionId)
          .maybeSingle(),
        supabase.rpc("get_session_likes", { p_session_id: guestSessionId }),
      ]);
      if (cancelled) return;
      let decidedName = null;
      if (
        sess?.decided_venue_id &&
        session?.user?.id &&
        session.user.is_anonymous === false
      ) {
        const { data: v } = await supabase.rpc("get_public_venue", {
          p_venue_id: sess.decided_venue_id,
        });
        decidedName = (v && v[0]?.name) || null;
      }
      if (cancelled) return;
      setSplashEnd({
        decidedName: sess?.decided_venue_id ? decidedName || "the spot" : null,
        decidedFor: sess?.decided_for || null,
        likesCount: (likes || []).length,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [
    isGuest,
    guestStage,
    guestSessionId,
    guestSessionData?.status,
    guestSessionData?.expires_at,
    session?.user?.id,
  ]);

  // Clock tick so the joined-guest effect below re-evaluates expiry — its
  // other deps only change on swipes, and a guest who stops swiping would
  // otherwise never notice time ran out. The tick also RE-READS expires_at
  // (July 31): the host can now end early or extend from their side, and a
  // guest holding the join-time value would either swipe into a decided game
  // (the original "others are just out" complaint) or flip out early.
  const [expiryTick, setExpiryTick] = useState(0);
  useEffect(() => {
    if (!isGuest || guestStage !== "joined") return;
    if (guestSessionData?.mode !== "concurrent") return;
    if (!guestSessionData?.expires_at || !guestSessionId) return;
    const t = setInterval(async () => {
      const { data } = await supabase
        .from("match_sessions")
        .select("expires_at")
        .eq("id", guestSessionId)
        .maybeSingle();
      if (data?.expires_at && data.expires_at !== guestSessionData.expires_at) {
        setGuestSessionData((prev) =>
          prev ? { ...prev, expires_at: data.expires_at } : prev
        );
      }
      setExpiryTick((n) => n + 1);
    }, 15000);
    return () => clearInterval(t);
  }, [isGuest, guestStage, guestSessionData?.mode, guestSessionData?.expires_at, guestSessionId]);

  useEffect(() => {
    if (!isGuest || guestStage !== "joined") return;
    const target = guestSessionData?.target_matches || 0;
    const mode = guestSessionData?.mode;
    let shouldFlip = false;

    let flipByExpiry = false;
    if (mode === "concurrent") {
      // Flip when the match target is reached OR the guest finishes the queue —
      // so a Right now guest always lands on the matches / sign-up screen and
      // never dead-ends on a blank card at end of list. Expiry counts too
      // (July 31): time's up means picks are in, wherever you were in the deck.
      const queueEmpty = guestQueue.length === 0 && guestCardIndex === 0;
      const reachedEnd =
        guestQueue.length > 0 && guestCardIndex >= guestQueue.length;
      const expired =
        guestSessionData?.expires_at &&
        Date.now() > new Date(guestSessionData.expires_at).getTime();
      const targetReached = target > 0 && sessionMatches.length >= target;
      flipByExpiry = !!expired && !targetReached && !reachedEnd && !queueEmpty;
      shouldFlip = targetReached || reachedEnd || queueEmpty || !!expired;
    } else if (mode === "curated") {
      // "Send options": the guest votes the WHOLE shortlist — no target-based
      // early stop (that was the old mutual-match model). Flip only when they
      // reach the end of the shortlist (or it's empty).
      const queueEmpty = guestQueue.length === 0 && guestCardIndex === 0;
      const reachedEnd = guestQueue.length > 0 && guestCardIndex >= guestQueue.length;
      shouldFlip = reachedEnd || queueEmpty;
    }

    if (shouldFlip) {
      setGuestStage("submitted");
      // Time ended this guest's game mid-deck → tell the HOST it's decision
      // time (no server cron, so a participant's device is the only clock
      // that can speak up; several guests expiring together may each send
      // one — rate-limited and better than silence).
      if (flipByExpiry && guestSessionData?.host_user_id) {
        sendPush(
          guestSessionData.host_user_id,
          "⏰ Time's up on your session",
          "See the results and make the call"
        );
      }
      // Fire-and-forget — failure here doesn't block the end screen.
      if (session?.user?.id && guestSessionId) {
        supabase
          .from("session_participants")
          .update({ submitted_at: new Date().toISOString() })
          .eq("session_id", guestSessionId)
          .eq("user_id", session.user.id)
          .then(async ({ error }) => {
            if (error) {
              console.error("Failed to set submitted_at:", error);
              return;
            }
            // Was that the LAST one in? Nudge the host to pick (Mark's
            // simplified flow: host waits, gets told, then chooses).
            const hostId = guestSessionData?.host_user_id;
            const { data: parts } = await supabase
              .from("session_participants")
              .select("user_id, submitted_at")
              .eq("session_id", guestSessionId);
            const others = (parts || []).filter((p) => p.user_id !== hostId);
            const allIn =
              others.length > 0 && others.every((p) => p.submitted_at);
            if (allIn && hostId) {
              sendPush(
                hostId,
                "Everyone's in 🎉",
                "All picks are submitted — make the call"
              );
            }
          });
      }
    }
    // NB: don't add `guestQueue.length` to deps — it's a useMemo declared
    // later in the component (TDZ would throw on evaluation here). The
    // body still reads guestQueue.length safely because the effect runs
    // post-render, by which point guestQueue is initialized. guestLikes
    // and sessionMatches changes drive re-runs frequently enough to catch
    // the right transitions.
  }, [
    isGuest,
    guestSessionData?.mode,
    guestSessionData?.target_matches,
    guestStage,
    sessionMatches.length,
    guestLikes.length,
    guestCardIndex,
    expiryTick,
    session?.user?.id,
    guestSessionId,
  ]);

 useEffect(() => {
    if (openNow) setSelectedTimes([]);
  }, [openNow]);

  // When match mode changes, reset openNow to false. The When? toggle is
  // hidden in multi modes (Right Now = going now so "open now" is implicit;
  // Later = going at a future time so "open now" is irrelevant). Hidden state
  // could still leak through, so force-reset on mode change. (The old
  // timeLimitMinutes snap went July 9, 2026 with the TimeLimitField —
  // expires_at is now always the 24h default at create.)
  useEffect(() => {
    if (matchMode === "concurrent" || matchMode === "curated") {
      setOpenNow(false);
    }
  }, [matchMode]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Redeem a cross-browser claim token. The guest tapped "Save my picks" in an
  // in-app browser; the magic link opened here in their real browser and signed
  // them in. Once they're authenticated (non-anon), pull their anon picks for
  // that session onto this account and drop them into the session.
  const claimRedeemedRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("claim");
    if (!token) return;
    // Wait until a real (non-anonymous) session exists.
    if (!session?.user?.id || session.user.is_anonymous) return;
    if (claimRedeemedRef.current) return;
    claimRedeemedRef.current = true;
    (async () => {
      const { data: sid, error } = await supabase.rpc("claim_session", {
        p_token: token,
      });
      // Strip ?claim either way so a refresh can't retry a burnt token.
      params.delete("claim");
      const clean =
        window.location.pathname + (params.toString() ? `?${params}` : "");
      window.history.replaceState({}, "", clean);
      if (!error && sid) setNotifSessionId(sid);
    })();
  }, [session?.user?.id, session?.user?.is_anonymous]);

  // (cameFromGuestRef deleted July 31 — guest-flow arrivals onboard like
  // everyone else now; see the OnboardingScreen mount.)

  // The identity a gate signup carries across the anon → real account swap
  // (door-typed name, or the anon profile's name for a returning auto-joined
  // guest). Read by the profile fetch above as a race guard; null unless a
  // brand-new account is mid-claim.
  const pendingDoorNameRef = useRef(null);

  useEffect(() => {
    if (!session?.user?.id) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    supabase
      .from("profiles")
      .select("id, display_name, username, tier, avatar_url")
      .eq("id", session.user.id)
      .single()
      .then(({ data, error }) => {
        if (cancelled || error) return;
        // Fetch-race guard (July 31): this fetch fires the moment the anon →
        // real auth swap lands, and can READ the new profile's placeholder
        // seed BEFORE the gate's set_guest_name write commits — clobbering
        // the carried name a beat after we patched it in. If a carried name
        // is pending and the fetched name is still a placeholder, the carried
        // name wins.
        const carried = pendingDoorNameRef.current;
        // Seeded = the trigger's work, not a person's: empty, "New user", or
        // the gate email's local part (the seed when an email exists).
        const local = (guestSignupEmail || "").split("@")[0].trim().toLowerCase();
        const fetched = (data?.display_name || "").trim().toLowerCase();
        const seeded =
          !realName(data?.display_name) || (!!local && fetched === local);
        if (carried && seeded) {
          pendingDoorNameRef.current = null; // one shot — never leaks to a later sign-in
          setProfile({ ...data, display_name: carried });
        } else {
          setProfile(data);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  // Resolve a pending /u/@handle invite once session is loaded. Three
  // branches:
  //   - handle resolves to the viewer themselves → clear and route to Profile
  //   - handle resolves to another user → push into lookupUserId so
  //     ProfileLookupScreen opens with state-aware Add friend / Accept / etc.
  //   - handle not found → toast + clear (no surface to route to)
  // localStorage gets cleared regardless so the handle doesn't re-trigger on
  // every refresh once it's been consumed. We don't wait for `profile` to
  // load — brand-new users don't have a profile row yet, so self-detection
  // happens via comparing resolved id to session.user.id instead.
  useEffect(() => {
    if (!friendInviteHandle) return;
    if (!session?.user?.id) return; // wait for sign-in

    let cancelled = false;

    supabase
      .from("profiles")
      .select("id, username")
      .ilike("username", friendInviteHandle)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        try { localStorage.removeItem("flanit_pending_invite_handle"); } catch {}
        try { window.history.replaceState({}, "", "/"); } catch {}
        if (error || !data) {
          showToast(`No @${friendInviteHandle} on Flanit`);
          setFriendInviteHandle(null);
          return;
        }
        // Self-handle: route to Profile tab instead of opening lookup.
        if (data.id === session.user.id) {
          setFriendInviteHandle(null);
          setTab("profile");
          return;
        }
        setLookupUserId(data.id);
        setFriendInviteHandle(null);
      });

    return () => {
      cancelled = true;
    };
  }, [friendInviteHandle, session?.user?.id]);

  // Refetch the unread (pending request) count on session change and whenever
  // the active tab changes — leaving the Activity tab stamps last-seen and
  // means the user just saw the items, so the count should re-sync.
  useEffect(() => {
    if (!session?.user?.id) {
      setUnreadCount(0);
      return;
    }
    const uid = session.user.id;
    let cancelled = false;
    const lastSeen =
      localStorage.getItem("flanit_drawer_last_seen") ||
      new Date(0).toISOString();
    (async () => {
      const reqRes = await supabase
        .from("friendships")
        .select("id", { count: "exact", head: true })
        .eq("addressee_id", uid)
        .eq("status", "pending");

      const [hostedRes, myPartsRes] = await Promise.all([
        supabase.from("match_sessions").select("id").eq("host_user_id", uid),
        supabase
          .from("session_participants")
          .select("session_id")
          .eq("user_id", uid),
      ]);

      let submittedCount = 0;
      const hostedIds = (hostedRes.data || []).map((s) => s.id);
      if (hostedIds.length) {
        const { count } = await supabase
          .from("session_participants")
          .select("session_id", { count: "exact", head: true })
          .in("session_id", hostedIds)
          .neq("user_id", uid)
          .not("submitted_at", "is", null)
          .gt("submitted_at", lastSeen);
        submittedCount = count ?? 0;
      }

      let decidedCount = 0;
      const partIds = (myPartsRes.data || []).map((p) => p.session_id);
      if (partIds.length) {
        const { count } = await supabase
          .from("match_sessions")
          .select("id", { count: "exact", head: true })
          .in("id", partIds)
          .not("decided_venue_id", "is", null)
          .neq("host_user_id", uid)
          .gt("updated_at", lastSeen);
        decidedCount = count ?? 0;
      }

      let inviteCount = 0;
      {
        const { count } = await supabase
          .from("session_invites")
          .select("session_id", { count: "exact", head: true })
          .eq("invitee_id", uid)
          .gt("created_at", lastSeen);
        inviteCount = count ?? 0;
      }

      // Friend check-ins since last seen (activities RLS already scopes reads
      // to own + friends' rows, so filtering out own is the only client work).
      let checkinCount = 0;
      {
        const { count } = await supabase
          .from("activities")
          .select("id", { count: "exact", head: true })
          .eq("kind", "checkin")
          .neq("user_id", uid)
          .gt("created_at", lastSeen);
        checkinCount = count ?? 0;
      }

      // Pending tag nudges — actionable, so counted regardless of last-seen
      // (same treatment as pending friend requests).
      let tagCount = 0;
      {
        const { count } = await supabase
          .from("activity_tags")
          .select("id", { count: "exact", head: true })
          .eq("tagged_user_id", uid)
          .eq("status", "pending");
        tagCount = count ?? 0;
      }

      // New comments + reactions + join requests on MY check-ins.
      let commentCount = 0;
      let reactionCount = 0;
      let joinReqCount = 0;
      {
        const { data: myActs } = await supabase
          .from("activities")
          .select("id")
          .eq("user_id", uid)
          .eq("kind", "checkin");
        const myActIds = (myActs || []).map((a) => a.id);
        if (myActIds.length > 0) {
          const [cRes, rRes, jRes] = await Promise.all([
            supabase
              .from("activity_comments")
              .select("id", { count: "exact", head: true })
              .in("activity_id", myActIds)
              .neq("user_id", uid)
              .gt("created_at", lastSeen),
            supabase
              .from("activity_reactions")
              .select("id", { count: "exact", head: true })
              .in("activity_id", myActIds)
              .neq("user_id", uid)
              .gt("created_at", lastSeen),
            // Pending join requests (self-requested tags) — actionable, so
            // counted regardless of last-seen.
            supabase
              .from("activity_tags")
              .select("tagged_user_id, requested_by")
              .in("activity_id", myActIds)
              .eq("status", "pending"),
          ]);
          commentCount = cRes.count ?? 0;
          reactionCount = rRes.count ?? 0; // 0 until checkin_reactions.sql runs
          joinReqCount = (jRes.data || []).filter(
            (t) => t.requested_by && t.requested_by === t.tagged_user_id
          ).length;
        }
      }

      // Morning-after photo nudge: own photoless check-ins 12–36h old.
      // Counted regardless of last-seen (actionable, self-expiring window).
      let photoNudgeCount = 0;
      {
        const from = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
        const to = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
        const { data: recent } = await supabase
          .from("activities")
          .select("id")
          .eq("user_id", uid)
          .eq("kind", "checkin")
          .gte("created_at", from)
          .lte("created_at", to);
        const recentIds = (recent || []).map((a) => a.id);
        if (recentIds.length > 0) {
          const { data: withPhotos } = await supabase
            .from("activity_photos")
            .select("activity_id")
            .in("activity_id", recentIds);
          const has = new Set((withPhotos || []).map((p) => p.activity_id));
          // Dismissed in the drawer (Aug, Mark) → doesn't badge either.
          const dis = readDismissed();
          photoNudgeCount = recentIds.filter(
            (id) => !has.has(id) && !dis.has(`pn_${id}`)
          ).length;
        }
      }

      // Session "Did you go?" nudges active this week (following Monday
      // after the outing, not yet answered, no check-in near the date).
      let sessionNudgeCount = 0;
      {
        const followingMonday = (ts) => {
          const d = new Date(ts);
          const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
          m.setDate(m.getDate() + (((8 - m.getDay()) % 7) || 7));
          return m.getTime();
        };
        // Cafés ask the same afternoon; everything else the following Monday
        // (mirrors ActivityDrawer's outing-aware nudge).
        const afternoonAfter = (ts) => {
          const d = new Date(ts);
          const three = new Date(
            d.getFullYear(),
            d.getMonth(),
            d.getDate(),
            15,
            0,
            0
          ).getTime();
          return ts < three ? three : ts + 2 * 60 * 60 * 1000;
        };
        let doneIds = [];
        try {
          doneIds = JSON.parse(
            localStorage.getItem("flanit_session_nudges_done") || "[]"
          );
        } catch {}
        const doneSet = new Set(doneIds);
        const allSessIds = Array.from(
          new Set([
            ...hostedIds,
            ...(myPartsRes.data || []).map((p) => p.session_id),
          ])
        );
        if (allSessIds.length > 0) {
          const { data: sess } = await supabase
            .from("match_sessions")
            .select("id, decided_venue_id, decided_for, event_at, updated_at")
            .in("id", allSessIds)
            .not("decided_venue_id", "is", null);
          const now = Date.now();
          const WEEK = 7 * 24 * 60 * 60 * 1000;
          // Mirrors ActivityDrawer's nudgeRef: the plan's when beats the
          // decide moment; upcoming plans stay silent until they happen.
          const nudgeRef = (s) =>
            new Date(s.decided_for || s.event_at || s.updated_at).getTime();
          const pre = (sess || []).filter((s) => {
            if (doneSet.has(s.id)) return false;
            const ref = nudgeRef(s);
            return ref <= now && now - ref < 16 * 24 * 60 * 60 * 1000;
          });
          let typeById = {};
          if (pre.length > 0) {
            const { data: vTypes } = await supabase
              .from("venues")
              .select("id, type")
              .in(
                "id",
                Array.from(new Set(pre.map((s) => s.decided_venue_id)))
              );
            typeById = Object.fromEntries(
              (vTypes || []).map((v) => [v.id, v.type])
            );
          }
          const cands = pre.filter((s) => {
            const ref = nudgeRef(s);
            // Dated plan → the morning after (mirrors the drawer). Café
            // test made loose here too — the drawer's July 31 fix (case /
            // "Coffee shop" variants) never reached this mirror.
            const t = (typeById[s.decided_venue_id] || "").toLowerCase();
            const dated =
              s.decided_for &&
              new Date(s.decided_for).getTime() -
                new Date(s.updated_at).getTime() >
                60 * 60 * 1000;
            const start = dated
              ? (() => {
                  const d = new Date(ref);
                  return new Date(
                    d.getFullYear(),
                    d.getMonth(),
                    d.getDate() + 1,
                    10,
                    0,
                    0
                  ).getTime();
                })()
              : t.includes("caf") || t.includes("coffee")
              ? afternoonAfter(ref)
              : followingMonday(ref);
            return now >= start && now < start + WEEK;
          });
          if (cands.length > 0) {
            const { data: myCheckins } = await supabase
              .from("activities")
              .select("venue_id, created_at")
              .eq("user_id", uid)
              .eq("kind", "checkin")
              .in(
                "venue_id",
                Array.from(new Set(cands.map((s) => s.decided_venue_id)))
              );
            const disNudge = readDismissed();
            sessionNudgeCount = cands.filter((s) => {
              if (disNudge.has(`sn_${s.id}`)) return false; // ✕'d in drawer
              const ref = nudgeRef(s);
              return !(myCheckins || []).some(
                (c) =>
                  c.venue_id === s.decided_venue_id &&
                  Math.abs(new Date(c.created_at).getTime() - ref) <
                    48 * 60 * 60 * 1000
              );
            }).length;
          }
        }
      }

      // Friends' new friendships since last seen (RPC absent → silent 0).
      let friendNewsCount = 0;
      {
        const { data: fnRows } = await supabase.rpc(
          "friends_new_friendships",
          { p_since: lastSeen }
        );
        if (fnRows?.length) {
          const seenPair = new Set();
          for (const r of fnRows) {
            seenPair.add([r.friend_id, r.other_id].sort().join("_"));
          }
          friendNewsCount = seenPair.size;
        }
      }

      if (cancelled) return;
      setUnreadCount(
        (reqRes.count ?? 0) +
          submittedCount +
          decidedCount +
          inviteCount +
          checkinCount +
          commentCount +
          reactionCount +
          joinReqCount +
          tagCount +
          photoNudgeCount +
          sessionNudgeCount +
          friendNewsCount
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, tab]);

  useEffect(() => {
    if (!session?.user?.id) {
      setSavedVenueIds(new Set());
      setHiddenVenueIds(new Set());
      return;
    }
    let cancelled = false;
    Promise.all([
      supabase
        .from("saved_venues")
        .select("venue_id")
        .eq("user_id", session.user.id),
      supabase
        .from("hidden_venues")
        .select("venue_id")
        .eq("user_id", session.user.id),
    ]).then(([savedRes, hiddenRes]) => {
      if (cancelled) return;
      if (!savedRes.error && savedRes.data) {
        setSavedVenueIds(new Set(savedRes.data.map((r) => r.venue_id)));
      }
      if (!hiddenRes.error && hiddenRes.data) {
        setHiddenVenueIds(new Set(hiddenRes.data.map((r) => r.venue_id)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  async function handleJoinSession(overrideName) {
    // The auto-join effect passes a name string for known signed-in users;
    // the Join button's onClick passes a DOM event, so only accept strings.
    const name = (typeof overrideName === "string" ? overrideName : guestName).trim();
    if (!name) return;
    if (!guestSessionId) return;

    setJoining(true);

    try {
      // If we're not signed in (typical guest case), sign in anonymously.
      // Returning users / the host visiting their own link skip this branch.
      let userId = session?.user?.id;
      let justSignedInAnon = false;
      if (!userId) {
        // Guard: captcha is required for first-time anon signins. The button
        // should already be disabled until the widget produces a token, but
        // guard defensively in case state lags behind the click.
        if (!guestCaptchaToken) {
          setJoining(false);
          return;
        }
        const { data: anonData, error: anonError } =
          await supabase.auth.signInAnonymously({
            options: { captchaToken: guestCaptchaToken },
          });
        // Tokens are single-use; reset for any retry path below.
        guestCaptchaRef.current?.reset();
        setGuestCaptchaToken(null);
        if (anonError) {
          console.error("Anonymous sign-in failed:", anonError);
          setJoining(false);
          return;
        }
        userId = anonData?.user?.id;
        if (!userId) {
          console.error("Anonymous sign-in returned no user");
          setJoining(false);
          return;
        }
        // Explicit session verification: after signInAnonymously resolves,
        // the SDK should have updated its internal session, but in some
        // cases the next REST call uses a stale (or empty) JWT, causing
        // RLS WITH CHECK to fail because server-side auth.uid() doesn't
        // match the user_id we're inserting. Force a getSession() to
        // settle the auth state before continuing.
        const { data: { session: verifySession } } = await supabase.auth.getSession();
        if (!verifySession?.access_token || !verifySession.user?.id) {
          console.error("Post-signIn session check failed", { verifySession });
          setJoining(false);
          return;
        }
        // Prefer the verified session's user id over the signIn response
        // — they should be identical but the verified one matches what
        // the JWT will actually send.
        userId = verifySession.user.id;
        justSignedInAnon = true;
      }

      // Debug: capture exact state at point of upsert. Remove once the
      // anon-join 403 bug is fully understood.
      console.log("Pre-upsert state:", {
        guestSessionId,
        userId,
        sessionUser: session?.user?.id,
        justSignedInAnon,
      });

      // Debug: ask the SERVER who it thinks we are. If this returns the same
      // UUID as userId above, JWT validation works and the issue is
      // elsewhere. If it returns 'NULL', the JWT isn't being validated
      // (which would explain the RLS 403 — auth.uid()=NULL fails the
      // INSERT WITH CHECK).
      const whoamiResult = await supabase.rpc("whoami");
      console.log("Server whoami:", whoamiResult);

      // Debug: evaluate the policy condition server-side with the exact
      // values being inserted. Shows whether auth.uid() matches user_id
      // at policy-eval time, plus the raw JWT claims.
      const debugResult = await supabase.rpc("debug_can_insert", {
        p_session_id: guestSessionId,
        p_user_id: userId,
      });
      console.log("debug_can_insert:", JSON.stringify(debugResult.data, null, 2));

      // Insert participant row via SECURITY DEFINER RPC. We previously
      // called supabase.from("session_participants").upsert(...) directly,
      // but it consistently failed RLS WITH CHECK even when auth.uid()
      // matched user_id (verified via debug_can_insert RPC). The function
      // bypasses RLS but still gates by auth.uid() not null, so the
      // security guarantee is preserved.
      const { data: joinData, error: joinError } = await supabase.rpc(
        "join_session",
        {
          p_session_id: guestSessionId,
          p_display_name: name,
        }
      );

      if (joinError || joinData?.error) {
        console.error("Failed to join session:", joinError || joinData);
        setJoining(false);
        return;
      }

      // Sync the typed name to profile.display_name for anonymous users —
      // this is what makes a RETURNING guest remembered (the auto-join reads
      // profiles). Via set_guest_name (SECURITY DEFINER), NOT a direct table
      // update: the participant insert above had to become an RPC because
      // direct writes from a fresh anon session "consistently failed RLS WITH
      // CHECK even when auth.uid() matched" — and the old direct update here
      // was the same pattern, fire-and-forget with no row-count check, so it
      // failed silently and guests came back as "New user" (July 31, Mark's
      // report). Skipped for signed-in users (never clobber a real name).
      const isAnon =
        justSignedInAnon || session?.user?.is_anonymous === true;
      if (isAnon) {
        supabase
          .rpc("set_guest_name", { p_name: name })
          .then(({ error }) => {
            if (error) console.error("Failed to sync display_name:", error);
          });
      }

      setGuestStage("joined");
    } catch (err) {
      console.error("Join error:", err);
    } finally {
      setJoining(false);
    }
  }

  // Known returning users skip the guest "what should we call you?" screen.
  // If a session link opens while we already know who this is — and they're not
  // the host — auto-join under that identity and go straight to the picks.
  //
  // "Known" is a display name, NOT a real account (Mark, July 31). An anonymous
  // guest who typed their name at a collect-link door has a profiles row too, so
  // asking again is us forgetting someone we just met. A fresh anon has no name
  // and still gets the manual screen, so the name check does the gating on its
  // own. `handleNotForMe` / "Not you?" is the escape hatch on a shared phone.
  const autoJoinedRef = useRef(false);
  useEffect(() => {
    if (!isGuest || autoJoinedRef.current) return;
    if (guestStage !== "splash") return;
    if (guestSessionData?.status !== "open") return;
    const u = session?.user;
    if (!u?.id) return;
    if (u.id === guestSessionData?.host_user_id) return; // host isn't a guest
    if (guestSubmittedAt) return; // already submitted → the restore effect handles it
    // realName, not raw display_name: the handle_new_user trigger seeds every
    // anon with "New user", which is a placeholder, not an identity — letting
    // it through auto-joined a returning guest as "New user" (July 31).
    const name = realName(profile?.display_name);
    if (!name) return; // no REAL name yet → fall back to the manual screen
    // Wait until the venue pool the guest will swipe is actually loaded.
    // Otherwise auto-join races ahead of the data, lands on an empty queue, and
    // the concurrent end-game effect instantly flips to "submitted" → an empty
    // results table. (A manual join doesn't hit this — the human delay lets the
    // pool load first.)
    const mode = guestSessionData?.mode;
    const poolReady =
      mode === "curated"
        ? guestShortlistVenues.length > 0
        : guestSessionData?.source_type === "list"
          ? guestListVenues.length > 0
          : venues.length > 0;
    if (!poolReady) return;
    autoJoinedRef.current = true;
    handleJoinSession(name);
  }, [
    isGuest,
    guestStage,
    guestSessionData?.status,
    guestSessionData?.host_user_id,
    guestSessionData?.mode,
    guestSessionData?.source_type,
    session?.user?.id,
    session?.user?.is_anonymous,
    profile?.display_name,
    venues.length,
    guestListVenues.length,
    guestShortlistVenues.length,
    guestSubmittedAt,
  ]);

  // On (re)load, check whether this guest already submitted in this session. If
  // so, restore the results/submitted view instead of bouncing them back to the
  // splash on a refresh. Keyed off the current uid (the persisted anon one, or
  // their real account after sign-in/claim).
  useEffect(() => {
    if (!isGuest || !session?.user?.id || !guestSessionId) return;
    let cancelled = false;
    supabase
      .from("session_participants")
      .select("submitted_at")
      .eq("session_id", guestSessionId)
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        setGuestSubmittedAt(data?.submitted_at ?? null);
        if (data?.submitted_at) {
          setGuestStage((s) => (s === "splash" ? "submitted" : s));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isGuest, session?.user?.id, guestSessionId]);

  // Anyone we have a name for (not the host) will be auto-joined once the venue
  // pool loads — so we show a "Joining as <name>…" state instead of flashing the
  // "what should we call you?" screen at them. Mirrors the effect above.
  const guestWillAutoJoin =
    isGuest &&
    guestStage === "splash" &&
    guestSessionData?.status === "open" &&
    !!session?.user?.id &&
    session.user.id !== guestSessionData?.host_user_id &&
    !!realName(profile?.display_name) &&
    !guestSubmittedAt;

  function handleNotForMe() {
    // Send them to the root — they can sign in and start their own session
    // if they want, or just close the tab.
    window.location.assign("/");
  }

  // "Not <name>?" — a shared phone auto-joining as whoever it remembers. Only
  // offered to anonymous sessions: a real account signs out through Profile,
  // and we shouldn't invite someone to drop a genuine login by accident.
  // Signing out clears the remembered identity; the reload lands on the same
  // /s/ link with no session, i.e. the manual name screen.
  async function handleNotMe() {
    try {
      await supabase.auth.signOut();
    } catch {}
    window.location.reload();
  }

  // Fire-and-forget DB write for concurrent guest swipes. Mirrors the host's
  // recordHostSwipe so reconciliation can see both sides immediately.
  // Curated keeps batching at submit time (see handleGuestSubmit).
  // The guest's anonymous-auth session populates `session` via
  // onAuthStateChange after Join, so session.user.id is the guest's uid here.
  function recordGuestSwipe(venueId, action) {
    // Per-swipe persistence for both modes:
    // - Concurrent: matches accumulate live as both sides swipe in parallel.
    // - Curated: host's likes are already in session_swipes from Done & Send,
    //   so every guest like is a mutual match. Per-swipe writes mean matches
    //   surface live on the host's invite_share screen.
    if (!guestSessionId || !session?.user?.id) return;
    if (!guestSessionData?.mode) return;
    // Via SECURITY DEFINER RPC, not a direct insert: anon guests' direct
    // session_swipes writes fail RLS WITH CHECK (auth.uid()=NULL at policy
    // eval), so votes were silently dropped. The RPC writes user_id =
    // auth.uid() server-side. Same fix pattern as join_session.
    supabase
      .rpc("record_session_swipe", {
        p_session_id: guestSessionId,
        p_venue_id: venueId,
        p_action: action,
      })
      .then(({ error }) => {
        if (error) console.error("Failed to record guest swipe:", error);
      });
  }

  function handleGuestLike() {
    const v = guestQueue[guestCardIndex];
    if (!v) return;
    recordGuestSwipe(v.id, "like");
    setGuestLikes((prev) => [...prev, v.id]);
    setGuestCardIndex((i) => i + 1);
  }

  function handleGuestPass() {
    const v = guestQueue[guestCardIndex];
    if (!v) return;
    recordGuestSwipe(v.id, "pass");
    setGuestPasses((prev) => [...prev, v.id]);
    setGuestCardIndex((i) => i + 1);
  }

  function handleGuestSubmit() {
    // Curated guests use this to submit their picks. Concurrent doesn't —
    // those flip to 'submitted' automatically via the game-end useEffect.
    setGuestStage("submitted");
  }

  // Drop a (now-authed) guest into the main app shell on the given tab.
  // Cleans the /s/<session_id> URL so subsequent reloads don't re-route
  // them back into the guest flow.
  function goToMainApp(targetTab) {
    setIsGuest(false);
    setTab(targetTab);
    if (typeof window !== "undefined" && window.history?.replaceState) {
      window.history.replaceState(null, "", "/");
    }
  }

  // Anon-to-email upgrade. Attaches an email to the anonymous user so they
  // keep the same auth.uid (and stay linked to their session_swipes /
  // participant row) after confirming via magic link. On confirmation the
  // same-tab onAuthStateChange listener fires, session.user.is_anonymous
  // flips to false, and the submitted-stage UI swaps to the reveal view.
  async function handleGuestSignup(e) {
    if (e && e.preventDefault) e.preventDefault();
    const email = guestSignupEmail.trim();
    if (!email) return;
    if (!guestSignupCaptchaToken) return;
    setGuestSigningUp(true);
    setGuestSignupError("");
    try {
      // Mint a one-time claim token tied to this anon guest's picks + session.
      // It rides along in the magic-link redirect so that when the link opens
      // in the user's REAL browser (escaping any in-app browser) and they
      // authenticate, claim_session migrates their picks onto that account.
      let redirectUrl = window.location.href;
      if (guestSessionId) {
        const { data: claimToken, error: claimErr } = await supabase.rpc(
          "create_session_claim",
          { p_session_id: guestSessionId }
        );
        if (!claimErr && claimToken) {
          setGuestClaimToken(claimToken); // held for the code-verify path
          const u = new URL(window.location.origin + "/");
          u.searchParams.set("claim", claimToken);
          redirectUrl = u.toString();
        }
      }
      // signInWithOtp (not updateUser): sends a normal magic link that signs the
      // user into their account (existing or new) in whatever browser opens it —
      // browser-independent. The claim token reunites their anon picks.
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: redirectUrl,
          captchaToken: guestSignupCaptchaToken,
        },
      });
      // Reset the widget regardless of outcome — tokens are single-use.
      guestSignupCaptchaRef.current?.reset();
      setGuestSignupCaptchaToken(null);
      if (error) {
        setGuestSignupError(error.message || "Couldn't send the link. Try again.");
        return;
      }
      setGuestSignupSent(true);
    } catch (err) {
      console.error("Guest signup error:", err);
      setGuestSignupError("Couldn't send the code. Try again.");
    } finally {
      setGuestSigningUp(false);
    }
  }

  // Verify the 6-digit email code in THIS browser (so an in-app browser can sign
  // in without bouncing out to Chrome), then migrate the anon picks onto the
  // now-authenticated account via the claim token we already hold.
  async function handleVerifyCode(e) {
    if (e && e.preventDefault) e.preventDefault();
    const code = guestSignupCode.trim();
    if (!code) return;
    setGuestVerifying(true);
    setGuestSignupError("");
    try {
      const email = guestSignupEmail.trim();
      // Capture the guest's played-under identity BEFORE verifyOtp swaps the
      // session to the new account (July 31, Mark's test: onboarding prefilled
      // "New user"). A RETURNING anon auto-joined, so the door input was never
      // typed this run — their name lives on the ANON profile, which is about
      // to stop being `profile`. Door input wins if present, anon profile
      // otherwise.
      const carriedName = realName(guestName) || realName(profile?.display_name);
      pendingDoorNameRef.current = carriedName || null;
      // Existing users verify with type 'email'; brand-new signups may need
      // 'signup'. Try 'email' first, fall back to 'signup' so both work.
      let { data: vData, error } = await supabase.auth.verifyOtp({
        email,
        token: code,
        type: "email",
      });
      if (error) {
        const retry = await supabase.auth.verifyOtp({ email, token: code, type: "signup" });
        error = retry.error;
        vData = retry.data;
      }
      if (error) {
        setGuestSignupError("That code didn't work — check it and try again.");
        return;
      }
      // Signed in as their real account in this browser. Reunite their picks.
      if (guestClaimToken) {
        const { error: claimErr } = await supabase.rpc("claim_session", {
          p_token: guestClaimToken,
        });
        if (claimErr) console.error("claim_session after code:", claimErr);
      }
      // Carried name wins when the account's name is a PLACEHOLDER (July 31,
      // second attempt — the created_at "is it new?" inference evaluated
      // false in Mark's test and silently skipped the whole carry). This
      // version can't mis-infer: read the account's ACTUAL profile row. A
      // placeholder name means there's nothing to protect — carry wins. A
      // real name means an existing account — untouched, ref disarmed.
      const { data: freshSess } = await supabase.auth.getSession();
      const newUid = freshSess?.session?.user?.id || vData?.user?.id;
      if (newUid) {
        const { data: freshProf, error: profErr } = await supabase
          .from("profiles")
          .select("id, display_name, username, tier, avatar_url")
          .eq("id", newUid)
          .maybeSingle();
        if (profErr) console.error("Post-claim profile read failed:", profErr);
        // A "real name" here must ALSO not be the email's local part — the
        // handle_new_user trigger seeds display_name from the email when one
        // exists ("budgie21385+ry"), and only "New user" for email-less anons
        // (July 31, Mark's third test run caught this). The gate knows the
        // email, so the seed is detectable exactly here.
        const localPart = email.split("@")[0].trim().toLowerCase();
        const profName = (freshProf?.display_name || "").trim().toLowerCase();
        const hasChosenName =
          !!realName(freshProf?.display_name) && profName !== localPart;
        if (freshProf && hasChosenName) {
          // Existing account with a name someone actually chose — never clobber.
          pendingDoorNameRef.current = null;
          setProfile(freshProf);
        } else if (carriedName) {
          const { error: nameErr } = await supabase.rpc("set_guest_name", {
            p_name: carriedName,
          });
          if (nameErr) console.error("set_guest_name after claim failed:", nameErr);
          // Disarm AFTER any in-flight profile fetch could land (clearing
          // immediately would unguard the exact race the ref exists for);
          // 15s is far past any request, far before any other sign-in.
          setTimeout(() => {
            pendingDoorNameRef.current = null;
          }, 15000);
          setProfile(
            freshProf
              ? { ...freshProf, display_name: carriedName }
              : (prev) => (prev ? { ...prev, display_name: carriedName } : prev)
          );
        } else if (freshProf) {
          setProfile(freshProf);
        }
      }
      // The auth state change re-renders the (now non-anon) submitted view.
    } catch (err) {
      console.error("Verify code error:", err);
      setGuestSignupError("Couldn't verify the code. Try again.");
    } finally {
      setGuestVerifying(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
  }
  // Check in = "I'm here now". Writes an activities row (kind='checkin');
  // accepted friends see it in their Activity tab via RLS. Guarded against
  // double-taps: one check-in per venue per 4 hours.
  // Thin UI wrapper around lib/checkins.performCheckIn — returns the activity
  // row (fresh or already) so the card's pill can flip; null on failure.
  // Fresh check-ins open the CheckinSheet (confetti, label, tags).
  // One profile router (July 23): self → your Profile tab, anyone else →
  // the lookup screen (which sits ABOVE cards, so nothing needs closing).
  function openProfile(uid) {
    if (!uid) return;
    setLookupHidden(false); // any explicit profile open unhides the screen
    if (uid === session?.user?.id) {
      setLookupUserId(null);
      setTab("profile");
      return;
    }
    setLookupUserId(uid);
  }

  async function handleCheckIn(venue, joinedFrom = null) {
    const uid = session?.user?.id;
    if (!uid) {
      showToast("Sign in to check in");
      return null;
    }
    // THE ONE FORM (Aug, Mark: "combine the check in experiences... the
    // been draw to be the standard"). A plain Check in from any venue card
    // routes to the unified form — venue prefilled, Right now selected,
    // live toggle off. Nothing is created until they confirm; the instant
    // check-in + CheckinSheet path is retired for this door.
    if (!joinedFrom) {
      scheduleNight(venue, "", [], { mode: "now" });
      return null;
    }
    // JOINS keep the instant path — "I'm here too" answers a friend's
    // check-in; it isn't composing a night.
    try {
      const { activity, already } = await performCheckIn(uid, venue.id, joinedFrom);
      if (!already) setCheckinSheet({ venue, activity });
      return activity;
    } catch (e) {
      console.error("Check-in failed:", e);
      showToast("Couldn't check in");
      return null;
    }
  }

  async function saveVenue(venueId) {
    if (!session?.user?.id) return;
    setSavedVenueIds((prev) => new Set([...prev, venueId]));
    setHiddenVenueIds((prev) => {
      const next = new Set(prev);
      next.delete(venueId);
      return next;
    });
    await supabase.from("saved_venues").upsert(
      { user_id: session.user.id, venue_id: venueId },
      { onConflict: "user_id,venue_id", ignoreDuplicates: true }
    );
    await supabase
      .from("hidden_venues")
      .delete()
      .eq("user_id", session.user.id)
      .eq("venue_id", venueId);
  }

  async function hideVenue(venueId) {
    if (!session?.user?.id) return;
    setHiddenVenueIds((prev) => new Set([...prev, venueId]));
    setSavedVenueIds((prev) => {
      const next = new Set(prev);
      next.delete(venueId);
      return next;
    });
    await supabase.from("hidden_venues").upsert(
      { user_id: session.user.id, venue_id: venueId },
      { onConflict: "user_id,venue_id", ignoreDuplicates: true }
    );
    await supabase
      .from("saved_venues")
      .delete()
      .eq("user_id", session.user.id)
      .eq("venue_id", venueId);
  }

  async function unsaveVenue(venueId) {
    if (!session?.user?.id) return;
    setSavedVenueIds((prev) => {
      const next = new Set(prev);
      next.delete(venueId);
      return next;
    });
    await supabase
      .from("saved_venues")
      .delete()
      .eq("user_id", session.user.id)
      .eq("venue_id", venueId);
  }

  async function handleDoneAndSend() {
    if (!currentSessionId || !session?.user?.id) return;

    const swipeRows = [
      ...markLikes.map((venueId) => ({
        session_id: currentSessionId,
        user_id: session.user.id,
        venue_id: venueId,
        action: "like",
      })),
      ...markPasses.map((venueId) => ({
        session_id: currentSessionId,
        user_id: session.user.id,
        venue_id: venueId,
        action: "pass",
      })),
    ];

    if (swipeRows.length > 0) {
      const { error: swipeError } = await supabase
        .from("session_swipes")
        .insert(swipeRows);
      if (swipeError) {
        console.error("Failed to write session swipes:", swipeError);
        return;
      }
    }

    const { error: updateError } = await supabase
      .from("match_sessions")
      .update({
        status: "open",
        host_curating_complete_at: new Date().toISOString(),
      })
      .eq("id", currentSessionId);

    if (updateError) {
      console.error("Failed to update session status:", updateError);
      return;
    }

    setScreen("invite_share");
  }

  async function unhideVenue(venueId) {
    if (!session?.user?.id) return;
    setHiddenVenueIds((prev) => {
      const next = new Set(prev);
      next.delete(venueId);
      return next;
    });
    await supabase
      .from("hidden_venues")
      .delete()
      .eq("user_id", session.user.id)
      .eq("venue_id", venueId);
  }

  function soloSave() {
    if (!currentVenue) return;
    const venueId = currentVenue.id;
    saveVenue(venueId);
    setMarkPasses((prev) => [...prev, venueId]);
  }

  function soloSkip() {
    if (!currentVenue) return;
    setMarkPasses((prev) => [...prev, currentVenue.id]);
  }

  function soloHide() {
    if (!currentVenue) return;
    const venueId = currentVenue.id;
    hideVenue(venueId);
    setMarkPasses((prev) => [...prev, venueId]);
  }
 
  useEffect(() => {
    // Venue bootstrap diet (July 21 speed pair): LIGHT columns only — every
    // filter signal + pin/card-header fields. The heavy tail (image arrays,
    // reviews, editorial) hydrates per venue via lib/venueDetails when a
    // card opens. Also: paginated past Supabase's 1,000-row default (we were
    // silently missing venues beyond it), and cached on-device so repeat
    // opens paint instantly (stale-while-revalidate).
    const LIGHT_COLS = [
      "id", "name", "address", "suburb", "latitude", "longitude",
      "type", "cuisine", "cuisine_bucket", "google_types",
      "rating", "review_count", "price_level", "primary_image",
      "verified", "created_by", "google_place_id",
      "monday_hours", "tuesday_hours", "wednesday_hours", "thursday_hours",
      "friday_hours", "saturday_hours", "sunday_hours",
      "serves_breakfast", "serves_brunch", "serves_coffee",
      "serves_cocktails", "serves_dessert", "serves_wine",
      "serves_vegetarian_food", "outdoor_seating", "live_music",
      "allows_dogs", "good_for_groups", "reservable", "takeout", "delivery",
    ].join(",");
    const CACHE_KEY = "flanit_venues_light_v1";

    let cachedIds = null; // Set of ids we painted from cache
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (cached?.rows?.length) {
        cachedIds = new Set(cached.rows.map((v) => v.id));
        setVenues([...cached.rows].sort(() => Math.random() - 0.5));
        setLoading(false);
      }
    } catch {}

    async function loadVenues() {
      const all = [];
      const PAGE = 1000;
      for (let fromIdx = 0; ; fromIdx += PAGE) {
        const { data, error } = await supabase
          .from("venues")
          .select(LIGHT_COLS)
          // ORDER BY is REQUIRED for correct pagination (July 25): without
          // it Postgres gives no stable row order, so consecutive .range()
          // pages can overlap or leave a GAP — venues past the first 1,000
          // silently disappeared from the deck, map and search, and which
          // ones changed run to run.
          .order("id", { ascending: true })
          .range(fromIdx, fromIdx + PAGE - 1);
        if (error) {
          console.error("Error loading venues:", error);
          break;
        }
        all.push(...(data || []));
        if (!data || data.length < PAGE) break;
      }
      if (all.length > 0) {
        try {
          localStorage.setItem(
            CACHE_KEY,
            JSON.stringify({ t: Date.now(), rows: all })
          );
        } catch {}
        // Don't reshuffle mid-use unless the SET actually changed. Comparing
        // counts alone missed an add+remove pair that nets to zero (and kept
        // a stale cache) — compare ids.
        const changed =
          !cachedIds ||
          cachedIds.size !== all.length ||
          all.some((v) => !cachedIds.has(v.id));
        if (changed) {
          setVenues([...all].sort(() => Math.random() - 0.5));
        }
      }
      setLoading(false);
    }
    loadVenues();
  }, []);
 
  useEffect(() => {
    async function loadAreas() {
      const { data, error } = await supabase
        .from("areas")
        .select("id, name, state, region, lat, lng")
        .order("region", { ascending: true })
        .order("name", { ascending: true });
      if (error) {
        console.error("Error loading areas:", error);
      } else {
        setAreas(data || []);
      }
      setAreasLoading(false);
    }
loadAreas();
  }, []);

  const cuisines = useMemo(() => {
    const availableVenues = venues.filter((venue) =>
      venueMatchesAreas(venue, selectedAreas, radiusKm)
    );
    return [
      ALL,
      ...Array.from(new Set(availableVenues.map((venue) => venue.cuisine_bucket)))
        .filter(Boolean)
        .sort(),
    ];
  }, [venues, selectedAreas, radiusKm]);

  // (availableTimes / availableVibes memos removed July 9, 2026 — the redesigned
  // setup screen shows all time-band and occasion chips unconditionally, so
  // nothing needs the computed availability lists anymore.)

  useEffect(() => {
    setSelectedCuisines((currentSelected) =>
      currentSelected.filter((cuisine) => cuisines.includes(cuisine))
    );
  }, [cuisines]);
 
  // With venue reads now open (any signed-in user resolves any venue for
  // check-in/social surfaces), CURATION is client-side: the swipe/match pool
  // only ever contains verified venues, your own additions, or your saved
  // ones — strangers' manual venues resolve by id but never enter your pool.
  // THE TIMBER YARD RULE (July 25 fix): being somewhere is not curating it.
  // A venue you created just to check in (work, a mate's gym, a cinema) must
  // NOT enter the swipe deck or the map — only VERIFIED venues and ones you
  // deliberately SAVED do. `created_by === me` used to sneak them back in
  // here, which is why checking in at work put work in a match session; the
  // map never had that clause, hence the two disagreed.
  const isPoolVenue = (venue) =>
    venue.verified === true || savedVenueIds.has(venue.id);

  // Suburb footprints for the selected areas — computed once per change,
  // not per venue (see buildAreaExtents).
  const areaExtents = useMemo(
    () => buildAreaExtents(venues, selectedAreas),
    [venues, selectedAreas]
  );

  const filteredVenues = useMemo(() => {
    const todayKey = getTodayDayKey();
    return venues.filter((venue) => {
      if (!isPoolVenue(venue)) return false;
      if (hiddenVenueIds.has(venue.id)) return false;
      const matchesArea = venueMatchesAreas(
        venue,
        selectedAreas,
        radiusKm,
        areaExtents
      );
      if (!matchesArea) return false;
 
      const matchesCuisine =
        selectedCuisines.length === 0 ||
        selectedCuisines.includes(venue.cuisine_bucket);
      if (!matchesCuisine) return false;
 
      if (openNow && !isVenueOpenNow(venue)) return false;
 
      if (selectedTimes.length > 0) {
        const anyBandMatches = selectedTimes.some((label) => {
          const band = TIME_BANDS.find((b) => b.key === label);
          return band && venueOpenInBand(venue, todayKey, band);
        });
        if (!anyBandMatches) return false;
      }
 
      if (!venueMatchesOccasions(venue, selectedOccasions, todayKey))
        return false;

      if (!venueMatchesPrice(venue, selectedPrices)) return false;
      if (!venueMatchesAmenities(venue, selectedAmenities)) return false;

      return true;
    });
  }, [
    venues,
    selectedAreas,
    radiusKm,
    areaExtents,
    selectedCuisines,
    openNow,
    selectedTimes,
    selectedOccasions,
    selectedPrices,
    selectedAmenities,
    hiddenVenueIds,
    savedVenueIds,
    session?.user?.id,
  ]);
 
  const currentUserSwipedIds =
    currentUser === "mark"
      ? [...markLikes, ...markPasses]
      : [...partnerLikes, ...partnerPasses];
 
  const swipeQueue = useMemo(() => {
    let q;
    if (matchSource === "my_list") {
      q = filteredVenues.filter((v) => savedVenueIds.has(v.id));
    } else if (matchMode === "solo") {
      q = filteredVenues.filter((v) => !savedVenueIds.has(v.id));
    } else {
      q = filteredVenues;
    }
    // Groups of 3+ swipe the SAME deck in the SAME order (orderGroupDeck is
    // deterministic — guests apply the identical sort to the identical pool).
    // No cap: every filtered venue is available (Mark, July 31 evening).
    if (matchMode === "concurrent" && expectedOthers >= 2) q = orderGroupDeck(q);
    return q;
  }, [filteredVenues, matchSource, matchMode, savedVenueIds, expectedOthers]);

  const guestQueueRaw = useMemo(() => {
    if (!isGuest || !guestSessionData) return [];

    // Curated: vote the host's shortlist (RPC rows, bypass venues RLS so
    // host-imported venues are included for the guest).
    if (guestSessionData.mode === "curated") {
      return guestShortlistVenues;
    }

    // Concurrent: candidate pool is the host's saved list (source='list') or
    // all venues, then narrowed by the host's captured filters — the same set
    // the host swiped, so both sides share one pool.
    const pool =
      guestSessionData.source_type === "list" ? guestListVenues : venues;
    if (!pool.length) return [];
    const filters = guestSessionData.filters || {};
    const todayKey = getTodayDayKey();
    const sessionAreas = filters.selectedAreaIds && areas.length
      ? areas.filter((a) => filters.selectedAreaIds.includes(a.id))
      : [];
    const sessionRadius =
      typeof filters.radiusKm === "number" ? filters.radiusKm : 0;
    const sessionExtents = buildAreaExtents(pool, sessionAreas);

    return pool.filter((venue) => {
      // Same client-side curation as the host pool (see isPoolVenue): open
      // venue reads must not leak strangers' manual venues into guest queues.
      if (
        guestSessionData.source_type !== "list" &&
        !(venue.verified === true || savedVenueIds.has(venue.id))
      )
        return false;
      if (!venueMatchesAreas(venue, sessionAreas, sessionRadius, sessionExtents))
        return false;

      if (filters.selectedCuisines && filters.selectedCuisines.length > 0) {
        if (!filters.selectedCuisines.includes(venue.cuisine_bucket)) return false;
      }

      if (filters.openNow && !isVenueOpenNow(venue)) return false;

      if (filters.selectedTimes && filters.selectedTimes.length > 0) {
        const anyBand = filters.selectedTimes.some((label) => {
          const band = TIME_BANDS.find((b) => b.key === label);
          return band && venueOpenInBand(venue, todayKey, band);
        });
        if (!anyBand) return false;
      }

      // New sessions (July 9, 2026+) write selectedOccasions; older sessions'
      // filters jsonb carries selectedVibes. Support both so old share links
      // keep filtering the same pool the host saw.
      if (!venueMatchesOccasions(venue, filters.selectedOccasions, todayKey))
        return false;
      if (filters.selectedVibes && filters.selectedVibes.length > 0) {
        const anyVibe = filters.selectedVibes.some((vibe) =>
          venueMatchesVibe(venue, vibe, todayKey)
        );
        if (!anyVibe) return false;
      }

      if (!venueMatchesPrice(venue, filters.selectedPrices)) return false;
      if (!venueMatchesAmenities(venue, filters.selectedAmenities)) return false;

      return true;
    });
  }, [isGuest, guestSessionData, venues, areas, guestShortlistIds, guestShortlistVenues, guestListVenues, savedVenueIds, session?.user?.id]);
  // Groups of 3+ hold the SAME deck in the SAME order as the host —
  // orderGroupDeck is deterministic over the same filtered pool, which is the
  // entire point: unanimity needs overlapping decks. No cap (July 31 evening).
  const guestQueue =
    guestSessionData?.mode === "concurrent" &&
    (guestSessionData?.expected_others || 0) >= 2
      ? orderGroupDeck(guestQueueRaw)
      : guestQueueRaw;

  const currentVenue = swipeQueue.find(
    (venue) => !currentUserSwipedIds.includes(venue.id)
  );

  // Host waiting state (Mark, July 23): finishing YOUR swipes isn't the end
  // of the session. Poll whether all non-host participants have submitted —
  // until then the end screen is a simple "we'll let you know" card.
  const [allPartsSubmitted, setAllPartsSubmitted] = useState(false);
  // How many of the declared party haven't submitted yet — the waiting card's
  // tally ("Waiting on 2 more"). Fed by the same poll as allPartsSubmitted.
  const [waitingOthersLeft, setWaitingOthersLeft] = useState(0);
  useEffect(() => {
    if (screen !== "matches" || matchMode !== "concurrent" || !currentSessionId) {
      setAllPartsSubmitted(false);
      return;
    }
    let stop = false;
    async function checkAllIn() {
      const { data: parts } = await supabase
        .from("session_participants")
        .select("user_id, submitted_at")
        .eq("session_id", currentSessionId);
      const others = (parts || []).filter(
        (p) => p.user_id !== session?.user?.id
      );
      // Expiry counts as everyone-in (July 31): the clock ended the game, so
      // the host must not wait forever on participants who never finished.
      const expired =
        sessionExpiresAt && Date.now() > new Date(sessionExpiresAt).getTime();
      if (!stop) {
        // "Everyone" means the DECLARED party, not whoever happens to have
        // joined so far (July 31 field test: the anon finished before anyone
        // else even joined — others = [anon], all submitted, and the host got
        // bounced to a board holding one person's likes). Until expected_others
        // people have joined AND submitted, the game is still on.
        const submittedOthers = others.filter((p) => p.submitted_at).length;
        setAllPartsSubmitted(
          expired ||
            (others.length >= expectedOthers &&
              others.length > 0 &&
              others.every((p) => p.submitted_at))
        );
        setWaitingOthersLeft(Math.max(0, expectedOthers - submittedOthers));
      }
    }
    checkAllIn();
    const iv = setInterval(checkAllIn, 5000);
    return () => {
      stop = true;
      clearInterval(iv);
    };
  }, [screen, matchMode, currentSessionId, session?.user?.id, sessionExpiresAt, expectedOthers]);

  // Everyone's in while the host sits on the waiting card → the Sessions
  // board, same door as everyone else. (Lives HERE, below allPartsSubmitted's
  // declaration — the TDZ rule; an effect above it would throw on render.)
  useEffect(() => {
    if (screen !== "matches" || matchMode !== "concurrent") return;
    if (!allPartsSubmitted || !currentSessionId) return;
    finishSessionToBoard();
  }, [screen, matchMode, allPartsSubmitted, currentSessionId]);

  // Warm the heavy tail for the current + next couple of swipe cards so the
  // deck never shows a skeleton mid-swipe.
  useEffect(() => {
    if (!currentVenue?.id) return;
    const idx = swipeQueue.findIndex((v) => v.id === currentVenue.id);
    prefetchVenueDetails(
      swipeQueue.slice(Math.max(0, idx), idx + 3).map((v) => v.id)
    );
  }, [currentVenue?.id, swipeQueue]);

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
 
  async function startSwiping() {
    // Belt + braces (Aug 21): 0 = unset, must never reach a created session.
    if (matchMode === "concurrent" && expectedOthers < 1) return;
    setCardIndex(0);
    setMatches([]);
    setPassed([]);
    setPicked(null);
    setMarkLikes([]);
    setPartnerLikes([]);
    setMarkPasses([]);
    setPartnerPasses([]);
    setCurrentUser("mark");
    setCurrentSessionId(null);

    let newSessionId = null;
    if (
      (matchMode === "concurrent" || matchMode === "curated") &&
      session?.user?.id
    ) {
      // expires_at: the chosen session time limit (July 31). Right Now
      // defaults to 30 minutes — this is now ENFORCED: at expiry both sides
      // land in the decide flow, which is how a group session that never
      // reaches unanimity ends. Curated keeps the 24h default (no live clock).
      const expiresAt = new Date();
      expiresAt.setMinutes(
        expiresAt.getMinutes() +
          (matchMode === "concurrent" ? sessionTimeoutMins : 60 * 24)
      );

      const sessionFilters = {
        selectedAreaIds: selectedAreas.map((a) => a.id),
        radiusKm,
        openNow,
        selectedTimes,
        selectedOccasions,
        selectedCuisines,
        selectedPrices,
        selectedAmenities,
      };

      const sessionName = eventDate
        ? eventDate.toLocaleDateString("en-AU", {
            weekday: "long",
            day: "numeric",
            month: "short",
          })
        : matchMode === "curated"
        ? "Send options"
        : "Pick together"; // the mode's public name (Aug 20; stored, never rendered)

      const { data, error } = await supabase
        .from("match_sessions")
        .insert({
          host_user_id: session.user.id,
          mode: matchMode,
          source_type: matchSource === "my_list" ? "list" : "filters",
          filters: sessionFilters,
          list_id: null,
          target_matches: matchMode === "curated" ? null : matchLimit || null,
          expected_others: matchMode === "concurrent" ? expectedOthers : null,
          event_at: eventDate ? eventDate.toISOString() : null,
          expires_at: expiresAt.toISOString(),
          status: matchMode === "curated" ? "host_curating" : "open",
          name: sessionName,
        })
        .select()
        .single();

      if (error || !data) {
        console.error("Failed to create session:", error);
        return;
      }
      setSessionExpiresAt(data.expires_at || expiresAt.toISOString());
      setSessionCreatedAt(data.created_at || new Date().toISOString());
      // FRESH GAME STATE AT CREATE (July 31 field test). Swipe history only
      // reset when a session ENDED through Done — a session abandoned midway
      // left markLikes/markPasses populated, so the NEXT session's deck read
      // as fully swiped, currentVenue came up empty, AutoRoute skipped the
      // host past swiping, and one early-finished anon tripped everyone's-in:
      // "clicked Start swiping and it went straight to results". One-shot bug
      // (the bounce itself reset the state), hence unreplicable.
      setMatches([]);
      setMarkLikes([]);
      setPartnerLikes([]);
      setMarkPasses([]);
      setPartnerPasses([]);
      setSessionMatches([]);
      setResultsAreVotes(false);
      setPicked(null);
      setCardIndex(0);

      newSessionId = data.id;
      setCurrentSessionId(data.id);

      await supabase.from("session_participants").insert({
        session_id: data.id,
        user_id: session.user.id,
        // Write the host's display_name from their profile so the
        // participants strip later shows "Mark" instead of falling back to
        // "Guest". Old sessions where this is NULL are hydrated lazily in
        // SessionsScreen via a profiles fallback fetch.
        display_name: profile?.display_name || null,
      });

      console.log("Session created:", data.id);
    }

    if (matchMode === "concurrent" && newSessionId) {
      setScreen("invite_share");
    } else {
      setScreen("swipe");
    }
   
  }
 
  function nextCard() {
    const nextIndex = cardIndex + 1;
    if (nextIndex >= filteredVenues.length) {
      setScreen("matches");
      return;
    }
    setCardIndex(nextIndex);
  }
 
  // Fire-and-forget DB write for concurrent host swipes. Local state updates
  // immediately so the UI doesn't wait on the network. Reconciliation + live
  // match detection (replacing the legacy partnerLikes path below) lands in
  // the get_session_matches polling step.
  function recordHostSwipe(venueId, action) {
    if (matchMode !== "concurrent") return;
    if (!currentSessionId || !session?.user?.id) return;
    supabase
      .from("session_swipes")
      .insert({
        session_id: currentSessionId,
        user_id: session.user.id,
        venue_id: venueId,
        action,
      })
      .then(({ error }) => {
        if (error) console.error("Failed to record host swipe:", error);
      });
  }

  function likeVenue() {
    if (!currentVenue) return;
    const venueId = currentVenue.id;
    recordHostSwipe(venueId, "like");
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
    recordHostSwipe(venueId, "pass");
    if (currentUser === "mark") {
      setMarkPasses((prev) => [...prev, venueId]);
    } else {
      setPartnerPasses((prev) => [...prev, venueId]);
    }
  }
 
  function pickForUs() {
    // Both concurrent and curated read from sessionMatches (the
    // reconciliation RPC populates it for both modes). Solo would fall
    // through to the legacy matches array, but solo doesn't hit the
    // matches screen in practice.
    if (matchMode === "concurrent" || matchMode === "curated") {
      if (!sessionMatches.length) return;
      const venueById = new Map(venues.map((v) => [v.id, v]));
      const pool = sessionMatches
        .map((m) => venueById.get(m.venue_id))
        .filter(Boolean);
      if (!pool.length) return;
      setPicked(pool[Math.floor(Math.random() * pool.length)]);
      return;
    }
    if (!matches.length) return;
    const randomMatch = matches[Math.floor(Math.random() * matches.length)];
    setPicked(randomMatch);
  }
 
if (authLoading || guestLoading) {
    return (
      <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
        Loading...
      </div>
    );
  }

  if (isGuest) {
    // Session not found at all — bad/expired link.
    if (!guestSessionData) {
      return (
        <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
          <div className="w-full max-w-sm text-center">
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              Link's expired
            </h1>
            <p className="mt-3 text-sm text-neutral-600">
              This session link doesn't exist anymore — it may have ended or been deleted.
            </p>
            <button
              type="button"
              onClick={handleNotForMe}
              className="mt-6 inline-flex items-center justify-center rounded-full bg-[#111111] px-5 py-2.5 text-sm font-medium text-white"
            >
              Start your own
            </button>
          </div>
        </div>
      );
    }

    // Format the host's display name.
    const hostName =
      guestHostProfile?.display_name ||
      (guestHostProfile?.username ? `@${guestHostProfile.username}` : "Someone");

    // The event-timing label that used to live here is gone (July 31). It
    // formatted `event_at`, which is always null — SessionSetupScreen calls
    // onPickLater(null), so no date is ever collected — leaving it to render
    // "Right now" or "Later", i.e. the eyebrow again. The card names the mode
    // once and says nothing it can't actually know.
    // Expired = closed for a NEW arrival (July 31): joining a timed-out game
    // is pointless, and the picks have already gone to the host.
    const isClosed =
      guestSessionData.status === "closed" ||
      (guestSessionData.expires_at &&
        Date.now() > new Date(guestSessionData.expires_at).getTime());
    const isHostCurating = guestSessionData.status === "host_curating";
    const isOpen = guestSessionData.status === "open";
    // Post-join stub — B.4.4 replaces this with the guest swipe queue.
    if (guestStage === "joined") {
      const guestCurrentVenue = guestQueue[guestCardIndex];
      const guestAtEnd = guestCardIndex >= guestQueue.length;
      const guestSwipedCount = guestLikes.length + guestPasses.length;
      const queueEmpty = guestQueue.length === 0;
      const target = guestSessionData.target_matches || 0;
      const isCurated = guestSessionData.mode === "curated";
      const isConcurrent = guestSessionData.mode === "concurrent";
      // Curated: every guest-like IS a match (shortlist = host's likes).
      // Concurrent: "match" requires mutual likes, reconciliation polling
      // populates sessionMatches and the game-end useEffect flips to the
      // 'submitted' stage when target is reached. So in concurrent we never
      // show "All done" mid-flow — we just keep swiping and let the trigger
      // navigate. The only mid-flow end state is queueEmpty.
      // "Send options": the guest votes the whole shortlist — done only when
      // they reach the end of it. No target-based early stop.
      const showAllDone = isCurated
        ? (guestAtEnd || queueEmpty)
        : queueEmpty;

      return (
        <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-start justify-center p-4 pb-40">
          <div className="w-full max-w-sm">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                {/* Same leak as the landing card: `name` is the host's own
                    label ("Send options"), so the guest reads the mode. */}
                <p className="text-xs text-neutral-500 truncate">
                  {/* No "Right now" for the guest (Mark, Aug 20 — mode label
                      says nothing to them; same family as the generated-name
                      leaks). Shortlist keeps its word: it tells the guest
                      what they're browsing. */}
                  {guestSessionData.mode === "concurrent"
                    ? guestQueue.length > 0
                      ? `${guestQueue.length} places`
                      : ""
                    : `Shortlist${guestQueue.length > 0 ? ` · ${guestQueue.length} places` : ""}`}
                </p>
                <h1 className="text-lg font-semibold tracking-tight truncate">
                  Welcome, {guestName.trim() || "friend"}
                </h1>
              </div>
              {!queueEmpty && !showAllDone && (
                <div className="text-xs text-neutral-500 shrink-0">
                  {isCurated
                    ? `${guestLikes.length} picked`
                    : `${sessionMatches.length}${target > 0 ? ` / ${target}` : ""} matched`}
                </div>
              )}
            </div>

            {queueEmpty ? (
              <div className="rounded-2xl bg-white shadow-sm border border-neutral-100 p-6 text-center">
                <h2 className="text-lg font-semibold tracking-tight">Nothing to swipe</h2>
                <p className="mt-2 text-sm text-neutral-600">
                  {hostName} didn't include any places. You can still submit empty.
                </p>
              </div>
            ) : showAllDone ? (
              <div className="rounded-2xl bg-white shadow-sm border border-neutral-100 p-6 text-center">
                <h2 className="text-lg font-semibold tracking-tight">All done!</h2>
                <p className="mt-2 text-sm text-neutral-600">
                  {isCurated
                    ? `Send your picks to ${hostName} — they'll choose from everyone's options.`
                    : `Submit your picks — we'll show you what you and ${hostName} both liked.`}
                </p>
                <p className="mt-3 text-xs text-neutral-500">
                  {isCurated
                    ? `${guestLikes.length} picked, ${guestPasses.length} skipped`
                    : `${guestLikes.length} like${guestLikes.length === 1 ? "" : "s"}, ${guestPasses.length} pass${guestPasses.length === 1 ? "" : "es"}`}
                </p>
              </div>
            ) : guestCurrentVenue ? (
              <VenueCard venue={guestCurrentVenue} />
            ) : null}
          </div>

          {/* Sticky action bar at bottom */}
          <div className="fixed bottom-0 left-0 right-0 z-30 px-4 pb-6 pt-4 bg-gradient-to-t from-[#fdf6f0] via-[#fdf6f0] to-transparent">
            <div className="w-full max-w-sm mx-auto">
              {!showAllDone && guestCurrentVenue && (
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={handleGuestPass}
                    className="rounded-2xl bg-neutral-100 py-4 font-medium text-neutral-700 active:scale-[0.98] transition shadow-md"
                  >
                    <span className="inline-flex items-center justify-center gap-2">
                      <X size={18} /> Pass
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={handleGuestLike}
                    className="rounded-2xl bg-[#edf2eb] py-4 font-medium text-[#455d3b] active:scale-[0.98] transition shadow-md"
                  >
                    <span className="inline-flex items-center justify-center gap-2">
                      <Heart size={18} /> Like
                    </span>
                  </button>
                </div>
              )}

              {/* No manual Submit in either mode now — the game ends
                  automatically when target_matches is reached or the guest
                  reaches end-of-queue. Auto-flip happens in the joined→
                  submitted useEffect. */}
            </div>
          </div>
        </div>
      );
    }

    if (guestStage === "submitted") {
      // "Send my options" (curated): the guest just votes — no match reveal
      // and no signup gate. Show a confirmation; the host chooses from
      // everyone's options and (for signed-in/friend guests) the decision
      // lands in their Activity drawer once the host confirms.
      if (guestSessionData.mode === "curated") {
        const stillAnon = session?.user?.is_anonymous !== false;
        return (
          <div className="min-h-screen bg-[#fdf6f0] text-[#111111] p-4">
            <div className="w-full max-w-sm mx-auto pt-12 pb-20">
              {guestDecidedVenueId && (
                <div className="mb-5 rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] p-4 text-center">
                  <p className="text-xs uppercase tracking-wide text-[#455d3b]">
                    It's decided
                  </p>
                  <p className="mt-1 text-lg font-semibold text-[#2f3f29]">
                    {guestShortlistVenues.find((v) => v.id === guestDecidedVenueId)?.name || "your spot"}
                  </p>
                  {/* The plan's WHEN — always shown once decided (Aug 20,
                      Mark: "it should still say when you're going"). */}
                  {guestDecidedFor && (
                      <p className="mt-1 text-sm font-medium text-[#2f3f29]">
                        {new Date(guestDecidedFor).toLocaleDateString("en-AU", {
                          weekday: "long",
                          day: "numeric",
                          month: "short",
                        })}{" "}
                        ·{" "}
                        {new Date(guestDecidedFor).toLocaleTimeString("en-AU", {
                          hour: "numeric",
                          minute: "2-digit",
                        })}
                      </p>
                    )}
                  <p className="mt-1 text-xs text-[#455d3b]">
                    {hostName} picked the place — see you there!
                  </p>
                </div>
              )}
              <div className="text-center">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#edf2eb] text-[#455d3b]">
                  <Check size={28} />
                </div>
                <h1 className="text-2xl font-semibold tracking-tight">
                  Your picks are in
                </h1>
                <p className="mt-2 text-sm text-neutral-600">
                  {hostName} picks from everyone's options next — we'll show you
                  where you land.
                </p>
                {(() => {
                  const pickedNames = guestLikes
                    .map((id) => guestShortlistVenues.find((v) => v.id === id)?.name)
                    .filter(Boolean);
                  return pickedNames.length > 0 ? (
                    <div className="mt-5 flex flex-wrap justify-center gap-2">
                      {pickedNames.map((name) => (
                        <span
                          key={name}
                          className="rounded-full border border-[#e7ddd1] bg-white px-3 py-1.5 text-xs text-neutral-700"
                        >
                          {name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-4 text-xs text-neutral-500">
                      You picked {guestLikes.length} place
                      {guestLikes.length === 1 ? "" : "s"}.
                    </p>
                  );
                })()}
              </div>

              {stillAnon ? (
                !guestSignupSent ? (
                  <div className="mt-6">
                    <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
                      <h2 className="text-base font-semibold tracking-tight">
                        See where you land
                      </h2>
                      <p className="mt-1.5 text-sm text-neutral-600">
                        Add your email — your picks stay with you and we'll tell
                        you the moment {hostName} decides.
                      </p>
                      <form onSubmit={handleGuestSignup} className="mt-4 space-y-3">
                        <input
                          type="email"
                          required
                          placeholder="you@example.com"
                          value={guestSignupEmail}
                          onChange={(e) => {
                            setGuestSignupEmail(e.target.value);
                            if (guestSignupError) setGuestSignupError("");
                          }}
                          className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-base focus:outline-none focus:border-[#455d3b]"
                        />
                        {/* Invisible/managed captcha — only shows a challenge if
                            the request looks suspicious. */}
                        <Turnstile
                          ref={guestSignupCaptchaRef}
                          siteKey={TURNSTILE_SITE_KEY}
                          onSuccess={setGuestSignupCaptchaToken}
                          onExpire={() => setGuestSignupCaptchaToken(null)}
                          onError={() => setGuestSignupCaptchaToken(null)}
                          options={{ theme: "light", appearance: "interaction-only" }}
                        />
                        <button
                          type="submit"
                          disabled={
                            guestSigningUp ||
                            !guestSignupEmail.trim() ||
                            !guestSignupCaptchaToken
                          }
                          className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {guestSigningUp ? "Saving..." : "Save my picks"}
                        </button>
                        {guestSignupError && (
                          <p className="text-sm text-red-600">{guestSignupError}</p>
                        )}
                      </form>
                      <p className="mt-3 text-center text-[11px] text-neutral-400">
                        No password — we email you a link
                      </p>
                    </div>
                    {/* "Just looking? Explore Flanit" removed July 31 (Mark:
                        no escape hatches for anons at gates — we want them to
                        sign up). It routed to the anon wall anyway. */}
                  </div>
                ) : (
                  <div className="mt-6 rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
                    <h2 className="text-base font-semibold tracking-tight">
                      Enter your code
                    </h2>
                    <p className="mt-1.5 text-sm text-neutral-600">
                      We emailed a 6-digit code to{" "}
                      <span className="font-medium">{guestSignupEmail}</span>.
                      Pop it in here to save your picks and see where you land.
                    </p>
                    <form onSubmit={handleVerifyCode} className="mt-4 space-y-3">
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        value={guestSignupCode}
                        onChange={(e) => {
                          setGuestSignupCode(
                            e.target.value.replace(/\D/g, "").slice(0, 8)
                          );
                          if (guestSignupError) setGuestSignupError("");
                        }}
                        className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-center text-lg tracking-[0.3em] focus:outline-none focus:border-[#455d3b]"
                      />
                      <button
                        type="submit"
                        disabled={guestVerifying || guestSignupCode.length < 6}
                        className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {guestVerifying ? "Checking…" : "Confirm"}
                      </button>
                      {guestSignupError && (
                        <p className="text-sm text-red-600">{guestSignupError}</p>
                      )}
                    </form>
                    <p className="mt-3 text-xs text-neutral-500">
                      No code? Check spam, or{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setGuestSignupSent(false);
                          setGuestSignupCode("");
                        }}
                        className="font-medium text-[#455d3b]"
                      >
                        try again
                      </button>
                      .
                    </p>
                  </div>
                )
              ) : (
                <>
                  {/* The session's people, for the freshly signed-up
                      shortlist guest too (Aug 20, Mark: "no subsequent
                      screen of add people from session") — same list as
                      the concurrent matched state. */}
                  <div className="mt-6 text-left">
                    <SessionPeople
                      part="list"
                      sessionId={guestSessionId}
                      viewerUserId={session?.user?.id}
                      viewerName={profile?.display_name}
                      hostUserId={guestSessionData?.host_user_id}
                      showToast={showToast}
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      const sid = guestSessionId;
                      goToMainApp("matches");
                      setNotifSessionId(sid); // open this session's results, not the map
                    }}
                    className="mt-6 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md"
                  >
                    {/* No plan exists before the host locks one (Aug, Mark:
                        guests shouldn't see the plan until it's locked) — the
                        board behind this shows only THEIR picks until then. */}
                    {guestDecidedVenueId ? "See the plan" : "See my picks"}
                  </button>
                </>
              )}
            </div>
          </div>
        );
      }

      // Match count comes from the reconciliation RPC (populated via live
      // polling for concurrent, one-shot fetch for curated). Anonymous
      // users see a sign-up gate first; signed-in (or dev-override) users
      // see the same SessionResultsView layout as the host and the
      // historical Your Sessions detail.
      const matchCount = sessionMatches.length;
      const isStillAnonymous = session?.user?.is_anonymous !== false;
      const isDevHost =
        typeof window !== "undefined" &&
        (window.location.hostname === "localhost" ||
          window.location.hostname === "127.0.0.1");
      const showGate = isStillAnonymous && !devRevealOverride;
      const sessionExpired =
        guestSessionData?.expires_at &&
        Date.now() > new Date(guestSessionData.expires_at).getTime();

      // ---------- Time's up with NOTHING (July 31 matrix) ----------
      // No matches, no votes, no decision: there is nothing behind a gate, so
      // nobody gets one — gating nothing teaches people the gate is noise.
      // Same plain screen for anon and signed-in.
      if (
        sessionExpired &&
        matchCount === 0 &&
        !guestDecidedVenueId
      ) {
        return (
          <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
            <div className="w-full max-w-sm text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#f0e6dc] text-[#6b5f54]">
                <Clock size={22} />
              </div>
              <h1 className="text-2xl font-semibold tracking-tight">
                Time's up
              </h1>
              <p className="mt-2 text-sm text-neutral-600">
                No matches this time — not everyone got to swipe.
              </p>
              <button
                type="button"
                onClick={() => goToMainApp("map")}
                className="mt-6 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition"
              >
                Done
              </button>
            </div>
          </div>
        );
      }

      // ---------- Sign-up gate (anonymous users) ----------
      // Copy follows what's actually behind the gate (July 31 matrix):
      // a locked plan, a unanimous match, the votes after a timeout — or the
      // game STILL RUNNING (the guest finished before the others; Mark's
      // screenshot showed "You matched on 0 places", a result that didn't
      // exist yet). That state sells plan-TRACKING, not a reveal.
      const gateStillRunning =
        !guestDecidedVenueId && !resultsAreVotes && matchCount === 0;
      if (showGate) {
        return (
          <div className="min-h-screen bg-[#fdf6f0] text-[#111111] p-4">
            <div className="w-full max-w-sm mx-auto pt-10 pb-20">
              <div className="text-center mb-6">
                <p className="text-sm text-neutral-500">
                  {gateStillRunning
                    ? `All done, ${guestName.trim() || "friend"}`
                    : `Game over, ${guestName.trim() || "friend"}`}
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                  {guestDecidedVenueId
                    ? "The plan is locked 🎉"
                    : resultsAreVotes
                      ? "Time's up — the votes are in"
                      : gateStillRunning
                        ? "Your choices are in"
                        : "It's a match"}
                </h1>
              </div>
              <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
                {!guestSignupSent ? (
                  <>
                    <h2 className="text-lg font-semibold tracking-tight">
                      {guestDecidedVenueId
                        ? "See where you're going"
                        : resultsAreVotes
                          ? "See what everyone liked"
                          : gateStillRunning
                            ? "Keep track of your plan"
                            : "See where you matched"}
                    </h2>
                    <p className="mt-2 text-sm text-neutral-600">
                      {gateStillRunning
                        ? `Add your email and you'll see the plan the moment ${hostName} locks it in — new or existing account, both work.`
                        : `Enter your email and we'll send a 6-digit code to reveal ${
                            guestDecidedVenueId
                              ? "the plan"
                              : resultsAreVotes
                                ? "the votes"
                                : "them"
                          } — works whether you're new or already have an account.`}
                    </p>
                    <form onSubmit={handleGuestSignup} className="mt-4 space-y-3">
                      <input
                        type="email"
                        required
                        placeholder="you@example.com"
                        value={guestSignupEmail}
                        onChange={(e) => {
                          setGuestSignupEmail(e.target.value);
                          if (guestSignupError) setGuestSignupError("");
                        }}
                        className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-base focus:outline-none focus:border-[#455d3b]"
                      />
                      <div className="flex justify-center">
                        <Turnstile
                          ref={guestSignupCaptchaRef}
                          siteKey={TURNSTILE_SITE_KEY}
                          onSuccess={setGuestSignupCaptchaToken}
                          onExpire={() => setGuestSignupCaptchaToken(null)}
                          onError={() => setGuestSignupCaptchaToken(null)}
                          options={{ theme: "light", appearance: "interaction-only" }}
                        />
                      </div>
                      <button
                        type="submit"
                        disabled={
                          guestSigningUp ||
                          !guestSignupEmail.trim() ||
                          !guestSignupCaptchaToken
                        }
                        className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {guestSigningUp
                          ? "Sending..."
                          : guestDecidedVenueId
                            ? "See the plan"
                            : gateStillRunning
                              ? "Stay updated"
                              : resultsAreVotes
                                ? "See the votes"
                                : "See your matches"}
                      </button>
                      {guestSignupError && (
                        <p className="text-sm text-red-600">{guestSignupError}</p>
                      )}
                    </form>
                  </>
                ) : (
                  <>
                    <h2 className="text-lg font-semibold tracking-tight">
                      Enter your code
                    </h2>
                    <p className="mt-2 text-sm text-neutral-600">
                      We emailed a 6-digit code to{" "}
                      <span className="font-medium">{guestSignupEmail}</span>.
                      Pop it in to reveal your matches.
                    </p>
                    <form onSubmit={handleVerifyCode} className="mt-4 space-y-3">
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        value={guestSignupCode}
                        onChange={(e) => {
                          setGuestSignupCode(
                            e.target.value.replace(/\D/g, "").slice(0, 8)
                          );
                          if (guestSignupError) setGuestSignupError("");
                        }}
                        className="w-full rounded-2xl border border-neutral-200 bg-white px-4 py-3 text-center text-lg tracking-[0.3em] focus:outline-none focus:border-[#455d3b]"
                      />
                      <button
                        type="submit"
                        disabled={guestVerifying || guestSignupCode.length < 6}
                        className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {guestVerifying ? "Checking…" : "Confirm"}
                      </button>
                      {guestSignupError && (
                        <p className="text-sm text-red-600">{guestSignupError}</p>
                      )}
                    </form>
                    <p className="mt-3 text-xs text-neutral-500">
                      No code? Check spam, or{" "}
                      <button
                        type="button"
                        onClick={() => {
                          setGuestSignupSent(false);
                          setGuestSignupCode("");
                        }}
                        className="font-medium text-[#455d3b]"
                      >
                        try again
                      </button>
                      .
                    </p>
                  </>
                )}
              </div>
              {isDevHost && (
                <button
                  type="button"
                  onClick={() => setDevRevealOverride(true)}
                  className="mt-3 block w-full text-center text-xs py-2 px-3 rounded-full bg-amber-50 border border-amber-200 text-amber-800 hover:bg-amber-100"
                >
                  Reveal anyway (dev only · localhost)
                </button>
              )}
            </div>
          </div>
        );
      }

      // ---------- Done state (signed-in guest, Mark's July 23 simplify,
      // July 31 matrix on top) ---- The headline states what's actually true:
      // the plan (decided), the match (unanimous — the game WORKED, and that
      // deserves its own sentence, not "picks are in"), the votes (timed out,
      // host picking), or plain picks-are-in while the game runs on.
      const decidedName =
        guestDecidedVenueId &&
        (venues.find((v) => v.id === guestDecidedVenueId)?.name ||
          guestShortlistVenues.find((v) => v.id === guestDecidedVenueId)?.name ||
          "the spot");
      const matchName =
        !resultsAreVotes && sessionMatches.length > 0
          ? venues.find((v) => v.id === sessionMatches[0].venue_id)?.name || null
          : null;
      return (
        <div className="fixed inset-0 bg-[#fdf6f0] text-[#111111] flex flex-col pb-16 overflow-y-auto">
          {/* The match is PEOPLE (Aug 20, Mark: the tick was underwhelming) —
              confetti + the group's faces on the matched state. */}
          {matchName && !decidedName && <ConfettiBurst />}
          <div className="w-full max-w-sm mx-auto px-4 pt-14 text-center">
            {matchName && !decidedName ? (
              <SessionPeople
                part="stack"
                sessionId={guestSessionId}
                viewerUserId={session?.user?.id}
                hostUserId={guestSessionData?.host_user_id}
              />
            ) : (
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#edf2eb] text-[#455d3b]">
                <Check size={28} />
              </div>
            )}
            {/* MATCHED, PRE-LOCK: no venue name (Mark, Aug 20) — the match
                is announced, but the where/when is the HOST's to deliver
                when they lock the plan. Same doctrine as shortlist guests
                not seeing the plan until it's locked. */}
            <h1 className="text-2xl font-semibold tracking-tight">
              {decidedName
                ? `${decidedName} it is 🎉`
                : matchName
                  ? "You matched 🎉"
                  : resultsAreVotes
                    ? "Time's up"
                    : "Your picks are in"}
            </h1>
            <p className="mt-2 text-sm text-neutral-600">
              {decidedName
                ? guestDecidedFor
                  ? `${new Date(guestDecidedFor).toLocaleDateString("en-AU", {
                      weekday: "long",
                      day: "numeric",
                      month: "short",
                    })} · ${new Date(guestDecidedFor).toLocaleTimeString("en-AU", {
                      hour: "numeric",
                      minute: "2-digit",
                    })} — see you there.`
                  : "The plan is locked — see you there."
                : matchName
                  ? `It's unanimous! You all liked the same spot. ${hostName} will update you on the when and where.`
                  : resultsAreVotes
                    ? `${hostName} is picking from what everyone liked.`
                    : `We'll nudge you the moment ${hostName} locks in the spot.`}
            </p>
            <div className="mt-6 text-left">
              {/* Matched state: EVERYONE in the session, state-aware chips
                  (Aug 20, Mark — a 3-person session offered only the host).
                  Other states keep the host-only card. */}
              {matchName && !decidedName ? (
                <SessionPeople
                  part="list"
                  sessionId={guestSessionId}
                  viewerUserId={session?.user?.id}
                  viewerName={profile?.display_name}
                  hostUserId={guestSessionData?.host_user_id}
                  showToast={showToast}
                />
              ) : (
                <AddHostFriendCard
                  hostUserId={guestSessionData?.host_user_id}
                  hostName={hostName}
                  viewerUserId={session?.user?.id}
                  showToast={showToast}
                />
              )}
            </div>
            <button
              type="button"
              onClick={() => {
                // A match or a locked plan has a home — the Sessions board
                // (July 31, Mark: "after they click done it should go to the
                // sessions board"). A still-running game just exits to the map.
                if (decidedName || matchName || resultsAreVotes) {
                  const sid = guestSessionId;
                  goToMainApp("matches");
                  setNotifSessionId(sid);
                } else {
                  goToMainApp("map");
                }
              }}
              className="mt-6 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md"
            >
              Done
            </button>
          </div>
          <BottomTabBar tab={null} setTab={goToMainApp} />
          {/* ONBOARDING AT THE MOMENT THEY BECOME REAL (July 31, Mark: "it
              should be on the screen that has the add friend"). A guest who
              just signed up at the gate lands here — display name, @username,
              photo get asked NOW, while the session is still warm, instead of
              whenever they next open the app. Renders over this screen;
              closing it returns here with Add-friend and Done waiting. */}
          {!onboardingDismissed &&
            session?.user?.id &&
            session.user.is_anonymous === false &&
            profile &&
            !profile.username && (
              <OnboardingScreen
                // Keyed to the name: the form snapshots its prefill at mount,
                // and the carried name can land a beat after the placeholder —
                // a key change remounts the form with the corrected prefill.
                key={profile.display_name || "onboard"}
                userId={session.user.id}
                profile={profile}
                setProfile={setProfile}
                onDone={dismissOnboarding}
              />
            )}
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center">
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {hostName} wants to pick a place with you
            </h1>
          </div>

          <div className="mt-6 rounded-2xl bg-white shadow-sm border border-neutral-100 p-5">
            {/* Copy is literal per mode, NOT `guestSessionData.name` (Mark,
                July 31). That column is a host-side label the app generates
                itself — "Right now" / "Send options" — so rendering it under an
                eyebrow that already says the same thing printed the mode twice,
                and "Send options" is what the HOST does, meaningless to the
                person receiving them. Reading it literally also fixes sessions
                created before today, whose stored name is still the old string.
                `whenLabel` is gone from this card for the same reason: there is
                no date picker, so it can only ever repeat the eyebrow. */}
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
              {guestSessionData.mode === "concurrent" ? (
                <>
                  <HeartHandshake size={14} />
                  Pick together
                </>
              ) : (
                <>
                  <ListChecks size={14} />
                  Here is my shortlist
                </>
              )}
            </div>
            {guestSessionData.mode !== "concurrent" && (
              <div className="mt-2 text-lg font-medium">
                Browse my list and let me know what you are happy with
              </div>
            )}

            {/* Concurrent only — "what you both like" describes mutual matching,
                which isn't what a shortlist does, and the line above already
                tells a shortlist guest what to do. */}
            {isOpen && guestSessionData.mode === "concurrent" && (
              <p className="mt-4 text-sm text-neutral-600">
                You'll swipe through some spots and we'll surface what you both like.
              </p>
            )}
            {isHostCurating && (
              <p className="mt-4 text-sm text-neutral-600">
                {hostName} is still picking the shortlist. Check back in a few minutes.
              </p>
            )}
            {isClosed && (
              <div className="mt-4">
                {splashEnd?.decidedName ? (
                  // The plan exists — that's the information a latecomer
                  // actually wants. Anon sees it's locked, not where.
                  session?.user?.id && session.user.is_anonymous === false ? (
                    <p className="text-sm text-neutral-700">
                      It's decided —{" "}
                      <span className="font-semibold text-[#2f3f29]">
                        {splashEnd.decidedName}
                      </span>
                      {splashEnd.decidedFor
                        ? `, ${new Date(splashEnd.decidedFor).toLocaleDateString(
                            "en-AU",
                            { weekday: "long", day: "numeric", month: "short" }
                          )} · ${new Date(
                            splashEnd.decidedFor
                          ).toLocaleTimeString("en-AU", {
                            hour: "numeric",
                            minute: "2-digit",
                          })}`
                        : ""}
                      . See you there.
                    </p>
                  ) : (
                    <p className="text-sm text-neutral-600">
                      The plan is locked 🎉 Sign in to see where you're going.
                    </p>
                  )
                ) : splashEnd?.likesCount > 0 ? (
                  <p className="text-sm text-neutral-600">
                    Time's up — {hostName} is picking from{" "}
                    {splashEnd.likesCount} place
                    {splashEnd.likesCount === 1 ? "" : "s"} people liked.
                  </p>
                ) : (
                  <p className="text-sm text-neutral-600">
                    This session has ended.
                  </p>
                )}
              </div>
            )}
          </div>

          {isOpen && guestWillAutoJoin && (
            <>
              <div className="mt-6 flex items-center justify-center gap-2 text-sm text-neutral-500">
                <span className="h-4 w-4 rounded-full border-2 border-neutral-300 border-t-[#455d3b] animate-spin" />
                Joining as {realName(profile?.display_name)}…
              </div>
              {session?.user?.is_anonymous && (
                <button
                  type="button"
                  onClick={handleNotMe}
                  className="mt-5 w-full text-center text-sm text-[#455d3b] underline underline-offset-2"
                >
                  Not {realName(profile?.display_name)}?
                </button>
              )}
            </>
          )}
          {isOpen && !guestWillAutoJoin && (
            <>
              <label className="mt-5 block text-xs font-medium uppercase tracking-wide text-neutral-500">
                What should we call you?
              </label>
              <input
                type="text"
                value={guestName}
                onChange={(e) => setGuestName(e.target.value)}
                placeholder="Your name"
                maxLength={40}
                className="mt-2 w-full rounded-2xl bg-white border border-neutral-200 px-4 py-3 text-base focus:border-neutral-400 focus:outline-none"
              />
              {/* Captcha only required for first-time anon signins. Returning
                  signed-in users (the host visiting their own link) skip it. */}
              {!session?.user?.id && (
                <div className="mt-3 flex justify-center">
                  <Turnstile
                    ref={guestCaptchaRef}
                    siteKey={TURNSTILE_SITE_KEY}
                    onSuccess={setGuestCaptchaToken}
                    onExpire={() => setGuestCaptchaToken(null)}
                    onError={() => setGuestCaptchaToken(null)}
                    options={{ theme: "light", appearance: "interaction-only" }}
                  />
                </div>
              )}
              <button
                type="button"
                onClick={handleJoinSession}
                disabled={
                  joining ||
                  !guestName.trim() ||
                  (!session?.user?.id && !guestCaptchaToken)
                }
                className="mt-3 w-full rounded-full bg-[#455d3b] px-5 py-3 text-sm font-medium text-white disabled:opacity-40"
              >
                {joining ? "Joining..." : "Join"}
              </button>
            </>
          )}
          {isHostCurating && (
            <button
              type="button"
              disabled
              className="mt-5 w-full rounded-full bg-neutral-200 px-5 py-3 text-sm font-medium text-neutral-500"
            >
              Waiting for {hostName}
            </button>
          )}

          <button
            type="button"
            onClick={handleNotForMe}
            className="mt-3 w-full text-center text-sm text-neutral-500 underline underline-offset-2"
          >
            This isn't for me
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    return <SignInScreen inviteHandle={friendInviteHandle} />;
  }

  // THE ANON GATE (July 31, 2026 — Mark: "They shouldn't be able to get through
  // to the app. Because right now they are.").
  //
  // An anonymous session IS a session, so for months the only branch here —
  // `if (!session)` — waved guests straight into the tab shell. Worse, a guest
  // who'd typed their name at a collect-link door had a profiles row, so they
  // arrived looking like a fully paid-up member: avatar, name, tier chip, four
  // tabs, all of it backed by a session that dies with the browser's storage.
  //
  // The two surfaces built FOR strangers return above this line: /s/<uuid>
  // (the `isGuest` block) and /c/<token> (mounted by index.js — App never runs).
  // So everything reaching here is an anon at the front door, and gets the wall
  // instead. Deliberately placed after `!session` and before `loading`: there's
  // nothing to wait for, since none of the app's data is theirs to see.
  if (session.user?.is_anonymous) {
    return (
      <GuestHome
        userId={session.user.id}
        displayName={realName(profile?.display_name)}
        onSignOut={signOut}
      />
    );
  }

  if (loading) {
    return <LoadingScreen />;
  }
 
  return (
    <div className="min-h-screen bg-[#fdf6f0] text-[#111111]">
      {tab === "matches" && (
          <div className="flex items-start justify-center p-4 pb-24">
            <div className="w-full max-w-sm">
              <div className="mb-5 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  {screen === "filters" && (
                    <button
                      type="button"
                      onClick={() =>
                        setScreen("session_setup")
                      }
                      aria-label="Back to mode"
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-sm border border-neutral-100 text-neutral-600 shrink-0"
                    >
                      <ArrowLeft size={18} />
                    </button>
                  )}
                  <div className="min-w-0">
                    <h1 className="text-2xl font-semibold tracking-tight">
                      Match with friends
                    </h1>
                    {/* One line on what this tab IS (Mark, Aug 20) — setup
                        screen only; deeper screens explain themselves. */}
                    {screen === "session_setup" && (
                      <p className="mt-1 text-sm text-neutral-500">
                        Find food, coffee or drinks with friends, without the
                        group-chat spiral
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {(screen === "swipe" || screen === "matches") && (
                    <button
                      onClick={resetSwipe}
                      className="rounded-full bg-white p-3 shadow-sm border border-neutral-100"
                      aria-label="Reset"
                    >
                      <RotateCcw size={18} />
                    </button>
                  )}
                </div>
              </div>
              {screen === "session_setup" && (
          <SessionSetupScreen
            onBack={() => setTab("map")}
            onPickRightNow={() => {
              setMatchMode("concurrent");
              setEventDate(null);
              setScreen("filters");
            }}
            onPickLater={(date) => {
              setMatchMode("curated");
              setEventDate(date);
              setScreen("filters");
            }}
          />
        )}
        {screen === "filters" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <div className="flex justify-center mb-4 pb-4 border-b border-neutral-100">
              <div className="flex bg-neutral-100 rounded-full p-0.5">
                <button
                  type="button"
                  onClick={() => setMatchSource("all")}
                  className={`rounded-full px-4 py-1.5 text-xs font-medium transition ${
                    matchSource === "all"
                      ? "bg-white text-[#455d3b] shadow-sm"
                      : "text-neutral-500"
                  }`}
                >
                  All venues
                </button>
                <button
                  type="button"
                  onClick={() => setMatchSource("my_list")}
                  className={`rounded-full px-4 py-1.5 text-xs font-medium transition ${
                    matchSource === "my_list"
                      ? "bg-white text-[#455d3b] shadow-sm"
                      : "text-neutral-500"
                  }`}
                >
                  My List
                </button>
              </div>
            </div>
            <div className="space-y-5">
              {/* WHO'S COMING — first input, above Suburbs (July 31, Mark).
                  Prominent because it now DRIVES the rules: the match must be
                  liked by everyone declared here, and groups of 3+ swipe a
                  bounded 30-venue deck. Right Now only. */}
              {matchMode === "concurrent" && (
                <div
                  className={`flex items-center justify-between rounded-2xl bg-[#edf2eb] px-4 py-3 ${
                    expectedOthers < 1
                      ? "border-2 border-[#455d3b] animate-pulse"
                      : "border border-[#cdd9c6]"
                  }`}
                >
                  <div>
                    <p className="text-sm font-medium text-[#2f3f29]">
                      How many friends?
                    </p>
                    <p className="text-[11px] text-[#455d3b] mt-0.5">
                      {expectedOthers < 1
                        ? "Pick a number to start"
                        : expectedOthers === 1
                        ? "You + 1 — first match wins"
                        : `You + ${expectedOthers} — everyone must like the place`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="Fewer people"
                      disabled={expectedOthers <= 1}
                      onClick={() => setExpectedOthers((n) => Math.max(1, n - 1))}
                      className="w-8 h-8 rounded-full bg-white border border-[#cdd9c6] text-[#455d3b] text-lg leading-none disabled:opacity-40 active:scale-95 transition"
                    >
                      −
                    </button>
                    <span className="w-6 text-center text-base font-semibold text-[#2f3f29]">
                      {expectedOthers}
                    </span>
                    <button
                      type="button"
                      aria-label="More people"
                      disabled={expectedOthers >= 12}
                      onClick={() => setExpectedOthers((n) => Math.min(12, n + 1))}
                      className="w-8 h-8 rounded-full bg-white border border-[#cdd9c6] text-[#455d3b] text-lg leading-none disabled:opacity-40 active:scale-95 transition"
                    >
                      +
                    </button>
                  </div>
                </div>
              )}
              <AreaFilter
                areaSearch={areaSearch}
                setAreaSearch={setAreaSearch}
                selectedAreas={selectedAreas}
                setSelectedAreas={setSelectedAreas}
                showAreaDropdown={showAreaDropdown}
                setShowAreaDropdown={setShowAreaDropdown}
                areas={areas}
                areasLoading={areasLoading}
                expandedRegions={expandedRegions}
                setExpandedRegions={setExpandedRegions}
              />
              <MapFilterGroup title="Time of day">
                {TIME_BAND_LABELS.map((label) => (
                  <MapFilterChip
                    key={label}
                    on={selectedTimes.includes(label)}
                    label={label}
                    onClick={() =>
                      setSelectedTimes((prev) =>
                        prev.includes(label)
                          ? prev.filter((x) => x !== label)
                          : [...prev, label]
                      )
                    }
                  />
                ))}
              </MapFilterGroup>
              <MapFilterGroup title="What are you after?">
                {OCCASION_OPTIONS.map((o) => (
                  <MapFilterChip
                    key={o}
                    on={selectedOccasions.includes(o)}
                    label={o}
                    onClick={() =>
                      setSelectedOccasions((prev) =>
                        prev.includes(o)
                          ? prev.filter((x) => x !== o)
                          : [...prev, o]
                      )
                    }
                  />
                ))}
              </MapFilterGroup>
              {/* SEE MORE (July 24, Mark's setup diet): Suburbs / Time of
                  day / What are you after lead; everything else folds away.
                  Cuisine on top, then Radius + Matches as one pill row. */}
              <button
                type="button"
                onClick={() =>
                  setShowMoreFilters((v) => {
                    // Opening advanced lands with a segment already expanded
                    // (July 31, Mark) — Matches when it exists, else Radius.
                    if (!v) {
                      setAdvTab(
                        matchMode !== "curated" && expectedOthers === 1
                          ? "matches"
                          : "radius"
                      );
                    }
                    return !v;
                  })
                }
                className="w-full text-center text-sm font-medium text-[#455d3b]"
              >
                {showMoreFilters ? "See fewer filters ⌃" : "See more filters ⌄"}
              </button>
              {showMoreFilters && (
                <>
                  <MapFilterSection
                    title="Cuisine"
                    summary={
                      selectedCuisines.length === 0
                        ? "Any"
                        : selectedCuisines.length === 1
                        ? selectedCuisines[0]
                        : `${selectedCuisines.length} selected`
                    }
                    accent={selectedCuisines.length > 0}
                  >
                    <SearchableChips
                      options={cuisines.filter((item) => item !== ALL)}
                      selected={selectedCuisines}
                      onToggle={(c) =>
                        setSelectedCuisines((prev) =>
                          prev.includes(c)
                            ? prev.filter((x) => x !== c)
                            : [...prev, c]
                        )
                      }
                      placeholder="Search cuisines"
                    />
                  </MapFilterSection>
                  {/* MATCHES | RADIUS | TIME LIMIT as one segmented row
                      (July 31, Mark — three side-by-side dropdown pills ran
                      off the screen). Tap a segment, the options for it swap
                      in underneath as chips. Matches hides for groups (forced
                      to 1 — one unanimous venue IS the plan) and for curated
                      (no target at all). */}
                  <div>
                    <div className="flex bg-neutral-100 rounded-full p-0.5 text-xs font-medium">
                      {[
                        ...(matchMode !== "curated" && expectedOthers === 1
                          ? [["matches", `Matches · ${matchLimit}`]]
                          : []),
                        [
                          "radius",
                          radiusKm === 0 ? "Suburb only" : `+${radiusKm} km`,
                        ],
                        ...(matchMode !== "curated"
                          ? [
                              [
                                "time",
                                // Named like its siblings (Aug 1, Mark: "is
                                // 3h descriptive enough?" — it wasn't).
                                `Duration · ${
                                  sessionTimeoutMins < 60
                                    ? `${sessionTimeoutMins}m`
                                    : sessionTimeoutMins < 1440
                                      ? `${sessionTimeoutMins / 60}h`
                                      : `${sessionTimeoutMins / 1440}d`
                                }`,
                              ],
                            ]
                          : []),
                      ].map(([key, lbl]) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() =>
                            setAdvTab((t) => (t === key ? null : key))
                          }
                          className={`flex-1 rounded-full px-2 py-1.5 transition truncate ${
                            advTab === key
                              ? "bg-white text-[#455d3b] shadow-sm"
                              : "text-neutral-500"
                          }`}
                        >
                          {lbl}
                        </button>
                      ))}
                    </div>
                    {advTab === "matches" && (
                      <div className="mt-2">
                        <p className="mb-1.5 text-[11px] text-neutral-500">
                          Number of matches — the game stops when you hit it
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {MATCH_OPTIONS.map((n) => (
                            <MapFilterChip
                              key={n}
                              on={matchLimit === n}
                              label={String(n)}
                              onClick={() => setMatchLimit(n)}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {advTab === "radius" && (
                      <div className="mt-2">
                        <p className="mb-1.5 text-[11px] text-neutral-500">
                          Search area — how far past the suburb's border
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {RADIUS_OPTIONS.map((r) => (
                            <MapFilterChip
                              key={r}
                              on={radiusKm === r}
                              label={r === 0 ? "Suburb only" : `+${r} km`}
                              onClick={() => setRadiusKm(r)}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                    {advTab === "time" && (
                      <div className="mt-2">
                        <p className="mb-1.5 text-[11px] text-neutral-500">
                          Time to decide — then the votes go to you
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {SESSION_DURATIONS.map(([v, lbl]) => (
                            <MapFilterChip
                              key={v}
                              on={sessionTimeoutMins === v}
                              label={lbl}
                              onClick={() => setSessionTimeoutMins(v)}
                            />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  <MapFilterGroup title="Must-haves">
                    {AMENITY_FILTERS.map((a) => (
                      <MapFilterChip
                        key={a.key}
                        on={selectedAmenities.includes(a.key)}
                        label={a.label}
                        onClick={() =>
                          setSelectedAmenities((prev) =>
                            prev.includes(a.key)
                              ? prev.filter((x) => x !== a.key)
                              : [...prev, a.key]
                          )
                        }
                      />
                    ))}
                  </MapFilterGroup>
                  <MapFilterGroup title="Price">
                    {[1, 2, 3, 4].map((p) => (
                      <MapFilterChip
                        key={p}
                        on={selectedPrices.includes(p)}
                        label={"$".repeat(p)}
                        onClick={() =>
                          setSelectedPrices((prev) =>
                            prev.includes(p)
                              ? prev.filter((x) => x !== p)
                              : [...prev, p]
                          )
                        }
                      />
                    ))}
                  </MapFilterGroup>
                </>
              )}

              <div className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600">
                {swipeQueue.length} places available with these filters.
              </div>
              <button
                onClick={startSwiping}
                disabled={
                  !swipeQueue.length ||
                  (matchMode === "concurrent" && expectedOthers < 1)
                }
                className="w-full rounded-2xl bg-[#455d3b] py-4 font-medium text-white disabled:bg-neutral-300"
              >
                Start swiping
              </button>
              {matchMode === "concurrent" &&
                expectedOthers < 1 &&
                swipeQueue.length > 0 && (
                  <p className="text-center text-xs text-neutral-500">
                    Pick how many friends are joining
                  </p>
                )}
            </div>
          </div>
        )}
        {screen === "invite_share" && (
          <InviteShareScreen
            sessionId={currentSessionId}
            mode={matchMode}
            matchCount={sessionMatches.length}
            target={matchLimit}
            userId={session?.user?.id}
            inviterName={profile?.display_name}
            showToast={showToast}
            onBack={() => setScreen("filters")}
            onContinue={() => setScreen(matchMode === "curated" ? "curated_results" : "swipe")}
            onDone={() => {
              // Curated host's "Done for now" — same exit as the Right Now
              // waiting card. The decision finds them: everyone's-picks push
              // + the Activity item, and Profile → Sessions re-opens it.
              setScreen("session_setup");
              setMatches([]);
              setMarkLikes([]);
              setPartnerLikes([]);
              setMarkPasses([]);
              setPartnerPasses([]);
              setSessionMatches([]);
              setCurrentSessionId(null);
              setPicked(null);
              setCardIndex(0);
            }}
          />
        )}
        {screen === "swipe" && (
          <div>
            <div className="mb-3 flex items-center justify-between text-sm text-neutral-500">
              <span>
                {matchMode === "curated" ? (
                  <>Shortlisted: {matches.length}</>
                ) : (
                  <>
                    Matches:{" "}
                    {matchMode === "concurrent" ? sessionMatches.length : matches.length}
                    {" "}/ {matchLimit}
                  </>
                )}
              </span>
              <span>
                {currentUserSwipedCount + 1} of {swipeQueue.length}
              </span>
            </div>
            {currentVenue ? (
              <>
                <VenueCard
                  venue={currentVenue}
                  beenPill={
                    <BeenPill
                      been={beenState.marked.has(currentVenue.id) || (beenState.visits.get(currentVenue.id) || 0) > 0}
                      visitCount={beenState.visits.get(currentVenue.id) || 0}
                      // ONE-WAY on the deck (Mark's call): tap marks Been,
                      // quietly, and never unmarks — a mis-tap is fixed on the
                      // full card, not by inviting fiddling mid-game. No toast,
                      // no follow-up; like/pass stays the dominant motion.
                      onToggle={
                        beenState.marked.has(currentVenue.id) ||
                        (beenState.visits.get(currentVenue.id) || 0) > 0
                          ? undefined
                          : () => deckMarkBeen(currentVenue.id)
                      }
                    />
                  }
                />
                <SwipeActions
                  mode={matchMode}
                  likeCount={markLikes.length}
                  onLike={likeVenue}
                  onPass={passVenue}
                  onSoloSave={soloSave}
                  onSoloSkip={soloSkip}
                  onSoloHide={soloHide}
                  onDoneAndSend={handleDoneAndSend}
                />
              </>
            ) : matchMode === "curated" ? (
              // Curated host has reached the end of curation without
              // explicitly tapping Done & Send. Auto-route them through
              // handleDoneAndSend so the session flips to 'open', the
              // shortlist is persisted, and they land on InviteShareScreen
              // — otherwise the session "ends" with no shareable state
              // (06-bugs.md, May 20).
              <EmptyState
                title="You've reviewed every place"
                text="Send your shortlist to friends to start matching."
                action={handleDoneAndSend}
                actionText={
                  markLikes.length > 0
                    ? `Send shortlist (${markLikes.length})`
                    : "Send to friends"
                }
              />
            ) : (
              // Friends-mode deck exhausted — the old "No more places /
              // View matches" card was a redundant stop before the real
              // end state (Mark, July 24). Route straight through.
              <AutoRoute go={() => setScreen("matches")} />
            )}
          </div>
        )}
        
        {screen === "curated_results" && (
          <div className="fixed inset-0 z-[2000] bg-[#fdf6f0] flex flex-col pb-24">
            <div className="bg-white border-b border-neutral-100 px-4 py-5 text-center">
              <p className="text-sm text-neutral-500">Everyone's picks</p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                Who's in for what
              </h1>
            </div>
            <CuratedResultsBoard
              sessionId={currentSessionId}
              venues={venues}
              hostUserId={session?.user?.id}
              userId={session?.user?.id}
              onOpenProfile={(uid) => setLookupUserId(uid)}
              savedIds={savedVenueIds}
              onSave={saveVenue}
              onUnsave={unsaveVenue}
              onHide={hideVenue}
              onDone={() => {
                setScreen("session_setup");
                setMatches([]);
                setMarkLikes([]);
                setMarkPasses([]);
                setSessionMatches([]);
                setCurrentSessionId(null);
                setPicked(null);
                setCardIndex(0);
              }}
              showToast={showToast}
              onScheduleNight={scheduleNight}
            />
          </div>
        )}
        {screen === "matches" && (() => {
          // Post-game results — full-screen overlay using the shared
          // SessionResultsView. Concurrent + Curated both read from live
          // reconciliation (sessionMatches). Solo doesn't have a matches
          // concept and falls back to a placeholder (shouldn't be reachable
          // in practice — solo end-of-queue should land on Filters, see
          // 06-bugs.md).
          const isSessionMode =
            matchMode === "concurrent" || matchMode === "curated";
          const matchCount = isSessionMode
            ? sessionMatches.length
            : matches.length;

          function handleDoneSession() {
            setScreen("session_setup");
            setMatches([]);
            setMarkLikes([]);
            setPartnerLikes([]);
            setMarkPasses([]);
            setPartnerPasses([]);
            setSessionMatches([]);
            setCurrentSessionId(null);
            setPicked(null);
            setCardIndex(0);
          }

          // Right Now never renders a board HERE any more (July 31, Mark:
          // one board, in Sessions). This screen is only the calm waiting
          // card; every ending — live match, everyone's in, time's up —
          // routes to the Sessions detail via finishSessionToBoard. The
          // redirect effects fire post-render, so return null for the one
          // frame where everyone's-in has landed but the route hasn't.
          if (matchMode === "concurrent" && allPartsSubmitted) {
            return null;
          }
          if (matchMode === "concurrent") {
            return (
              <div className="fixed inset-0 z-[2000] bg-[#fdf6f0] flex items-center justify-center p-6 pb-24">
                <div className="w-full max-w-sm text-center">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#edf2eb] text-[#455d3b]">
                    <Check size={28} />
                  </div>
                  <h1 className="text-2xl font-semibold tracking-tight">
                    Your picks are in
                  </h1>
                  <p className="mt-2 text-sm text-neutral-600">
                    {waitingOthersLeft > 0
                      ? `Waiting on ${
                          waitingOthersLeft === 1
                            ? "one friend"
                            : `${waitingOthersLeft} friends`
                        } — we'll nudge you when everyone is done.`
                      : "Waiting on your friends — we'll nudge you when everyone is done."}
                  </p>
                  {/* No "End it now" HERE (July 31, Mark: the host usually
                      submits FIRST — ending from this card would cut guests
                      off mid-swipe). Ending early lives on the Sessions board,
                      where the host returns once people have had their go.
                      This card just parks the session: Done for now, with a
                      quiet Extend for the host who already knows someone
                      needs longer. */}
                  {/* DURATION ROW (Aug 1, Mark: label and value as separate
                      entities, value as a clear dropdown, above Done). Shows
                      the session's duration as a property; changing it
                      recomputes expiry from creation. text-base: sub-16px
                      selects make iOS zoom the page. */}
                  {/* Copy per Mark (Aug 20): headline sells what the control
                      does; "Session length" over the awkward "Duration time". */}
                  <p className="mt-6 mb-2 text-sm font-medium text-neutral-800 text-left">
                    Give your friends time to pick
                  </p>
                  <div className="flex items-center justify-between rounded-2xl bg-white border border-neutral-200 px-4 py-3 text-left">
                    <span className="text-sm font-medium text-neutral-700">
                      Session length
                    </span>
                    <span className="relative inline-flex items-center">
                      <select
                        value={sessionTimeoutMins}
                        onChange={(e) =>
                          setSessionDuration(Number(e.target.value))
                        }
                        className="appearance-none rounded-full border border-[#cdd9c6] bg-[#edf2eb] py-1.5 pl-4 pr-8 text-base font-medium text-[#455d3b] focus:outline-none"
                      >
                        {SESSION_DURATIONS.map(([v, lbl]) => (
                          <option key={v} value={v}>
                            {lbl}
                          </option>
                        ))}
                      </select>
                      <span className="pointer-events-none absolute right-3 text-[#455d3b] text-xs">
                        ⌄
                      </span>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={handleDoneSession}
                    className="mt-3 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md"
                  >
                    Done for now
                  </button>
                  <p className="mt-3 text-xs text-neutral-400">
                    This session lives under Profile → Sessions
                  </p>
                </div>
              </div>
            );
          }

          return (
            <div className="fixed inset-0 z-[2000] bg-[#fdf6f0] flex flex-col pb-24">
              <div className="bg-white border-b border-neutral-100 px-4 py-5 text-center">
                <p className="text-sm text-neutral-500">Game over</p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">
                  {matchCount === 0
                    ? "No mutual matches"
                    : `You matched on ${matchCount} place${matchCount === 1 ? "" : "s"}`}
                </h1>
              </div>

              {isSessionMode ? (
                <SessionResultsView
                  participants={sessionParticipants}
                  sessionId={currentSessionId}
                  sessionMatches={sessionMatches}
                  myLikedIds={markLikes}
                  venues={venues}
                  userId={session?.user?.id}
                  hostUserId={session?.user?.id}
                  savedIds={savedVenueIds}
                  onSave={saveVenue}
                  onUnsave={unsaveVenue}
                  onHide={hideVenue}
                  onOpenProfile={(uid) => setLookupUserId(uid)}
                  showConfetti={matchCount > 0}
                  showToast={showToast}
                />
              ) : (
                <div className="flex-1 overflow-y-auto p-6 text-center text-neutral-500 text-sm">
                  Matches screen isn't used in solo mode.
                </div>
              )}

              <div className="fixed bottom-24 left-0 right-0 z-[2050] px-4 pb-2">
                <div className="max-w-sm mx-auto flex items-center gap-2">
                  {/* Pick for us — random match selector. Opens the venue
                      in MapVenueSheet so the user can decide on the spot.
                      Tap again to re-roll. Disabled when no matches. */}
                  <button
                    type="button"
                    onClick={pickForUs}
                    disabled={matchCount === 0}
                    className="flex-1 rounded-2xl bg-white border border-neutral-200 py-3 font-medium text-neutral-800 shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <span className="inline-flex items-center justify-center gap-2">
                      <Shuffle size={16} /> Pick for us
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={handleDoneSession}
                    className="flex-1 rounded-2xl bg-[#111111] py-3 font-medium text-white shadow-lg"
                  >
                    Done
                  </button>
                </div>
              </div>

              {/* Picked venue lands in MapVenueSheet — same in-app card the
                  rest of the app uses, so the user sees full details and
                  the Open in Maps action right there. */}
              {picked && (
                <MapVenueSheet
                  venue={picked}
                  onClose={() => setPicked(null)}
                  savedIds={savedVenueIds}
                  onSave={saveVenue}
                  onUnsave={unsaveVenue}
                  onHide={hideVenue}
                  onCheckIn={handleCheckIn}
                  onOpenThread={setThreadCheckin}
                  onOpenProfile={(uid) => setLookupUserId(uid)}
                  userId={session?.user?.id}
                />
              )}
            </div>
          );
        })()}
          </div>
        </div>
      )}
      {tab === "map" && (
        <MapScreen
          venues={venues}
          hiddenIds={hiddenVenueIds}
          areas={areas}
          onFiltersSnapshot={(f) => {
            mapFiltersRef.current = f; // ref: no re-render, read at FAB time
          }}
          savedIds={savedVenueIds}
          onSave={saveVenue}
          onUnsave={unsaveVenue}
          onHide={hideVenue}
          showToast={showToast}
          onCheckIn={handleCheckIn}
          onOpenThread={setThreadCheckin}
          onOpenProfile={(uid) => setLookupUserId(uid)}
          userId={session?.user?.id}
          searchOpen={mapSearchOpen}
          onSearchOpenChange={setMapSearchOpen}
          personFilter={mapPersonFilter}
          onClearPersonFilter={() => setMapPersonFilter(null)}
          onVenueAdded={(venue, opts) => {
            // New venue from the search sheet → into the pool state so the
            // card/fly-to work. Only mark saved when the user chose "Add to
            // my list" — a check-in-only add stays off their map.
            setVenues((prev) =>
              prev.some((v) => v.id === venue.id) ? prev : [...prev, venue]
            );
            if (opts?.saved !== false) {
              setSavedVenueIds((prev) => new Set([...prev, venue.id]));
            }
          }}
        />
      )}
      {tab === "profile" && (
        <ProfileTab
          profile={profile}
          setProfile={setProfile}
          session={session}
          signOut={signOut}
          venues={venues}
          savedIds={savedVenueIds}
          hiddenIds={hiddenVenueIds}
          onSave={saveVenue}
          onUnsave={unsaveVenue}
          onHide={hideVenue}
          onUnhide={unhideVenue}
          showImport={showImport}
          setShowImport={setShowImport}
          showToast={showToast}
          onOpenProfile={openProfile}
          onFindFriends={() => setShowFindFriends(true)}
          onAddNight={() => setCheckinForm({ mode: "date" })}
          beenRefresh={beenRefresh}
          onScheduleNight={scheduleNight}
        />
      )}
      {tab === "activity" && session?.user?.id && (
        <ActivityDrawer
          asTab
          userId={session?.user?.id}
          onOpenProfile={openProfile}
          onOpenSession={(sid) => setNotifSessionId(sid)}
          onOpenVenue={(v) => {
            setCardVenueZ(3100); // base layer — a strip-tap thread stacks above
            setCardVenue(v);
          }}
          onCheckIn={handleCheckIn}
          profileIncomplete={profileIncomplete}
          onFinishProfile={() => setTab("profile")}
          showToast={showToast}
        />
      )}
      {/* EVENTS — fifth tab (Aug 29–30). Upcoming nights + past events;
          "+ Create event" opens the unified form's event variant. */}
      {tab === "events" && session?.user?.id && (
        <EventsScreen
          userId={session.user.id}
          showToast={showToast}
          onOpenProfile={openProfile}
          onCreateEvent={() => setCheckinForm({ event: true })}
          refreshSignal={beenRefresh}
        />
      )}
      {showImport && (
        <ImportGoogleMapsScreen
          userId={session?.user?.id}
          onBack={() => setShowImport(false)}
        />
      )}
      {showFindFriends && (
        <FindFriendsSheet
          profile={profile}
          viewerUserId={session?.user?.id}
          onBack={() => setShowFindFriends(false)}
          onOpenProfile={(uid) => {
            setShowFindFriends(false);
            setLookupUserId(uid);
          }}
          showToast={showToast}
        />
      )}
      {lookupUserId && (
        <ProfileLookupScreen
          userId={lookupUserId}
          viewerUserId={session?.user?.id}
          onBack={() => setLookupUserId(null)}
          showToast={showToast}
          hidden={lookupHidden}
          onOpenProfile={(uid) => openProfile(uid)}
          onShowOnMap={(p) => {
            setLookupUserId(null);
            setMapPersonFilter({ userId: lookupUserId, profile: p });
            setTab("map");
          }}
          onOpenThread={(t) => {
            // Cards render UNDER the profile (3600 < 3900) — hide the
            // profile so the album shows, without unmounting it.
            setLookupHidden(true);
            setThreadCheckin(t);
          }}
        />
      )}
      {notifSessionId && (
        <SessionsScreen
          venues={venues}
          userId={session?.user?.id}
          savedIds={savedVenueIds}
          onSave={saveVenue}
          onUnsave={unsaveVenue}
          onHide={hideVenue}
          onBack={() => setNotifSessionId(null)}
          showToast={showToast}
          onOpenProfile={(uid) => setLookupUserId(uid)}
          initialSessionId={notifSessionId}
          onScheduleNight={scheduleNight}
        />
      )}
      {cardVenue && (
        <MapVenueSheet
          venue={cardVenue}
          onClose={() => setCardVenue(null)}
          savedIds={savedVenueIds}
          onSave={saveVenue}
          onUnsave={unsaveVenue}
          onHide={hideVenue}
          onCheckIn={handleCheckIn}
          onOpenThread={setThreadCheckin}
          onOpenProfile={(uid) => setLookupUserId(uid)}
          userId={session?.user?.id}
          zIndex={cardVenueZ}
        />
      )}
      {/* Post-signup onboarding (B): real account, no username yet, not
          already dismissed. The came-from-guest deferral is GONE (July 31,
          Mark: "there is no onboarding path... we should get Display Name,
          username and profile image") — a gate signup used to sail past this
          with an email-local-part name and no photo, and the profile nudge
          was too weak to catch them. isGuest still guards it, so the reveal
          moment is never interrupted; this fires when they enter the app. */}
      {!isGuest &&
        !onboardingDismissed &&
        session?.user?.id &&
        session.user.is_anonymous === false &&
        profile &&
        !profile.username && (
          <OnboardingScreen
            userId={session.user.id}
            profile={profile}
            setProfile={setProfile}
            onDone={dismissOnboarding}
          />
        )}
      <FloatingActionButton
        tab={tab}
        showToast={showToast}
        onAddFriend={() => setShowFindFriends(true)}
        onImportMap={() => setShowImport(true)}
        onCheckIn={() => {
          // The unified form, on THIS page (Aug, Mark: "It should stay on
          // the same page you are on") — no map jump, no search sheet. The
          // form has its own place search.
          setCheckinForm({ mode: "now" });
        }}
        onRightNow={() => {
          carryMapFilters();
          setMatchMode("concurrent");
          setEventDate(null);
          setScreen("filters");
          setTab("matches");
        }}
        onShortlist={() => {
          carryMapFilters();
          setMatchMode("curated");
          setEventDate(null);
          setScreen("filters");
          setTab("matches");
        }}
      />
      {checkinSheet && (
        <CheckinSheet
          venue={checkinSheet.venue}
          activity={checkinSheet.activity}
          userId={session?.user?.id}
          showToast={showToast}
          onClose={() => setCheckinSheet(null)}
        />
      )}
      {/* THE ONE CHECK-IN FORM — overlays whatever page is active (Aug,
          Mark). Saving offers the album (unless the door already did),
          then opens the night's card on top. */}
      {checkinForm && session?.user?.id && (
        <CheckinForm
          userId={session.user.id}
          prefill={checkinForm}
          showToast={showToast}
          onClose={() => setCheckinForm(null)}
          onCreated={(t) => {
            setCheckinForm(null);
            setBeenRefresh((n) => n + 1);
            // Events skip the album prompt (the toggle already answered) and
            // open the card — that IS the share moment: address for the
            // guest list, Collect photos link for everyone else.
            if (t.isEvent) {
              showToast("Event created — share it from the card");
              setThreadCheckin(t);
            } else if (t.bornAlbum) setThreadCheckin(t);
            else setAlbumPromptFor(t); // "Create an album?" first (Aug 21)
          }}
        />
      )}
      {albumPromptFor && (
        <AlbumPrompt
          venueName={albumPromptFor.venueName}
          busy={albumPromptBusy}
          onCreate={async () => {
            setAlbumPromptBusy(true);
            const { error } = await supabase.rpc("create_night_album", {
              p_activity_id: albumPromptFor.activityId,
            });
            setAlbumPromptBusy(false);
            if (error) {
              console.error("Create album failed:", error);
              showToast("Couldn't create the album");
              return;
            }
            const t = albumPromptFor;
            setAlbumPromptFor(null);
            setThreadCheckin(t); // card opens in album mode
          }}
          onSkip={() => {
            const t = albumPromptFor;
            setAlbumPromptFor(null);
            setThreadCheckin(t); // plain card; upgrade lives on the tile
          }}
        />
      )}
      {threadCheckin && (
        <CheckinThreadSheet
          thread={threadCheckin}
          userId={session?.user?.id}
          showToast={showToast}
          onClose={() => {
            setThreadCheckin(null);
            setLookupHidden(false); // unhide the profile if we came from one
          }}
          onOpenProfile={(uid) => {
            // Lookup sits ABOVE the card now — only close for self (Profile
            // tab lives beneath everything).
            if (uid && uid === session?.user?.id) setThreadCheckin(null);
            openProfile(uid);
          }}
          onOpenVenue={(v) => {
            // Keep the check-in card open underneath — the venue card stacks
            // above it (zIndex 3700) and closing it returns you here.
            setCardVenueZ(3700);
            setCardVenue(v);
          }}
          onCheckIn={handleCheckIn}
        />
      )}
      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
      <BottomTabBar
        tab={tab}
        unreadCount={unreadCount}
        profileDot={profileIncomplete}
        setTab={(t) => {
          setNotifSessionId(null);
          setCardVenue(null);
          setTab(t);
        }}
      />
    </div>
  );
}

// venueMatchesAreas, getMapsUrl, getDistanceKm, day/time helpers, isVenueOpenNow,
// venueMatchesVibe moved to ./lib/venueLogic.js (imported at the top).
 
// UserToggle deleted (dead code — no longer rendered).
// OpenNowToggle, AreaCheckbox + the form fields moved to ./components/SessionFields.js.

function AreaFilter({
  areaSearch,
  setAreaSearch,
  selectedAreas,
  setSelectedAreas,
  showAreaDropdown,
  setShowAreaDropdown,
  areas,
  areasLoading,
  expandedRegions,
  setExpandedRegions,
}) {
  const [searchActive, setSearchActive] = useState(false);
  const searchInputRef = useRef(null);

  useEffect(() => {
    if (searchActive) {
      searchInputRef.current?.focus();
    }
  }, [searchActive]);

  useEffect(() => {
    if (!showAreaDropdown) setSearchActive(false);
  }, [showAreaDropdown]);

  const areasByRegion = useMemo(() => {
    const groups = new Map();
    for (const a of areas) {
      const region = a.region || "Other";
      if (!groups.has(region)) groups.set(region, []);
      groups.get(region).push(a);
    }
    return Array.from(groups.entries()).map(([region, items]) => ({
      region,
      items,
    }));
  }, [areas]);
 
  const searchedAreas = useMemo(() => {
    const q = areaSearch.trim().toLowerCase();
    if (!q) return [];
    return areas
      .filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.region || "").toLowerCase().includes(q)
      )
      .slice(0, 50);
  }, [areas, areaSearch]);
 
  const selectedIds = useMemo(
    () => new Set(selectedAreas.map((a) => a.id)),
    [selectedAreas]
  );
 
  function toggleSuburb(area) {
    if (selectedIds.has(area.id)) {
      setSelectedAreas((prev) => prev.filter((a) => a.id !== area.id));
    } else {
      setSelectedAreas((prev) => [
        ...prev,
        {
          id: area.id,
          name: area.name,
          lat: area.lat,
          lng: area.lng,
          region: area.region,
        },
      ]);
    }
  }
 
  function toggleRegion(items, region) {
    const allSelected = items.every((a) => selectedIds.has(a.id));
    if (allSelected) {
      const itemIds = new Set(items.map((a) => a.id));
      setSelectedAreas((prev) => prev.filter((a) => !itemIds.has(a.id)));
    } else {
      const missing = items.filter((a) => !selectedIds.has(a.id));
      setSelectedAreas((prev) => [
        ...prev,
        ...missing.map((a) => ({
          id: a.id,
          name: a.name,
          lat: a.lat,
          lng: a.lng,
          region: a.region,
        })),
      ]);
      // Ticking a WHOLE region unrolls its suburbs (July 31, Mark): the person
      // just grabbed a big area sight-unseen — show them what that actually
      // means and let them deselect the odd one out. Accordion rules apply
      // (any other open region closes); deselecting leaves expansion alone.
      if (region) {
        anchorTo(region);
        setExpandedRegions(new Set([region]));
      }
    }
  }
 
  function getRegionState(items) {
    const selectedCount = items.filter((a) => selectedIds.has(a.id)).length;
    if (selectedCount === 0) return "none";
    if (selectedCount === items.length) return "all";
    return "some";
  }

  // ACCORDION + SCROLL ANCHOR (July 31, Mark). One region open at a time —
  // but closing a region ABOVE the tapped one removes content overhead, which
  // would yank the list up under the user's finger. So before every expansion
  // change we note where the tapped region's row sits on screen, and after the
  // re-render nudge scrollTop so that row hasn't moved. useLayoutEffect, not
  // useEffect: the correction must land before paint or it reads as a flicker.
  const listRef = useRef(null);
  const rowRefs = useRef({});
  const scrollAnchor = useRef(null); // { region, top } captured pre-update
  function anchorTo(region) {
    const el = rowRefs.current[region];
    if (el && listRef.current) {
      scrollAnchor.current = { region, top: el.getBoundingClientRect().top };
    }
  }
  useLayoutEffect(() => {
    const a = scrollAnchor.current;
    if (!a) return;
    scrollAnchor.current = null;
    const el = rowRefs.current[a.region];
    const list = listRef.current;
    if (!el || !list) return;
    const delta = el.getBoundingClientRect().top - a.top;
    if (delta !== 0) list.scrollTop += delta;
  }, [expandedRegions]);

  function toggleExpand(region) {
    anchorTo(region);
    setExpandedRegions((prev) =>
      prev.has(region) ? new Set() : new Set([region])
    );
  }
 
  function clearAll() {
    setSelectedAreas([]);
    setAreaSearch("");
  }
 
  let placeholderText;
  if (areasLoading) {
    placeholderText = "Loading suburbs...";
  } else if (selectedAreas.length === 0) {
    placeholderText = "Search suburb or region";
  } else {
    const names = selectedAreas.map((a) => a.name).join(", ");
    const truncated = names.length > 32 ? names.slice(0, 30) + "..." : names;
    placeholderText = `${selectedAreas.length} selected · ${truncated}`;
  }
 
  return (
    <div>
       <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-medium text-neutral-700">
          Where are we going?
        </span>
        {selectedAreas.length > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#edf2eb] px-3 py-1 text-xs font-medium text-[#455d3b] border border-[#c5d4c2]"
          >
            {selectedAreas.length} selected
            <X size={12} />
          </button>
        )}
      </div>
      <input
        ref={searchInputRef}
        value={areaSearch}
        readOnly={!searchActive}
        inputMode={searchActive ? "text" : "none"}
        onFocus={() => setShowAreaDropdown(true)}
        onChange={(event) => {
          setAreaSearch(event.target.value);
          setShowAreaDropdown(true);
        }}
        placeholder={placeholderText}
        disabled={areasLoading}
        className="w-full rounded-2xl bg-neutral-50 px-4 py-4 text-base outline-none border border-neutral-100"
      />

      {showAreaDropdown && !areasLoading && (
        <div
          ref={listRef}
          className="mt-3 max-h-80 overflow-y-auto rounded-2xl bg-white border border-neutral-100 shadow-sm"
        >
          <div className="sticky top-0 z-10 flex items-center justify-end gap-1 bg-white border-b border-neutral-100 px-2 py-2">
            <button
              type="button"
              onClick={() => {
                setSearchActive(true);
                setTimeout(() => searchInputRef.current?.focus(), 0);
              }}
              aria-label="Search"
              className={`flex h-8 w-8 items-center justify-center rounded-full hover:bg-neutral-100 ${
                searchActive ? "text-[#455d3b]" : "text-neutral-500"
              }`}
            >
              <Search size={16} />
            </button>
            <button
              type="button"
              onClick={() => setShowAreaDropdown(false)}
              aria-label="Close"
              className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100"
            >
              <X size={16} />
            </button>
          </div>
          {areaSearch.trim() ? (
            searchedAreas.length === 0 ? (
              <div className="px-4 py-3 text-sm text-neutral-500">
                No matching suburbs
              </div>
            ) : (
              <ul>
                {searchedAreas.map((a) => {
                  const state = selectedIds.has(a.id) ? "all" : "none";
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => toggleSuburb(a)}
                        className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm hover:bg-neutral-50"
                      >
                        <AreaCheckbox state={state} />
                        <span className="flex-1 font-medium text-neutral-800">
                          {a.name}
                        </span>
                        <span className="text-xs text-neutral-500">
                          {a.region}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            <ul>
              {areasByRegion.map(({ region, items }) => {
                const open = expandedRegions.has(region);
                const state = getRegionState(items);
                const selectedCount = items.filter((a) =>
                  selectedIds.has(a.id)
                ).length;
                return (
                  <li
                    key={region}
                    ref={(node) => {
                      if (node) rowRefs.current[region] = node;
                      else delete rowRefs.current[region];
                    }}
                    className="border-b border-neutral-100 last:border-b-0"
                  >
                    <div className="flex items-stretch">
                      <button
                        type="button"
                        onClick={() => toggleRegion(items, region)}
                        aria-label={`Select all in ${region}`}
                        className="flex items-center justify-center pl-4 pr-2 hover:bg-neutral-50"
                      >
                        <AreaCheckbox state={state} />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleExpand(region)}
                        aria-expanded={open}
                        className="flex flex-1 items-center gap-3 py-3 pr-4 text-left text-sm font-medium text-neutral-800 hover:bg-neutral-50"
                      >
                        <span className="flex-1">{region}</span>
                        <span className="text-xs text-neutral-500">
                          {selectedCount}/{items.length}
                        </span>
                        <span
                          className={`text-neutral-500 transition-transform ${
                            open ? "rotate-180" : ""
                          }`}
                        >
                          ⌄
                        </span>
                      </button>
                    </div>
                    {open && (
                      <ul className="bg-neutral-50">
                        {items.map((a) => {
                          const subState = selectedIds.has(a.id) ? "all" : "none";
                          return (
                            <li key={a.id}>
                              <button
                                type="button"
                                onClick={() => toggleSuburb(a)}
                                className="flex w-full items-center gap-3 px-6 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-100"
                              >
                                <AreaCheckbox state={subState} />
                                <span>{a.name}</span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
 
// MultiSelectChips, MatchLimitField, ParticipantsField, TimeLimitField
// moved to ./components/SessionFields.js (imported at the top).
 
// VenueHeroCarousel, PhotoAttribution, VenueVibes, VenueCard moved to
// ./components/VenueBits.js (imported at the top).

// MapVenueSheet moved to ./components/MapVenueSheet.js (imported at the top).

// FAB rendered above the BottomTabBar on Profile and Map tabs. Tap to expand
// a tap-to-pick menu of add actions; per-tab option list. Find Friends is
// the only target wired in D.1 (via onAddFriend); the other actions are stubs
// that fire a "Coming soon" toast until #17 / #21 ship.
// FloatingActionButton moved to ./components/Chrome.js (imported at the top).

// ActivityDrawer + ActivityItem moved to ./components/ActivityDrawer.js
// (imported at the top).

// Single-message toast pinned above the BottomTabBar. Self-clears after 2.2s.
// Render anywhere; controlled via App-level toastMessage state.
// Toast + BottomTabBar moved to ./components/Chrome.js (imported at the top).

function ProfileTab({
  profile,
  setProfile,
  session,
  signOut,
  venues,
  savedIds,
  hiddenIds,
  onSave,
  onUnsave,
  onHide,
  onUnhide,
  showImport,
  setShowImport,
  showToast,
  onOpenProfile,
  onFindFriends,
  onAddNight,
  beenRefresh,
  onScheduleNight,
}) {
  const [showMyList, setShowMyList] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [sessionsCount, setSessionsCount] = useState(null);
  // Been — your own check-in history (the memory ledger).
  const [showBeen, setShowBeen] = useState(false);

  // (The scheduler → Been navigation handoff died in Aug's overlay refactor:
  // CheckinForm now overlays whatever page you're on — no tab switch.)
  const [beenCount, setBeenCount] = useState(null);
  // Friend graph counts for the entry card subtitle. Two queries kept simple
  // (count, head:true). Task #8 will lift requestCount to App level so the
  // bell badge shares the same source.
  const [showFriends, setShowFriends] = useState(false);
  const [friendCount, setFriendCount] = useState(null);
  const [requestCount, setRequestCount] = useState(null);

  // Light-touch count fetch just for the card subtitle. The full sessions
  // list is fetched lazily when the user opens the SessionsScreen.
  useEffect(() => {
    if (!session?.user?.id) {
      setSessionsCount(null);
      return;
    }
    let cancelled = false;
    supabase
      .from("session_participants")
      .select("session_id", { count: "exact", head: true })
      .eq("user_id", session.user.id)
      .then(({ count, error }) => {
        if (cancelled || error) return;
        setSessionsCount(count ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  // Been count for the card subtitle.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) {
      setBeenCount(null);
      return;
    }
    let cancelled = false;
    supabase
      .from("activities")
      .select("id", { count: "exact", head: true })
      .eq("user_id", uid)
      .eq("kind", "checkin")
      .then(({ count, error }) => {
        if (cancelled || error) return;
        setBeenCount(count ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);

  // Friend + request counts. Accepted friendships (either party) drive the
  // "N friends" subtitle; incoming pending requests (I'm addressee) drive the
  // red badge. Two separate count queries — cheaper than fetching rows.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) {
      setFriendCount(null);
      setRequestCount(null);
      return;
    }
    let cancelled = false;
    supabase
      .from("friendships")
      .select("id", { count: "exact", head: true })
      .or(`requester_id.eq.${uid},addressee_id.eq.${uid}`)
      .eq("status", "accepted")
      .then(({ count, error }) => {
        if (cancelled || error) return;
        setFriendCount(count ?? 0);
      });
    supabase
      .from("friendships")
      .select("id", { count: "exact", head: true })
      .eq("addressee_id", uid)
      .eq("status", "pending")
      .then(({ count, error }) => {
        if (cancelled || error) return;
        setRequestCount(count ?? 0);
      });
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id]);
  const [displayName, setDisplayName] = useState(profile?.display_name || "");
  const [username, setUsername] = useState(profile?.username || "");
  const [usernameStatus, setUsernameStatus] = useState({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  // Sync local form state when a different profile loads (e.g. after sign-in).
  // Keyed on profile.id so unsaved edits aren't blown away by a re-fetch of
  // the same profile.
  useEffect(() => {
    if (profile) {
      setDisplayName(profile.display_name || "");
      setUsername(profile.username || "");
    }
  }, [profile?.id]);

  // Debounced username availability check.
  useEffect(() => {
    const trimmed = username.trim().toLowerCase();
    if (!trimmed) {
      setUsernameStatus({ state: "idle" });
      return;
    }
    if (trimmed.length < 3) {
      setUsernameStatus({ state: "tooShort" });
      return;
    }
    if (!/^[a-z0-9_]+$/.test(trimmed)) {
      setUsernameStatus({ state: "invalid" });
      return;
    }
    if (trimmed === (profile?.username || "").toLowerCase()) {
      setUsernameStatus({ state: "current" });
      return;
    }
    setUsernameStatus({ state: "checking" });
    const handle = setTimeout(async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id")
        .eq("username", trimmed)
        .neq("id", session.user.id)
        .maybeSingle();
      if (error) {
        setUsernameStatus({ state: "error" });
      } else if (data) {
        setUsernameStatus({ state: "taken" });
      } else {
        setUsernameStatus({ state: "available" });
      }
    }, 300);
    return () => clearTimeout(handle);
  }, [username, profile?.username, session?.user?.id]);

  const trimmedDisplay = displayName.trim();
  const trimmedUsername = username.trim().toLowerCase();
  const hasChanges =
    trimmedDisplay !== (profile?.display_name || "") ||
    trimmedUsername !== (profile?.username || "").toLowerCase();
  const usernameOk =
    usernameStatus.state === "available" ||
    usernameStatus.state === "current" ||
    usernameStatus.state === "idle";
  const canSave = hasChanges && usernameOk && !saving;

  async function handleSave() {
    setSaving(true);
    setSaveError("");
    setSaved(false);
    const updates = {
      display_name: trimmedDisplay || null,
      username: trimmedUsername || null,
    };
    const { data, error } = await supabase
      .from("profiles")
      .update(updates)
      .eq("id", session.user.id)
      .select()
      .single();
    setSaving(false);
    if (error) {
      setSaveError(error.message || "Couldn't save. Try again.");
    } else {
      setProfile(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    }
  }

  const avatarFileRef = useRef(null);
  const usernameInputRef = useRef(null);
  const [avatarUploading, setAvatarUploading] = useState(false);
  async function handleAvatarUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarUploading(true);
    setSaveError("");
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const path = `${session.user.id}/${Date.now()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from("avatars")
        .upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) {
        setSaveError("Couldn't upload that photo. Try another.");
        return;
      }
      const { data: pub } = supabase.storage.from("avatars").getPublicUrl(path);
      const { data, error } = await supabase
        .from("profiles")
        .update({ avatar_url: pub.publicUrl })
        .eq("id", session.user.id)
        .select()
        .single();
      if (error) {
        setSaveError("Couldn't save the photo. Try again.");
        return;
      }
      setProfile(data);
    } catch {
      setSaveError("Couldn't upload that photo. Try another.");
    } finally {
      setAvatarUploading(false);
    }
  }

  const email = session?.user?.email || "";
  const initial = (trimmedDisplay || email || "?").charAt(0).toUpperCase();
  const tierLabel = {
    active: "Member",
    micro_influencer: "Micro Influencer",
    influencer: "Influencer",
  }[profile?.tier] || "Member";

  return (
    <div className="flex items-start justify-center p-4 pb-52">
      {showMyList && (
        <MyListScreen
          venues={venues}
          savedIds={savedIds}
          hiddenIds={hiddenIds}
          onBack={() => setShowMyList(false)}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
          onUnhide={onUnhide}
          userId={session?.user?.id}
        />
      )}
      {showFriends && (
        <FriendsScreen
          userId={session?.user?.id}
          onBack={() => setShowFriends(false)}
          showToast={showToast}
          onOpenProfile={onOpenProfile}
          onAddFriend={onFindFriends}
        />
      )}
      {showSessions && (
        <SessionsScreen
          venues={venues}
          userId={session?.user?.id}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
          onBack={() => setShowSessions(false)}
          showToast={showToast}
          onOpenProfile={onOpenProfile}
          onScheduleNight={onScheduleNight}
        />
      )}
      {showBeen && (
        <BeenScreen
          userId={session?.user?.id}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
          onBack={() => setShowBeen(false)}
          onAddNight={onAddNight}
          refreshSignal={beenRefresh}
          showToast={showToast}
          onOpenProfile={(uid) => {
            // Lookup renders ABOVE Been now — only close for self (your
            // Profile tab is what's underneath Been).
            if (uid && uid === session?.user?.id) {
              setShowBeen(false);
              return;
            }
            onOpenProfile?.(uid); // ProfileTab's prop → lookup screen at root
          }}
        />
      )}
      <div className="w-full max-w-sm">
        <div className="mb-5">
          <p className="text-sm text-neutral-500">Account</p>
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        </div>

        {(!profile?.username || !profile?.avatar_url) && (
          <div className="mb-5 rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] p-4">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-[#2f3f29]">
                Complete your profile
              </p>
              <span className="text-xs text-[#455d3b]">
                {[profile?.username, profile?.avatar_url].filter(Boolean).length} of 2
              </span>
            </div>
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => avatarFileRef.current?.click()}
                disabled={!!profile?.avatar_url}
                className="flex w-full items-center gap-2 py-1 text-sm text-[#2f3f29]"
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full ${
                    profile?.avatar_url
                      ? "bg-[#455d3b] text-white"
                      : "border border-[#455d3b]"
                  }`}
                >
                  {profile?.avatar_url && <Check size={12} />}
                </span>
                <span className={profile?.avatar_url ? "text-neutral-400 line-through" : ""}>
                  Add a profile photo
                </span>
                {!profile?.avatar_url && (
                  <span className="ml-auto text-xs font-medium text-[#455d3b]">Add</span>
                )}
              </button>
              <button
                type="button"
                onClick={() => usernameInputRef.current?.focus()}
                disabled={!!profile?.username}
                className="flex w-full items-center gap-2 py-1 text-sm text-[#2f3f29]"
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full ${
                    profile?.username
                      ? "bg-[#455d3b] text-white"
                      : "border border-[#455d3b]"
                  }`}
                >
                  {profile?.username && <Check size={12} />}
                </span>
                <span className={profile?.username ? "text-neutral-400 line-through" : ""}>
                  Pick a username
                </span>
                {!profile?.username && (
                  <span className="ml-auto text-xs font-medium text-[#455d3b]">Add</span>
                )}
              </button>
            </div>
          </div>
        )}

        <div className="text-center mb-5">
          <button
            type="button"
            onClick={() => avatarFileRef.current?.click()}
            aria-label="Change photo"
            className="relative inline-flex items-center justify-center w-20 h-20 rounded-full overflow-hidden bg-[#455d3b] text-white text-3xl font-medium active:scale-95 transition"
          >
            {profile?.avatar_url ? (
              <img
                src={profile.avatar_url}
                alt="Your avatar"
                className="h-full w-full object-cover"
              />
            ) : (
              initial
            )}
            <span className="absolute -right-0.5 -bottom-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-[#455d3b] text-white border-4 border-white">
              <Camera size={13} />
            </span>
          </button>
          <input
            ref={avatarFileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAvatarUpload}
          />
          {avatarUploading && (
            <p className="text-xs text-neutral-400 mt-1">Uploading…</p>
          )}
          {email && (
            <p className="text-sm text-neutral-500 mt-2">{email}</p>
          )}
          <span className="inline-block mt-2 text-xs text-[#455d3b] bg-[#455d3b]/10 rounded-full px-3 py-1">
            {tierLabel}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setShowMyList(true)}
          className="w-full rounded-3xl bg-white p-4 shadow-sm border border-neutral-100 flex items-center gap-3 text-left mb-3 hover:bg-neutral-50 active:scale-[0.99] transition"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b]">
            <Heart size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium">My List</p>
            <p className="text-xs text-neutral-500">
              {savedIds?.size || 0} saved · {hiddenIds?.size || 0} hidden
            </p>
          </div>
          <span className="text-neutral-400 text-lg leading-none">›</span>
        </button>

        <button
          type="button"
          onClick={() => setShowBeen(true)}
          className="w-full rounded-3xl bg-white p-4 shadow-sm border border-neutral-100 flex items-center gap-3 text-left mb-3 hover:bg-neutral-50 active:scale-[0.99] transition"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b]">
            <MapPinIcon size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium">Been</p>
            <p className="text-xs text-neutral-500">
              {beenCount === null
                ? "Loading..."
                : beenCount === 0
                ? "No check-ins yet"
                : `${beenCount} check-in${beenCount === 1 ? "" : "s"}`}
            </p>
          </div>
          <span className="text-neutral-400 text-lg leading-none">›</span>
        </button>

        <button
          type="button"
          onClick={() => setShowSessions(true)}
          className="w-full rounded-3xl bg-white p-4 shadow-sm border border-neutral-100 flex items-center gap-3 text-left mb-3 hover:bg-neutral-50 active:scale-[0.99] transition"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b]">
            <Users size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium">Your sessions</p>
            <p className="text-xs text-neutral-500">
              {sessionsCount === null
                ? "Loading..."
                : sessionsCount === 0
                ? "Nothing yet"
                : `${sessionsCount} session${sessionsCount === 1 ? "" : "s"}`}
            </p>
          </div>
          <span className="text-neutral-400 text-lg leading-none">›</span>
        </button>

        <button
          type="button"
          onClick={() => setShowFriends(true)}
          className="w-full rounded-3xl bg-white p-4 shadow-sm border border-neutral-100 flex items-center gap-3 text-left mb-3 hover:bg-neutral-50 active:scale-[0.99] transition"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b]">
            <Heart size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium">Friends</p>
            <p className="text-xs text-neutral-500 flex items-center gap-2">
              {friendCount === null
                ? "Loading..."
                : friendCount === 0
                ? "Nobody yet"
                : `${friendCount} friend${friendCount === 1 ? "" : "s"}`}
              {requestCount > 0 && (
                <span className="inline-flex items-center justify-center rounded-full bg-red-600 text-white text-[10px] font-medium px-2 py-0.5">
                  {requestCount} request{requestCount === 1 ? "" : "s"}
                </span>
              )}
            </p>
          </div>
          <span className="text-neutral-400 text-lg leading-none">›</span>
        </button>

        <button
          type="button"
          onClick={() => setShowImport(true)}
          className="w-full rounded-3xl bg-white p-4 shadow-sm border border-neutral-100 flex items-center gap-3 text-left mb-4 hover:bg-neutral-50 active:scale-[0.99] transition"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b]">
            <Download size={18} />
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-medium">Import from Google Maps</p>
            <p className="text-xs text-neutral-500">
              Bring your saved places onto your map
            </p>
          </div>
          <span className="text-neutral-400 text-lg leading-none">›</span>
        </button>

        <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 space-y-4">
          <label className="block">
            <span className="block text-xs font-medium text-neutral-700 mb-1.5">
              Your name
            </span>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={60}
              className="w-full rounded-2xl bg-neutral-50 px-4 py-3 text-base outline-none border border-neutral-100"
            />
          </label>

          <label className="block">
            <span className="block text-xs font-medium text-neutral-700 mb-1.5">
              Username
            </span>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-400 text-base">
                @
              </span>
              <input
                ref={usernameInputRef}
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value.toLowerCase())}
                maxLength={20}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                className="w-full rounded-2xl bg-neutral-50 pl-8 pr-4 py-3 text-base outline-none border border-neutral-100"
              />
            </div>
            <UsernameHint status={usernameStatus} />
          </label>
        </div>

        <button
          onClick={handleSave}
          disabled={!canSave}
          className="w-full rounded-2xl bg-[#455d3b] py-4 mt-4 font-medium text-white disabled:bg-neutral-300"
        >
          {saving ? "Saving..." : saved ? "Saved" : "Save"}
        </button>
        {saveError && (
          <p className="text-sm text-red-600 mt-2 text-center">{saveError}</p>
        )}

        <div className="h-px bg-neutral-200 my-6" />

        <button
          onClick={signOut}
          className="w-full rounded-2xl bg-white border border-neutral-200 py-4 font-medium text-red-700 flex items-center justify-center gap-2"
        >
          <LogOut size={18} />
          Sign out
        </button>
      </div>
    </div>
  );
}

function UsernameHint({ status }) {
  if (status.state === "idle" || status.state === "current") return null;
  if (status.state === "checking") {
    return <p className="text-xs mt-1.5 text-neutral-400">Checking...</p>;
  }
  if (status.state === "tooShort") {
    return <p className="text-xs mt-1.5 text-neutral-400">At least 3 characters</p>;
  }
  if (status.state === "invalid") {
    return (
      <p className="text-xs mt-1.5 text-red-600">
        Letters, numbers, and underscores only
      </p>
    );
  }
  if (status.state === "available") {
    return (
      <p className="text-xs mt-1.5 text-green-700 flex items-center gap-1">
        <Check size={14} /> Available
      </p>
    );
  }
  if (status.state === "taken") {
    return (
      <p className="text-xs mt-1.5 text-red-600 flex items-center gap-1">
        <X size={14} /> Taken
      </p>
    );
  }
  if (status.state === "error") {
    return (
      <p className="text-xs mt-1.5 text-neutral-500">
        Couldn't check availability
      </p>
    );
  }
  return null;
}

function MyListScreen({
  venues,
  savedIds,
  hiddenIds,
  onBack,
  onSave,
  onUnsave,
  onHide,
  onUnhide,
  userId,
}) {
  const [view, setView] = useState("saved");
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [typeFilter, setTypeFilter] = useState(null);

  const sourceIds = view === "saved" ? savedIds : hiddenIds;

  const listVenues = useMemo(() => {
    const filtered = venues.filter((v) => sourceIds.has(v.id));
    if (typeFilter) return filtered.filter((v) => v.type === typeFilter);
    return filtered;
  }, [venues, sourceIds, typeFilter]);

  const availableTypes = useMemo(() => {
    return Array.from(
      new Set(venues.filter((v) => sourceIds.has(v.id)).map((v) => v.type))
    )
      .filter(Boolean)
      .sort();
  }, [venues, sourceIds]);

  return (
    <div className="fixed inset-0 z-[2000] bg-[#fdf6f0] flex flex-col">
      <div className="bg-white border-b border-neutral-100 px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-lg font-semibold flex-1">My List</h1>
      </div>

      <div className="bg-white border-b border-neutral-100 px-4 py-2 flex gap-2">
        <button
          type="button"
          onClick={() => setView("saved")}
          className={`flex-1 rounded-full py-2 text-sm font-medium transition ${
            view === "saved"
              ? "bg-[#455d3b] text-white"
              : "bg-neutral-50 text-neutral-700 border border-neutral-100"
          }`}
        >
          Saved
        </button>
        <button
          type="button"
          onClick={() => setView("hidden")}
          className={`flex-1 rounded-full py-2 text-sm font-medium transition ${
            view === "hidden"
              ? "bg-[#455d3b] text-white"
              : "bg-neutral-50 text-neutral-700 border border-neutral-100"
          }`}
        >
          Hidden
        </button>
      </div>

      {availableTypes.length > 0 && (
        <div className="bg-white border-b border-neutral-100 px-4 py-2 overflow-x-auto">
          <div className="flex gap-2 whitespace-nowrap">
            <button
              type="button"
              onClick={() => setTypeFilter(null)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${
                !typeFilter
                  ? "bg-[#455d3b] text-white"
                  : "bg-neutral-50 text-neutral-700 border border-neutral-100"
              }`}
            >
              All
            </button>
            {availableTypes.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setTypeFilter(type)}
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  typeFilter === type
                    ? "bg-[#455d3b] text-white"
                    : "bg-neutral-50 text-neutral-700 border border-neutral-100"
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 pb-24">
        {listVenues.length === 0 ? (
          <div className="text-center text-neutral-500 mt-12 text-sm">
            {view === "saved"
              ? "No saved venues yet. Add some from the map."
              : "No hidden venues."}
          </div>
        ) : (
          <ul className="space-y-2">
            {listVenues.map((venue) => (
              <li key={venue.id}>
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => setSelectedVenue(venue)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedVenue(venue);
                    }
                  }}
                  className="w-full flex items-center gap-3 rounded-2xl bg-white border border-neutral-100 p-3 text-left cursor-pointer hover:bg-neutral-50 active:scale-[0.99] transition"
                >
                  {venue.primary_image ? (
                    <img
                      src={`/api/place-photo?url=${encodeURIComponent(venue.primary_image)}`}
                      alt=""
                      className="w-14 h-14 rounded-xl object-cover bg-neutral-100"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-xl bg-neutral-100" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{venue.name}</p>
                    <p className="text-xs text-neutral-500 truncate">
                      {venue.type}
                      {venue.suburb ? ` · ${venue.suburb}` : ""}
                      {venue.rating ? ` · ⭐ ${venue.rating}` : ""}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (view === "saved") onUnsave(venue.id);
                      else onUnhide(venue.id);
                    }}
                    aria-label={
                      view === "saved" ? "Remove from list" : "Unhide"
                    }
                    className="text-neutral-400 hover:text-red-600 px-2 py-2"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selectedVenue && (
        <MapVenueSheet
          venue={selectedVenue}
          onClose={() => setSelectedVenue(null)}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
          userId={userId}
        />
      )}
    </div>
  );
}

// One-shot confetti burst rendered on a fixed full-screen canvas. Fires
// once on mount and self-destructs when all particles fall off screen.
// No external dependency — small enough to inline. Used on post-game
// results screens to celebrate the match moment.
// ConfettiBurst moved into ./components/SessionResultsView.js (its only consumer).

// Post-match-reveal CTA card for guests: "X hosted this session — add as a
// friend?" Renders between the title and the SessionResultsView body on the
// guest's end-of-game screen. Hides itself when:
//   - viewer IS the host (defensive — shouldn't happen on guest side)
//   - viewer + host are already friends
//   - host already sent the viewer a pending request (Accept happens in the
//     participants strip / drawer instead)
// When the viewer already sent a pending request (or just sent one this
// session), shows a frozen "Request sent" pill instead of the Add button.
// AddHostFriendCard moved to ./components/AddHostFriendCard.js (imported at top).

// Shared body for any "session results" surface — the post-game host
// matches screen, the post-game guest revealed view, and the historical
// Your Sessions detail view all render this. Accepts data as props rather
// than fetching internally so each parent can wire it to its own state.
//
// Returns body content only (participants strip + Matches/My-likes pill +
// always-on checkboxes + bulk Save + MapVenueSheet on row tap). The parent
// is responsible for its own header / footer / wrapper layout.
// Host results board for "Send my options" (curated). Reads get_curated_results
// (every shortlisted venue ranked by GUEST votes, host's own likes excluded),
// resolves voter display names from session_participants, and lets the host
// commit to a venue via set_curated_decision ("We're going here").
// CuratedResultsBoard moved to ./components/CuratedResultsBoard.js (imported at top).

// Shared participants strip — avatars + names + Host/You labels, with inline
// friend-state chips (Friends / Accept / Requested / Add / Invite). Used by
// both the concurrent results (SessionResultsView) and the curated board.
// ParticipantsStrip moved to ./components/ParticipantsStrip.js (imported at top).

// SessionResultsView moved to ./components/SessionResultsView.js (imported at top).

// Full-screen overlay showing every session the current user has joined
// (host or guest). Tap a session to see the matched venues for that
// session, with per-venue Save toggles to add them to the user's saved
// list. Uses get_session_matches for mutual-like reconciliation — for
// curated sessions every host-shortlisted venue counts; for concurrent
// sessions only venues with >=2 distinct likers appear.
// Google Maps Takeout import — parses the user's zip client-side, shows a
// preview of what was found, and (once the Edge Function ships) sends
// chunks to /functions/v1/enrich-and-import for Places enrichment + DB
// writes. Right now the "Import" button is stubbed because the backend
// isn't wired yet — the local prototype script in the Swipes folder
// (`import_google_maps_prototype.js`) covers Mark's own bootstrap.
// ImportGoogleMapsScreen moved to ./components/ImportGoogleMapsScreen.js.

function SessionsScreen({ venues, userId, savedIds, onSave, onUnsave, onHide, onBack, showToast, onOpenProfile, initialSessionId, onScheduleNight }) {
  const [sessions, setSessions] = useState(null); // null = loading
  const [selectedSession, setSelectedSession] = useState(null);
  // True when the detail was opened via a deep-link (a tapped notification /
  // "See the plan"), so backing out exits to where they came from instead of
  // dropping them on the sessions list they never navigated through.
  const [deepLinked, setDeepLinked] = useState(false);
  const [sessionMatches, setSessionMatches] = useState(null); // null = loading
  const [matchesError, setMatchesError] = useState("");
  // My personal likes in this session (everything I swiped right on, whether
  // or not it became a mutual match). Hydrated separately because RLS only
  // lets me read my own rows in session_swipes.
  const [myLikedIds, setMyLikedIds] = useState(null);
  // Participants strip — display_name list pulled from session_participants.
  const [participants, setParticipants] = useState([]);
  // (View / selection / detail-venue state now lives inside SessionResultsView.)

  // Deep-link from a tapped notification: auto-select that session once the
  // list loads. Once only, so backing out of the detail shows the list.
  const autoSelectedId = useRef(null);
  useEffect(() => {
    if (!initialSessionId || !sessions) return;
    // Re-select whenever the deep-link target changes (tapping a different
    // notification), but not after the user backs out of the same one.
    if (autoSelectedId.current === initialSessionId) return;
    const s = sessions.find((x) => x.id === initialSessionId);
    if (s) {
      setSelectedSession(s);
      setDeepLinked(true);
      autoSelectedId.current = initialSessionId;
    }
  }, [initialSessionId, sessions]);

  // Fetch the list of sessions this user has participated in, plus the
  // other participants per session so each row can show "With Tomas".
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    async function load() {
      const { data: participations, error: pErr } = await supabase
        .from("session_participants")
        .select("session_id, joined_at, submitted_at")
        .eq("user_id", userId)
        .order("joined_at", { ascending: false });
      if (cancelled) return;
      if (pErr) {
        console.error("Failed to fetch participations:", pErr);
        setSessions([]);
        return;
      }
      const ids = (participations || []).map((p) => p.session_id);
      if (!ids.length) {
        setSessions([]);
        return;
      }
      const { data: sessionRows, error: sErr } = await supabase
        .from("match_sessions")
        .select("id, name, mode, status, created_at, event_at, host_user_id, target_matches, expires_at, decided_venue_id, decided_for, expected_others")
        .in("id", ids);
      if (cancelled) return;
      if (sErr) {
        console.error("Failed to fetch sessions:", sErr);
        setSessions([]);
        return;
      }

      // Batch-fetch every participant across every session in one go, then
      // hydrate any NULL display_names from profiles (same fallback the
      // detail view uses for old sessions where the host's name wasn't
      // written at insert time).
      const { data: allParticipants, error: apErr } = await supabase
        .from("session_participants")
        .select("session_id, user_id, display_name")
        .in("session_id", ids);
      if (cancelled) return;
      if (apErr) {
        console.error("Failed to fetch participants:", apErr);
      }
      const participantRows = allParticipants || [];
      const otherIds = Array.from(
        new Set(
          participantRows
            .filter((p) => p.user_id !== userId)
            .map((p) => p.user_id)
        )
      );
      let profileById = new Map();
      if (otherIds.length > 0) {
        const { data: profileRows } = await supabase
          .from("profiles")
          .select("id, display_name, avatar_url")
          .in("id", otherIds);
        profileById = new Map((profileRows || []).map((r) => [r.id, r]));
      }
      const otherPeopleBySession = new Map();
      for (const p of participantRows) {
        if (p.user_id === userId) continue;
        const prof = profileById.get(p.user_id);
        const name = p.display_name?.trim() || prof?.display_name || "Guest";
        if (!otherPeopleBySession.has(p.session_id)) {
          otherPeopleBySession.set(p.session_id, []);
        }
        otherPeopleBySession
          .get(p.session_id)
          .push({ name, avatar: prof?.avatar_url || null });
      }

      // Join everything, preserving the participations sort order.
      const sessionById = new Map((sessionRows || []).map((s) => [s.id, s]));
      const merged = participations
        .map((p) => {
          const s = sessionById.get(p.session_id);
          if (!s) return null;
          return {
            ...s,
            isHost: s.host_user_id === userId,
            joined_at: p.joined_at,
            submitted_at: p.submitted_at,
            otherPeople: otherPeopleBySession.get(p.session_id) || [],
            otherNames: (otherPeopleBySession.get(p.session_id) || []).map(
              (x) => x.name
            ),
          };
        })
        .filter(Boolean);
      setSessions(merged);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Format a list of other participants' names for the row subtitle.
  // "With Tomas" / "With Tomas and Sarah" / "With Tomas, Sarah and 2 others".
  function formatOtherNames(names) {
    if (!names || names.length === 0) return null;
    if (names.length === 1) return `With ${names[0]}`;
    if (names.length === 2) return `With ${names[0]} and ${names[1]}`;
    const extra = names.length - 2;
    return `With ${names[0]}, ${names[1]} and ${extra} other${extra === 1 ? "" : "s"}`;
  }

  // When a session is selected, fetch matches (RPC), my likes (own rows in
  // session_swipes), and the participant list (display_names). Reset the
  // view + select-mode UI so we always start fresh on the matches tab.
  useEffect(() => {
    if (!selectedSession) {
      setSessionMatches(null);
      setMyLikedIds(null);
      setParticipants([]);
      setMatchesError("");
      return;
    }
    let cancelled = false;
    setSessionMatches(null);
    setMyLikedIds(null);
    setMatchesError("");

    // Matches (reconciliation RPC — unanimous under the group rule). When a
    // session ends with NOTHING unanimous (the timeout case), fall back to
    // the VOTES (get_session_likes, best-supported first) so the board the
    // host lands on has something to decide from instead of sitting empty.
    (async () => {
      const { data, error } = await supabase.rpc("get_session_matches", {
        p_session_id: selectedSession.id,
      });
      if (cancelled) return;
      if (error) {
        console.error("Failed to fetch session matches:", error);
        setMatchesError("Couldn't load matches.");
        setSessionMatches([]);
        return;
      }
      if (data?.length) {
        setSessionMatches(data);
        return;
      }
      const { data: likes } = await supabase.rpc("get_session_likes", {
        p_session_id: selectedSession.id,
      });
      if (cancelled) return;
      setSessionMatches(likes || []);
    })();

    // My likes (everything I personally swiped right on in this session).
    if (userId) {
      supabase
        .from("session_swipes")
        .select("venue_id")
        .eq("session_id", selectedSession.id)
        .eq("user_id", userId)
        .eq("action", "like")
        .then(({ data, error }) => {
          if (cancelled) return;
          if (error) {
            console.error("Failed to fetch my likes:", error);
            setMyLikedIds([]);
            return;
          }
          setMyLikedIds((data || []).map((r) => r.venue_id));
        });
    } else {
      setMyLikedIds([]);
    }

    // Participants (display names for the strip below the title). For any
    // participant with a NULL display_name (typically the host on sessions
    // created before display_name was written at insert time), fall back to
    // their profiles.display_name in a second batched fetch.
    (async () => {
      const { data: pData, error: pErr } = await supabase
        .from("session_participants")
        .select("user_id, display_name, joined_at")
        .eq("session_id", selectedSession.id)
        .order("joined_at", { ascending: true });
      if (cancelled) return;
      if (pErr) {
        console.error("Failed to fetch participants:", pErr);
        setParticipants([]);
        return;
      }
      const rows = pData || [];
      const missingIds = rows
        .filter((p) => !p.display_name?.trim())
        .map((p) => p.user_id);
      if (missingIds.length === 0) {
        setParticipants(rows);
        return;
      }
      const { data: profileRows, error: profileErr } = await supabase
        .from("profiles")
        .select("id, display_name")
        .in("id", missingIds);
      if (cancelled) return;
      const profileNameById = new Map(
        (profileErr ? [] : profileRows || []).map((r) => [r.id, r.display_name])
      );
      const hydrated = rows.map((p) =>
        p.display_name?.trim()
          ? p
          : { ...p, display_name: profileNameById.get(p.user_id) || null }
      );
      setParticipants(hydrated);
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedSession, userId]);

  // (View / selection state is owned by SessionResultsView now.)

  function formatSessionDate(s) {
    const when = s.event_at || s.created_at;
    if (!when) return "";
    try {
      const d = new Date(when);
      const now = new Date();
      const isSameDay =
        d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      const isYesterday =
        d.getFullYear() === yesterday.getFullYear() &&
        d.getMonth() === yesterday.getMonth() &&
        d.getDate() === yesterday.getDate();
      if (isSameDay) return "Today";
      if (isYesterday) return "Yesterday";
      return d.toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
      });
    } catch {
      return "";
    }
  }

  return (
    <div className="fixed inset-0 z-[2000] bg-[#fdf6f0] flex flex-col">
      <div className="bg-white border-b border-neutral-100 px-4 py-3 flex items-center gap-3">
        <button
          type="button"
          onClick={
            selectedSession
              ? deepLinked
                ? onBack
                : () => setSelectedSession(null)
              : onBack
          }
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100"
        >
          <ArrowLeft size={18} />
        </button>
        {/* NEVER the stored name (generated "Right now"/"Send options" —
            the July 31 rule; this header was the last surface leaking it,
            Mark's Aug 21 screenshots). Mode reads literally instead. */}
        <h1 className="text-lg font-semibold flex-1 truncate">
          {selectedSession
            ? selectedSession.mode === "curated"
              ? "Shortlist"
              : "Pick together"
            : "Your sessions"}
        </h1>
      </div>

      {!selectedSession ? (
        // ---------- Sessions list ----------
        <div className="flex-1 overflow-y-auto p-4 pb-24">
          {sessions === null ? (
            <div className="text-center text-neutral-500 mt-12 text-sm">
              Loading your sessions...
            </div>
          ) : sessions.length === 0 ? (
            <div className="text-center text-neutral-500 mt-12 text-sm">
              You haven't joined any sessions yet.
            </div>
          ) : (
            <ul className="space-y-2">
              {sessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSession(s);
                      setDeepLinked(false);
                    }}
                    className="w-full flex items-center gap-3 rounded-2xl bg-white border border-neutral-100 p-4 text-left hover:bg-neutral-50 active:scale-[0.99] transition"
                  >
                    {/* Mode icons (Aug 20, Mark: ⚡/📅 "aren't even the right
                        icons") — HeartHandshake = Pick together, ListChecks =
                        a shortlist. */}
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b] shrink-0">
                      {s.mode === "concurrent" ? (
                        <HeartHandshake size={18} />
                      ) : (
                        <ListChecks size={18} />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">
                          {formatSessionDate(s) || "Session"}
                        </p>
                        {s.isHost && (
                          <span className="inline-flex items-center rounded-full bg-[#edf2eb] px-2 py-0.5 text-[10px] font-medium text-[#3f5a3a] border border-[#c5d4c2] shrink-0">
                            Host
                          </span>
                        )}
                      </div>
                      {/* THE OUTCOME, not the mode (Aug 20, Mark: "Later"
                          was a fossil and the mode is the icon's job) —
                          what the row says is what HAPPENED. */}
                      {(() => {
                        if (s.decided_venue_id) {
                          const dv = venues.find(
                            (v) => v.id === s.decided_venue_id
                          );
                          const when = s.decided_for
                            ? ` · ${new Date(s.decided_for).toLocaleDateString(
                                "en-AU",
                                { weekday: "short" }
                              )} ${new Date(s.decided_for).toLocaleTimeString(
                                "en-AU",
                                { hour: "numeric", minute: "2-digit" }
                              )}`
                            : "";
                          return (
                            <p className="text-xs text-[#455d3b] font-medium truncate">
                              → {dv?.name || "your pick"}
                              {when}
                            </p>
                          );
                        }
                        const ended =
                          s.expires_at &&
                          Date.now() > new Date(s.expires_at).getTime();
                        return (
                          <p className="text-xs text-neutral-500 truncate">
                            {!ended
                              ? "Still running"
                              : s.isHost
                              ? "Nothing locked in, it's your call"
                              : "Nothing locked in"}
                          </p>
                        );
                      })()}
                      {s.otherPeople?.length > 0 && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <div className="flex -space-x-2 shrink-0">
                            {s.otherPeople.slice(0, 4).map((person, i) =>
                              person.avatar ? (
                                <img
                                  key={i}
                                  src={person.avatar}
                                  alt={person.name}
                                  className="h-6 w-6 rounded-full object-cover border-2 border-white"
                                />
                              ) : (
                                <span
                                  key={i}
                                  className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#edf2eb] text-[#3f5a3a] text-[10px] font-medium border-2 border-white"
                                >
                                  {(person.name || "?").charAt(0).toUpperCase()}
                                </span>
                              )
                            )}
                          </div>
                          <span className="text-xs text-neutral-600 truncate">
                            {formatOtherNames(s.otherNames)}
                          </span>
                        </div>
                      )}
                    </div>
                    <span className="text-neutral-400 text-lg leading-none">›</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        // ---------- Session detail ----------
        <>
          {matchesError && (
            <div className="bg-white border-b border-neutral-100 px-4 py-2 text-center text-red-600 text-sm">
              {matchesError}
            </div>
          )}
          {/* STILL-RUNNING BANNER (July 31, Mark: "End it now" belongs on the
              results board, not the host's post-swipe card — the host usually
              submits first, and ending from there would cut guests off).
              Host + Right Now + clock still running + undecided: end it here,
              once people have had their go. Ending = expires_at → now, the
              same clock everyone's devices already watch; the detail reloads
              itself via the selectedSession identity change. */}
          {selectedSession.mode === "concurrent" &&
            userId === selectedSession.host_user_id &&
            !selectedSession.decided_venue_id &&
            selectedSession.expires_at &&
            Date.now() < new Date(selectedSession.expires_at).getTime() && (
              <div className="bg-[#edf2eb] border-b border-[#cdd9c6] px-4 py-3 flex items-center gap-3">
                <p className="flex-1 text-xs text-[#2f3f29]">
                  Still running — friends can keep swiping until time's up.
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    const nowIso = new Date().toISOString();
                    const { error } = await supabase
                      .from("match_sessions")
                      .update({ expires_at: nowIso })
                      .eq("id", selectedSession.id)
                      .eq("host_user_id", userId);
                    if (error) {
                      console.error("End now failed:", error);
                      showToast?.("Couldn't end it");
                      return;
                    }
                    showToast?.("Session ended");
                    setSessions((prev) =>
                      (prev || []).map((x) =>
                        x.id === selectedSession.id
                          ? { ...x, expires_at: nowIso }
                          : x
                      )
                    );
                    setSelectedSession((prev) =>
                      prev ? { ...prev, expires_at: nowIso } : prev
                    );
                  }}
                  className="shrink-0 rounded-full bg-[#455d3b] px-4 py-2 text-xs font-medium text-white active:scale-95 transition"
                >
                  End it now
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const next = new Date(
                      Math.max(
                        Date.now(),
                        new Date(selectedSession.expires_at).getTime()
                      ) +
                        30 * 60 * 1000
                    ).toISOString();
                    const { error } = await supabase
                      .from("match_sessions")
                      .update({ expires_at: next })
                      .eq("id", selectedSession.id)
                      .eq("host_user_id", userId);
                    if (error) {
                      console.error("Extend failed:", error);
                      showToast?.("Couldn't extend");
                      return;
                    }
                    showToast?.("Extended 30 minutes");
                    setSessions((prev) =>
                      (prev || []).map((x) =>
                        x.id === selectedSession.id ? { ...x, expires_at: next } : x
                      )
                    );
                    setSelectedSession((prev) =>
                      prev ? { ...prev, expires_at: next } : prev
                    );
                  }}
                  className="shrink-0 rounded-full border border-[#cdd9c6] bg-white px-4 py-2 text-xs font-medium text-[#455d3b] active:scale-95 transition"
                >
                  +30 min
                </button>
              </div>
            )}
          {selectedSession.mode === "curated" ? (
            <CuratedResultsBoard
              sessionId={selectedSession.id}
              venues={venues}
              hostUserId={selectedSession.host_user_id}
              userId={userId}
              onOpenProfile={onOpenProfile}
              canDecide={userId === selectedSession.host_user_id}
              savedIds={savedIds}
              onSave={onSave}
              onUnsave={onUnsave}
              onHide={onHide}
              onDone={() => (deepLinked ? onBack() : setSelectedSession(null))}
              showToast={showToast}
              onScheduleNight={onScheduleNight}
            />
          ) : (
            <SessionResultsView
              participants={participants}
              sessionId={selectedSession.id}
              sessionMatches={sessionMatches}
              myLikedIds={myLikedIds}
              venues={venues}
              userId={userId}
              hostUserId={selectedSession.host_user_id}
              savedIds={savedIds}
              onSave={onSave}
              onUnsave={onUnsave}
              onHide={onHide}
              onOpenProfile={onOpenProfile}
              showConfetti={false}
              showToast={showToast}
              onScheduleNight={onScheduleNight}
            />
          )}
        </>
      )}
    </div>
  );
}

// Full-screen Friends overlay. Pattern of MyListScreen / SessionsScreen.
// Renders two views via a segmented toggle:
//   - friends: search + list of accepted friendships
//   - requests: Incoming (others requested me) + Pending (I requested others)
//
// Two-step fetch: friendships → profiles for referenced user_ids → merge in JS.
// friendships table has no FK to profiles (both link to auth.users), so no
// implicit Supabase join. Refetch on every mount + after every action.
function FriendsScreen({ userId, onBack, showToast, onOpenProfile, onAddFriend }) {
  const [view, setView] = useState("friends");
  const [friends, setFriends] = useState(null); // null = loading; array when loaded
  const [incoming, setIncoming] = useState(null);
  const [pending, setPending] = useState(null);
  const [search, setSearch] = useState("");
  const [actingId, setActingId] = useState(null); // friendship.id mid-update, blocks double-tap

  // Loads all three datasets in parallel then resolves profile rows for
  // referenced user_ids in a single batch fetch. Profile lookups indexed by
  // id so each friendship/request row can hydrate display_name + username.
  async function load() {
    if (!userId) return;
    const [acceptedRes, incomingRes, sentRes] = await Promise.all([
      supabase
        .from("friendships")
        .select("id, requester_id, addressee_id, created_at")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
        .eq("status", "accepted"),
      supabase
        .from("friendships")
        .select("id, requester_id, created_at")
        .eq("addressee_id", userId)
        .eq("status", "pending"),
      supabase
        .from("friendships")
        .select("id, addressee_id, created_at")
        .eq("requester_id", userId)
        .eq("status", "pending"),
    ]);

    const acceptedRows = acceptedRes.data || [];
    const incomingRows = incomingRes.data || [];
    const sentRows = sentRes.data || [];

    // Collect every other-party user_id we need to hydrate from profiles.
    const otherIds = new Set();
    acceptedRows.forEach((r) => {
      otherIds.add(r.requester_id === userId ? r.addressee_id : r.requester_id);
    });
    incomingRows.forEach((r) => otherIds.add(r.requester_id));
    sentRows.forEach((r) => otherIds.add(r.addressee_id));

    let profilesById = {};
    if (otherIds.size > 0) {
      const { data: profileRows } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", Array.from(otherIds));
      profilesById = Object.fromEntries(
        (profileRows || []).map((p) => [p.id, p])
      );
    }

    setFriends(
      acceptedRows.map((r) => {
        const otherId = r.requester_id === userId ? r.addressee_id : r.requester_id;
        return { ...r, otherId, profile: profilesById[otherId] || null };
      })
    );
    setIncoming(
      incomingRows.map((r) => ({
        ...r,
        otherId: r.requester_id,
        profile: profilesById[r.requester_id] || null,
      }))
    );
    setPending(
      sentRows.map((r) => ({
        ...r,
        otherId: r.addressee_id,
        profile: profilesById[r.addressee_id] || null,
      }))
    );
  }

  useEffect(() => {
    load();
    // load is defined inside the component; userId is the only external it
    // reads, so the dep array is intentionally just [userId].
  }, [userId]);

  // Update helpers: set status then refetch. Single source of truth.
  async function setStatus(friendshipId, newStatus) {
    setActingId(friendshipId);
    const { error } = await supabase
      .from("friendships")
      .update({ status: newStatus })
      .eq("id", friendshipId);
    setActingId(null);
    if (error) {
      console.error("Friendship update failed:", error);
      showToast?.("Something went wrong");
      return;
    }
    await load();
  }

  const friendCount = friends?.length ?? 0;
  const requestCount = (incoming?.length ?? 0) + (pending?.length ?? 0);

  // Search filter applies to the Friends view only — case-insensitive match on
  // display_name or username.
  const filteredFriends = (friends || []).filter((f) => {
    if (!search.trim()) return true;
    const q = search.trim().toLowerCase();
    const name = (f.profile?.display_name || "").toLowerCase();
    const handle = (f.profile?.username || "").toLowerCase();
    return name.includes(q) || handle.includes(q);
  });

  return (
    <div className="fixed inset-0 z-[3400] bg-[#fdf6f0] overflow-y-auto pb-24">
      <div className="max-w-sm mx-auto p-4">
        <div className="flex items-center justify-between mb-4">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="inline-flex items-center gap-1 text-sm text-neutral-600"
          >
            <ArrowLeft size={16} /> Back
          </button>
          <button
            type="button"
            onClick={onAddFriend}
            aria-label="Add friend"
            className="inline-flex items-center justify-center w-9 h-9 rounded-full text-[#455d3b] hover:bg-[#455d3b]/10 transition"
          >
            <UserPlus size={18} />
          </button>
        </div>

        <h1 className="text-2xl font-semibold tracking-tight mb-4">
          With friends
        </h1>

        {/* Segmented toggle — same style as the All venues / My List pill. */}
        <div className="flex bg-white border border-neutral-200 rounded-full p-1 mb-4 text-sm">
          <button
            type="button"
            onClick={() => setView("friends")}
            className={`flex-1 py-2 rounded-full font-medium transition ${
              view === "friends"
                ? "bg-[#455d3b] text-white"
                : "text-neutral-600"
            }`}
          >
            Friends · {friendCount}
          </button>
          <button
            type="button"
            onClick={() => setView("requests")}
            className={`flex-1 py-2 rounded-full font-medium transition ${
              view === "requests"
                ? "bg-[#455d3b] text-white"
                : "text-neutral-600"
            }`}
          >
            Requests · {requestCount}
          </button>
        </div>

        {view === "friends" && (
          <>
            <div className="relative mb-4">
              <Search
                size={14}
                className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
              />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search your friends"
                className="w-full pl-9 pr-3 py-2 rounded-full border border-neutral-200 bg-white text-base focus:outline-none focus:border-[#455d3b]"
              />
            </div>

            {friends === null && (
              <p className="text-sm text-neutral-500 text-center py-8">Loading…</p>
            )}
            {friends !== null && filteredFriends.length === 0 && (
              <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 text-center">
                <p className="text-sm text-neutral-600 mb-3">
                  {friends.length === 0
                    ? "No friends yet. Tap the + to invite someone."
                    : "No matches for that search."}
                </p>
              </div>
            )}
            {friends !== null && filteredFriends.length > 0 && (
              <div className="rounded-3xl bg-white shadow-sm border border-neutral-100 overflow-hidden">
                {filteredFriends.map((f, idx) => (
                  <button
                    key={f.id}
                    type="button"
                    onClick={() => onOpenProfile?.(f.otherId)}
                    className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50 active:scale-[0.99] transition ${
                      idx > 0 ? "border-t border-neutral-100" : ""
                    }`}
                  >
                    <FriendAvatar profile={f.profile} />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm truncate">
                        {f.profile?.display_name || "Unknown"}
                      </p>
                      {f.profile?.username && (
                        <p className="text-xs text-neutral-500 truncate">
                          @{f.profile.username}
                        </p>
                      )}
                    </div>
                    <span className="text-neutral-400 text-lg leading-none">›</span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}

        {view === "requests" && (
          <>
            <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2 px-1">
              Incoming · {incoming?.length ?? 0}
            </p>
            {incoming === null && (
              <p className="text-sm text-neutral-500 text-center py-4">Loading…</p>
            )}
            {incoming !== null && incoming.length === 0 && (
              <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 mb-4">
                <p className="text-sm text-neutral-600">
                  No incoming requests.
                </p>
              </div>
            )}
            {incoming !== null && incoming.length > 0 && (
              <div className="rounded-3xl bg-white shadow-sm border border-neutral-100 overflow-hidden mb-4">
                {incoming.map((r, idx) => (
                  <div
                    key={r.id}
                    className={`px-4 py-3 ${
                      idx > 0 ? "border-t border-neutral-100" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onOpenProfile?.(r.otherId)}
                      className="w-full flex items-center gap-3 text-left mb-3"
                    >
                      <FriendAvatar profile={r.profile} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">
                          {r.profile?.display_name || "Unknown"}
                        </p>
                        {r.profile?.username && (
                          <p className="text-xs text-neutral-500 truncate">
                            @{r.profile.username}
                          </p>
                        )}
                      </div>
                    </button>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={actingId === r.id}
                        onClick={() => setStatus(r.id, "accepted")}
                        className="flex-1 rounded-full bg-[#455d3b] text-white text-xs font-medium py-2 disabled:opacity-50"
                      >
                        Accept
                      </button>
                      <button
                        type="button"
                        disabled={actingId === r.id}
                        onClick={() => setStatus(r.id, "declined")}
                        className="flex-1 rounded-full border border-neutral-300 text-xs font-medium py-2 disabled:opacity-50"
                      >
                        Decline
                      </button>
                      <button
                        type="button"
                        disabled={actingId === r.id}
                        onClick={() => setStatus(r.id, "blocked")}
                        aria-label="Block"
                        className="rounded-full border border-neutral-300 px-3 py-2 text-neutral-500 disabled:opacity-50"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Pending sent — boxed sub-block, visually distinct from incoming. */}
            <div className="bg-neutral-100 rounded-3xl p-4">
              <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">
                Pending · you sent · {pending?.length ?? 0}
              </p>
              {pending === null && (
                <p className="text-sm text-neutral-500 text-center py-2">Loading…</p>
              )}
              {pending !== null && pending.length === 0 && (
                <p className="text-sm text-neutral-600">
                  No outgoing requests.
                </p>
              )}
              {pending !== null && pending.length > 0 && (
                <div className="space-y-2">
                  {pending.map((r) => (
                    <div
                      key={r.id}
                      className="flex items-center gap-3 bg-white rounded-2xl px-3 py-2"
                    >
                      <FriendAvatar profile={r.profile} small />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-sm truncate">
                          {r.profile?.display_name || "Unknown"}
                        </p>
                        {r.profile?.username && (
                          <p className="text-[11px] text-neutral-500 truncate">
                            @{r.profile.username}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={actingId === r.id}
                        onClick={() => setStatus(r.id, "declined")}
                        className="text-xs text-neutral-500 hover:text-red-600 disabled:opacity-50"
                      >
                        Cancel
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Find Friends overlay — opened from the FAB's Add friend option AND from
// the FriendsScreen header + button. Three paths to a new connection:
//   - @handle search → live results from `profiles` table
//   - QR / share link → in-person / async
//   - Email invite → mailto stub for D.1 (proper Resend-backed flow is later)
//
// Auto-routes the search input: a string matching *@*.* is treated as an
// email and shows a "coming soon" hint since email lookup needs an RPC to
// query auth.users (deferred). Otherwise it's an @handle search against
// profiles.username with ilike.
function FindFriendsSheet({
  profile,
  viewerUserId,
  onBack,
  onOpenProfile,
  showToast,
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null); // null = no search yet, [] = no results
  const [searching, setSearching] = useState(false);
  const [copied, setCopied] = useState(false);

  const isEmail = /\S+@\S+\.\S+/.test(query.trim());
  const trimmed = query.trim().replace(/^@/, ""); // drop a leading @ if typed

  const myHandle = profile?.username || "";
  const inviteUrl = myHandle
    ? `https://flanit.co/u/@${myHandle}`
    : "https://flanit.co";

  // Debounced search against profiles.username. Skips if too short or empty
  // or looks like an email (handled separately).
  useEffect(() => {
    if (isEmail) {
      setResults(null);
      return;
    }
    if (!trimmed || trimmed.length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, display_name, username, tier, avatar_url")
        .ilike("username", `%${trimmed}%`)
        .neq("id", viewerUserId) // never list myself
        .limit(20);
      if (cancelled) return;
      setSearching(false);
      if (error) {
        console.error("Search failed:", error);
        setResults([]);
        return;
      }
      setResults(data || []);
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [trimmed, isEmail, viewerUserId]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      showToast?.("Couldn't copy — long-press the link instead");
    }
  }

  function emailInvite() {
    const subject = encodeURIComponent("Join me on Flanit");
    const body = encodeURIComponent(
      `Hey — join me on Flanit, we'll find places to eat together.\n\n${inviteUrl}`
    );
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }

  return (
    <div className="fixed inset-0 z-[3400] bg-[#fdf6f0] overflow-y-auto pb-24">
      <div className="max-w-sm mx-auto p-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-600"
        >
          <ArrowLeft size={16} /> Back
        </button>

        <h1 className="text-2xl font-semibold tracking-tight mb-4">
          Find friends
        </h1>

        {/* Search input */}
        <div className="relative mb-4">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400"
          />
          {/* No autoFocus (July 25, Mark): opening Find friends shouldn't
              throw up the keyboard — the QR and your own code are half the
              point of this screen. text-base (16px) too: iOS Safari ZOOMS
              the whole page on focus for anything smaller, which is what
              made the app look bigger than the screen. */}
          <input
            type="text"
            inputMode="search"
            autoCapitalize="none"
            autoCorrect="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search @username or email"
            className="w-full pl-9 pr-3 py-2.5 rounded-full border border-neutral-200 bg-white text-base focus:outline-none focus:border-[#455d3b]"
          />
        </div>

        {/* Search results / states */}
        {isEmail && query.trim() && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 text-center mb-4">
            <p className="text-sm text-neutral-600 mb-1">
              Email search coming soon
            </p>
            <p className="text-xs text-neutral-500">
              For now, invite by email below or share your link.
            </p>
          </div>
        )}

        {!isEmail && trimmed.length >= 2 && searching && (
          <p className="text-sm text-neutral-500 text-center py-3">
            Searching…
          </p>
        )}

        {!isEmail && trimmed.length >= 2 && !searching && results !== null && results.length === 0 && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 text-center mb-4">
            <p className="text-sm text-neutral-600">
              No @{trimmed} on Flanit yet
            </p>
          </div>
        )}

        {!isEmail && results !== null && results.length > 0 && (
          <div className="rounded-3xl bg-white shadow-sm border border-neutral-100 overflow-hidden mb-4">
            {results.map((r, idx) => (
              <button
                key={r.id}
                type="button"
                onClick={() => onOpenProfile?.(r.id)}
                className={`w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-neutral-50 active:scale-[0.99] transition ${
                  idx > 0 ? "border-t border-neutral-100" : ""
                }`}
              >
                <FriendAvatar profile={r} />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate">
                    {r.display_name || "Unknown"}
                  </p>
                  {r.username && (
                    <p className="text-xs text-neutral-500 truncate">
                      @{r.username}
                    </p>
                  )}
                </div>
                <span className="text-neutral-400 text-lg leading-none">›</span>
              </button>
            ))}
          </div>
        )}

        {/* QR + share link block */}
        <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 mb-3 text-center">
          <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-3">
            Or share your code
          </p>
          {myHandle ? (
            <>
              <div className="inline-block p-3 bg-white border border-neutral-200 rounded-2xl mb-3">
                <QRCodeSVG value={inviteUrl} size={140} />
              </div>
              <p className="text-sm text-neutral-700 mb-3 break-all">
                flanit.co/u/<strong>@{myHandle}</strong>
              </p>
            </>
          ) : (
            <p className="text-sm text-neutral-500 mb-3">
              Set a @username on your profile first.
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={copyLink}
              disabled={!myHandle}
              className="flex-1 rounded-full border border-neutral-300 py-2 text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {copied ? <Check size={14} /> : <Upload size={14} />}
              {copied ? "Copied" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={emailInvite}
              disabled={!myHandle}
              className="flex-1 rounded-full border border-neutral-300 py-2 text-sm font-medium flex items-center justify-center gap-2 disabled:opacity-50"
            >
              Invite by email
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Profile lookup overlay — opened when tapping a row from FriendsScreen, a
// SessionsScreen participant chip (task #9), or eventually the drawer. Two
// render states gated by friendship status:
//   - locked: only the hero + Add friend CTA visible. List / Friends / Activity
//     are placeholders explaining they unlock on connect.
//   - unlocked: hero + Friends ✓ chip + three sections. In D.1 the sections
//     are still placeholders (their content needs SECURITY DEFINER RPCs to
//     bypass owner-only RLS on saved_venues + friendships — D.2 work).
//
// Friendship-state derivation: fetch all my friendships, find any row where
// the other party is the viewed user. That row's status drives the CTA.
function ProfileLookupScreen({
  userId,
  viewerUserId,
  onBack,
  showToast,
  onOpenThread,
  onOpenProfile,
  onShowOnMap,
  hidden = false,
}) {
  // Subviews behind the counters (July 25): "photos" = flat grid,
  // "friends" = the full list. Reset when the profile re-targets.
  const [subView, setSubView] = useState(null);
  const [gridUrls, setGridUrls] = useState({}); // web_path → signed URL
  useEffect(() => {
    setSubView(null);
    setGridUrls({});
  }, [userId]);
  const [profile, setProfile] = useState(null);
  const [friendship, setFriendship] = useState(null); // null = no row found
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [avatarExpanded, setAvatarExpanded] = useState(false);
  // Whether the looked-up user is an anonymous (not signed-up) guest. They
  // can't be friended — the host invites them to come back to the app instead.
  const [isAnon, setIsAnon] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  // Their recent check-ins (friends only — RLS returns nothing otherwise).
  // [{id, venueName, created_at}], newest first; first row may be "live" (<3h).
  const [theirCheckins, setTheirCheckins] = useState(null);

  async function load() {
    setLoading(true);
    const [profileRes, friendshipsRes, accountsRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, display_name, username, tier, avatar_url")
        .eq("id", userId)
        .maybeSingle(),
      // RLS limits this to rows where the viewer is a party. Find the one
      // (if any) where the other party is the user being looked up.
      supabase
        .from("friendships")
        .select("id, requester_id, addressee_id, status")
        .or(`requester_id.eq.${viewerUserId},addressee_id.eq.${viewerUserId}`),
      supabase.rpc("get_account_user_ids", { p_user_ids: [userId] }),
    ]);
    setProfile(profileRes.data || null);
    const rows = friendshipsRes.data || [];
    const match = rows.find(
      (r) => r.requester_id === userId || r.addressee_id === userId
    );
    setFriendship(match || null);
    setIsAnon(!(accountsRes.data || []).some((r) => r.user_id === userId));
    setLoading(false);
  }

  useEffect(() => {
    if (!userId || !viewerUserId) return;
    load();
    // load reads userId + viewerUserId only.
  }, [userId, viewerUserId]);

  // Derived friendship state.
  const status = friendship?.status; // 'pending' | 'accepted' | 'declined' | 'blocked' | undefined
  const iAmRequester = friendship?.requester_id === viewerUserId;
  const isFriends = status === "accepted";

  // PHOTO-FIRST PROFILE (July 25, Mark's pick): one fetch builds the whole
  // page. An "event" is just a check-in that collected media — those render
  // as album covers; photoless check-ins are quiet "Also been" rows. RLS
  // already trims activities AND photos to what the viewer may see, so the
  // page is privacy-correct for free.
  const [theirData, setTheirData] = useState(null);
  // Their friends — via friends_of() (SECURITY DEFINER; only THEIR accepted
  // friends get rows, so this stays empty pre-friendship). Mutuals first.
  const [theirFriends, setTheirFriends] = useState(null);
  useEffect(() => {
    if (!isFriends || !userId || !viewerUserId) {
      setTheirFriends(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const [{ data: uidsRaw }, { data: myRows }] = await Promise.all([
        supabase.rpc("friends_of", { p_user: userId }),
        supabase
          .from("friendships")
          .select("requester_id, addressee_id")
          .eq("status", "accepted")
          .or(`requester_id.eq.${viewerUserId},addressee_id.eq.${viewerUserId}`),
      ]);
      if (cancelled) return;
      // setof uuid arrives as scalars; normalize defensively either way.
      // The viewer stays IN the list (Mark: "I am not seen in the friends
      // list") — you're part of their circle, show it.
      const theirIds = (uidsRaw || [])
        .map((u) => (typeof u === "string" ? u : u?.friends_of))
        .filter(Boolean);
      const mine = new Set(
        (myRows || []).map((r) =>
          r.requester_id === viewerUserId ? r.addressee_id : r.requester_id
        )
      );
      if (theirIds.length === 0) {
        setTheirFriends([]);
        return;
      }
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", theirIds);
      if (cancelled) return;
      setTheirFriends(
        (profs || [])
          .map((p) => ({
            ...p,
            self: p.id === viewerUserId,
            mutual: mine.has(p.id),
          }))
          .sort(
            (a, b) =>
              (b.self ? 2 : b.mutual ? 1 : 0) -
                (a.self ? 2 : a.mutual ? 1 : 0) ||
              (a.display_name || "").localeCompare(b.display_name || "")
          )
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [isFriends, userId, viewerUserId]);
  useEffect(() => {
    if (!isFriends || !userId) {
      setTheirCheckins(null);
      setTheirData(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data: rows } = await supabase
        .from("activities")
        .select("id, venue_id, created_at, label, joined_from, show_live")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .order("created_at", { ascending: false })
        .limit(30);
      const acts = rows || [];
      const venueIds = Array.from(
        new Set(acts.map((r) => r.venue_id).filter(Boolean))
      );
      const [vRes, pRes, pMineRes] = await Promise.all([
        venueIds.length
          ? supabase.from("venues").select("*").in("id", venueIds)
          : Promise.resolve({ data: [] }),
        acts.length
          ? supabase
              .from("activity_photos")
              .select("id, activity_id, user_id, web_path, created_at")
              .in("activity_id", acts.map((a) => a.id))
          : Promise.resolve({ data: [] }),
        // Photos they AUTHORED that live on someone else's check-in —
        // via-link uploads attach to the ALBUM OWNER's shard (doctrine),
        // so without this their own contribution is invisible on their
        // profile (July 25 field test).
        supabase
          .from("activity_photos")
          .select("id, activity_id, user_id, web_path, created_at")
          .eq("user_id", userId),
      ]);
      const vById = Object.fromEntries(
        (vRes.data || []).map((v) => [v.id, v])
      );
      const photos = pRes.data || [];
      const have = new Set(photos.map((p) => p.id));
      for (const ph of pMineRes.data || []) {
        if (have.has(ph.id)) continue;
        // Re-home onto their twin shard: the twin joined THROUGH the
        // activity the photo lives on (joined_from edge).
        const home = acts.find((a) => a.joined_from === ph.activity_id);
        if (home) {
          photos.push({ ...ph, activity_id: home.id });
          have.add(ph.id);
        }
      }
      const byAct = {};
      for (const ph of photos) {
        if (!byAct[ph.activity_id]) byAct[ph.activity_id] = [];
        byAct[ph.activity_id].push(ph);
      }
      // An event = a check-in with MEDIA or a TITLE (July 25, Mark: titled
      // nights are events even before photos land). Untitled + photoless
      // stays in "Also been".
      const albumActs = acts.filter(
        (a) => (byAct[a.id] || []).length > 0 || a.label
      );
      const covers = albumActs.map((a) => {
        const ps = (byAct[a.id] || [])
          .slice()
          .sort((x, y) => new Date(y.created_at) - new Date(x.created_at));
        return {
          act: a,
          count: ps.length,
          coverPath: ps[0]?.web_path || null,
        };
      });
      let coverUrlByPath = {};
      const coverPaths = covers.map((c) => c.coverPath).filter(Boolean);
      if (coverPaths.length > 0) {
        const { data: signed } = await supabase.storage
          .from("checkin-photos")
          .createSignedUrls(coverPaths, 3600);
        coverUrlByPath = Object.fromEntries(
          (signed || [])
            .filter((s) => s.signedUrl)
            .map((s) => [s.path, s.signedUrl])
        );
      }
      if (cancelled) return;
      // Old banner state keeps working off the same rows.
      setTheirCheckins(
        acts.slice(0, 8).map((r) => ({
          id: r.id,
          venueName: vById[r.venue_id]?.name || "a spot",
          label: r.label || null,
          created_at: r.created_at,
        }))
      );
      setTheirData({
        albums: covers.map((c) => ({
          activityId: c.act.id,
          title: c.act.label || vById[c.act.venue_id]?.name || "A day out",
          venueName: vById[c.act.venue_id]?.name || "a spot",
          venueObj: vById[c.act.venue_id] || null,
          label: c.act.label || null,
          created_at: c.act.created_at,
          count: c.count,
          // Photo cover when they have one; the venue's own photo otherwise
          // (titled-but-photoless events still get a face).
          coverUrl:
            (c.coverPath && coverUrlByPath[c.coverPath]) ||
            vById[c.act.venue_id]?.image_cdn_urls?.[0] ||
            null,
        })),
        alsoBeen: acts
          .filter((a) => !(byAct[a.id] || []).length && !a.label)
          .map((a) => ({
            id: a.id,
            venueName: vById[a.venue_id]?.name || "a spot",
            label: a.label || null,
            created_at: a.created_at,
          })),
        photoCount: photos.length,
        placeCount: new Set(acts.map((a) => a.venue_id).filter(Boolean)).size,
        // Flat grid + tap-through metadata (Photos counter subview).
        photoList: photos
          .slice()
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
        actMeta: Object.fromEntries(
          acts.map((a) => [
            a.id,
            {
              venueName: vById[a.venue_id]?.name || "a spot",
              label: a.label || null,
              created_at: a.created_at,
              venueObj: vById[a.venue_id] || null,
            },
          ])
        ),
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [isFriends, userId]);

  // Sign the flat grid's URLs when the Photos subview opens (covers are
  // signed in the main fetch; the rest wait until someone actually looks).
  useEffect(() => {
    if (subView !== "photos" || !theirData?.photoList?.length) return;
    const missing = theirData.photoList
      .map((p) => p.web_path)
      .filter((path) => path && !gridUrls[path]);
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data: signed } = await supabase.storage
        .from("checkin-photos")
        .createSignedUrls(missing, 3600);
      if (cancelled || !signed) return;
      setGridUrls((prev) => ({
        ...prev,
        ...Object.fromEntries(
          signed.filter((s) => s.signedUrl).map((s) => [s.path, s.signedUrl])
        ),
      }));
    })();
    return () => {
      cancelled = true;
    };
  }, [subView, theirData, gridUrls]);

  const pendingFromMe = status === "pending" && iAmRequester;
  const pendingToMe = status === "pending" && !iAmRequester;
  // 'declined' or 'blocked' or no row → treat as openable (Add friend).
  // Re-requesting after a decline is allowed via insert (the UNIQUE constraint
  // is on (requester, addressee) — we'd update the existing row instead, but
  // for D.1 first ship we'll let the insert error surface if it conflicts.

  // Action: send a new friend request.
  // RLS on friendships only allows UPDATE of rows whose status is 'pending'
  // (see friendships_table.sql). Once a row is declined / blocked / accepted
  // it's effectively immutable, so attempting to UPDATE it back to 'pending'
  // silently no-ops. For declined rows we DELETE then INSERT fresh, which
  // also lets the new initiator become requester_id even if the original
  // request went the other direction. RLS allows either party to DELETE
  // (delete_party) and the new initiator to INSERT (insert_as_requester).
  // Shared with the drawer, the participants strip and the album (July 31) —
  // the write and its push live together in lib/friendships so this path can't
  // be the quiet one again. It was: adding someone from their PROFILE, the
  // most obvious route in the app, sent the row and no notification.
  async function sendRequest() {
    setActing(true);
    const result = await sendFriendRequest(viewerUserId, userId);
    setActing(false);
    showToast?.(friendRequestToast(result));
    if (result !== "error") await load();
  }

  async function acceptRequest() {
    if (!friendship) return;
    setActing(true);
    const ok = await acceptFriendRequest(viewerUserId, userId, friendship.id);
    setActing(false);
    if (!ok) {
      showToast?.("Couldn't accept request");
      return;
    }
    await load();
  }

  async function cancelOrDecline() {
    if (!friendship) return;
    setActing(true);
    const { error } = await supabase
      .from("friendships")
      .update({ status: "declined" })
      .eq("id", friendship.id);
    setActing(false);
    if (error) {
      showToast?.("Couldn't update request");
      return;
    }
    await load();
  }

  async function unfriend() {
    if (!friendship) return;
    if (!window.confirm("Remove this friend?")) return;
    setActing(true);
    const { error } = await supabase
      .from("friendships")
      .delete()
      .eq("id", friendship.id);
    setActing(false);
    if (error) {
      showToast?.("Couldn't unfriend");
      return;
    }
    await load();
  }

  const displayName = profile?.display_name || "Loading…";
  const handle = profile?.username ? `@${profile.username}` : "";
  const initial =
    (profile?.display_name || profile?.username || "?").trim()[0]?.toUpperCase() || "?";

  return (
    // z-3900: ABOVE check-in cards (3600) and lightbox (3800) — profile taps
    // from any card must land on top, not underneath (Mark's bug report).
    // `invisible` (not unmount) while an album opened FROM here is up —
    // visibility keeps state + scroll so the return is instant.
    <div
      className={`fixed inset-0 z-[3900] bg-[#fdf6f0] overflow-y-auto pb-24 ${
        hidden ? "invisible" : ""
      }`}
    >
      <div className="max-w-sm mx-auto p-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-600"
        >
          <ArrowLeft size={16} /> Back
        </button>

        {/* Hero */}
        <div className="flex flex-col items-center text-center mb-6">
          <button
            type="button"
            onClick={() => setAvatarExpanded((v) => !v)}
            aria-label="Expand avatar"
            className={`rounded-full bg-[#455d3b] text-white font-medium flex items-center justify-center overflow-hidden transition-all ${
              avatarExpanded ? "w-40 h-40 text-6xl" : "w-20 h-20 text-3xl"
            }`}
          >
            {profile?.avatar_url ? (
              <img
                src={profile.avatar_url}
                alt={displayName}
                className="h-full w-full object-cover"
              />
            ) : (
              initial
            )}
          </button>
          <h1 className="text-2xl font-semibold tracking-tight mt-3">
            {displayName}
          </h1>
          {handle && (
            <p className="text-sm text-neutral-500">{handle}</p>
          )}
          {profile?.tier && profile.tier !== "active" && (
            <span className="inline-block mt-2 text-xs text-[#455d3b] bg-[#455d3b]/10 rounded-full px-3 py-1">
              {profile.tier.replace("_", " ")}
            </span>
          )}
        </div>

        {/* CTA — derived from friendship state */}
        {loading && (
          <p className="text-sm text-neutral-500 text-center mb-6">Loading…</p>
        )}

        {!loading && isAnon && (
          <button
            type="button"
            onClick={() => setShowInvite(true)}
            className="w-full rounded-full bg-[#455d3b] text-white font-medium py-3 mb-6 flex items-center justify-center gap-2"
          >
            <UserPlus size={16} /> Invite to Flanit
          </button>
        )}

        {showInvite &&
          (() => {
            const inviteUrl = "https://flanit.co";
            const inviteName = profile?.display_name?.trim() || "them";
            const inviteMsg = `Come back to Flanit and claim your account — your picks and friends are saved: ${inviteUrl}`;
            return (
              <>
                <div
                  className="fixed inset-0 bg-black/30 z-[3400]"
                  onClick={() => setShowInvite(false)}
                />
                <div className="fixed bottom-0 left-0 right-0 bg-white rounded-t-3xl p-5 z-[3500] max-w-md mx-auto shadow-2xl">
                  <div className="w-10 h-1 bg-neutral-200 rounded-full mx-auto mb-4" />
                  <h2 className="text-lg font-semibold mb-1">
                    Invite {inviteName} back
                  </h2>
                  <p className="text-sm text-neutral-500 mb-4">
                    Send a link so they can claim their account — they'll keep the
                    picks and friends from your sessions.
                  </p>
                  <div className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-700 mb-3 break-all border border-neutral-100">
                    {inviteUrl}
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(inviteUrl);
                          showToast?.("Link copied");
                        } catch {
                          /* clipboard blocked */
                        }
                      }}
                      className="rounded-2xl bg-white border border-neutral-200 py-3 font-medium text-neutral-700 active:scale-[0.98] transition"
                    >
                      Copy link
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          if (navigator.share) {
                            await navigator.share({
                              title: "Join me on Flanit",
                              text: inviteMsg,
                              url: inviteUrl,
                            });
                          } else {
                            await navigator.clipboard.writeText(inviteUrl);
                            showToast?.("Link copied");
                          }
                        } catch {
                          /* user cancelled */
                        }
                      }}
                      className="rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition"
                    >
                      Share…
                    </button>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <a
                      href={`mailto:?subject=${encodeURIComponent(
                        "Join me on Flanit"
                      )}&body=${encodeURIComponent(inviteMsg)}`}
                      className="rounded-2xl bg-white border border-neutral-200 py-2.5 text-center text-sm font-medium text-neutral-700"
                    >
                      Email
                    </a>
                    <a
                      href={`sms:?&body=${encodeURIComponent(inviteMsg)}`}
                      className="rounded-2xl bg-white border border-neutral-200 py-2.5 text-center text-sm font-medium text-neutral-700"
                    >
                      Message
                    </a>
                    <a
                      href={`https://wa.me/?text=${encodeURIComponent(inviteMsg)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="rounded-2xl bg-white border border-neutral-200 py-2.5 text-center text-sm font-medium text-neutral-700"
                    >
                      WhatsApp
                    </a>
                  </div>
                </div>
              </>
            );
          })()}

        {!loading && !isAnon && !isFriends && !pendingToMe && !pendingFromMe && (
          <button
            type="button"
            disabled={acting}
            onClick={sendRequest}
            className="w-full rounded-full bg-[#455d3b] text-white font-medium py-3 mb-6 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            <UserPlus size={16} /> Add friend
          </button>
        )}

        {!loading && pendingToMe && (
          <div className="flex gap-2 mb-6">
            <button
              type="button"
              disabled={acting}
              onClick={acceptRequest}
              className="flex-1 rounded-full bg-[#455d3b] text-white font-medium py-3 flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <Check size={16} /> Accept request
            </button>
            <button
              type="button"
              disabled={acting}
              onClick={cancelOrDecline}
              className="rounded-full border border-neutral-300 px-4 py-3 text-sm disabled:opacity-50"
            >
              Decline
            </button>
          </div>
        )}

        {!loading && pendingFromMe && (
          <div className="flex gap-2 mb-6">
            <div className="flex-1 rounded-full bg-neutral-100 text-neutral-600 font-medium py-3 flex items-center justify-center gap-2">
              <Check size={16} /> Request sent
            </div>
            <button
              type="button"
              disabled={acting}
              onClick={cancelOrDecline}
              className="rounded-full border border-neutral-300 px-4 py-3 text-sm disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        )}

        {!loading && isFriends && (
          <div className="flex gap-2 mb-6">
            <div className="flex-1 rounded-full bg-[#455d3b]/10 text-[#455d3b] font-medium py-3 flex items-center justify-center gap-2">
              <Check size={16} /> Friends
            </div>
            <button
              type="button"
              disabled={acting}
              onClick={unfriend}
              aria-label="Unfriend"
              className="rounded-full border border-neutral-300 px-4 py-3 text-neutral-500 disabled:opacity-50"
            >
              <UserMinus size={16} />
            </button>
          </div>
        )}

        {/* Locked sections (pre-friend) */}
        {!loading && !isFriends && (
          <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 text-center">
            <p className="text-sm text-neutral-600 mb-1">
              Add as a friend to see
            </p>
            <p className="text-xs text-neutral-500">
              their list, friends, and activity unlock once you're connected.
            </p>
          </div>
        )}

        {/* PHOTO-FIRST profile (July 25): counts → live → EVENTS (albums =
            check-ins with media) → Also been (quiet check-ins). Friends
            section deliberately absent until the friends-of-friends
            privacy call + RPC. */}
        {!loading && isFriends && (
          <>
            {theirData === null && (
              <p className="text-sm text-neutral-500 text-center py-4">
                Loading…
              </p>
            )}
            {theirData !== null && (
              <>
                <div className="mb-3 grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-2xl bg-white border border-neutral-100 py-2.5">
                    <p className="text-base font-semibold text-neutral-900">
                      {theirData.albums.length}
                    </p>
                    <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                      Events
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={theirData.photoCount === 0}
                    onClick={() => setSubView("photos")}
                    className="rounded-2xl bg-white border border-neutral-100 py-2.5 active:scale-95 transition"
                  >
                    <p className="text-base font-semibold text-neutral-900">
                      {theirData.photoCount}
                    </p>
                    <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                      Photos{theirData.photoCount > 0 ? " ›" : ""}
                    </p>
                  </button>
                  <button
                    type="button"
                    disabled={theirData.placeCount === 0}
                    onClick={() => onShowOnMap?.(profile)}
                    className="rounded-2xl bg-white border border-neutral-100 py-2.5 active:scale-95 transition"
                  >
                    <p className="text-base font-semibold text-neutral-900">
                      {theirData.placeCount}
                    </p>
                    <p className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
                      Places{theirData.placeCount > 0 ? " ›" : ""}
                    </p>
                  </button>
                </div>
                {(() => {
                  const latest = theirCheckins?.[0];
                  // Presence is the toggle (Aug, Mark) — a quiet check-in
                  // never claims "Is at ... right now" on their profile.
                  const live =
                    latest &&
                    latest.show_live !== false &&
                    Date.now() - new Date(latest.created_at).getTime() <
                      3 * 60 * 60 * 1000;
                  return live ? (
                    <div className="mb-3 flex items-center gap-2 rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] px-3 py-2.5">
                      <span className="h-2 w-2 rounded-full bg-[#455d3b] animate-pulse" />
                      <p className="text-sm text-[#2f3f29]">
                        Is at{" "}
                        <strong className="font-medium">
                          {latest.venueName}
                        </strong>{" "}
                        right now
                        {latest.label ? ` · ${latest.label}` : ""}
                      </p>
                    </div>
                  ) : null;
                })()}
                {theirData.albums.length > 0 && (
                  <>
                    <p className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
                      Events
                    </p>
                    <div className="mb-4 grid grid-cols-2 gap-2">
                      {theirData.albums.map((al) => (
                        <button
                          key={al.activityId}
                          type="button"
                          onClick={() =>
                            onOpenThread?.({
                              activityId: al.activityId,
                              ownerId: userId,
                              ownerName:
                                profile?.display_name || "A friend",
                              ownerProfile: profile || null,
                              venueName: al.venueName,
                              label: al.label,
                              venueObj: al.venueObj,
                              timestamp: al.created_at,
                            })
                          }
                          className="text-left active:scale-[0.98] transition"
                        >
                          <div className="relative aspect-[4/3] overflow-hidden rounded-xl bg-[#dfe9da]">
                            {al.coverUrl && (
                              <img
                                src={al.coverUrl}
                                alt=""
                                className="h-full w-full object-cover"
                              />
                            )}
                            {al.count > 0 && (
                              <span className="absolute bottom-1.5 right-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white">
                                {al.count} 📷
                              </span>
                            )}
                          </div>
                          <p className="mt-1 truncate text-xs font-semibold text-neutral-900">
                            {al.title}
                          </p>
                          <p className="truncate text-[10px] text-neutral-500">
                            {al.label ? `${al.venueName} · ` : ""}
                            {new Date(al.created_at).toLocaleDateString(
                              "en-AU",
                              { day: "numeric", month: "short" }
                            )}
                          </p>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {theirData.alsoBeen.length > 0 && (
                  <>
                    <p className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
                      Also been
                    </p>
                    <div className="space-y-2">
                      {theirData.alsoBeen.slice(0, 6).map((c) => (
                        <CheckinHistoryRow key={c.id} c={c} />
                      ))}
                    </div>
                  </>
                )}
                {theirData.albums.length === 0 &&
                  theirData.alsoBeen.length === 0 && (
                    <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 text-center">
                      <p className="text-sm text-neutral-600">
                        Nothing here yet — when{" "}
                        {profile?.display_name || "they"} checks in somewhere,
                        it shows up here.
                      </p>
                    </div>
                  )}
              </>
            )}
            {theirFriends !== null && theirFriends.length > 0 && (
              <>
                <p className="mb-2 mt-4 px-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
                  Friends · {theirFriends.length}
                </p>
                {/* Compact avatar rail (Mark: full-width rows were too much
                    chrome) — horizontal scroll, you first, mutuals next. */}
                <div className="flex gap-3 overflow-x-auto pb-2 px-1 -mx-1">
                  {theirFriends.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => onOpenProfile?.(f.id)}
                      className="flex w-16 shrink-0 flex-col items-center gap-1 active:scale-95 transition"
                    >
                      <FriendAvatar profile={f} />
                      <span className="w-full truncate text-center text-[10px] text-neutral-700">
                        {f.self ? "You" : f.display_name || "Someone"}
                      </span>
                      {f.mutual && !f.self && (
                        <span className="-mt-0.5 text-[8px] font-medium text-[#455d3b]">
                          mutual
                        </span>
                      )}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSubView("friends")}
                    className="flex w-16 shrink-0 flex-col items-center gap-1 active:scale-95 transition"
                  >
                    <span className="flex h-10 w-10 items-center justify-center rounded-full border border-neutral-200 bg-white text-base text-neutral-500">
                      ›
                    </span>
                    <span className="text-[10px] text-neutral-500">
                      See all
                    </span>
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </div>

      {/* PHOTOS subview — the flat grid behind the Photos counter. Tiles
          open the check-in card with that photo's lightbox deep-linked. */}
      {subView === "photos" && theirData && (
        <div className="fixed inset-0 z-[3910] bg-[#fdf6f0] overflow-y-auto pb-24">
          <div className="max-w-sm mx-auto p-4">
            <button
              type="button"
              onClick={() => setSubView(null)}
              className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-600"
            >
              <ArrowLeft size={16} /> {displayName}
            </button>
            <p className="mb-3 text-lg font-semibold tracking-tight">
              Photos · {theirData.photoCount}
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {theirData.photoList.map((ph) => {
                const meta = theirData.actMeta[ph.activity_id];
                return (
                  <button
                    key={ph.id}
                    type="button"
                    onClick={() =>
                      meta &&
                      onOpenThread?.({
                        activityId: ph.activity_id,
                        ownerId: userId,
                        ownerName: displayName,
                        ownerProfile: profile || null,
                        venueName: meta.venueName,
                        label: meta.label,
                        venueObj: meta.venueObj,
                        timestamp: meta.created_at,
                        photoId: ph.id,
                      })
                    }
                    className="aspect-square overflow-hidden rounded-lg bg-[#dfe9da] active:scale-95 transition"
                  >
                    {gridUrls[ph.web_path] && (
                      <img
                        src={gridUrls[ph.web_path]}
                        alt=""
                        className="h-full w-full object-cover"
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* FRIENDS subview — the full list behind "See all". */}
      {subView === "friends" && theirFriends && (
        <div className="fixed inset-0 z-[3910] bg-[#fdf6f0] overflow-y-auto pb-24">
          <div className="max-w-sm mx-auto p-4">
            <button
              type="button"
              onClick={() => setSubView(null)}
              className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-600"
            >
              <ArrowLeft size={16} /> {displayName}
            </button>
            <p className="mb-3 text-lg font-semibold tracking-tight">
              Friends · {theirFriends.length}
            </p>
            <div className="rounded-3xl bg-white p-3 shadow-sm border border-neutral-100 space-y-1">
              {theirFriends.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => onOpenProfile?.(f.id)}
                  className="flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left active:bg-neutral-50"
                >
                  <FriendAvatar profile={f} small />
                  <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                    {f.self ? "You" : f.display_name || "Someone"}
                    {f.username ? (
                      <span className="text-neutral-400"> · @{f.username}</span>
                    ) : null}
                  </span>
                  {f.mutual && !f.self && (
                    <span className="shrink-0 rounded-full bg-[#edf2eb] px-2 py-0.5 text-[10px] font-medium text-[#455d3b]">
                      Mutual
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// BeenScreen + CheckinHistoryRow moved to ./components/BeenScreen.js;
// check-in domain logic lives in ./lib/checkins.js (both imported at the top).

// Fresh-load screen. Rotating wry one-liners instead of "Loading venues..." —
// starts on a random line so repeat visitors don't see the same one twice.
const LOADING_LINES = [
  "finding the good spots",
  "checking who's out",
  "scouting the laneways",
  "asking the group chat",
  "reading the chalkboard menu",
  "judging a bar by its lighting",
  "lining up for coffee, it's melbourne",
  "saving you the corner table",
];

function LoadingScreen() {
  const [i, setI] = useState(() =>
    Math.floor(Math.random() * LOADING_LINES.length)
  );
  useEffect(() => {
    const t = setInterval(
      () => setI((prev) => (prev + 1) % LOADING_LINES.length),
      1600
    );
    return () => clearInterval(t);
  }, []);
  return (
    <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex flex-col items-center justify-center gap-4 p-4">
      <div className="relative flex h-12 w-12 items-center justify-center">
        <span className="absolute inset-0 rounded-full bg-[#455d3b]/15 animate-ping" />
        <span className="relative flex h-9 w-9 items-center justify-center rounded-full bg-[#455d3b] text-white">
          <MapPinIcon size={18} />
        </span>
      </div>
      <p className="text-sm text-neutral-500">{LOADING_LINES[i]}…</p>
    </div>
  );
}

// CheckinHistoryRow moved to ./components/BeenScreen.js (imported at the top).

// FriendAvatar moved to ./components/FriendAvatar.js (imported at the top).

function SessionSetupScreen({ onBack, onPickRightNow, onPickLater }) {
  const [expanded, setExpanded] = useState(null);

  return (
    <div className="flex items-start justify-center p-4 pb-24">
      <div className="w-full max-w-sm">
        <SessionSetupCard
          icon={<HeartHandshake size={18} />}
          title="Pick together"
          subtitle="Swipe together and find the perfect match"
          expanded={expanded === "right_now"}
          onToggle={() =>
            setExpanded(expanded === "right_now" ? null : "right_now")
          }
          steps={[
            "Pick your filters",
            "Invite your friends",
            "Swipe together",
            "See your matches",
          ]}
          ctaLabel="Continue"
          onCta={onPickRightNow}
        />

        <div className="h-2" />

        <SessionSetupCard
          icon={<ListChecks size={18} />}
          title="Send a shortlist"
          subtitle="You curate the list, friends vote on it"
          expanded={expanded === "later"}
          onToggle={() =>
            setExpanded(expanded === "later" ? null : "later")
          }
          steps={[
            "Pick your filters",
            "Build your shortlist",
            "Send to friends",
            "See their picks",
          ]}
          ctaLabel="Continue"
          onCta={() => onPickLater(null)}
        />
      </div>
    </div>
  );
}

function SessionSetupCard({
  icon,
  title,
  subtitle,
  expanded,
  onToggle,
  steps,
  ctaLabel,
  onCta,
}) {
  return (
    <div
      className={`bg-white rounded-2xl shadow-sm transition border ${
        expanded ? "border-[#455d3b] border-2" : "border-neutral-100"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full p-4 flex items-center gap-3 text-left"
      >
        <div
          className={`inline-flex items-center justify-center w-10 h-10 rounded-full transition ${
            expanded
              ? "bg-[#455d3b] text-white"
              : "bg-[#455d3b]/10 text-[#455d3b]"
          }`}
        >
          {icon}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-base font-medium text-neutral-900">{title}</p>
          <p className="text-xs text-neutral-500">{subtitle}</p>
        </div>
        <span className="text-neutral-400 text-lg leading-none">
          {expanded ? "" : "›"}
        </span>
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          <ul className="mb-3 space-y-1.5">
            {steps.map((step, i) => (
              <li key={i} className="flex gap-3 text-sm text-neutral-700">
                <span className="text-[#455d3b] font-medium w-4">{i + 1}</span>
                <span>{step}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onCta}
            className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.99] transition"
          >
            {ctaLabel}
          </button>
        </div>
      )}
    </div>
  );
}

function InviteShareScreen({
  sessionId,
  mode = "concurrent",
  matchCount = 0,
  target = 0,
  userId,
  inviterName,
  showToast,
  onBack,
  onContinue,
  onDone,
}) {
  const [copied, setCopied] = useState(false);
  const [friends, setFriends] = useState([]);
  const [invitedIds, setInvitedIds] = useState(() => new Set());
  const [invitingId, setInvitingId] = useState(null);
  const shareUrl = sessionId
    ? `${window.location.origin}/s/${sessionId}`
    : "";
  const isCurated = mode === "curated";

  // The host's accepted friends + who's already been invited to this session.
  useEffect(() => {
    if (!userId || !sessionId) return;
    let cancelled = false;
    (async () => {
      const { data: fr } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id, status")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`)
        .eq("status", "accepted");
      const otherIds = (fr || []).map((f) =>
        f.requester_id === userId ? f.addressee_id : f.requester_id
      );
      if (otherIds.length === 0) {
        if (!cancelled) setFriends([]);
        return;
      }
      const [profsRes, invRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", otherIds),
        supabase
          .from("session_invites")
          .select("invitee_id")
          .eq("session_id", sessionId),
      ]);
      if (cancelled) return;
      setFriends(profsRes.data || []);
      setInvitedIds(new Set((invRes.data || []).map((r) => r.invitee_id)));
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, sessionId]);

  async function inviteFriend(friendId) {
    setInvitingId(friendId);
    const { error } = await supabase.rpc("invite_to_session", {
      p_session_id: sessionId,
      p_invitee_id: friendId,
    });
    setInvitingId(null);
    if (error) {
      console.error("invite_to_session failed:", error);
      showToast?.("Couldn't send invite");
      return;
    }
    // A session invite is the most time-sensitive thing in the app — a Right
    // Now session is over in ten minutes — and until July 31 it created an
    // in-app Activity item and NOTHING else, so it only reached people who
    // happened to open Flanit. Deep-links straight to the join screen.
    sendPush(
      friendId,
      mode === "curated" ? "A shortlist for you" : "Pick a place together",
      inviterName
        ? `${inviterName} wants you in`
        : "A friend wants you in",
      `/s/${sessionId}`
    );
    setInvitedIds((prev) => new Set([...prev, friendId]));
    showToast?.("Invite sent");
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  }

  async function shareLink() {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Join my session",
          text: "Help me pick a place",
          url: shareUrl,
        });
      } catch (err) {
        // user cancelled or share failed; no-op
      }
    } else {
      copyLink();
    }
  }

  return (
    <div className="flex items-start justify-center p-4 pb-24">
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back"
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-sm border border-neutral-100 text-neutral-600 shrink-0"
          >
            <ArrowLeft size={18} />
          </button>
          <h1 className="text-2xl font-semibold tracking-tight">
            {isCurated ? "Sent! Now invite friends" : "Invite your friends"}
          </h1>
        </div>

        <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 mb-4">
          {shareUrl && (
            <div className="flex flex-col items-center mb-4">
              <div className="rounded-2xl bg-white p-3 border border-neutral-100">
                <QRCodeSVG value={shareUrl} size={180} />
              </div>
              <p className="mt-2 text-xs uppercase tracking-wide text-neutral-500">
                Scan to join
              </p>
            </div>
          )}
          <p className="text-sm text-neutral-500 mb-2">Share this link</p>
          <div className="rounded-2xl bg-neutral-50 px-4 py-3 text-sm text-neutral-700 mb-3 break-all border border-neutral-100">
            {shareUrl}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={copyLink}
              className="rounded-2xl bg-white border border-neutral-200 py-3 font-medium text-neutral-700 active:scale-[0.98] transition"
            >
              {copied ? "Copied!" : "Copy link"}
            </button>
            <button
              type="button"
              onClick={shareLink}
              className="rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition"
            >
              Share
            </button>
          </div>
        </div>

        {friends.length > 0 && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 mb-4">
            <p className="text-sm font-semibold text-neutral-800 mb-3">
              Send to friends
            </p>
            <div className="space-y-2">
              {friends.map((f) => {
                const name =
                  f.display_name?.trim() ||
                  (f.username ? `@${f.username}` : "Friend");
                const invited = invitedIds.has(f.id);
                return (
                  <div key={f.id} className="flex items-center gap-3">
                    {f.avatar_url ? (
                      <img
                        src={f.avatar_url}
                        alt={name}
                        className="h-9 w-9 shrink-0 rounded-full object-cover"
                      />
                    ) : (
                      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b] text-sm font-medium">
                        {name.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="flex-1 min-w-0 truncate text-sm text-neutral-800">
                      {name}
                    </span>
                    <button
                      type="button"
                      disabled={invited || invitingId === f.id}
                      onClick={() => inviteFriend(f.id)}
                      className={`shrink-0 rounded-full px-4 py-1.5 text-xs font-medium disabled:opacity-70 ${
                        invited
                          ? "bg-neutral-100 text-neutral-400"
                          : "bg-[#455d3b] text-white active:scale-95"
                      }`}
                    >
                      {invited ? "Invited" : invitingId === f.id ? "…" : "Invite"}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* CURATED HOST = a calm waiting state (July 25, Mark: match the
            Right Now end screen — don't push them at an empty results
            board). One card, a nudge promise, and an exit. The decision
            comes to them: everyone's picks push + the Activity item. */}
        {isCurated ? (
          <>
            <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 mb-4 text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-[#edf2eb] text-[#455d3b]">
                <Check size={28} />
              </div>
              <h2 className="text-xl font-semibold tracking-tight">
                Your shortlist is sent
              </h2>
              <p className="mt-2 text-sm text-neutral-600">
                We'll nudge you as friends pick, then you make the call.
              </p>
            </div>
            <button
              type="button"
              onClick={onDone || onContinue}
              className="w-full rounded-2xl bg-[#455d3b] py-4 font-medium text-white active:scale-[0.98] transition"
            >
              Done for now
            </button>
          </>
        ) : (
          <>
            <div className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600 mb-4">
              Your friends will swipe the same places as you. The session ends
              when everyone submits or time runs out.
            </div>
            <button
              type="button"
              onClick={onContinue}
              className="w-full rounded-2xl bg-[#455d3b] py-4 font-medium text-white active:scale-[0.98] transition"
            >
              Start swiping
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function SwipeActions({
  mode,
  likeCount,
  onLike,
  onPass,
  onSoloSave,
  onSoloSkip,
  onSoloHide,
  onDoneAndSend,
}) {
  const [soloMenuOpen, setSoloMenuOpen] = useState(false);

  // Portaled with the tab bar (Aug 1) — same iOS fixed-in-transformed-ancestor
  // break scrolled both mid-page together.
  return createPortal(
    <div className="fixed bottom-20 left-0 right-0 z-30 px-4">
      <div className="w-full max-w-sm mx-auto">
        {mode === "solo" ? (
          <div className="flex gap-2 relative">
            <button
              type="button"
              onClick={() => setSoloMenuOpen(true)}
              aria-label="More options"
              className="rounded-2xl bg-white border border-neutral-200 px-4 py-4 text-neutral-500 active:scale-[0.98] transition flex items-center justify-center shadow-md"
            >
              <MoreVertical size={18} />
            </button>
            <button
              type="button"
              onClick={onSoloSkip}
              className="flex-1 rounded-2xl bg-neutral-100 py-4 font-medium text-neutral-700 active:scale-[0.98] transition shadow-md"
            >
              Next
            </button>
            <button
              type="button"
              onClick={onSoloSave}
              className="flex-1 rounded-2xl bg-[#455d3b] py-4 font-medium text-white active:scale-[0.98] transition shadow-md"
            >
              Add to list
            </button>
            {soloMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-[3400]"
                  onClick={() => setSoloMenuOpen(false)}
                />
                <div className="absolute bottom-full left-0 mb-2 bg-white border border-neutral-200 rounded-xl shadow-lg z-[3500] overflow-hidden">
                  <button
                    type="button"
                    onClick={() => {
                      onSoloHide();
                      setSoloMenuOpen(false);
                    }}
                    className="block px-5 py-3 text-red-700 font-medium hover:bg-neutral-50 whitespace-nowrap text-left"
                  >
                    Don't show this again
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={onPass}
              className="rounded-2xl bg-neutral-100 py-4 font-medium text-neutral-700 active:scale-[0.98] transition shadow-md"
            >
              <span className="inline-flex items-center justify-center gap-2">
                <X size={18} /> Pass
              </span>
            </button>
            <button
              type="button"
              onClick={onLike}
              className="rounded-2xl bg-[#edf2eb] py-4 font-medium text-[#455d3b] active:scale-[0.98] transition shadow-md"
            >
              <span className="inline-flex items-center justify-center gap-2">
                <Heart size={18} /> Like
              </span>
            </button>
          </div>
        )}

        {mode === "curated" && (
          <div className="mt-2">
            {likeCount < 15 ? (
              <button
                type="button"
                onClick={onDoneAndSend}
                disabled={likeCount === 0}
                className="block w-full text-center text-sm py-2 px-4 rounded-full bg-white border border-neutral-200 text-neutral-600 hover:bg-neutral-50 disabled:text-neutral-300 disabled:border-neutral-200 disabled:cursor-not-allowed"
              >
                Done &amp; send ({likeCount})
              </button>
            ) : (
              <button
                type="button"
                onClick={onDoneAndSend}
                className={`w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition flex items-center justify-center gap-2 shadow-md ${
                  likeCount >= 20 ? "animate-pulse" : ""
                }`}
              >
                {likeCount < 20 && <span>✨</span>}
                <span>Done &amp; send ({likeCount})</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}

// MapResizer + MapScreen moved to ./components/MapScreen.js (imported at top).
// (MapScreen body now lives in ./components/MapScreen.js)

// MapFilterGroup, MapFilterChip, MapFilterSection, SearchableChips,
// MapAreaFilter moved to ./components/MapFilters.js (imported at the top).

// VenueCard, VenueHeroCarousel, VenueVibes, VenueRating, OpeningHours,
// OpenMapsButton moved to ./components/VenueBits.js;
// EmptyState moved to ./components/EmptyState.js (both imported at the top).

// Render-safe redirect: fires the navigation AFTER mount instead of during
// render (React forbids setState mid-render). Used where a screen has
// nothing left to say and should just move on.
function AutoRoute({ go }) {
  useEffect(() => {
    go();
  }, [go]);
  return null;
}
