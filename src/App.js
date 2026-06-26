import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './styles.css';
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  TIME_BANDS,
  VIBE_OPTIONS,
  venueMatchesAreas,
  getTodayDayKey,
  venueOpenInBand,
  isVenueOpenNow,
  venueMatchesVibe,
} from "./lib/venueLogic";
import {
  MapFilterGroup,
  MapFilterChip,
  MapFilterSection,
  SearchableChips,
  MapAreaFilter,
} from "./components/MapFilters";
import { VenueCard } from "./components/VenueBits";
import { EmptyState } from "./components/EmptyState";
import { MapVenueSheet } from "./components/MapVenueSheet";
import { MapScreen } from "./components/MapScreen";
import { FloatingActionButton, Toast, BottomTabBar } from "./components/Chrome";
import { ImportGoogleMapsScreen } from "./components/ImportGoogleMapsScreen";
import { ParticipantsStrip } from "./components/ParticipantsStrip";
import { CuratedResultsBoard } from "./components/CuratedResultsBoard";
import { SessionResultsView } from "./components/SessionResultsView";
import { AddHostFriendCard } from "./components/AddHostFriendCard";
import {
  OpenNowToggle,
  AreaCheckbox,
  MultiSelectChips,
  MatchLimitField,
  ParticipantsField,
  TimeLimitField,
  RadiusField,
} from "./components/SessionFields";
import {
  ALL,
  TIME_LIMIT_OPTIONS_CONCURRENT,
  TIME_LIMIT_OPTIONS_CURATED,
} from "./lib/constants";
import { MapPin, Shuffle, RotateCcw, Heart, X, Search, Locate, LogOut, Users, Check, ArrowLeft, Trash2, MoreVertical, Zap, Calendar, Download, Upload, UserPlus, UserMinus } from "lucide-react";
import { supabase } from "./supabaseClient";
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
                    setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
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
  const [radiusKm, setRadiusKm] = useState(1);
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
  // Activity tab notifications. Derived from existing tables for D.1 — no
  // dedicated notifications table yet. unreadCount drives the tab's red badge.
  const [unreadCount, setUnreadCount] = useState(0);
  // Session id to deep-link into from a tapped notification — opens that
  // session's Your Sessions detail / results board.
  const [notifSessionId, setNotifSessionId] = useState(null);
  // Venue to show in an app-level MapVenueSheet card — e.g. tapping a
  // "You're going to X" decision notification opens that venue's card directly.
  const [cardVenue, setCardVenue] = useState(null);
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
      // Flip when the match target is reached OR the guest finishes the queue —
      // so a Right now guest always lands on the matches / sign-up screen and
      // never dead-ends on a blank card at end of list.
      const queueEmpty = guestQueue.length === 0 && guestCardIndex === 0;
      const reachedEnd =
        guestQueue.length > 0 && guestCardIndex >= guestQueue.length;
      shouldFlip =
        (target > 0 && sessionMatches.length >= target) ||
        reachedEnd ||
        queueEmpty;
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

      if (cancelled) return;
      setUnreadCount((reqRes.count ?? 0) + submittedCount + decidedCount);
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

  // Known returning users skip the guest "what should we call you?" screen.
  // If a session link opens while the person is already signed in (non-anon and
  // not the host) and we have a display name for them, auto-join under their
  // real account and go straight to the picks. Anonymous/unknown users (incl.
  // in-app browsers with no session) still see the manual name screen.
  const autoJoinedRef = useRef(false);
  useEffect(() => {
    if (!isGuest || autoJoinedRef.current) return;
    if (guestStage !== "splash") return;
    if (guestSessionData?.status !== "open") return;
    const u = session?.user;
    if (!u?.id || u.is_anonymous) return;
    if (u.id === guestSessionData?.host_user_id) return; // host isn't a guest
    const name = profile?.display_name?.trim();
    if (!name) return; // no display name yet → fall back to the manual screen
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
  ]);

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
      // Existing users verify with type 'email'; brand-new signups may need
      // 'signup'. Try 'email' first, fall back to 'signup' so both work.
      let { error } = await supabase.auth.verifyOtp({ email, token: code, type: "email" });
      if (error) {
        const retry = await supabase.auth.verifyOtp({ email, token: code, type: "signup" });
        error = retry.error;
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
      ...Array.from(new Set(availableVenues.map((venue) => venue.cuisine_bucket)))
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
        !selectedCuisines.includes(venue.cuisine_bucket)
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
        !selectedCuisines.includes(venue.cuisine_bucket)
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
    const sessionRadius = typeof filters.radiusKm === "number" ? filters.radiusKm : 1;

    return pool.filter((venue) => {
      if (!venueMatchesAreas(venue, sessionAreas, sessionRadius)) return false;

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
                    <button
                      type="button"
                      onClick={() => goToMainApp("map")}
                      className="mt-3 w-full text-center text-sm text-neutral-500"
                    >
                      Just looking?{" "}
                      <span className="font-medium text-[#455d3b]">
                        Explore Flanit ›
                      </span>
                    </button>
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
                            e.target.value.replace(/\D/g, "").slice(0, 6)
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
                <button
                  type="button"
                  onClick={() => goToMainApp("map")}
                  className="mt-6 w-full rounded-2xl bg-[#455d3b] py-3 font-medium text-white active:scale-[0.98] transition shadow-md"
                >
                  See the plan
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
                            e.target.value.replace(/\D/g, "").slice(0, 6)
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
          venues={venues}
          hiddenIds={hiddenVenueIds}
          areas={areas}
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
      {tab === "activity" && session?.user?.id && (
        <ActivityDrawer
          asTab
          userId={session?.user?.id}
          onOpenProfile={(uid) => setLookupUserId(uid)}
          onOpenSession={(sid) => setNotifSessionId(sid)}
          onOpenVenue={(v) => setCardVenue(v)}
          showToast={showToast}
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
      {cardVenue && (
        <MapVenueSheet
          venue={cardVenue}
          onClose={() => setCardVenue(null)}
          savedIds={savedVenueIds}
          onSave={saveVenue}
          onUnsave={unsaveVenue}
          onHide={hideVenue}
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
        unreadCount={unreadCount}
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
        <RadiusField value={radiusKm} onChange={setRadiusKm} />
      </div>
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
function ActivityDrawer({ userId, onClose, onOpenProfile, onOpenSession, onOpenVenue, showToast, asTab = false }) {
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
            venueObj: v || null, // full venue → tap opens its card
            sessionName: s.name || "your session",
            timestamp: s.updated_at,
          };
        })
      );
    }

    // ---- Connect: people from my sessions I'm not yet connected with ----
    // Add (signed-up) or invite (anon) each one — actionable from the drawer.
    let connectItems = [];
    if (myPartRows.length > 0) {
      const [coPartsRes, myFriendshipsRes] = await Promise.all([
        supabase
          .from("session_participants")
          .select("user_id, display_name, joined_at")
          .in("session_id", myPartRows.map((p) => p.session_id))
          .neq("user_id", userId)
          .order("joined_at", { ascending: false }),
        supabase
          .from("friendships")
          .select("requester_id, addressee_id, status")
          .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
      ]);
      // Skip anyone I already have any friendship history with (any status).
      const hasFriendship = new Set();
      (myFriendshipsRes.data || []).forEach((f) => {
        hasFriendship.add(
          f.requester_id === userId ? f.addressee_id : f.requester_id
        );
      });
      const coById = new Map();
      (coPartsRes.data || []).forEach((p) => {
        if (!p.user_id || hasFriendship.has(p.user_id)) return;
        if (!coById.has(p.user_id)) coById.set(p.user_id, p);
      });
      const coIds = Array.from(coById.keys());
      if (coIds.length > 0) {
        const { data: acctRows } = await supabase.rpc("get_account_user_ids", {
          p_user_ids: coIds,
        });
        const signedUp = new Set((acctRows || []).map((r) => r.user_id));
        connectItems = coIds.map((uid) => {
          const p = coById.get(uid);
          return {
            kind: signedUp.has(uid) ? "connect_add" : "connect_invite",
            id: `con_${uid}`,
            otherId: uid,
            name: p.display_name || "Someone",
            timestamp: p.joined_at,
          };
        });
      }
    }

    const all = [
      ...incomingItems,
      ...acceptedItems,
      ...submittedItems,
      ...decidedItems,
      ...connectItems,
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    setItems(all);
  }

  async function sendRequest(otherId) {
    setActing(otherId);
    const { error } = await supabase
      .from("friendships")
      .insert({ requester_id: userId, addressee_id: otherId, status: "pending" });
    setActing(null);
    if (error) {
      console.error("Drawer add friend failed:", error);
      showToast?.("Couldn't send request");
      return;
    }
    showToast?.("Request sent");
    await load();
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

  const body = (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
        {!asTab && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-8 h-8 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-100"
          >
            <X size={18} />
          </button>
        )}
      </div>

      {items === null && (
        <p className="text-sm text-neutral-500 text-center py-8">Loading…</p>
      )}

      {items !== null && items.length === 0 && (
        <div className="rounded-3xl bg-white p-6 shadow-sm border border-neutral-100 text-center">
          <p className="text-sm text-neutral-600">Nothing here yet.</p>
          <p className="text-xs text-neutral-500 mt-1">
            Friend requests and people from your sessions show up here.
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
                acting={acting === item.friendshipId || acting === item.otherId}
                onAccept={() => setStatus(item.friendshipId, "accepted")}
                onDecline={() => setStatus(item.friendshipId, "declined")}
                onAddFriend={() => sendRequest(item.otherId)}
                onOpenProfile={onOpenProfile}
                onOpenSession={onOpenSession}
                onOpenVenue={onOpenVenue}
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
                acting={acting === item.friendshipId || acting === item.otherId}
                onAccept={() => setStatus(item.friendshipId, "accepted")}
                onDecline={() => setStatus(item.friendshipId, "declined")}
                onAddFriend={() => sendRequest(item.otherId)}
                onOpenProfile={onOpenProfile}
                onOpenSession={onOpenSession}
                onOpenVenue={onOpenVenue}
              />
            ))}
          </div>
        </>
      )}
    </>
  );

  if (asTab) {
    return (
      <div className="min-h-screen bg-[#fdf6f0] pb-28">
        <div className="p-4 max-w-md mx-auto">{body}</div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        aria-label="Close notifications"
        onClick={onClose}
        className="fixed inset-0 z-[3490] bg-black/25"
      />
      <div className="fixed top-0 right-0 bottom-0 z-[3500] w-[78%] max-w-sm bg-[#fdf6f0] overflow-y-auto shadow-xl">
        <div className="p-4">{body}</div>
      </div>
    </>
  );
}

// Single drawer item row. Visually distinguishes NEW with a soft green tinted
// background. Friend-request items get inline Accept/Decline; accepted-back
// items are informational.
function ActivityItem({ item, isNew, acting, onAccept, onDecline, onAddFriend, onOpenProfile, onOpenSession, onOpenVenue }) {
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
        onClick={() =>
          item.venueObj
            ? onOpenVenue?.(item.venueObj)
            : onOpenSession?.(item.sessionId)
        }
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

  if (item.kind === "connect_add") {
    return (
      <div className={`rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3`}>
        <button
          type="button"
          onClick={() => onOpenProfile?.(item.otherId)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
        >
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#edf2eb] text-[#3f5a3a] text-sm font-medium">
            {(item.name || "?").charAt(0).toUpperCase()}
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-neutral-900">
              <strong className="font-medium">{item.name}</strong> was in your session
            </p>
            <p className="text-[11px] text-neutral-500">Add them as a friend</p>
          </div>
        </button>
        <button
          type="button"
          onClick={onAddFriend}
          disabled={acting}
          className="shrink-0 rounded-full bg-[#455d3b] text-white text-xs font-medium px-3 py-1.5 disabled:opacity-50"
        >
          {acting ? "…" : "Add"}
        </button>
      </div>
    );
  }

  if (item.kind === "connect_invite") {
    return (
      <button
        type="button"
        onClick={() => onOpenProfile?.(item.otherId)}
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-400 text-sm font-medium">
          {(item.name || "?").charAt(0).toUpperCase()}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            <strong className="font-medium">{item.name}</strong> joined as a guest
          </p>
          <p className="text-[11px] text-neutral-500">Invite them to join Flanit</p>
        </div>
        <span className="shrink-0 rounded-full bg-white border border-neutral-200 text-neutral-700 text-xs font-medium px-3 py-1.5">
          Invite
        </span>
      </button>
    );
  }

  return null;
}

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
          onOpenProfile={onOpenProfile}
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
  const [showInvite, setShowInvite] = useState(false);

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

// MapResizer + MapScreen moved to ./components/MapScreen.js (imported at top).
// (MapScreen body now lives in ./components/MapScreen.js)

// MapFilterGroup, MapFilterChip, MapFilterSection, SearchableChips,
// MapAreaFilter moved to ./components/MapFilters.js (imported at the top).

// VenueCard, VenueHeroCarousel, VenueVibes, VenueRating, OpeningHours,
// OpenMapsButton moved to ./components/VenueBits.js;
// EmptyState moved to ./components/EmptyState.js (both imported at the top).
