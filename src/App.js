import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './styles.css';
import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapPin, Shuffle, RotateCcw, Heart, X, ExternalLink, Search, Locate, LogOut, User, Users, Check, ArrowLeft, Trash2, MoreVertical, Zap, Calendar, Download, Upload, UserPlus, UserMinus, Plus, Bell } from "lucide-react";
import { supabase } from "./supabaseClient";
import { MapContainer, TileLayer, Marker, useMap } from "react-leaflet";
import L from "leaflet";
import MarkerClusterGroup from "react-leaflet-cluster";
import { QRCodeSVG } from "qrcode.react";
import { Turnstile } from "@marsidev/react-turnstile";
import JSZip from "jszip";
import Papa from "papaparse";

// Cloudflare Turnstile site key (public — safe to commit). Bot/captcha
// gate on the three Supabase Auth entry points: host magic-link signin,
// anonymous guest signin, and the anon→email upgrade. The matching
// secret key is held in Supabase Auth → Captcha Protection. If captcha
// is disabled server-side the token is simply ignored, so this widget
// is safe to render before the Supabase side is enabled.
const TURNSTILE_SITE_KEY = "0x4AAAAAADTF1P7KXWBPldrU";
 
const ALL = "All";
const MATCH_OPTIONS = [1, 2, 3, 4];
const RADIUS_OPTIONS = [1, 3, 5, 10];

// 2-4 because 1 is solo (no session needed) and >4 stops being playful.
// If you change this, update the schema CHECK / validation too.
const PARTICIPANT_OPTIONS = [2, 3, 4];

// Time-limit options per mode, in minutes. Used to compute the session's
// expires_at when it's created. "Right now" is short by design — get to a
// decision in the next 10 min or two. "Later" is generous — host curates,
// guests can swipe at their own pace over hours or days.
const TIME_LIMIT_OPTIONS_CONCURRENT = [
  { label: "10 min", minutes: 10 },
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
];
const TIME_LIMIT_OPTIONS_CURATED = [
  { label: "6 hours", minutes: 60 * 6 },
  { label: "24 hours", minutes: 60 * 24 },
  { label: "3 days", minutes: 60 * 24 * 3 },
  { label: "7 days", minutes: 60 * 24 * 7 },
];
 
const DAY_KEYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
 
const TIME_BANDS = [
  { key: "Morning", start: 6 * 60, end: 11 * 60 },
  { key: "Lunch", start: 11 * 60, end: 14 * 60 + 30 },
  { key: "Afternoon", start: 14 * 60 + 30, end: 17 * 60 },
  { key: "Dinner", start: 17 * 60, end: 22 * 60 },
  { key: "Late night", start: 22 * 60, end: 2 * 60 },
];
 
const TIME_BAND_LABELS = TIME_BANDS.map((b) => b.key);
 
const VIBE_OPTIONS = [
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

const MELBOURNE_CENTER = [-37.8136, 144.9631];
const MELBOURNE_ZOOM = 12;

const VIBE_EMOJI_PRIORITY = [
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

function getVenueEmoji(venue) {
  const todayKey = getTodayDayKey();
  for (const [vibe, emoji] of VIBE_EMOJI_PRIORITY) {
    if (venueMatchesVibe(venue, vibe, todayKey)) return emoji;
  }
  return "📍";
}

function createEmojiIcon(emoji) {
  return L.divIcon({
    html: `<div style="font-size:24px;line-height:1;text-align:center;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.25));">${emoji}</div>`,
    className: "venue-emoji-icon",
    iconSize: [32, 32],
    iconAnchor: [16, 32],
  });
}
 
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
      setMessage("Couldn't send the link. " + error.message);
    } else {
      setMessage("Check your email for the sign-in link.");
    }
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
          }}
          className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-600 hover:text-neutral-900"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
          <h2 className="text-xl font-semibold tracking-tight mb-2">
            Sign in
          </h2>
          <p className="text-sm text-neutral-600 mb-4">
            Pop in your email and we'll send you a sign-in link.
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
                options={{ theme: "light" }}
              />
            </div>
            <button
              type="submit"
              disabled={sending || !email.trim() || !captchaToken}
              className="w-full rounded-2xl bg-[#455d3b] py-4 font-medium text-white disabled:bg-neutral-300"
            >
              {sending ? "Sending..." : "Send sign-in link"}
            </button>
            {message && (
              <p className="text-sm text-neutral-700 text-center">{message}</p>
            )}
          </form>
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
  const [radiusKm, setRadiusKm] = useState(5);
  const [showAreaDropdown, setShowAreaDropdown] = useState(false);
  const [openNow, setOpenNow] = useState(false);
  const [selectedTimes, setSelectedTimes] = useState([]);
  const [selectedVibes, setSelectedVibes] = useState([]);
  const [matchLimit, setMatchLimit] = useState(3);
  // Multi-mode session config. Defaults: 2 participants; 10 min for
  // concurrent ("Right now"), 24h for curated ("Later").
  const [participants, setParticipants] = useState(2);
  const [timeLimitMinutes, setTimeLimitMinutes] = useState(10);
  const [cardIndex, setCardIndex] = useState(0);
  const [matches, setMatches] = useState([]);
  const [passed, setPassed] = useState([]);
  const [profile, setProfile] = useState(null);
  const [savedVenueIds, setSavedVenueIds] = useState(() => new Set());
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
  // Find Friends sheet — opened by the FAB's Add friend option AND by the
  // FriendsScreen header + icon. Lifted to App level for that shared access.
  const [showFindFriends, setShowFindFriends] = useState(false);
  // Profile lookup overlay — set to a user_id to open. Lifted from ProfileTab
  // so FindFriendsSheet search results can also open profiles.
  const [lookupUserId, setLookupUserId] = useState(null);
  // Activity drawer (bell icon). Derived from existing tables for D.1 — no
  // dedicated notifications table yet. unreadCount drives the bell's red dot.
  const [showDrawer, setShowDrawer] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  // Session id to deep-link into from a tapped notification — opens that
  // session's Your Sessions detail / results board.
  const [notifSessionId, setNotifSessionId] = useState(null);
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
  const [guestShortlistIds, setGuestShortlistIds] = useState([]);
  // Full venue rows for the curated shortlist, fetched via SECURITY DEFINER
  // RPC so guests can see host-imported (unverified) venues that the general
  // venues query's RLS (verified OR own) would otherwise hide.
  const [guestShortlistVenues, setGuestShortlistVenues] = useState([]);
  // Host's final pick for this session — polled on the guest "Sent" screen.
  const [guestDecidedVenueId, setGuestDecidedVenueId] = useState(null);
  // Host's saved list ("My List") for a concurrent source='list' session.
  const [guestListVenues, setGuestListVenues] = useState([]);
  const [guestLikes, setGuestLikes] = useState([]);
  const [guestPasses, setGuestPasses] = useState([]);
  const [guestCardIndex, setGuestCardIndex] = useState(0);
  // Concurrent-mode reconciliation. sessionMatches is the raw RPC payload
  // (one row per venue with like_count + liker_user_ids); sessionParticipants
  // gives us a uid -> display_name map for labelling matches "You + Sarah".
  const [sessionMatches, setSessionMatches] = useState([]);
  const [sessionParticipants, setSessionParticipants] = useState([]);
  // Guest sign-up flow (anon -> email). guestSignupEmail is the field value,
  // guestSignupSent flips to true after updateUser succeeds, guestSignupError
  // surfaces any updateUser error inline.
  const [guestSignupEmail, setGuestSignupEmail] = useState("");
  const [guestSignupSent, setGuestSignupSent] = useState(false);
  const [guestSignupError, setGuestSignupError] = useState("");
  const [guestSigningUp, setGuestSigningUp] = useState(false);
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
      .select("id, host_user_id, mode, source_type, filters, target_matches, event_at, expires_at, status, name, created_at")
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
    if (!isGuest || guestStage !== "submitted") return;
    if (guestSessionData?.mode !== "curated" || !guestSessionId) return;
    let cancelled = false;
    function poll() {
      supabase
        .from("match_sessions")
        .select("decided_venue_id")
        .eq("id", guestSessionId)
        .single()
        .then(({ data }) => {
          if (cancelled) return;
          setGuestDecidedVenueId(data?.decided_venue_id ?? null);
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

  // Game-end trigger for the host. Concurrent: flip from swipe → matches
  // when target hit. Curated: flip from invite_share → matches when target
  // hit (guests writing per-swipe land matches on the host's invite_share
  // screen, and once reconciliation crosses target_matches we navigate the
  // host to the unified matches view).
  useEffect(() => {
    const target = matchLimit || 0;
    if (!target || sessionMatches.length < target) return;
    if (matchMode === "concurrent" && screen === "swipe") {
      setScreen("matches");
    }
    // Curated ("Send options") no longer auto-flips on a match count — the
    // host opens the results board manually via the "See results" CTA.
  }, [matchMode, screen, matchLimit, sessionMatches.length]);

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
    supabase
      .rpc("get_session_matches", { p_session_id: guestSessionId })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to refetch guest matches:", error);
          return;
        }
        setSessionMatches(data || []);
      });
    return () => {
      cancelled = true;
    };
  }, [isGuest, guestStage, guestSessionId]);

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

  useEffect(() => {
    if (!isGuest || guestStage !== "joined") return;
    const target = guestSessionData?.target_matches || 0;
    const mode = guestSessionData?.mode;
    let shouldFlip = false;

    if (mode === "concurrent") {
      // Concurrent: reconciliation polling tells us when target is reached.
      shouldFlip = target > 0 && sessionMatches.length >= target;
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
      // Fire-and-forget — failure here doesn't block the end screen.
      if (session?.user?.id && guestSessionId) {
        supabase
          .from("session_participants")
          .update({ submitted_at: new Date().toISOString() })
          .eq("session_id", guestSessionId)
          .eq("user_id", session.user.id)
          .then(({ error }) => {
            if (error) console.error("Failed to set submitted_at:", error);
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
    session?.user?.id,
    guestSessionId,
  ]);

 useEffect(() => {
    if (openNow) setSelectedTimes([]);
  }, [openNow]);

  // When match mode changes:
  //  - Snap timeLimitMinutes to a sensible default for the new mode
  //    ("Right now" is short, "Later" is generous; user can override).
  //  - Reset openNow to false. The When? toggle is hidden in multi modes
  //    (Right Now = going now so "open now" is implicit; Later = going at
  //    a future time so "open now" is irrelevant). Hidden state could
  //    still leak through if it was true from a prior solo session, so
  //    force-reset on mode change.
  useEffect(() => {
    if (matchMode === "concurrent") {
      setTimeLimitMinutes(10);
      setOpenNow(false);
    } else if (matchMode === "curated") {
      setTimeLimitMinutes(60 * 24);
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

  useEffect(() => {
    if (!session?.user?.id) {
      setProfile(null);
      return;
    }
    let cancelled = false;
    supabase
      .from("profiles")
      .select("id, display_name, username, tier")
      .eq("id", session.user.id)
      .single()
      .then(({ data, error }) => {
        if (!cancelled && !error) setProfile(data);
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
  // the drawer closes — closing means the user just acted on (or saw) the
  // items, so the count should re-sync.
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

      if (cancelled) return;
      setUnreadCount((reqRes.count ?? 0) + submittedCount + decidedCount);
    })();
    return () => {
      cancelled = true;
    };
  }, [session?.user?.id, showDrawer]);

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

  async function handleJoinSession() {
    const name = guestName.trim();
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

      // Sync the typed name to profile.display_name for anonymous users so
      // their Profile tab shows the real name instead of the "New user"
      // default created by the handle_new_user trigger. Skipped for
      // returning signed-in users (we don't want to clobber their existing
      // display name).
      const isAnon =
        justSignedInAnon || session?.user?.is_anonymous === true;
      if (isAnon) {
        supabase
          .from("profiles")
          .update({ display_name: name })
          .eq("id", userId)
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

  function handleNotForMe() {
    // Send them to the root — they can sign in and start their own session
    // if they want, or just close the tab.
    window.location.assign("/");
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
      const { error } = await supabase.auth.updateUser(
        { email },
        {
          emailRedirectTo: window.location.href,
          captchaToken: guestSignupCaptchaToken,
        }
      );
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
      setGuestSignupError("Couldn't send the link. Try again.");
    } finally {
      setGuestSigningUp(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
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
      ...Array.from(new Set(availableVenues.map((venue) => venue.cuisine)))
        .filter(Boolean)
        .sort(),
    ];
  }, [venues, selectedAreas, radiusKm]);

  const availableTimes = useMemo(() => {
    const todayKey = getTodayDayKey();
    const candidates = venues.filter((venue) => {
      if (!venueMatchesAreas(venue, selectedAreas, radiusKm)) return false;
      if (
        selectedCuisines.length > 0 &&
        !selectedCuisines.includes(venue.cuisine)
      )
        return false;
      if (openNow && !isVenueOpenNow(venue)) return false;
      if (selectedVibes.length > 0) {
        if (!selectedVibes.some((vibe) => venueMatchesVibe(venue, vibe, todayKey)))
          return false;
      }
      return true;
    });
    const computed = TIME_BANDS.filter((band) =>
      candidates.some((v) => venueOpenInBand(v, todayKey, band))
    ).map((b) => b.key);
    return Array.from(new Set([...computed, ...selectedTimes]));
  }, [
    venues,
    selectedAreas,
    radiusKm,
    selectedCuisines,
    openNow,
    selectedVibes,
    selectedTimes,
  ]);

  const availableVibes = useMemo(() => {
    const todayKey = getTodayDayKey();
    const candidates = venues.filter((venue) => {
      if (!venueMatchesAreas(venue, selectedAreas, radiusKm)) return false;
      if (
        selectedCuisines.length > 0 &&
        !selectedCuisines.includes(venue.cuisine)
      )
        return false;
      if (openNow && !isVenueOpenNow(venue)) return false;
      if (selectedTimes.length > 0) {
        const anyBandMatches = selectedTimes.some((label) => {
          const band = TIME_BANDS.find((b) => b.key === label);
          return band && venueOpenInBand(venue, todayKey, band);
        });
        if (!anyBandMatches) return false;
      }
      return true;
    });
    const computed = VIBE_OPTIONS.filter((vibe) =>
      candidates.some((v) => venueMatchesVibe(v, vibe, todayKey))
    );
    return Array.from(new Set([...computed, ...selectedVibes]));
  }, [
    venues,
    selectedAreas,
    radiusKm,
    selectedCuisines,
    openNow,
    selectedTimes,
    selectedVibes,
  ]);

  useEffect(() => {
    setSelectedCuisines((currentSelected) =>
      currentSelected.filter((cuisine) => cuisines.includes(cuisine))
    );
  }, [cuisines]);
 
  const filteredVenues = useMemo(() => {
    const todayKey = getTodayDayKey();
    return venues.filter((venue) => {
      if (hiddenVenueIds.has(venue.id)) return false;
      const matchesArea = venueMatchesAreas(venue, selectedAreas, radiusKm);
      if (!matchesArea) return false;
 
      const matchesCuisine =
        selectedCuisines.length === 0 ||
        selectedCuisines.includes(venue.cuisine);
      if (!matchesCuisine) return false;
 
      if (openNow && !isVenueOpenNow(venue)) return false;
 
      if (selectedTimes.length > 0) {
        const anyBandMatches = selectedTimes.some((label) => {
          const band = TIME_BANDS.find((b) => b.key === label);
          return band && venueOpenInBand(venue, todayKey, band);
        });
        if (!anyBandMatches) return false;
      }
 
      if (selectedVibes.length > 0) {
        const anyVibeMatches = selectedVibes.some((vibe) =>
          venueMatchesVibe(venue, vibe, todayKey)
        );
        if (!anyVibeMatches) return false;
      }
 
      return true;
    });
  }, [
    venues,
    selectedAreas,
    radiusKm,
    selectedCuisines,
    openNow,
    selectedTimes,
    selectedVibes,
    hiddenVenueIds,
  ]);
 
  const currentUserSwipedIds =
    currentUser === "mark"
      ? [...markLikes, ...markPasses]
      : [...partnerLikes, ...partnerPasses];
 
  const swipeQueue = useMemo(() => {
    if (matchSource === "my_list") {
      return filteredVenues.filter((v) => savedVenueIds.has(v.id));
    }
    if (matchMode === "solo") {
      return filteredVenues.filter((v) => !savedVenueIds.has(v.id));
    }
    return filteredVenues;
  }, [filteredVenues, matchSource, matchMode, savedVenueIds]);

  const guestQueue = useMemo(() => {
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
    const sessionRadius = typeof filters.radiusKm === "number" ? filters.radiusKm : 5;

    return pool.filter((venue) => {
      if (!venueMatchesAreas(venue, sessionAreas, sessionRadius)) return false;

      if (filters.selectedCuisines && filters.selectedCuisines.length > 0) {
        if (!filters.selectedCuisines.includes(venue.cuisine)) return false;
      }

      if (filters.openNow && !isVenueOpenNow(venue)) return false;

      if (filters.selectedTimes && filters.selectedTimes.length > 0) {
        const anyBand = filters.selectedTimes.some((label) => {
          const band = TIME_BANDS.find((b) => b.key === label);
          return band && venueOpenInBand(venue, todayKey, band);
        });
        if (!anyBand) return false;
      }

      if (filters.selectedVibes && filters.selectedVibes.length > 0) {
        const anyVibe = filters.selectedVibes.some((vibe) =>
          venueMatchesVibe(venue, vibe, todayKey)
        );
        if (!anyVibe) return false;
      }

      return true;
    });
  }, [isGuest, guestSessionData, venues, areas, guestShortlistIds, guestShortlistVenues, guestListVenues]);

  const currentVenue = swipeQueue.find(
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
 
  async function startSwiping() {
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
      // expires_at is computed from the time-limit selector (mode default
      // applied on mode-change useEffect; user can override on Filters).
      const expiresAt = new Date();
      expiresAt.setMinutes(
        expiresAt.getMinutes() + (timeLimitMinutes || 60 * 24)
      );

      const sessionFilters = {
        selectedAreaIds: selectedAreas.map((a) => a.id),
        radiusKm,
        openNow,
        selectedTimes,
        selectedVibes,
        selectedCuisines,
      };

      const sessionName = eventDate
        ? eventDate.toLocaleDateString("en-AU", {
            weekday: "long",
            day: "numeric",
            month: "short",
          })
        : matchMode === "curated"
        ? "Send options"
        : "Right now";

      const { data, error } = await supabase
        .from("match_sessions")
        .insert({
          host_user_id: session.user.id,
          mode: matchMode,
          source_type: matchSource === "my_list" ? "list" : "filters",
          filters: sessionFilters,
          list_id: null,
          target_matches: matchMode === "curated" ? null : matchLimit || null,
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

    // Format the event timing.
    let whenLabel = "Right now";
    if (guestSessionData.mode === "curated" && guestSessionData.event_at) {
      try {
        const eventDate = new Date(guestSessionData.event_at);
        whenLabel = new Intl.DateTimeFormat(undefined, {
          weekday: "long",
          day: "numeric",
          month: "long",
        }).format(eventDate);
      } catch {
        whenLabel = "Later";
      }
    } else if (guestSessionData.mode === "curated") {
      whenLabel = "Later";
    }

    const isClosed = guestSessionData.status === "closed";
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
                <p className="text-xs text-neutral-500 truncate">
                  {guestSessionData.name || "Session"}
                  {guestQueue.length > 0 ? ` · ${guestQueue.length} places` : ""}
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
                  <p className="mt-1 text-xs text-[#455d3b]">
                    {hostName} picked the place — see you there!
                  </p>
                </div>
              )}
              <div className="text-center">
                <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-[#edf2eb] text-[#455d3b]">
                  <Check size={28} />
                </div>
                <h1 className="text-2xl font-semibold tracking-tight">
                  Sent to {hostName}
                </h1>
                <p className="mt-3 text-sm text-neutral-600">
                  Your picks are in. {hostName} will choose from everyone's
                  options and let you know where you're going.
                </p>
                <p className="mt-4 text-xs text-neutral-500">
                  You picked {guestLikes.length} place{guestLikes.length === 1 ? "" : "s"}.
                </p>
              </div>

              {stillAnon ? (
                <div className="mt-6 rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
                  {!guestSignupSent ? (
                    <>
                      <h2 className="text-lg font-semibold tracking-tight">
                        Want to know the plan?
                      </h2>
                      <p className="mt-2 text-sm text-neutral-600">
                        Create an account and we'll let you know where {hostName} lands — your picks and saved places stay with you.
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
                            options={{ theme: "light" }}
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
                          {guestSigningUp ? "Sending..." : "Create account"}
                        </button>
                        {guestSignupError && (
                          <p className="text-sm text-red-600">{guestSignupError}</p>
                        )}
                      </form>
                    </>
                  ) : (
                    <>
                      <h2 className="text-lg font-semibold tracking-tight">
                        Check your email
                      </h2>
                      <p className="mt-2 text-sm text-neutral-600">
                        We sent a link to <span className="font-medium">{guestSignupEmail}</span>. Click it to finish creating your account.
                      </p>
                      <p className="mt-3 text-xs text-neutral-500">
                        Keep this tab open — you'll be signed in automatically once you confirm.
                      </p>
                    </>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => goToMainApp("map")}
                  className="mt-6 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md"
                >
                  Explore the app
                </button>
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

      // ---------- Sign-up gate (anonymous users) ----------
      if (showGate) {
        return (
          <div className="min-h-screen bg-[#fdf6f0] text-[#111111] p-4">
            <div className="w-full max-w-sm mx-auto pt-10 pb-20">
              <div className="text-center mb-6">
                <p className="text-sm text-neutral-500">
                  Game over, {guestName.trim() || "friend"}
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                  You matched on {matchCount} place{matchCount === 1 ? "" : "s"}
                </h1>
              </div>
              <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
                {!guestSignupSent ? (
                  <>
                    <h2 className="text-lg font-semibold tracking-tight">
                      Sign up to see them
                    </h2>
                    <p className="mt-2 text-sm text-neutral-600">
                      We'll send a link to your email. Click it and your matches will appear here.
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
                          options={{ theme: "light" }}
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
                        {guestSigningUp ? "Sending..." : "Sign up to see matches"}
                      </button>
                      {guestSignupError && (
                        <p className="text-sm text-red-600">{guestSignupError}</p>
                      )}
                    </form>
                  </>
                ) : (
                  <>
                    <h2 className="text-lg font-semibold tracking-tight">
                      Check your email
                    </h2>
                    <p className="mt-2 text-sm text-neutral-600">
                      We sent a link to <span className="font-medium">{guestSignupEmail}</span>. Click it and your matches will show up here.
                    </p>
                    <p className="mt-3 text-xs text-neutral-500">
                      Keep this tab open — your matches will reveal automatically once you confirm.
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

      // ---------- Revealed view (signed-in or dev-overridden) ----------
      return (
        <div className="fixed inset-0 bg-[#fdf6f0] text-[#111111] flex flex-col pb-16">
          <div className="bg-white border-b border-neutral-100 px-4 py-5 text-center">
            <p className="text-sm text-neutral-500">
              Game over, {guestName.trim() || "friend"}
            </p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {matchCount === 0
                ? "No mutual matches"
                : `You matched on ${matchCount} place${matchCount === 1 ? "" : "s"}`}
            </h1>
          </div>
          {/* Add-host-as-friend CTA — high-intent moment, hides itself if
              already friends or pending in either direction. */}
          <AddHostFriendCard
            hostUserId={guestSessionData?.host_user_id}
            hostName={hostName}
            viewerUserId={session?.user?.id}
            showToast={showToast}
          />
          <SessionResultsView
            participants={sessionParticipants}
            sessionId={guestSessionId}
            sessionMatches={sessionMatches}
            myLikedIds={guestLikes}
            venues={venues}
            userId={session?.user?.id}
            hostUserId={guestSessionData?.host_user_id}
            savedIds={savedVenueIds}
            onSave={saveVenue}
            onUnsave={unsaveVenue}
            onHide={hideVenue}
            onOpenProfile={(uid) => setLookupUserId(uid)}
            showConfetti={matchCount > 0}
            showToast={showToast}
          />
          <BottomTabBar tab={null} setTab={goToMainApp} />
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="text-center">
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">
              {hostName} wants to pick dinner with you
            </h1>
          </div>

          <div className="mt-6 rounded-2xl bg-white shadow-sm border border-neutral-100 p-5">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-neutral-500">
              {guestSessionData.mode === "concurrent" ? (
                <>
                  <Zap size={14} />
                  Right now
                </>
              ) : (
                <>
                  <Calendar size={14} />
                  Later
                </>
              )}
            </div>
            <div className="mt-2 text-lg font-medium">
              {guestSessionData.name || whenLabel}
            </div>
            {guestSessionData.name && whenLabel !== guestSessionData.name && (
              <div className="text-sm text-neutral-500 mt-0.5">{whenLabel}</div>
            )}

            {isOpen && (
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
              <p className="mt-4 text-sm text-neutral-600">
                This session has ended.
              </p>
            )}
          </div>

          {isOpen && (
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
                className="mt-2 w-full rounded-2xl bg-white border border-neutral-200 px-4 py-3 text-sm focus:border-neutral-400 focus:outline-none"
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
                    options={{ theme: "light" }}
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
                className="mt-3 w-full rounded-full bg-[#111111] px-5 py-3 text-sm font-medium text-white disabled:opacity-40"
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

  if (loading) {
    return (
      <div className="min-h-screen bg-[#fdf6f0] text-[#111111] flex items-center justify-center p-4">
        Loading venues...
      </div>
    );
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
              <AreaFilter
                areaSearch={areaSearch}
                setAreaSearch={setAreaSearch}
                selectedAreas={selectedAreas}
                setSelectedAreas={setSelectedAreas}
                radiusKm={radiusKm}
                setRadiusKm={setRadiusKm}
                showAreaDropdown={showAreaDropdown}
                setShowAreaDropdown={setShowAreaDropdown}
                areas={areas}
                areasLoading={areasLoading}
                expandedRegions={expandedRegions}
                setExpandedRegions={setExpandedRegions}
              />
              {/* Solo only — in multi modes "open now" is either implicit
                  (Right Now) or irrelevant (Later). */}
              {matchMode === "solo" && (
                <OpenNowToggle openNow={openNow} setOpenNow={setOpenNow} />
              )}
            {!openNow && availableTimes.length > 0 && (
                <MultiSelectChips
                  label="Time of day"
                  options={availableTimes}
                  selected={selectedTimes}
                  setSelected={setSelectedTimes}
                />
              )}
              {availableVibes.length > 0 && (
                <MultiSelectChips
                  label="Vibe"
                  options={availableVibes}
                  selected={selectedVibes}
                  setSelected={setSelectedVibes}
                />
              )}
              <MultiSelectChips
                label="Cuisine"
                options={cuisines.filter((item) => item !== ALL)}
                selected={selectedCuisines}
                setSelected={setSelectedCuisines}
              />
              {/* "How many matches?" is a stop-after-N target — only
                  meaningful for Right Now (concurrent). Send options
                  (curated) curates the whole shortlist, so no target. */}
              {matchMode !== "curated" && (
                <MatchLimitField value={matchLimit} onChange={setMatchLimit} />
              )}

              {/* Multi-mode-only fields. Solo doesn't need participants or
                  a session time limit. */}
              {(matchMode === "concurrent" || matchMode === "curated") && (
                <>
                  <ParticipantsField
                    value={participants}
                    onChange={setParticipants}
                  />
                  <TimeLimitField
                    value={timeLimitMinutes}
                    onChange={setTimeLimitMinutes}
                    options={
                      matchMode === "concurrent"
                        ? TIME_LIMIT_OPTIONS_CONCURRENT
                        : TIME_LIMIT_OPTIONS_CURATED
                    }
                  />
                </>
              )}

              <div className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600">
                {swipeQueue.length} places available with these filters.
              </div>
              <button
                onClick={startSwiping}
                disabled={!swipeQueue.length}
                className="w-full rounded-2xl bg-[#455d3b] py-4 font-medium text-white disabled:bg-neutral-300"
              >
                Start swiping
              </button>            
            </div>
          </div>
        )}
        {screen === "invite_share" && (
          <InviteShareScreen
            sessionId={currentSessionId}
            mode={matchMode}
            matchCount={sessionMatches.length}
            target={matchLimit}
            onBack={() => setScreen("filters")}
            onContinue={() => setScreen(matchMode === "curated" ? "curated_results" : "swipe")}
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
                <VenueCard venue={currentVenue} />
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
              <EmptyState
                title="No more places"
                text="You've reached the end of this list."
                action={() => setScreen("matches")}
                actionText="View matches"
              />
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
          venues={filteredVenues}
          savedIds={savedVenueIds}
          onSave={saveVenue}
          onUnsave={unsaveVenue}
          onHide={hideVenue}
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
          onOpenProfile={(uid) => setLookupUserId(uid)}
          onFindFriends={() => setShowFindFriends(true)}
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
        />
      )}
      {session?.user?.id && (
        <BellButton
          unreadCount={unreadCount}
          onClick={() => setShowDrawer(true)}
        />
      )}
      {showDrawer && (
        <ActivityDrawer
          userId={session?.user?.id}
          onClose={() => setShowDrawer(false)}
          onOpenProfile={(uid) => {
            setShowDrawer(false);
            setLookupUserId(uid);
          }}
          onOpenSession={(sid) => {
            setShowDrawer(false);
            setNotifSessionId(sid);
          }}
          showToast={showToast}
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
        />
      )}
      <FloatingActionButton
        tab={tab}
        showToast={showToast}
        onAddFriend={() => setShowFindFriends(true)}
        onImportMap={() => setShowImport(true)}
      />
      <Toast message={toastMessage} onDismiss={() => setToastMessage(null)} />
      <BottomTabBar
        tab={tab}
        setTab={(t) => {
          setNotifSessionId(null);
          setTab(t);
        }}
      />
    </div>
  );
}

function venueMatchesAreas(venue, selectedAreas, radiusKm) {
  if (!selectedAreas || selectedAreas.length === 0) return true;
  const lat = Number(venue.latitude);
  const lng = Number(venue.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  return selectedAreas.some(
    (area) => getDistanceKm(area.lat, area.lng, lat, lng) <= radiusKm
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
 
function getTodayDayKey() {
  return DAY_KEYS[new Date().getDay()];
}
 
function getYesterdayDayKey() {
  return DAY_KEYS[(new Date().getDay() + 6) % 7];
}
 
function timeStringToMinutes(value) {
  if (!value) return NaN;
  const trimmed = String(value).trim();
  const [h, m] = trimmed.split(":").map((part) => Number(part));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return NaN;
  return h * 60 + m;
}
 
function expandRange(start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  if (end > start) return [{ start, end }];
  if (end === start) return [];
  return [
    { start, end: 1440 },
    { start: 0, end },
  ];
}
 
function venueDayIntervals(venue, dayKey) {
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
 
function intervalsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}
 
function venueOpenInBand(venue, dayKey, band) {
  const venueIntervals = venueDayIntervals(venue, dayKey);
  if (venueIntervals.length === 0) return false;
  const bandIntervals = expandRange(band.start, band.end);
  return venueIntervals.some((vi) =>
    bandIntervals.some((bi) => intervalsOverlap(vi, bi))
  );
}
 
function isVenueOpenNow(venue) {
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
 
function venueMatchesVibe(venue, vibe, dayKey) {
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
 
function OpenNowToggle({ openNow, setOpenNow }) {
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">When?</span>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => setOpenNow(false)}
          className={`rounded-2xl py-3 font-medium transition ${
            !openNow
              ? "bg-[#455d3b] text-white"
              : "bg-neutral-50 text-neutral-700 border border-neutral-100"
          }`}
        >
          Any time
        </button>
        <button
          type="button"
          onClick={() => setOpenNow(true)}
          className={`rounded-2xl py-3 font-medium transition ${
            openNow
              ? "bg-[#455d3b] text-white"
              : "bg-neutral-50 text-neutral-700 border border-neutral-100"
          }`}
        >
          Open now
        </button>
      </div>
    </div>
  );
}
 
function AreaCheckbox({ state }) {
  return (
    <span
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${
        state === "all"
          ? "border-[#455d3b] bg-[#455d3b]"
          : state === "some"
          ? "border-[#455d3b] bg-white"
          : "border-neutral-300 bg-white"
      }`}
    >
      {state === "all" && (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M2 6L5 9L10 3"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {state === "some" && <span className="block h-0.5 w-2.5 bg-[#455d3b]" />}
    </span>
  );
}
 
function AreaFilter({
  areaSearch,
  setAreaSearch,
  selectedAreas,
  setSelectedAreas,
  radiusKm,
  setRadiusKm,
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
 
  function toggleRegion(items) {
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
    }
  }
 
  function getRegionState(items) {
    const selectedCount = items.filter((a) => selectedIds.has(a.id)).length;
    if (selectedCount === 0) return "none";
    if (selectedCount === items.length) return "all";
    return "some";
  }
 
  function toggleExpand(region) {
    setExpandedRegions((prev) => {
      const next = new Set(prev);
      if (next.has(region)) next.delete(region);
      else next.add(region);
      return next;
    });
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
        <div className="mt-3 max-h-80 overflow-y-auto rounded-2xl bg-white border border-neutral-100 shadow-sm">
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
                    className="border-b border-neutral-100 last:border-b-0"
                  >
                    <div className="flex items-stretch">
                      <button
                        type="button"
                        onClick={() => toggleRegion(items)}
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
 
function MatchLimitField({ value, onChange }) {
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">
        How many matches?
      </span>
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

function ParticipantsField({ value, onChange }) {
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">
        How many of us?
      </span>
      <div className="grid gap-2 grid-cols-3">
        {PARTICIPANT_OPTIONS.map((option) => (
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

function TimeLimitField({ value, onChange, options }) {
  // Both option sets are length 4 — keep them that length, or update the
  // grid class here if the design ever needs a different count.
  return (
    <div>
      <span className="mb-2 block text-sm font-medium text-neutral-700">
        Time limit
      </span>
      <div className="grid gap-2 grid-cols-4">
        {options.map((option) => (
          <button
            key={option.minutes}
            type="button"
            onClick={() => onChange(option.minutes)}
            className={`rounded-2xl py-3 text-sm font-medium transition ${
              value === option.minutes
                ? "bg-[#455d3b] text-white"
                : "bg-neutral-50 text-neutral-700 border border-neutral-100"
            }`}
          >
            {option.label}
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
 
function VenueVibes({ venue }) {
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

function MapVenueSheet({ venue, onClose, savedIds, onSave, onUnsave, onHide }) {
  const [mapMenuOpen, setMapMenuOpen] = useState(false);
  return (
    <div
      className="absolute left-0 right-0 mx-auto max-w-sm bg-white rounded-3xl border border-neutral-100 shadow-2xl flex flex-col"
      style={{
        bottom: 80,
        width: "calc(100% - 1.5rem)",
        maxHeight: "calc(100% - 100px)",
        zIndex: 2500,
      }}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between bg-white px-4 py-3 border-b border-neutral-100 rounded-t-3xl">
        <span className="text-sm font-semibold text-neutral-800 truncate pr-2">
          {venue.name}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-neutral-500 hover:bg-neutral-100"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <VenueHeroCarousel venue={venue} />
        <p className="text-sm leading-6 text-neutral-500">{venue.address}</p>
        <VenueRating venue={venue} />
        <VenueVibes venue={venue} />
        <OpeningHours venue={venue} />
        <OpenMapsButton url={getMapsUrl(venue)} />
      </div>

      <div className="p-4 pt-3 border-t border-neutral-100 bg-white rounded-b-3xl">
        <div className="flex gap-2 relative">
          <button
            type="button"
            onClick={() => setMapMenuOpen(true)}
            aria-label="More options"
            className="rounded-2xl bg-white border border-neutral-200 px-4 py-3 text-neutral-500 active:scale-[0.98] transition flex items-center justify-center"
          >
            <MoreVertical size={18} />
          </button>
          {savedIds && savedIds.has(venue.id) ? (
            <button
              type="button"
              onClick={() => onUnsave(venue.id)}
              className="flex-1 rounded-2xl bg-[#edf2eb] py-3 font-medium text-[#455d3b] border border-[#c5d4c2]"
            >
              Remove from list
            </button>
          ) : (
            <button
              type="button"
              onClick={() => onSave(venue.id)}
              className="flex-1 rounded-2xl bg-[#455d3b] py-3 font-medium text-white"
            >
              Add to list
            </button>
          )}
          {mapMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-[3400]"
                onClick={() => setMapMenuOpen(false)}
              />
              <div className="absolute bottom-full left-0 mb-2 bg-white border border-neutral-200 rounded-xl shadow-lg z-[3500] overflow-hidden">
                <button
                  type="button"
                  onClick={() => {
                    onHide(venue.id);
                    setMapMenuOpen(false);
                    onClose();
                  }}
                  className="block px-5 py-3 text-red-700 font-medium hover:bg-neutral-50 whitespace-nowrap text-left"
                >
                  Don't show this again
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// FAB rendered above the BottomTabBar on Profile and Map tabs. Tap to expand
// a tap-to-pick menu of add actions; per-tab option list. Find Friends is
// the only target wired in D.1 (via onAddFriend); the other actions are stubs
// that fire a "Coming soon" toast until #17 / #21 ship.
function FloatingActionButton({ tab, showToast, onAddFriend, onImportMap }) {
  const [open, setOpen] = useState(false);

  // Don't render outside Profile + Map tabs.
  if (tab !== "profile" && tab !== "map") return null;

  const profileOptions = [
    {
      key: "add_friend",
      icon: <UserPlus size={16} />,
      label: "Add friend",
      action: () => {
        setOpen(false);
        onAddFriend();
      },
    },
    {
      key: "add_venue",
      icon: <MapPin size={16} />,
      label: "Add a venue",
      action: () => {
        setOpen(false);
        showToast("Add a venue — coming soon");
      },
    },
    {
      key: "import_map",
      icon: <Upload size={16} />,
      label: "Import a map",
      action: () => {
        setOpen(false);
        onImportMap();
      },
    },
  ];

  const mapOptions = profileOptions.filter((o) => o.key !== "add_friend");
  const options = tab === "profile" ? profileOptions : mapOptions;

  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close add menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[3050] bg-black/25"
        />
      )}
      {open && (
        <div className="fixed bottom-[136px] right-4 z-[3060] flex flex-col items-end gap-2">
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={opt.action}
              className="flex items-center gap-2 bg-white border border-neutral-200 rounded-full pl-3 pr-4 py-2 text-sm font-medium shadow-sm active:scale-95 transition"
            >
              <span className="text-neutral-600">{opt.icon}</span>
              <span>{opt.label}</span>
              {opt.soon && (
                <span className="text-[10px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5 font-medium ml-1">
                  soon
                </span>
              )}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        aria-label={open ? "Close add menu" : "Open add menu"}
        onClick={() => setOpen((v) => !v)}
        className={`fixed bottom-20 right-4 z-[3060] w-12 h-12 rounded-full flex items-center justify-center shadow-md active:scale-95 transition ${
          open ? "bg-neutral-900 text-white" : "bg-[#455d3b] text-white"
        }`}
      >
        {open ? <X size={20} /> : <Plus size={20} />}
      </button>
    </>
  );
}

// Bell button anchored top-right. z-[2950] sits above tab content but below
// full-screen sub-screens (z-[3500]+) and below BottomTabBar at z-[3000] —
// since the bell is at the top of the viewport and the tab bar at the bottom
// they don't overlap geometrically, so the order doesn't matter visually.
function BellButton({ unreadCount, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={
        unreadCount > 0 ? `${unreadCount} unread notifications` : "Notifications"
      }
      className="fixed top-4 right-4 z-[2950] w-10 h-10 rounded-full bg-white border border-neutral-200 shadow-sm flex items-center justify-center text-neutral-700 hover:bg-neutral-50 active:scale-95 transition"
    >
      <Bell size={18} />
      {unreadCount > 0 && (
        <span className="absolute top-0.5 right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-600 text-white text-[10px] font-medium flex items-center justify-center border-2 border-white">
          {unreadCount > 9 ? "9+" : unreadCount}
        </span>
      )}
    </button>
  );
}

// Activity drawer — slides in from the right (~78% width). Items are derived
// on the fly from existing tables (no `notifications` table yet — that's D.5).
// Two derivation sources for D.1:
//   - friendships pending (you're addressee) → "X sent you a friend request"
//     with inline Accept/Decline
//   - friendships accepted (you're requester, responded_at set) → "X accepted
//     your friend request" — informational
// NEW vs EARLIER split via a localStorage timestamp: `flanit_drawer_last_seen`.
// Items with their relevant timestamp after last_seen are NEW. Updated when
// the drawer closes.
function ActivityDrawer({ userId, onClose, onOpenProfile, onOpenSession, showToast }) {
  const [items, setItems] = useState(null); // null = loading
  const [acting, setActing] = useState(null); // friendship.id mid-update
  const [lastSeen] = useState(() => {
    const stored = localStorage.getItem("flanit_drawer_last_seen");
    return stored ? new Date(stored) : new Date(0);
  });

  async function load() {
    if (!userId) return;
    const [incomingRes, acceptedRes, hostedRes, myPartsRes] = await Promise.all([
      // Pending requests where I'm addressee — actionable items.
      supabase
        .from("friendships")
        .select("id, requester_id, created_at, status")
        .eq("addressee_id", userId)
        .eq("status", "pending")
        .order("created_at", { ascending: false }),
      // Accepted requests where I'm requester, recently — they accepted me.
      supabase
        .from("friendships")
        .select("id, addressee_id, responded_at, status")
        .eq("requester_id", userId)
        .eq("status", "accepted")
        .not("responded_at", "is", null)
        .order("responded_at", { ascending: false })
        .limit(20),
      // Sessions I host — to surface guests who've submitted their picks.
      supabase
        .from("match_sessions")
        .select("id, name")
        .eq("host_user_id", userId),
      // Sessions I'm in — to surface a host's final decision.
      supabase
        .from("session_participants")
        .select("session_id")
        .eq("user_id", userId),
    ]);

    const incomingRows = incomingRes.data || [];
    const acceptedRows = acceptedRes.data || [];

    // Hydrate profiles for every referenced other-party user_id.
    const otherIds = new Set();
    incomingRows.forEach((r) => otherIds.add(r.requester_id));
    acceptedRows.forEach((r) => otherIds.add(r.addressee_id));

    let profilesById = {};
    if (otherIds.size > 0) {
      const { data: profileRows } = await supabase
        .from("profiles")
        .select("id, display_name, username")
        .in("id", Array.from(otherIds));
      profilesById = Object.fromEntries(
        (profileRows || []).map((p) => [p.id, p])
      );
    }

    // Shape into a flat sortable list of activity items.
    const incomingItems = incomingRows.map((r) => ({
      kind: "request_received",
      id: `req_${r.id}`,
      friendshipId: r.id,
      otherId: r.requester_id,
      profile: profilesById[r.requester_id] || null,
      timestamp: r.created_at,
    }));
    const acceptedItems = acceptedRows.map((r) => ({
      kind: "request_accepted",
      id: `acc_${r.id}`,
      otherId: r.addressee_id,
      profile: profilesById[r.addressee_id] || null,
      timestamp: r.responded_at,
    }));

    // ---- Host: guests who submitted their picks on sessions I host ----
    const hostedRows = hostedRes.data || [];
    const hostedNameById = Object.fromEntries(
      hostedRows.map((s) => [s.id, s.name])
    );
    let submittedItems = [];
    if (hostedRows.length > 0) {
      const { data: subRows } = await supabase
        .from("session_participants")
        .select("session_id, user_id, display_name, submitted_at")
        .in("session_id", hostedRows.map((s) => s.id))
        .neq("user_id", userId)
        .not("submitted_at", "is", null)
        .order("submitted_at", { ascending: false })
        .limit(30);
      submittedItems = (subRows || []).map((r) => ({
        kind: "session_submitted",
        id: `sub_${r.session_id}_${r.user_id}`,
        sessionId: r.session_id,
        guestName: r.display_name || "A guest",
        sessionName: hostedNameById[r.session_id] || "your session",
        timestamp: r.submitted_at,
      }));
    }

    // ---- Guest: a host's final pick on a session I'm in (not hosting) ----
    const myPartRows = myPartsRes.data || [];
    let decidedItems = [];
    if (myPartRows.length > 0) {
      const { data: decidedRows } = await supabase
        .from("match_sessions")
        .select("id, name, host_user_id, decided_venue_id, updated_at")
        .in("id", myPartRows.map((p) => p.session_id))
        .not("decided_venue_id", "is", null)
        .neq("host_user_id", userId);
      // Resolve venue names via the shortlist RPC (bypasses venues RLS so
      // host-imported decided venues still show their name).
      decidedItems = await Promise.all(
        (decidedRows || []).map(async (s) => {
          let venueName = "a spot";
          const { data: vts } = await supabase.rpc(
            "get_session_shortlist_venues",
            { p_session_id: s.id }
          );
          const v = (vts || []).find((x) => x.id === s.decided_venue_id);
          if (v?.name) venueName = v.name;
          return {
            kind: "session_decided",
            id: `dec_${s.id}`,
            sessionId: s.id,
            venueName,
            sessionName: s.name || "your session",
            timestamp: s.updated_at,
          };
        })
      );
    }

    const all = [
      ...incomingItems,
      ...acceptedItems,
      ...submittedItems,
      ...decidedItems,
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    setItems(all);
  }

  useEffect(() => {
    load();
    // Stamp the timestamp on close, not open — closing means "you've seen it."
    return () => {
      localStorage.setItem(
        "flanit_drawer_last_seen",
        new Date().toISOString()
      );
    };
    // load only depends on userId.
  }, [userId]);

  async function setStatus(friendshipId, newStatus) {
    setActing(friendshipId);
    const { error } = await supabase
      .from("friendships")
      .update({ status: newStatus })
      .eq("id", friendshipId);
    setActing(null);
    if (error) {
      console.error("Drawer action failed:", error);
      showToast?.("Couldn't update");
      return;
    }
    await load();
  }

  const newItems = (items || []).filter(
    (i) => new Date(i.timestamp) > lastSeen
  );
  const earlierItems = (items || []).filter(
    (i) => new Date(i.timestamp) <= lastSeen
  );

  return (
    <>
      {/* Scrim covers everything; click closes. */}
      <button
        type="button"
        aria-label="Close notifications"
        onClick={onClose}
        className="fixed inset-0 z-[3490] bg-black/25"
      />
      {/* Drawer panel — ~78% width, full height, slides from the right. */}
      <div className="fixed top-0 right-0 bottom-0 z-[3500] w-[78%] max-w-sm bg-[#fdf6f0] overflow-y-auto shadow-xl">
        <div className="p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-8 h-8 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-100"
            >
              <X size={18} />
            </button>
          </div>

          {items === null && (
            <p className="text-sm text-neutral-500 text-center py-8">Loading…</p>
          )}

          {items !== null && items.length === 0 && (
            <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 text-center">
              <p className="text-sm text-neutral-600">
                Nothing here yet.
              </p>
              <p className="text-xs text-neutral-500 mt-1">
                Friend requests and accepted connections will show up here.
              </p>
            </div>
          )}

          {newItems.length > 0 && (
            <>
              <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2 px-1">
                New
              </p>
              <div className="space-y-2 mb-4">
                {newItems.map((item) => (
                  <ActivityItem
                    key={item.id}
                    item={item}
                    isNew
                    acting={acting === item.friendshipId}
                    onAccept={() => setStatus(item.friendshipId, "accepted")}
                    onDecline={() => setStatus(item.friendshipId, "declined")}
                    onOpenProfile={onOpenProfile}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </div>
            </>
          )}

          {earlierItems.length > 0 && (
            <>
              <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2 px-1">
                Earlier
              </p>
              <div className="space-y-2">
                {earlierItems.map((item) => (
                  <ActivityItem
                    key={item.id}
                    item={item}
                    acting={acting === item.friendshipId}
                    onAccept={() => setStatus(item.friendshipId, "accepted")}
                    onDecline={() => setStatus(item.friendshipId, "declined")}
                    onOpenProfile={onOpenProfile}
                    onOpenSession={onOpenSession}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

// Single drawer item row. Visually distinguishes NEW with a soft green tinted
// background. Friend-request items get inline Accept/Decline; accepted-back
// items are informational.
function ActivityItem({ item, isNew, acting, onAccept, onDecline, onOpenProfile, onOpenSession }) {
  const name = item.profile?.display_name || "Someone";
  const handle = item.profile?.username ? `@${item.profile.username}` : "";
  const bg = isNew ? "bg-[#455d3b]/8" : "bg-white";

  if (item.kind === "request_received") {
    return (
      <div className={`rounded-2xl ${bg} border border-neutral-100 p-3`}>
        <button
          type="button"
          onClick={() => onOpenProfile?.(item.otherId)}
          className="w-full flex items-center gap-3 text-left mb-3"
        >
          <FriendAvatar profile={item.profile} small />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-neutral-900">
              <strong className="font-medium">{name}</strong> sent you a friend request
            </p>
            {handle && (
              <p className="text-[11px] text-neutral-500 truncate">{handle}</p>
            )}
          </div>
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={acting}
            onClick={onAccept}
            className="flex-1 rounded-full bg-[#455d3b] text-white text-xs font-medium py-2 disabled:opacity-50"
          >
            Accept
          </button>
          <button
            type="button"
            disabled={acting}
            onClick={onDecline}
            className="flex-1 rounded-full border border-neutral-300 text-xs font-medium py-2 disabled:opacity-50"
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  if (item.kind === "request_accepted") {
    return (
      <button
        type="button"
        onClick={() => onOpenProfile?.(item.otherId)}
        className={`w-full rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 text-left hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <FriendAvatar profile={item.profile} small />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            <strong className="font-medium">{name}</strong> accepted your friend request
          </p>
          {handle && (
            <p className="text-[11px] text-neutral-500 truncate">{handle}</p>
          )}
        </div>
        <Check size={16} className="text-[#455d3b]" />
      </button>
    );
  }

  if (item.kind === "session_submitted") {
    return (
      <button
        type="button"
        onClick={() => onOpenSession?.(item.sessionId)}
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#edf2eb] text-[#455d3b]">
          <Check size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            <strong className="font-medium">{item.guestName}</strong> sent their picks
          </p>
          <p className="text-[11px] text-neutral-500 truncate">{item.sessionName}</p>
        </div>
        <span className="text-neutral-400 text-lg leading-none shrink-0">›</span>
      </button>
    );
  }

  if (item.kind === "session_decided") {
    return (
      <button
        type="button"
        onClick={() => onOpenSession?.(item.sessionId)}
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#edf2eb] text-[#455d3b]">
          <MapPin size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            You're going to <strong className="font-medium">{item.venueName}</strong>
          </p>
          <p className="text-[11px] text-neutral-500 truncate">{item.sessionName}</p>
        </div>
        <span className="text-neutral-400 text-lg leading-none shrink-0">›</span>
      </button>
    );
  }

  return null;
}

// Single-message toast pinned above the BottomTabBar. Self-clears after 2.2s.
// Render anywhere; controlled via App-level toastMessage state.
function Toast({ message, onDismiss }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(onDismiss, 2200);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  if (!message) return null;
  return (
    <div className="fixed bottom-36 left-1/2 -translate-x-1/2 z-[3070] bg-neutral-900 text-white text-sm font-medium px-4 py-2 rounded-full shadow-lg pointer-events-none">
      {message}
    </div>
  );
}

function BottomTabBar({ tab, setTab }) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-[3000] bg-white border-t border-neutral-100 shadow-lg">
      <div className="flex max-w-md mx-auto">
        <button
          type="button"
          onClick={() => setTab("matches")}
          className={`flex-1 flex flex-col items-center gap-1 py-3 transition ${
            tab === "matches" ? "text-[#455d3b]" : "text-neutral-400"
          }`}
        >
          <Heart
            size={20}
            fill={tab === "matches" ? "#455d3b" : "none"}
          />
          <span className="text-xs font-medium">With friends</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("map")}
          className={`flex-1 flex flex-col items-center gap-1 py-3 transition ${
            tab === "map" ? "text-[#455d3b]" : "text-neutral-400"
          }`}
        >
          <MapPin
            size={20}
            fill={tab === "map" ? "#455d3b" : "none"}
          />
          <span className="text-xs font-medium">Map</span>
        </button>
        <button
          type="button"
          onClick={() => setTab("profile")}
          className={`flex-1 flex flex-col items-center gap-1 py-3 transition ${
            tab === "profile" ? "text-[#455d3b]" : "text-neutral-400"
          }`}
        >
          <User size={20} />
          <span className="text-xs font-medium">Profile</span>
        </button>
      </div>
    </div>
  );
}

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
}) {
  const [showMyList, setShowMyList] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const [sessionsCount, setSessionsCount] = useState(null);
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
          onOpenProfile={(uid) => setLookupUserId(uid)}
        />
      )}
      <div className="w-full max-w-sm">
        <div className="mb-5">
          <p className="text-sm text-neutral-500">Account</p>
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
        </div>

        <div className="text-center mb-5">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-[#455d3b] text-white text-3xl font-medium">
            {initial}
          </div>
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
              Display name
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
        />
      )}
    </div>
  );
}

// One-shot confetti burst rendered on a fixed full-screen canvas. Fires
// once on mount and self-destructs when all particles fall off screen.
// No external dependency — small enough to inline. Used on post-game
// results screens to celebrate the match moment.
function ConfettiBurst() {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    const colors = ["#455d3b", "#c5d4c2", "#fdb22d", "#f06292", "#5e60ce", "#fff"];
    const particles = [];
    const centerX = window.innerWidth / 2;
    const startY = window.innerHeight / 3;
    for (let i = 0; i < 140; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 12 + 6;
      particles.push({
        x: centerX,
        y: startY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 4,
        rotation: Math.random() * 360,
        vr: (Math.random() - 0.5) * 12,
        color: colors[Math.floor(Math.random() * colors.length)],
        w: Math.random() * 8 + 6,
        h: Math.random() * 4 + 3,
      });
    }
    let frame;
    const gravity = 0.35;
    const drag = 0.99;
    function tick() {
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      let alive = false;
      for (const p of particles) {
        p.vy += gravity;
        p.vx *= drag;
        p.x += p.vx;
        p.y += p.vy;
        p.rotation += p.vr;
        if (p.y < window.innerHeight + 50) alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate((p.rotation * Math.PI) / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive) frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-[9999]"
      aria-hidden="true"
    />
  );
}

// Post-match-reveal CTA card for guests: "X hosted this session — add as a
// friend?" Renders between the title and the SessionResultsView body on the
// guest's end-of-game screen. Hides itself when:
//   - viewer IS the host (defensive — shouldn't happen on guest side)
//   - viewer + host are already friends
//   - host already sent the viewer a pending request (Accept happens in the
//     participants strip / drawer instead)
// When the viewer already sent a pending request (or just sent one this
// session), shows a frozen "Request sent" pill instead of the Add button.
function AddHostFriendCard({ hostUserId, hostName, viewerUserId, showToast }) {
  const [friendship, setFriendship] = useState(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [justSent, setJustSent] = useState(false);

  async function load() {
    if (!viewerUserId || !hostUserId || viewerUserId === hostUserId) {
      setLoading(false);
      return;
    }
    const { data } = await supabase
      .from("friendships")
      .select("id, requester_id, addressee_id, status")
      .or(`requester_id.eq.${viewerUserId},addressee_id.eq.${viewerUserId}`);
    const rows = data || [];
    const match = rows.find(
      (r) => r.requester_id === hostUserId || r.addressee_id === hostUserId
    );
    setFriendship(match || null);
    setLoading(false);
  }

  useEffect(() => {
    load();
    // load only depends on viewerUserId + hostUserId.
  }, [viewerUserId, hostUserId]);

  // See ProfileLookupScreen.sendRequest for why declined rows need DELETE +
  // INSERT (RLS UPDATE policy filters out non-pending rows).
  async function handleAdd() {
    if (!viewerUserId || !hostUserId) return;
    setSending(true);
    if (friendship && friendship.status === "declined") {
      const { error: delError } = await supabase
        .from("friendships")
        .delete()
        .eq("id", friendship.id);
      if (delError) {
        setSending(false);
        console.error("AddHostFriendCard delete failed:", delError);
        showToast?.("Couldn't send request");
        return;
      }
    }
    const { error } = await supabase
      .from("friendships")
      .insert({
        requester_id: viewerUserId,
        addressee_id: hostUserId,
        status: "pending",
      });
    setSending(false);
    if (error) {
      console.error("AddHostFriendCard insert failed:", error);
      showToast?.("Couldn't send request");
      return;
    }
    setJustSent(true);
    await load();
  }

  // Don't render at all in these cases.
  if (loading) return null;
  if (!viewerUserId || !hostUserId) return null;
  if (viewerUserId === hostUserId) return null;
  if (friendship?.status === "accepted") return null;
  if (
    friendship?.status === "pending" &&
    friendship?.addressee_id === viewerUserId
  ) {
    // Host sent viewer a request — surfaced via drawer / participants strip.
    return null;
  }

  const alreadySent =
    justSent ||
    (friendship?.status === "pending" &&
      friendship?.requester_id === viewerUserId);

  return (
    <div className="bg-[#fdf6f0] px-4 pt-3 pb-1">
      <div className="max-w-sm mx-auto rounded-2xl border border-[#c5d4c2] bg-white p-4 shadow-sm">
        <p className="text-sm text-neutral-700">
          <span className="font-medium">{hostName}</span> hosted this session — add as a friend?
        </p>
        <div className="mt-3 flex justify-end">
          {alreadySent ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-white border border-neutral-200 text-neutral-500 text-xs font-medium px-3 py-1.5">
              <Check size={12} />
              Request sent
            </span>
          ) : (
            <button
              type="button"
              onClick={handleAdd}
              disabled={sending}
              className="inline-flex items-center gap-1 rounded-full bg-[#455d3b] text-white text-xs font-medium px-4 py-1.5 disabled:opacity-50"
            >
              <UserPlus size={12} />
              {sending ? "Sending..." : "Add friend"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

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
function CuratedResultsBoard({ sessionId, venues, hostUserId, userId, onDone, showToast, canDecide = true, savedIds, onSave, onUnsave, onHide, onOpenProfile }) {
  const [results, setResults] = useState(null);
  const [venueRows, setVenueRows] = useState([]);
  const [names, setNames] = useState({});
  const [participantsList, setParticipantsList] = useState([]);
  const [decidedVenueId, setDecidedVenueId] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [detailVenue, setDetailVenue] = useState(null);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    async function load(initial) {
      if (initial) setLoading(true);
      const [resRpc, venuesRpc, partsRpc, sessRpc] = await Promise.all([
        supabase.rpc("get_curated_results", { p_session_id: sessionId }),
        supabase.rpc("get_session_shortlist_venues", { p_session_id: sessionId }),
        supabase
          .from("session_participants")
          .select("user_id, display_name")
          .eq("session_id", sessionId),
        supabase
          .from("match_sessions")
          .select("decided_venue_id")
          .eq("id", sessionId)
          .single(),
      ]);
      if (cancelled) return;
      if (resRpc.error) console.error("get_curated_results failed:", resRpc.error);
      setResults(resRpc.data || []);
      setVenueRows(venuesRpc.data || []);
      const nameMap = {};
      (partsRpc.data || []).forEach((p) => {
        if (p.user_id !== hostUserId) nameMap[p.user_id] = p.display_name || "Friend";
      });
      setNames(nameMap);
      setParticipantsList(partsRpc.data || []);
      if (initial) setDecidedVenueId(sessRpc.data?.decided_venue_id ?? null);
      if (initial) setLoading(false);
    }
    load(true);
    // Poll so guest votes appear live without leaving/reopening the board.
    const pollId = setInterval(() => load(false), 5000);
    return () => {
      cancelled = true;
      clearInterval(pollId);
    };
  }, [sessionId, hostUserId]);

  // Venue details come from the shortlist RPC (bypasses venues RLS so
  // host-imported venues resolve for guests too); fall back to the venues prop.
  const venueById = useMemo(() => {
    const m = {};
    (venues || []).forEach((v) => {
      m[v.id] = v;
    });
    (venueRows || []).forEach((v) => {
      m[v.id] = v;
    });
    return m;
  }, [venues, venueRows]);

  async function decide(venueId) {
    setDeciding(true);
    const { error } = await supabase.rpc("set_curated_decision", {
      p_session_id: sessionId,
      p_venue_id: venueId,
    });
    setDeciding(false);
    if (error) {
      console.error("set_curated_decision failed:", error);
      if (showToast) showToast("Couldn't save — try again");
      return;
    }
    setDecidedVenueId(venueId);
    if (showToast) showToast("Locked it in");
  }

  if (loading) {
    return (
      <div className="flex-1 p-8 text-center text-sm text-neutral-500">
        Loading results…
      </div>
    );
  }

  const list = results || [];
  const topCount = list.length ? list[0].vote_count : 0;
  // Badge a "top pick" only when ONE venue holds the lead. A single venue on
  // 1 vote (others on 0) is a clear winner → badge. A multi-way tie at the top
  // (e.g. everything on 1) has no standout → no badge.
  const leaderCount = list.filter((r) => r.vote_count === topCount).length;
  const hasClearLeader = topCount > 0 && leaderCount === 1;

  // Only rows whose venue resolved (RPC rows merged into venueById).
  const rows = list
    .map((r) => ({ r, v: venueById[r.venue_id] }))
    .filter((x) => x.v);

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allSelected = rows.length > 0 && rows.every((x) => selectedIds.has(x.v.id));
  const someSelected = !allSelected && rows.some((x) => selectedIds.has(x.v.id));
  function toggleSelectAll() {
    if (allSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((x) => x.v.id)));
  }
  function bulkSave() {
    for (const id of selectedIds) {
      if (!savedIds?.has(id)) onSave(id);
    }
    setSelectedIds(new Set());
  }
  const newSelectionCount = Array.from(selectedIds).filter(
    (id) => !savedIds?.has(id)
  ).length;

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4">
      <div className="mb-4 -mx-4">
        <ParticipantsStrip
          participants={participantsList}
          userId={userId}
          hostUserId={hostUserId}
          onOpenProfile={onOpenProfile}
          showToast={showToast}
        />
      </div>
      {decidedVenueId && (
        <div className="mb-4 rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] p-4 text-center">
          <p className="text-xs uppercase tracking-wide text-[#455d3b]">
            You're going to
          </p>
          <p className="mt-1 text-lg font-semibold text-[#2f3f29]">
            {venueById[decidedVenueId]?.name || "your pick"}
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-2xl bg-white p-6 text-center shadow-sm border border-neutral-100">
          <p className="text-sm text-neutral-600">
            No shortlist yet — add some places first.
          </p>
        </div>
      ) : (
        <>
          {/* Select-all + bulk save (mirrors the Right Now results view) */}
          {onSave && (
            <div className="mb-3 flex items-center gap-3">
              <button
                type="button"
                onClick={toggleSelectAll}
                aria-label={allSelected ? "Deselect all" : "Select all"}
                className={`flex h-5 w-5 items-center justify-center rounded border shrink-0 transition ${
                  allSelected
                    ? "bg-[#455d3b] border-[#455d3b] text-white"
                    : someSelected
                    ? "bg-[#455d3b]/40 border-[#455d3b]/40 text-white"
                    : "bg-white border-neutral-300"
                }`}
              >
                {(allSelected || someSelected) && <Check size={14} />}
              </button>
              <button
                type="button"
                onClick={bulkSave}
                disabled={selectedIds.size === 0 || newSelectionCount === 0}
                className="rounded-full bg-[#455d3b] px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {selectedIds.size === 0
                  ? "Save to my list"
                  : newSelectionCount === 0
                  ? `${selectedIds.size} already saved`
                  : `Save ${newSelectionCount} to my list`}
              </button>
            </div>
          )}

          <ul className="space-y-2">
            {rows.map(({ r, v }) => {
              const isTop = hasClearLeader && r.vote_count === topCount;
              const isDecided = decidedVenueId === r.venue_id;
              const isSelected = selectedIds.has(v.id);
              const voterNames = (r.voter_user_ids || []).map(
                (id) => names[id] || "Friend"
              );
              return (
                <li key={r.venue_id}>
                  <div
                    className={`flex items-start gap-3 rounded-2xl bg-white p-3 border ${
                      isDecided
                        ? "border-[#455d3b] ring-1 ring-[#455d3b]"
                        : isTop
                        ? "border-[#cdd9c6]"
                        : "border-neutral-100"
                    }`}
                  >
                    {onSave && (
                      <button
                        type="button"
                        onClick={() => toggleSelected(v.id)}
                        aria-label={isSelected ? "Deselect" : "Select"}
                        className={`flex h-5 w-5 items-center justify-center rounded border shrink-0 mt-1 transition ${
                          isSelected
                            ? "bg-[#455d3b] border-[#455d3b] text-white"
                            : "bg-white border-neutral-300"
                        }`}
                      >
                        {isSelected && <Check size={14} />}
                      </button>
                    )}
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailVenue(v)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDetailVenue(v);
                        }
                      }}
                      className="flex-1 min-w-0 cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{v.name}</p>
                        {isTop && (
                          <span className="shrink-0 text-[10px] uppercase tracking-wide bg-[#edf2eb] text-[#455d3b] rounded-full px-2 py-0.5">
                            Top pick
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-neutral-500 truncate">
                        {r.vote_count === 0
                          ? "No votes yet"
                          : `${r.vote_count} vote${r.vote_count === 1 ? "" : "s"}${
                              voterNames.length ? " · " + voterNames.join(", ") : ""
                            }`}
                      </p>
                      <p className="text-xs text-neutral-500 truncate">
                        {v.type}
                        {v.suburb ? ` · ${v.suburb}` : ""}
                        {v.rating ? ` · ⭐ ${v.rating}` : ""}
                      </p>
                    </div>
                    {canDecide ? (
                      <button
                        type="button"
                        disabled={deciding || isDecided}
                        onClick={() => decide(r.venue_id)}
                        className={`shrink-0 self-center rounded-xl px-3 py-2 text-sm font-medium transition ${
                          isDecided
                            ? "bg-[#455d3b] text-white"
                            : "bg-[#edf2eb] text-[#455d3b] active:scale-[0.98]"
                        } disabled:opacity-60`}
                      >
                        {isDecided ? "Going ✓" : "We're going here"}
                      </button>
                    ) : isDecided ? (
                      <span className="shrink-0 self-center rounded-xl px-3 py-2 text-sm font-medium bg-[#455d3b] text-white">
                        Going ✓
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <button
        type="button"
        onClick={onDone}
        className="mt-6 w-full rounded-2xl bg-neutral-100 py-3 font-medium text-neutral-700"
      >
        Done
      </button>

      {detailVenue && (
        <MapVenueSheet
          venue={detailVenue}
          onClose={() => setDetailVenue(null)}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
        />
      )}
    </div>
  );
}

// Shared participants strip — avatars + names + Host/You labels, with inline
// friend-state chips (Friends / Accept / Requested / Add / Invite). Used by
// both the concurrent results (SessionResultsView) and the curated board.
function ParticipantsStrip({ participants = [], userId, hostUserId, onOpenProfile, showToast }) {
  const [friendshipByOtherId, setFriendshipByOtherId] = useState(() => new Map());
  const [profileExistsSet, setProfileExistsSet] = useState(() => new Set());
  const [chipActingOn, setChipActingOn] = useState(null);
  const [signedUpIds, setSignedUpIds] = useState(() => new Set());

  const otherIds = useMemo(
    () => participants.map((p) => p.user_id).filter((id) => id && id !== userId),
    [participants, userId]
  );

  async function loadFriendshipState() {
    if (!userId || otherIds.length === 0) {
      setFriendshipByOtherId(new Map());
      setProfileExistsSet(new Set());
      setSignedUpIds(new Set());
      return;
    }
    const [friendshipsRes, profilesRes, accountsRes] = await Promise.all([
      supabase
        .from("friendships")
        .select("id, requester_id, addressee_id, status")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
      supabase.from("profiles").select("id").in("id", otherIds),
      supabase.rpc("get_account_user_ids", { p_user_ids: otherIds }),
    ]);
    const otherIdSet = new Set(otherIds);
    const map = new Map();
    for (const row of friendshipsRes.data || []) {
      const other =
        row.requester_id === userId ? row.addressee_id : row.requester_id;
      if (otherIdSet.has(other)) map.set(other, row);
    }
    setFriendshipByOtherId(map);
    setProfileExistsSet(new Set((profilesRes.data || []).map((r) => r.id)));
    setSignedUpIds(new Set((accountsRes.data || []).map((r) => r.user_id)));
  }

  const otherIdsKey = otherIds.join("|");
  useEffect(() => {
    loadFriendshipState();
  }, [userId, otherIdsKey]);

  function getRowState(p) {
    if (!p.user_id) return "invite";
    if (p.user_id === userId) return "self";
    const row = friendshipByOtherId.get(p.user_id);
    if (row) {
      if (row.status === "accepted") return "friends";
      if (row.status === "pending") {
        return row.addressee_id === userId ? "incoming" : "outgoing";
      }
    }
    if (!profileExistsSet.has(p.user_id)) return "invite";
    return "none";
  }

  async function sendRequestTo(otherId) {
    if (!userId || !otherId) return;
    setChipActingOn(otherId);
    const existing = friendshipByOtherId.get(otherId);
    if (existing && existing.status === "declined") {
      const { error: delError } = await supabase
        .from("friendships")
        .delete()
        .eq("id", existing.id);
      if (delError) {
        setChipActingOn(null);
        console.error("sendRequestTo delete failed:", delError);
        showToast?.("Couldn't send request");
        return;
      }
    }
    const { error } = await supabase
      .from("friendships")
      .insert({ requester_id: userId, addressee_id: otherId, status: "pending" });
    setChipActingOn(null);
    if (error) {
      console.error("sendRequestTo failed:", error);
      showToast?.("Couldn't send request");
      return;
    }
    showToast?.("Request sent");
    await loadFriendshipState();
  }

  async function acceptRequestFrom(otherId) {
    const row = friendshipByOtherId.get(otherId);
    if (!row) return;
    setChipActingOn(otherId);
    const { error } = await supabase
      .from("friendships")
      .update({ status: "accepted" })
      .eq("id", row.id);
    setChipActingOn(null);
    if (error) {
      console.error("acceptRequestFrom failed:", error);
      showToast?.("Couldn't accept");
      return;
    }
    showToast?.("Friend added");
    await loadFriendshipState();
  }

  if (participants.length === 0) return null;

  return (
    <div className="bg-white border-b border-neutral-100 px-4 py-3">
      <p className="text-xs text-neutral-500 mb-1.5">
        {participants.length === 1 ? "Just you" : `${participants.length} people`}
      </p>
      <div className="flex items-center gap-2 flex-wrap">
        {participants.map((p) => {
          const name =
            p.display_name?.trim() || (p.user_id === userId ? "You" : "Guest");
          const initial = name.charAt(0).toUpperCase();
          const isMe = p.user_id === userId;
          const isSignedUp = signedUpIds.has(p.user_id);
          const isHost = !!hostUserId && p.user_id === hostUserId;
          const state = getRowState(p);
          const acting = chipActingOn === p.user_id;
          return (
            <div
              key={p.user_id}
              className="inline-flex items-center gap-1.5 rounded-full bg-neutral-50 border border-neutral-100 pl-1 pr-2 py-1"
            >
              <button
                type="button"
                onClick={() => {
                  if (isMe) return;
                  onOpenProfile?.(p.user_id);
                }}
                aria-label={isMe ? "You" : `Open ${name}'s profile`}
                disabled={isMe}
                className="inline-flex items-center gap-1.5"
              >
                <span
                  className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                    isMe
                      ? "bg-[#455d3b] text-white"
                      : isSignedUp
                      ? "bg-[#edf2eb] text-[#3f5a3a]"
                      : "bg-neutral-100 text-neutral-400"
                  }`}
                >
                  {initial}
                </span>
                <span className="text-xs font-medium text-neutral-700">
                  {isMe ? "You" : name}
                </span>
              </button>
              {isHost && (
                <span className="text-[9px] uppercase tracking-wide font-semibold text-neutral-500 px-1">
                  Host
                </span>
              )}
              {!isMe && isSignedUp && state === "friends" && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-[#edf2eb] text-[#3f5a3a] text-[10px] font-medium px-1.5 py-0.5 border border-[#c5d4c2]">
                  <Check size={10} />
                  Friends
                </span>
              )}
              {!isMe && isSignedUp && state === "incoming" && (
                <button
                  type="button"
                  onClick={() => acceptRequestFrom(p.user_id)}
                  disabled={acting}
                  className="rounded-full bg-[#455d3b] text-white text-[10px] font-medium px-2 py-0.5 disabled:opacity-50"
                >
                  {acting ? "…" : "Accept"}
                </button>
              )}
              {!isMe && isSignedUp && state === "outgoing" && (
                <span className="rounded-full bg-white border border-neutral-200 text-neutral-500 text-[10px] font-medium px-2 py-0.5">
                  Requested
                </span>
              )}
              {!isMe && isSignedUp && state === "none" && (
                <button
                  type="button"
                  onClick={() => sendRequestTo(p.user_id)}
                  disabled={acting}
                  className="rounded-full bg-[#455d3b] text-white text-[10px] font-medium px-2 py-0.5 disabled:opacity-50"
                >
                  {acting ? "…" : "Add"}
                </button>
              )}
              {!isMe && !isSignedUp && (
                <span className="text-[9px] uppercase tracking-wide font-semibold text-neutral-400 px-1">
                  Guest
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SessionResultsView({
  participants = [],
  sessionId,
  sessionMatches,
  myLikedIds,
  venues,
  userId,
  hostUserId,
  savedIds,
  onSave,
  onUnsave,
  onHide,
  onOpenProfile,
  showConfetti = false,
  showToast,
}) {
  const [view, setView] = useState("matches");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [detailVenue, setDetailVenue] = useState(null);
  // Host's final pick for this session ("We're going here") — reuses the same
  // decided_venue_id mechanism as the curated board.
  const [decidedVenueId, setDecidedVenueId] = useState(null);
  const [deciding, setDeciding] = useState(false);
  const canDecide = !!sessionId && !!userId && userId === hostUserId;

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    supabase
      .from("match_sessions")
      .select("decided_venue_id")
      .eq("id", sessionId)
      .single()
      .then(({ data }) => {
        if (!cancelled) setDecidedVenueId(data?.decided_venue_id ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  async function decideVenue(venueId) {
    if (!canDecide) return;
    setDeciding(true);
    const { error } = await supabase.rpc("set_curated_decision", {
      p_session_id: sessionId,
      p_venue_id: venueId,
    });
    setDeciding(false);
    if (error) {
      console.error("set_curated_decision failed:", error);
      showToast?.("Couldn't save — try again");
      return;
    }
    setDecidedVenueId(venueId);
    showToast?.("Locked it in");
  }

  // Clear per-row selections when switching tabs.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [view]);

  const venueById = useMemo(
    () => new Map(venues.map((v) => [v.id, v])),
    [venues]
  );
  const matchedIdSet = new Set(
    (sessionMatches || []).map((m) => m.venue_id)
  );
  const likeCountById = new Map(
    (sessionMatches || []).map((m) => [m.venue_id, m.like_count])
  );

  let rows;
  let loading;
  let emptyMessage;
  if (view === "matches") {
    loading = sessionMatches === null;
    rows = (sessionMatches || [])
      .map((m) => {
        const venue = venueById.get(m.venue_id);
        if (!venue) return null;
        return { venue, likeCount: m.like_count, isMatch: true };
      })
      .filter(Boolean);
    emptyMessage = "No mutual matches in this session.";
  } else {
    loading = myLikedIds === null;
    rows = (myLikedIds || [])
      .map((id) => {
        const venue = venueById.get(id);
        if (!venue) return null;
        return {
          venue,
          likeCount: likeCountById.get(id) || 1,
          isMatch: matchedIdSet.has(id),
        };
      })
      .filter(Boolean);
    emptyMessage = "You didn't like any places in this session.";
  }

  const matchesCount = (sessionMatches || []).length;
  const myLikesCount = (myLikedIds || []).length;

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const allVisibleSelected =
    rows.length > 0 && rows.every((r) => selectedIds.has(r.venue.id));
  const someVisibleSelected =
    !allVisibleSelected && rows.some((r) => selectedIds.has(r.venue.id));
  function toggleSelectAll() {
    if (allVisibleSelected) setSelectedIds(new Set());
    else setSelectedIds(new Set(rows.map((r) => r.venue.id)));
  }
  function bulkSave() {
    for (const id of selectedIds) {
      if (!savedIds?.has(id)) onSave(id);
    }
    setSelectedIds(new Set());
  }
  const newSelectionCount = Array.from(selectedIds).filter(
    (id) => !savedIds?.has(id)
  ).length;

  return (
    <>
      {showConfetti && <ConfettiBurst />}

      {/* Participants strip */}
      <ParticipantsStrip
        participants={participants}
        userId={userId}
        hostUserId={hostUserId}
        onOpenProfile={onOpenProfile}
        showToast={showToast}
      />

      {/* Matches / My likes pill toggle */}
      <div className="bg-white border-b border-neutral-100 px-4 py-3 flex justify-center">
        <div className="flex bg-neutral-100 rounded-full p-0.5">
          <button
            type="button"
            onClick={() => setView("matches")}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition ${
              view === "matches"
                ? "bg-white text-[#455d3b] shadow-sm"
                : "text-neutral-500"
            }`}
          >
            Matches ({matchesCount})
          </button>
          <button
            type="button"
            onClick={() => setView("my_likes")}
            className={`rounded-full px-4 py-1.5 text-xs font-medium transition ${
              view === "my_likes"
                ? "bg-white text-[#455d3b] shadow-sm"
                : "text-neutral-500"
            }`}
          >
            My likes ({myLikesCount})
          </button>
        </div>
      </div>

      {/* Top action row — select-all checkbox + Save button */}
      {rows.length > 0 && (
        <div className="px-4 py-3 flex items-center gap-3">
          <button
            type="button"
            onClick={toggleSelectAll}
            aria-label={allVisibleSelected ? "Deselect all" : "Select all"}
            className={`flex h-5 w-5 items-center justify-center rounded border shrink-0 transition ${
              allVisibleSelected
                ? "bg-[#455d3b] border-[#455d3b] text-white"
                : someVisibleSelected
                ? "bg-[#455d3b]/40 border-[#455d3b]/40 text-white"
                : "bg-white border-neutral-300"
            }`}
          >
            {(allVisibleSelected || someVisibleSelected) && <Check size={14} />}
          </button>
          <button
            type="button"
            onClick={bulkSave}
            disabled={selectedIds.size === 0 || newSelectionCount === 0}
            className="rounded-full bg-[#455d3b] px-4 py-1.5 text-xs font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {selectedIds.size === 0
              ? "Save to my list"
              : newSelectionCount === 0
              ? `${selectedIds.size} already saved`
              : `Save ${newSelectionCount} to my list`}
          </button>
        </div>
      )}

      {/* Venue list */}
      <div className="flex-1 overflow-y-auto p-4 pb-24">
        {loading ? (
          <div className="text-center text-neutral-500 mt-12 text-sm">
            Loading...
          </div>
        ) : rows.length === 0 ? (
          <div className="text-center text-neutral-500 mt-12 text-sm">
            {emptyMessage}
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map(({ venue, likeCount, isMatch }) => {
              const isSelected = selectedIds.has(venue.id);
              return (
                <li key={venue.id}>
                  <div className={`flex items-start gap-3 rounded-2xl border bg-white p-3 ${
                    decidedVenueId === venue.id
                      ? "border-[#455d3b] ring-1 ring-[#455d3b]"
                      : "border-neutral-100"
                  }`}>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelected(venue.id);
                      }}
                      aria-label={isSelected ? "Deselect" : "Select"}
                      className={`flex h-5 w-5 items-center justify-center rounded border shrink-0 mt-1 transition ${
                        isSelected
                          ? "bg-[#455d3b] border-[#455d3b] text-white"
                          : "bg-white border-neutral-300"
                      }`}
                    >
                      {isSelected && <Check size={14} />}
                    </button>
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => setDetailVenue(venue)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setDetailVenue(venue);
                        }
                      }}
                      className="flex-1 min-w-0 cursor-pointer"
                    >
                      <div className="flex items-center gap-2">
                        <p className="font-medium truncate">{venue.name}</p>
                        {likeCount > 2 && isMatch && (
                          <span className="inline-flex items-center rounded-full bg-[#edf2eb] px-2 py-0.5 text-[10px] font-medium text-[#3f5a3a] border border-[#c5d4c2] shrink-0">
                            ×{likeCount}
                          </span>
                        )}
                        {view === "my_likes" && isMatch && (
                          <span className="inline-flex items-center rounded-full bg-[#455d3b]/10 px-2 py-0.5 text-[10px] font-medium text-[#455d3b] shrink-0">
                            Matched
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-neutral-500 truncate">
                        {venue.type}
                        {venue.suburb ? ` · ${venue.suburb}` : ""}
                        {venue.rating ? ` · ⭐ ${venue.rating}` : ""}
                      </p>
                    </div>
                    {canDecide ? (
                      <button
                        type="button"
                        disabled={deciding || decidedVenueId === venue.id}
                        onClick={() => decideVenue(venue.id)}
                        className={`shrink-0 self-center rounded-xl px-3 py-2 text-xs font-medium transition ${
                          decidedVenueId === venue.id
                            ? "bg-[#455d3b] text-white"
                            : "bg-[#edf2eb] text-[#455d3b] active:scale-[0.98]"
                        } disabled:opacity-60`}
                      >
                        {decidedVenueId === venue.id ? "Going ✓" : "We're going here"}
                      </button>
                    ) : decidedVenueId === venue.id ? (
                      <span className="shrink-0 self-center rounded-xl px-3 py-2 text-xs font-medium bg-[#455d3b] text-white">
                        Going ✓
                      </span>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {detailVenue && (
        <MapVenueSheet
          venue={detailVenue}
          onClose={() => setDetailVenue(null)}
          savedIds={savedIds}
          onSave={onSave}
          onUnsave={onUnsave}
          onHide={onHide}
        />
      )}
    </>
  );
}

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
function ImportGoogleMapsScreen({ userId, onBack }) {
  // 'idle' | 'parsing' | 'preview' | 'importing' | 'done' | 'error'
  const [stage, setStage] = useState("idle");
  const [error, setError] = useState("");
  const [parsedVenues, setParsedVenues] = useState([]); // [{ title, list, cid, fid }]
  const [perListCounts, setPerListCounts] = useState({}); // { "Bangkok": 75, ... }
  const fileInputRef = useRef(null);

  // Regex extracts FID + CID hex IDs from a Google Maps URL. Same shape as
  // the standalone prototype script — keep these in sync if either changes.
  const URL_PATTERN = /1s(0x[0-9a-f]+):(0x[0-9a-f]+)/;

  async function parseZip(file) {
    setStage("parsing");
    setError("");
    try {
      const zip = await JSZip.loadAsync(file);
      const venues = [];
      const counts = {};
      const entries = Object.values(zip.files).filter(
        (f) =>
          !f.dir &&
          f.name.startsWith("Takeout/Saved/") &&
          f.name.endsWith(".csv") &&
          !f.name.endsWith("Images.csv") // Images.csv = saved web images, not places
      );
      if (entries.length === 0) {
        throw new Error(
          "Couldn't find any Takeout/Saved/*.csv files in this zip. Make sure you exported your Saved Places from Google Takeout."
        );
      }
      for (const entry of entries) {
        const text = await entry.async("string");
        const listName = entry.name
          .split("/")
          .pop()
          .replace(/\.csv$/, "");
        const { data } = Papa.parse(text, { header: true, skipEmptyLines: true });
        let count = 0;
        for (const row of data) {
          const title = (row.Title || "").trim();
          const url = (row.URL || "").trim();
          if (!title && !url) continue;
          const m = URL_PATTERN.exec(url);
          const cid = m ? m[2] : "";
          const fid = m ? m[1] : "";
          venues.push({ title, list: listName, cid, fid });
          count++;
        }
        if (count > 0) counts[listName] = count;
      }
      // Dedup by CID — same place tagged in multiple lists collapses into one
      const seen = new Map();
      for (const v of venues) {
        if (!v.cid) continue;
        if (!seen.has(v.cid)) {
          seen.set(v.cid, { ...v, lists: [v.list] });
        } else {
          seen.get(v.cid).lists.push(v.list);
        }
      }
      setParsedVenues([...seen.values()]);
      setPerListCounts(counts);
      setStage("preview");
    } catch (e) {
      console.error("Parse failed:", e);
      setError(e.message || "Couldn't parse the zip. Try again.");
      setStage("error");
    }
  }

  function handleFileChange(e) {
    const file = e.target.files?.[0];
    if (file) parseZip(file);
  }

  function resetForAnother() {
    setStage("idle");
    setError("");
    setParsedVenues([]);
    setPerListCounts({});
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  // Stub for the actual import. Will POST chunks to the Edge Function once
  // it's deployed. For now, surface a clear "not yet wired" message so the
  // UI is honest with the user.
  function handleImport() {
    setStage("done");
  }

  const totalLists = Object.keys(perListCounts).length;
  const totalRaw = Object.values(perListCounts).reduce((a, b) => a + b, 0);

  return (
    <div className="fixed inset-0 z-[3500] bg-[#fdf6f0] overflow-y-auto pb-20">
      <div className="max-w-sm mx-auto p-4">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back"
          className="mb-4 inline-flex items-center gap-1 text-sm text-neutral-600"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <h1 className="text-2xl font-semibold tracking-tight mb-2">
          Import from Google Maps
        </h1>
        <p className="text-sm text-neutral-600 mb-5">
          Bring your saved places onto your personal Flanit map.
        </p>

        {stage === "idle" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <h2 className="text-base font-semibold tracking-tight mb-2">
              Step 1 — Export from Google
            </h2>
            <ol className="text-sm text-neutral-700 space-y-3 mb-4 list-decimal list-outside ml-5">
              <li>
                Open{" "}
                <a
                  href="https://takeout.google.com/settings/takeout"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#455d3b] underline"
                >
                  Google Takeout
                </a>
                <ul className="list-disc list-outside ml-5 mt-2 space-y-1 text-neutral-600">
                  <li>Click <strong>Deselect all</strong></li>
                  <li>Scroll to the option <strong>Saved</strong> and select (near the bottom)</li>
                  <li>Click <strong>Next step</strong></li>
                  <li>Click <strong>Create export</strong></li>
                </ul>
              </li>
              <li>Download the zip from your email.</li>
              <li>Upload it below.</li>
            </ol>
            <input
              ref={fileInputRef}
              type="file"
              accept=".zip,application/zip"
              onChange={handleFileChange}
              className="hidden"
              id="takeout-zip-input"
            />
            <label
              htmlFor="takeout-zip-input"
              className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white text-center flex items-center justify-center gap-2 cursor-pointer"
            >
              <Upload size={18} /> Choose your Takeout zip
            </label>
          </div>
        )}

        {stage === "parsing" && (
          <div className="rounded-3xl bg-white p-8 shadow-sm border border-neutral-100 text-center">
            <p className="text-sm text-neutral-700">Reading your saved places...</p>
          </div>
        )}

        {stage === "preview" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <h2 className="text-base font-semibold tracking-tight mb-2">
              Found {parsedVenues.length} unique venues
            </h2>
            <p className="text-xs text-neutral-500 mb-4">
              Across {totalLists} list{totalLists === 1 ? "" : "s"} (
              {totalRaw} total entries, deduped)
            </p>
            <div className="max-h-56 overflow-y-auto space-y-1 mb-4 pr-1">
              {Object.entries(perListCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([list, count]) => (
                  <div
                    key={list}
                    className="flex justify-between text-xs py-1 border-b border-neutral-100"
                  >
                    <span className="text-neutral-700 truncate">{list}</span>
                    <span className="text-neutral-500 ml-2 shrink-0">{count}</span>
                  </div>
                ))}
            </div>
            <button
              type="button"
              onClick={handleImport}
              className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white"
            >
              Import these to my map
            </button>
            <button
              type="button"
              onClick={resetForAnother}
              className="w-full mt-2 text-sm text-neutral-500 underline underline-offset-2"
            >
              Choose a different file
            </button>
          </div>
        )}

        {stage === "done" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <h2 className="text-base font-semibold tracking-tight mb-2">
              Almost there
            </h2>
            <p className="text-sm text-neutral-600 mb-3">
              The enrichment backend (Places API lookup + matching) is being
              wired up. Once it's live, this button will finish the import and
              save matches to your map automatically.
            </p>
            <p className="text-xs text-neutral-500 mb-4">
              We parsed {parsedVenues.length} unique venues from your zip — the
              data is ready, just needs a backend trip to finish.
            </p>
            <button
              type="button"
              onClick={resetForAnother}
              className="w-full rounded-2xl bg-white border border-neutral-200 py-3 font-medium text-neutral-700"
            >
              Done
            </button>
          </div>
        )}

        {stage === "error" && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
            <h2 className="text-base font-semibold tracking-tight mb-2 text-red-700">
              Couldn't read that file
            </h2>
            <p className="text-sm text-neutral-600 mb-4">{error}</p>
            <button
              type="button"
              onClick={resetForAnother}
              className="w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function SessionsScreen({ venues, userId, savedIds, onSave, onUnsave, onHide, onBack, showToast, onOpenProfile, initialSessionId }) {
  const [sessions, setSessions] = useState(null); // null = loading
  const [selectedSession, setSelectedSession] = useState(null);
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
        .select("id, name, mode, status, created_at, event_at, host_user_id, target_matches")
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
      const missingIds = Array.from(
        new Set(
          participantRows
            .filter((p) => p.user_id !== userId && !p.display_name?.trim())
            .map((p) => p.user_id)
        )
      );
      let profileNameById = new Map();
      if (missingIds.length > 0) {
        const { data: profileRows } = await supabase
          .from("profiles")
          .select("id, display_name")
          .in("id", missingIds);
        profileNameById = new Map(
          (profileRows || []).map((r) => [r.id, r.display_name])
        );
      }
      const otherNamesBySession = new Map();
      for (const p of participantRows) {
        if (p.user_id === userId) continue;
        const name =
          p.display_name?.trim() ||
          profileNameById.get(p.user_id) ||
          "Guest";
        if (!otherNamesBySession.has(p.session_id)) {
          otherNamesBySession.set(p.session_id, []);
        }
        otherNamesBySession.get(p.session_id).push(name);
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
            otherNames: otherNamesBySession.get(p.session_id) || [],
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

    // Matches (reconciliation RPC — venues with >=2 distinct likers).
    supabase
      .rpc("get_session_matches", { p_session_id: selectedSession.id })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error("Failed to fetch session matches:", error);
          setMatchesError("Couldn't load matches.");
          setSessionMatches([]);
          return;
        }
        setSessionMatches(data || []);
      });

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
          onClick={selectedSession ? () => setSelectedSession(null) : onBack}
          aria-label="Back"
          className="flex h-9 w-9 items-center justify-center rounded-full text-neutral-600 hover:bg-neutral-100"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-lg font-semibold flex-1 truncate">
          {selectedSession ? selectedSession.name || "Session" : "Your sessions"}
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
                    onClick={() => setSelectedSession(s)}
                    className="w-full flex items-center gap-3 rounded-2xl bg-white border border-neutral-100 p-4 text-left hover:bg-neutral-50 active:scale-[0.99] transition"
                  >
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#455d3b]/10 text-[#455d3b] shrink-0">
                      {s.mode === "concurrent" ? <Zap size={18} /> : <Calendar size={18} />}
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
                      <p className="text-xs text-neutral-500 truncate">
                        {s.mode === "concurrent" ? "Right now" : "Later"}
                      </p>
                      {formatOtherNames(s.otherNames) && (
                        <p className="text-xs text-neutral-600 truncate mt-0.5">
                          {formatOtherNames(s.otherNames)}
                        </p>
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
              onDone={() => setSelectedSession(null)}
              showToast={showToast}
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
        .select("id, display_name, username")
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
    <div className="fixed inset-0 z-[3500] bg-[#fdf6f0] overflow-y-auto pb-24">
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
                className="w-full pl-9 pr-3 py-2 rounded-full border border-neutral-200 bg-white text-sm focus:outline-none focus:border-[#455d3b]"
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
        .select("id, display_name, username, tier")
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
    <div className="fixed inset-0 z-[3500] bg-[#fdf6f0] overflow-y-auto pb-24">
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
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search @username or email"
            className="w-full pl-9 pr-3 py-2.5 rounded-full border border-neutral-200 bg-white text-sm focus:outline-none focus:border-[#455d3b]"
            autoFocus
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
}) {
  const [profile, setProfile] = useState(null);
  const [friendship, setFriendship] = useState(null); // null = no row found
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState(false);
  const [avatarExpanded, setAvatarExpanded] = useState(false);
  // Whether the looked-up user is an anonymous (not signed-up) guest. They
  // can't be friended — the host invites them to come back to the app instead.
  const [isAnon, setIsAnon] = useState(false);

  async function load() {
    setLoading(true);
    const [profileRes, friendshipsRes, accountsRes] = await Promise.all([
      supabase
        .from("profiles")
        .select("id, display_name, username, tier")
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
  async function sendRequest() {
    setActing(true);
    if (friendship && status === "declined") {
      const { error: delError } = await supabase
        .from("friendships")
        .delete()
        .eq("id", friendship.id);
      if (delError) {
        setActing(false);
        showToast?.("Couldn't reset previous decline");
        console.error(delError);
        return;
      }
    }
    const { error } = await supabase
      .from("friendships")
      .insert({
        requester_id: viewerUserId,
        addressee_id: userId,
        status: "pending",
      });
    setActing(false);
    if (error) {
      showToast?.("Couldn't send request");
      console.error(error);
      return;
    }
    await load();
  }

  async function acceptRequest() {
    if (!friendship) return;
    setActing(true);
    const { error } = await supabase
      .from("friendships")
      .update({ status: "accepted" })
      .eq("id", friendship.id);
    setActing(false);
    if (error) {
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
    <div className="fixed inset-0 z-[3500] bg-[#fdf6f0] overflow-y-auto pb-24">
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
            className={`rounded-full bg-[#455d3b] text-white font-medium flex items-center justify-center transition-all ${
              avatarExpanded ? "w-40 h-40 text-6xl" : "w-20 h-20 text-3xl"
            }`}
          >
            {initial}
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
            onClick={async () => {
              const url = "https://flanit.co";
              try {
                if (navigator.share) {
                  await navigator.share({ title: "Join me on Flanit", url });
                } else {
                  await navigator.clipboard.writeText(url);
                  showToast?.("Invite link copied — send it to your guest");
                }
              } catch {
                /* user cancelled the share sheet */
              }
            }}
            className="w-full rounded-full bg-[#455d3b] text-white font-medium py-3 mb-6 flex items-center justify-center gap-2"
          >
            <UserPlus size={16} /> Invite to Flanit
          </button>
        )}

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

        {/* Unlocked sections (post-friend) — placeholders for D.2 */}
        {!loading && isFriends && (
          <>
            <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 mb-3">
              <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">
                Their list
              </p>
              <p className="text-sm text-neutral-600">
                Coming soon — friend list visibility ships with D.2.
              </p>
            </div>
            <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 mb-3">
              <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">
                Their friends
              </p>
              <p className="text-sm text-neutral-600">
                Coming soon — friends-of-friends ships with D.2.
              </p>
            </div>
            <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100">
              <p className="text-xs font-medium text-neutral-500 uppercase tracking-wide mb-2">
                Recent activity
              </p>
              <p className="text-sm text-neutral-600">
                Coming soon — check-ins and reviews ship with D.2.
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Small avatar that renders initials from display_name or @handle. Olive bg
// to match the rest of the app's primary palette.
function FriendAvatar({ profile, small = false }) {
  const seed =
    (profile?.display_name || profile?.username || "?").trim() || "?";
  const initial = seed[0].toUpperCase();
  const size = small ? "w-8 h-8 text-xs" : "w-10 h-10 text-sm";
  return (
    <div
      className={`flex-shrink-0 ${size} rounded-full bg-[#455d3b]/10 text-[#455d3b] flex items-center justify-center font-medium`}
    >
      {initial}
    </div>
  );
}

function SessionSetupScreen({ onBack, onPickRightNow, onPickLater }) {
  const [expanded, setExpanded] = useState(null);

  return (
    <div className="flex items-start justify-center p-4 pb-24">
      <div className="w-full max-w-sm">
        <SessionSetupCard
          icon={<Zap size={18} />}
          title="Right now"
          subtitle="Swipe together, find a place in 10 min"
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
          icon={<Calendar size={18} />}
          title="Send a shortlist"
          subtitle="Curate options, friends choose"
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
  onBack,
  onContinue,
}) {
  const [copied, setCopied] = useState(false);
  const shareUrl = sessionId
    ? `${window.location.origin}/s/${sessionId}`
    : "";
  const isCurated = mode === "curated";

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
          text: "Help me pick a place to eat",
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

        {/* Live match indicator — curated only, since the host's already
            done swiping and is now waiting for guests. Concurrent host
            still has the swipe screen for their own progress. */}
        {isCurated && (
          <div className="rounded-3xl bg-white p-5 shadow-sm border border-neutral-100 mb-4 text-center">
            <p className="text-xs uppercase tracking-wide text-neutral-500">
              Waiting for friends
            </p>
            <p className="mt-3 text-sm text-neutral-600">
              Your shortlist is sent. As friends pick the places that work for
              them, their choices land here — then you make the call.
            </p>
          </div>
        )}

        <div className="rounded-2xl bg-neutral-50 p-4 text-sm text-neutral-600 mb-4">
          {isCurated
            ? "Once your friends have picked from your shortlist, you'll see everyone's choices here and can choose where you're going."
            : "Your friends will swipe the same places as you. The session ends when everyone submits or time runs out."}
        </div>

        {/* Concurrent host gets a "Start swiping" CTA into their own swipe
            flow. Curated ("Send options") host has already curated — they get
            a "See results" CTA to open the votes board when ready. */}
        <button
          type="button"
          onClick={onContinue}
          className="w-full rounded-2xl bg-[#455d3b] py-4 font-medium text-white active:scale-[0.98] transition"
        >
          {isCurated ? "See results" : "Start swiping"}
        </button>
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

  return (
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
    </div>
  );
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

function MapScreen({ venues, savedIds, onSave, onUnsave, onHide }) {
  const [selectedVenue, setSelectedVenue] = useState(null);
  const [mapFilter, setMapFilter] = useState("all");
  const plottable = venues.filter(
    (v) =>
      Number.isFinite(Number(v.latitude)) &&
      Number.isFinite(Number(v.longitude))
  );
  const displayedPlottable =
      mapFilter === "my_list" && savedIds
        ? plottable.filter((v) => savedIds.has(v.id))
        : plottable;

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[1500] bg-white">
      <div className="absolute top-0 left-0 right-0 z-[2000] flex items-center justify-between gap-3 bg-white/95 backdrop-blur px-4 py-3 border-b border-neutral-100">
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
        <span className="text-sm font-medium text-neutral-700">
          {displayedPlottable.length}{" "}
          {displayedPlottable.length === 1 ? "place" : "places"}
        </span>
      </div>
      <div className="absolute top-14 left-0 right-0 bottom-0">
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
        />
      )}
    </div>
  );
}

function VenueCard({ venue }) {
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
      <button
        onClick={action}
        className="mt-5 w-full rounded-2xl bg-[#111111] py-4 font-medium text-white"
      >
        {actionText}
      </button>
    </div>
  );
}
