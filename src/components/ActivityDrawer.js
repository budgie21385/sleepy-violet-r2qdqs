// Activity surface — renders as the Activity bottom tab (asTab) or the legacy
// right-side slide-in drawer. Items are derived on the fly from existing
// tables (no `notifications` table yet — that's D.5): friend requests (inline
// Accept/Decline), accepted-back, session invites, "sent their picks" (host),
// "you're going to X" (guest), and connect-with-session-people rows.
// NEW vs EARLIER split via a localStorage timestamp: `flanit_drawer_last_seen`.
// Items with their relevant timestamp after last_seen are NEW. Updated when
// the drawer closes. Extracted verbatim from App.js (July 10, 2026).
import { useState, useEffect } from "react";
import { X, UserPlus, Check, MapPin, MessageCircle, Camera, Clock } from "lucide-react";
import { pushState, enablePush, sendPush } from "../lib/push";
import {
  sendFriendRequest,
  acceptFriendRequest,
  friendRequestToast,
} from "../lib/friendships";

// Priority tiers for the Activity list (Mark, July 18): items that deal
// with the person directly outrank ambient news regardless of age.
const KIND_WEIGHT = {
  tag_nudge: 0, // someone checked you in — answer them
  request_received: 0, // friend request — answer them
  join_request: 0, // someone joined your night — answer them
  session_invite: 1,
  session_nudge: 1,
  photo_nudge: 1,
  session_timeup: 1, // your session ended on the clock — go decide
};
function itemWeight(i) {
  return KIND_WEIGHT[i.kind] ?? 2;
}

// Local midnight of the Monday strictly AFTER the given time — the session
// "Did you go?" nudge fires then for evening outings (Mark: following
// Monday covers the weekend).
function followingMonday(ts) {
  const d = new Date(ts);
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() + (((8 - m.getDay()) % 7) || 7));
  return m;
}

// Daytime outings (cafés) get asked the SAME afternoon (Mark, July 21:
// "if it's a coffee thing prompt in the afternoon") — 3pm local, or two
// hours later if the plan was already made after 3.
function afternoonAfter(ts) {
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
}

// DATED plans ask the day after the night (Aug 1, Mark: "If we have a date
// we should also ask them the day after — did you go here"). 10am local:
// late enough to be polite, early enough that the night is fresh.
function morningAfter(ts) {
  const d = new Date(ts);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + 1,
    10,
    0,
    0
  ).getTime();
}
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";
import { CheckinThreadSheet } from "./CheckinThreadSheet";
import { timeAgoShort, whenAgo } from "../lib/checkins";
import { realName } from "../lib/names";
import { readDismissed, dismissItems } from "../lib/dismissed";

// Tiny corner timestamp on every Activity card (Mark, July 25): "2h" while
// fresh, "yesterday", then a date — same ladder as the check-in card.
function whenLabel(ts) {
  if (!ts) return "";
  const ms = Date.now() - new Date(ts).getTime();
  if (ms < 0) return ""; // future-dated nudge windows — say nothing
  // Short form in a corner: "2h", "yesterday", "18 Jul" — same calendar
  // rules as lib/checkins' whenAgo, minus the "ago".
  return whenAgo(ts).replace(/ ago$/, "");
}

// Last loaded items, module-level — reopening the tab paints instantly from
// this while load() refreshes in the background (stale-while-revalidate).
let drawerCache = null; // { uid, items }

export function ActivityDrawer({ userId, onClose, onOpenProfile, onOpenSession, onOpenVenue, onCheckIn, profileIncomplete = false, onFinishProfile, showToast, asTab = false }) {
  const [items, setItems] = useState(() =>
    drawerCache && drawerCache.uid === userId ? drawerCache.items : null
  ); // null = loading
  // Dismissed ids (Aug, Mark) — per-device, see lib/dismissed.js.
  const [dismissed, setDismissed] = useState(() => readDismissed());
  function dismiss(ids) {
    dismissItems(ids);
    setDismissed(readDismissed());
  }
  const [acting, setActing] = useState(null); // friendship.id mid-update
  const [thread, setThread] = useState(null); // open comment thread sheet
  const [visibleCount, setVisibleCount] = useState(10); // "Show more" paging
  // Push enable prompt: shown until granted/dismissed. iOS needs the app
  // installed first — that state points at /install instead.
  const [pushPrompt, setPushPrompt] = useState(() => {
    try {
      if (localStorage.getItem("flanit_push_prompt_dismissed")) return null;
    } catch {}
    const s = pushState();
    return s === "default" || s === "need-install" ? s : null;
  });
  const [lastSeen] = useState(() => {
    const stored = localStorage.getItem("flanit_drawer_last_seen");
    return stored ? new Date(stored) : new Date(0);
  });

  // ---- Session "Did you go?" nudge helpers (Mark, July 16: fires the
  // following Monday, no matter when the outing was — one weekly moment).
  const SESSION_NUDGE_DONE_KEY = "flanit_session_nudges_done";
  function readNudgesDone() {
    try {
      return new Set(
        JSON.parse(localStorage.getItem(SESSION_NUDGE_DONE_KEY) || "[]")
      );
    } catch {
      return new Set();
    }
  }
  function markNudgeDone(sessionId) {
    const done = readNudgesDone();
    done.add(sessionId);
    try {
      localStorage.setItem(
        SESSION_NUDGE_DONE_KEY,
        JSON.stringify(Array.from(done))
      );
    } catch {}
  }

  async function load() {
    if (!userId) return;
    const [incomingRes, acceptedRes, hostedRes, myPartsRes, invitesRes, myFriendsRes] =
      await Promise.all([
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
      // Sessions I host — guests' submissions + time's-up items both need
      // the clock and decision fields (July 31).
      supabase
        .from("match_sessions")
        .select("id, name, mode, expires_at, decided_venue_id, expected_others")
        .eq("host_user_id", userId),
      // Sessions I'm in — to surface a host's final decision.
      supabase
        .from("session_participants")
        .select("session_id")
        .eq("user_id", userId),
      // Sessions a friend invited me to (that I haven't joined yet).
      supabase
        .from("session_invites")
        .select("session_id, inviter_id, created_at")
        .eq("invitee_id", userId)
        .order("created_at", { ascending: false }),
      // All my accepted friendships (both directions) — for check-in items.
      supabase
        .from("friendships")
        .select("requester_id, addressee_id")
        .eq("status", "accepted")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
    ]);

    const incomingRows = incomingRes.data || [];
    const acceptedRows = acceptedRes.data || [];

    // Hydrate profiles for every referenced other-party user_id.
    const otherIds = new Set();
    incomingRows.forEach((r) => otherIds.add(r.requester_id));
    acceptedRows.forEach((r) => otherIds.add(r.addressee_id));

    // All derivation blocks below run CONCURRENTLY — they only depend on the
    // phase-1 results, and running them in sequence was the drawer's whole
    // slowness (each block is 1–4 further round-trips).
    const requestsP = (async () => {
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
      return [incomingItems, acceptedItems];
    })();

    // ---- Host: guests who submitted their picks on sessions I host ----
    const hostedRows = hostedRes.data || [];
    const hostedNameById = Object.fromEntries(
      hostedRows.map((s) => [s.id, s.name])
    );
    const submittedP = (async () => {
      let submittedItems = [];
      if (hostedRows.length === 0) return submittedItems;
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
      return submittedItems;
    })();

    // ---- Host: sessions whose CLOCK ended them, undecided, with votes ----
    // (July 31, Mark: "session time up — 2 out of 3 submitted, see results").
    // The push at expiry comes from whichever guest device noticed; this item
    // is the host's durable record of the same moment. 7-day window; skipped
    // once decided or when nobody submitted (nothing to decide from).
    const timeUpP = (async () => {
      const items = [];
      const now = Date.now();
      const WEEK = 7 * 24 * 60 * 60 * 1000;
      const ended = hostedRows.filter(
        (s) =>
          s.mode === "concurrent" &&
          !s.decided_venue_id &&
          s.expires_at &&
          now > new Date(s.expires_at).getTime() &&
          now - new Date(s.expires_at).getTime() < WEEK
      );
      if (ended.length === 0) return items;
      const { data: parts } = await supabase
        .from("session_participants")
        .select("session_id, user_id, submitted_at")
        .in("session_id", ended.map((s) => s.id));
      for (const s of ended) {
        const others = (parts || []).filter(
          (p) => p.session_id === s.id && p.user_id !== userId
        );
        const submitted = others.filter((p) => p.submitted_at).length;
        if (submitted === 0) continue;
        items.push({
          kind: "session_timeup",
          id: `stu_${s.id}`,
          sessionId: s.id,
          sessionName: s.name || "your session",
          submitted,
          expected: s.expected_others || others.length,
          timestamp: s.expires_at,
        });
      }
      return items;
    })();

    // ---- Guest: a host's final pick on a session I'm in (not hosting) ----
    const myPartRows = myPartsRes.data || [];
    const decidedP = (async () => {
      let decidedItems = [];
      if (myPartRows.length === 0) return decidedItems;
      const { data: decidedRows } = await supabase
        .from("match_sessions")
        .select("id, name, host_user_id, decided_venue_id, decided_for, updated_at")
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
            decidedFor: s.decided_for || null, // the plan's WHEN (Aug 1)
            timestamp: s.updated_at,
          };
        })
      );
      return decidedItems;
    })();

    // ---- Connect: people from my sessions I'm not yet connected with ----
    // Add (signed-up) or invite (anon) each one — actionable from the drawer.
    const connectP = (async () => {
      let connectItems = [];
      if (myPartRows.length === 0) return connectItems;
      const [coPartsRes, myFriendshipsRes] = await Promise.all([
        supabase
          .from("session_participants")
          .select("session_id, user_id, display_name, joined_at")
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
        const { data: avRows } = await supabase
          .from("profiles")
          .select("id, avatar_url")
          .in("id", coIds);
        const avatarByUid = new Map(
          (avRows || []).filter((r) => r.avatar_url).map((r) => [r.id, r.avatar_url])
        );
        // A guest who signs up mid-session exists TWICE in the participants —
        // their abandoned anon uid and their real account, same name, same
        // session (July 31, Mark: Dama showed as both "Add" and "Invite").
        // The real account is the person; the anon shell's Invite row is
        // noise. Dedupe by name-within-session, keeping the signed-up uid.
        const signedUpNameKeys = new Set(
          coIds
            .filter((uid) => signedUp.has(uid))
            .map((uid) => {
              const p = coById.get(uid);
              return `${p.session_id}|${(realName(p.display_name) || "").toLowerCase()}`;
            })
            .filter((k) => !k.endsWith("|"))
        );
        connectItems = coIds
          .filter((uid) => {
            if (signedUp.has(uid)) return true;
            const p = coById.get(uid);
            const key = `${p.session_id}|${(realName(p.display_name) || "").toLowerCase()}`;
            return key.endsWith("|") || !signedUpNameKeys.has(key);
          })
          .map((uid) => {
            const p = coById.get(uid);
            return {
              kind: signedUp.has(uid) ? "connect_add" : "connect_invite",
              id: `con_${uid}`,
              otherId: uid,
              // realName: rows written before the July 31 fix can carry the
              // trigger's "New user" placeholder — "Someone" reads as intended.
              name: realName(p.display_name) || "Someone",
              avatar: avatarByUid.get(uid) || null,
              timestamp: p.joined_at,
            };
          });
      }
      return connectItems;
    })();

    // ---- Friend check-ins ("[Name] is at [venue]") — last 7 days ----
    const friendIds = Array.from(
      new Set(
        (myFriendsRes.data || []).map((f) =>
          f.requester_id === userId ? f.addressee_id : f.requester_id
        )
      )
    );
    const checkinP = (async () => {
      let checkinItems = [];
      if (friendIds.length === 0) return checkinItems;
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: checkinRows } = await supabase
        .from("activities")
        .select("id, user_id, venue_id, created_at, label, show_live")
        .eq("kind", "checkin")
        .in("user_id", friendIds)
        .gte("created_at", weekAgo)
        // UPCOMING nights stay silent until they happen (Aug 1, Mark) — a
        // future created_at passes the week window AND reads as ultra-fresh
        // ("MB is at X · Right now" for an event next Tuesday). The item
        // appears naturally once the date arrives.
        .lte("created_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(20);
      if (checkinRows && checkinRows.length > 0) {
        const checkinUserIds = Array.from(new Set(checkinRows.map((r) => r.user_id)));
        const venueIds = Array.from(new Set(checkinRows.map((r) => r.venue_id)));
        const [profsRes, venuesRes] = await Promise.all([
          supabase
            .from("profiles")
            .select("id, display_name, username, avatar_url")
            .in("id", checkinUserIds),
          // Plain venues read — RLS may hide a friend's own unverified venue;
          // those fall back to "a spot" rather than leaking or breaking.
          supabase.from("venues").select("*").in("id", venueIds),
        ]);
        const profById = Object.fromEntries(
          (profsRes.data || []).map((p) => [p.id, p])
        );
        const venueById = Object.fromEntries(
          (venuesRes.data || []).map((v) => [v.id, v])
        );
        // Comment counts for these check-ins, one query (RLS trims to what
        // the viewer may see anyway).
        const countByActivity = {};
        {
          const { data: cRows } = await supabase
            .from("activity_comments")
            .select("activity_id")
            .in("activity_id", checkinRows.map((r) => r.id));
          for (const c of cRows || []) {
            countByActivity[c.activity_id] =
              (countByActivity[c.activity_id] || 0) + 1;
          }
        }
        // "with [names]" — ACCEPTED tags only (July 31, Mark: SayIdo saw "MB
        // checked in · with Resha" when Resha hadn't accepted, and isn't
        // SayIdo's friend).
        //
        // These items are shown to a THIRD PARTY — a friend of the check-in's
        // owner — and this block used to render pending tags too. A pending tag
        // is an ASK, not a fact: publishing it names someone who never agreed
        // to appear, to an audience they didn't choose, and it breaks the
        // promise the tag picker makes ("They'll be asked before their friends
        // see anything"). Acceptance IS the consent to be named on the card, so
        // acceptance is the gate.
        const withByActivity = {};
        {
          const { data: rawTRows } = await supabase
            .from("activity_tags")
            .select("activity_id, tagged_user_id, status, requested_by")
            .in("activity_id", checkinRows.map((r) => r.id))
            .eq("status", "accepted");
          const tRows = rawTRows || [];
          const taggedIds = Array.from(
            new Set((tRows || []).map((t) => t.tagged_user_id))
          );
          let tagProfById = {};
          if (taggedIds.length > 0) {
            const { data: tp } = await supabase
              .from("profiles")
              .select("id, display_name")
              .in("id", taggedIds);
            tagProfById = Object.fromEntries((tp || []).map((p) => [p.id, p]));
          }
          for (const t of tRows || []) {
            const nm = (tagProfById[t.tagged_user_id]?.display_name || "").split(" ")[0];
            if (!nm) continue;
            (withByActivity[t.activity_id] = withByActivity[t.activity_id] || []).push(nm);
          }
        }
        checkinItems = checkinRows.map((r) => ({
          kind: "friend_checkin",
          id: `chk_${r.id}`,
          activityId: r.id,
          otherId: r.user_id,
          profile: profById[r.user_id] || null,
          venueObj: venueById[r.venue_id] || null,
          venueName: venueById[r.venue_id]?.name || "a spot",
          label: r.label || null,
          withNames: withByActivity[r.id] || [],
          commentCount: countByActivity[r.id] || 0,
          // Presence is the toggle (Aug, Mark): a quiet check-in renders
          // as history ("checked in at"), never as a live "is at".
          showLive: r.show_live !== false,
          timestamp: r.created_at,
        }));
      }
      return checkinItems;
    })();

    // ---- Tag nudges: "[Name] checked you in at [venue]" (pending only) ----
    const tagNudgeP = (async () => {
      let tagNudgeItems = [];
      const { data: rawTagRows } = await supabase
        .from("activity_tags")
        .select("id, activity_id, created_at, requested_by")
        .eq("tagged_user_id", userId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(10);
      // Exclude my own join requests — those are the OWNER's to answer.
      const tagRows = (rawTagRows || []).filter(
        (t) => t.requested_by !== userId
      );
      if (tagRows && tagRows.length > 0) {
        const actIds = tagRows.map((t) => t.activity_id);
        const { data: acts } = await supabase
          .from("activities")
          .select("id, user_id, venue_id, label, created_at")
          .in("id", actIds);
        const actById = Object.fromEntries((acts || []).map((a) => [a.id, a]));
        const taggerIds = Array.from(
          new Set((acts || []).map((a) => a.user_id))
        );
        const venueIds = Array.from(
          new Set((acts || []).map((a) => a.venue_id).filter(Boolean))
        );
        const [profsRes, venuesRes] = await Promise.all([
          taggerIds.length
            ? supabase
                .from("profiles")
                .select("id, display_name, username, avatar_url")
                .in("id", taggerIds)
            : { data: [] },
          venueIds.length
            ? supabase.from("venues").select("*").in("id", venueIds)
            : { data: [] },
        ]);
        const tProfById = Object.fromEntries(
          (profsRes.data || []).map((p) => [p.id, p])
        );
        const vById2 = Object.fromEntries(
          (venuesRes.data || []).map((v) => [v.id, v])
        );
        tagNudgeItems = tagRows
          .filter((t) => actById[t.activity_id])
          .map((t) => {
            const act = actById[t.activity_id];
            return {
              kind: "tag_nudge",
              id: `tag_${t.id}`,
              tagId: t.id,
              activityId: t.activity_id,
              otherId: act.user_id,
              profile: tProfById[act.user_id] || null,
              venueId: act.venue_id,
              venueName: vById2[act.venue_id]?.name || "a spot",
              venueObj: vById2[act.venue_id] || null, // accept → card opens wired
              label: act.label || null,
              checkinTimestamp: act.created_at,
              timestamp: t.created_at,
            };
          });
      }
      // MUTUAL CONSENT ACROSS SHARDS (July 24 — Mark + Renasha's coffee):
      // both answered "Did you go?" separately, then each tagged the OTHER
      // from their own card. Two consents existed on two shards, yet both
      // got asked to accept. Rule: if I've already tagged the tagger on my
      // OWN same-night check-in at the same venue, my consent is on record
      // — auto-accept their tag silently, link my shard into the night, and
      // render no ask. (Their side resolves symmetrically when they open
      // Activity; my outgoing tag is theirs to complete, not mine.)
      if (tagNudgeItems.length > 0) {
        const W = 12 * 60 * 60 * 1000;
        const kept = [];
        for (const it of tagNudgeItems) {
          try {
            if (!it.venueId) {
              kept.push(it);
              continue;
            }
            const ts = new Date(it.checkinTimestamp).getTime();
            const { data: myActs } = await supabase
              .from("activities")
              .select("id, joined_from")
              .eq("user_id", userId)
              .eq("kind", "checkin")
              .eq("venue_id", it.venueId)
              .gte("created_at", new Date(ts - W).toISOString())
              .lte("created_at", new Date(ts + W).toISOString());
            if (!myActs || myActs.length === 0) {
              kept.push(it);
              continue;
            }
            const { data: myTags } = await supabase
              .from("activity_tags")
              .select("id, activity_id, requested_by")
              .in("activity_id", myActs.map((a) => a.id))
              .eq("tagged_user_id", it.otherId);
            // My initiative only — their self-request on my shard is THEIR
            // consent, not mine.
            const myConsent = (myTags || []).find(
              (t) => t.requested_by !== it.otherId
            );
            if (!myConsent) {
              kept.push(it);
              continue;
            }
            // Two consents → complete silently. No push, no toast.
            await supabase
              .from("activity_tags")
              .update({
                status: "accepted",
                responded_at: new Date().toISOString(),
              })
              .eq("id", it.tagId);
            // Link my shard into their night — unless THEIR shard already
            // points at mine (they resolved first; a back-edge would cycle
            // the root walk).
            const shard = myActs.find((a) => a.id === myConsent.activity_id);
            if (shard && !shard.joined_from && shard.id !== it.activityId) {
              const { data: theirs } = await supabase
                .from("activities")
                .select("joined_from")
                .eq("id", it.activityId)
                .maybeSingle();
              if (theirs?.joined_from !== shard.id) {
                await supabase
                  .from("activities")
                  .update({ joined_from: it.activityId })
                  .eq("id", shard.id);
              }
            }
          } catch (e) {
            console.error("Cross-shard auto-accept failed:", e);
            kept.push(it); // fall back to the manual ask
          }
        }
        tagNudgeItems = kept;
      }
      return tagNudgeItems;
    })();

    // ---- Join requests: "[X] is here too — add them to your check-in?" ----
    // Self-requested tags on MY check-ins (requested_by = tagged user),
    // awaiting MY accept (their name renders nowhere until then).
    const joinReqP = (async () => {
      const reqItems = [];
      const { data: myActs } = await supabase
        .from("activities")
        .select("id, venue_id")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .gte(
          "created_at",
          new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()
        );
      if (!myActs || myActs.length === 0) return reqItems;
      const { data: reqs } = await supabase
        .from("activity_tags")
        .select("id, activity_id, tagged_user_id, requested_by, created_at, status")
        .in("activity_id", myActs.map((a) => a.id))
        .eq("status", "pending");
      const selfReqs = (reqs || []).filter(
        (t) => t.requested_by === t.tagged_user_id
      );
      if (selfReqs.length === 0) return reqItems;
      const actById = Object.fromEntries(myActs.map((a) => [a.id, a]));
      const uids = Array.from(new Set(selfReqs.map((t) => t.tagged_user_id)));
      const venueIds = Array.from(
        new Set(
          selfReqs
            .map((t) => actById[t.activity_id]?.venue_id)
            .filter(Boolean)
        )
      );
      const [profsRes, vensRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", uids),
        venueIds.length
          ? supabase.from("venues").select("id, name").in("id", venueIds)
          : { data: [] },
      ]);
      const pById = Object.fromEntries((profsRes.data || []).map((p) => [p.id, p]));
      const vNameById = Object.fromEntries(
        (vensRes.data || []).map((v) => [v.id, v.name])
      );
      for (const t of selfReqs) {
        reqItems.push({
          kind: "join_request",
          id: `jr_${t.id}`,
          tagId: t.id,
          activityId: t.activity_id,
          otherId: t.tagged_user_id,
          profile: pById[t.tagged_user_id] || null,
          venueName: vNameById[actById[t.activity_id]?.venue_id] || "your check-in",
          timestamp: t.created_at,
        });
      }
      return reqItems;
    })();

    // ---- Morning-after photo nudge: MY photoless check-ins, 12–36h old ----
    // The one deliberate self-item: prompts collection at the moment people
    // relive the night. Self-expires (window), disappears once photos exist.
    const photoNudgeP = (async () => {
      const nudgeItems = [];
      const from = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
      const to = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      const { data: acts } = await supabase
        .from("activities")
        .select("id, venue_id, label, created_at")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .gte("created_at", from)
        .lte("created_at", to);
      if (!acts || acts.length === 0) return nudgeItems;
      const [photosRes, vensRes] = await Promise.all([
        supabase
          .from("activity_photos")
          .select("activity_id")
          .in("activity_id", acts.map((a) => a.id)),
        supabase
          .from("venues")
          .select("*")
          .in("id", Array.from(new Set(acts.map((a) => a.venue_id)))),
      ]);
      const hasPhotos = new Set((photosRes.data || []).map((p) => p.activity_id));
      const venById = Object.fromEntries(
        (vensRes.data || []).map((v) => [v.id, v])
      );
      for (const a of acts) {
        if (hasPhotos.has(a.id)) continue;
        nudgeItems.push({
          kind: "photo_nudge",
          id: `pn_${a.id}`,
          activityId: a.id,
          ownerId: userId,
          venueObj: venById[a.venue_id] || null,
          venueName: venById[a.venue_id]?.name || "that spot",
          label: a.label || null,
          checkinTimestamp: a.created_at,
          // Surfaces as NEW the morning after, not buried at check-in time.
          timestamp: new Date(
            new Date(a.created_at).getTime() + 12 * 60 * 60 * 1000
          ).toISOString(),
        });
      }
      return nudgeItems;
    })();

    // ---- Session "Did you go?" nudge: decided sessions I hosted or joined,
    // surfaced the FOLLOWING MONDAY after the outing (event_at for planned
    // sessions, decision time for Right Now). Yes → backdated check-in +
    // photos; Not yet → dismissed (localStorage). Window: that one week.
    const sessionNudgeP = (async () => {
      const nudges = [];
      const sessIds = Array.from(
        new Set([
          ...hostedRows.map((s) => s.id),
          ...myPartRows.map((p) => p.session_id),
        ])
      );
      if (sessIds.length === 0) return nudges;
      const doneSet = readNudgesDone();
      const { data: sess } = await supabase
        .from("match_sessions")
        .select("id, name, decided_venue_id, decided_for, event_at, updated_at")
        .in("id", sessIds)
        .not("decided_venue_id", "is", null);
      const now = Date.now();
      const WEEK = 7 * 24 * 60 * 60 * 1000;
      // The outing's reference time: the PLAN'S when (decided_for) beats the
      // decide moment — a Tuesday plan locked on Sunday should nudge off
      // Tuesday, not Sunday. ref <= now keeps upcoming plans silent.
      const nudgeRef = (s) =>
        new Date(s.decided_for || s.event_at || s.updated_at).getTime();
      // Loose prefilter — the real window depends on the VENUE TYPE (café =
      // same afternoon, else following Monday), decided per candidate below.
      const candidates = (sess || []).filter((s) => {
        if (doneSet.has(s.id)) return false;
        const ref = nudgeRef(s);
        return ref <= now && now - ref < 16 * 24 * 60 * 60 * 1000;
      });
      if (candidates.length === 0) return nudges;
      // If they checked in near the outing, we already know they went.
      const { data: myCheckins } = await supabase
        .from("activities")
        .select("venue_id, created_at")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .in(
          "venue_id",
          Array.from(new Set(candidates.map((s) => s.decided_venue_id)))
        );
      // Venues read DIRECTLY (July 31 — Mark decided on a café at 11:31, no
      // nudge by 4:30). The old path resolved through the CURATED shortlist
      // RPC, which returns nothing for a Right Now session — so `type` was
      // undefined, the café test failed, and every Right Now café quietly
      // waited for Monday. Open venue reads (July 13) made the RPC workaround
      // unnecessary for signed-in users anyway.
      const { data: nudgeVens } = await supabase
        .from("venues")
        .select("*")
        .in(
          "id",
          Array.from(new Set(candidates.map((s) => s.decided_venue_id)))
        );
      const nudgeVenById = new Map((nudgeVens || []).map((v) => [v.id, v]));
      for (const s of candidates) {
        const ref = nudgeRef(s);
        const went = (myCheckins || []).some(
          (c) =>
            c.venue_id === s.decided_venue_id &&
            Math.abs(new Date(c.created_at).getTime() - ref) <
              48 * 60 * 60 * 1000
        );
        if (went) continue;
        const v = nudgeVenById.get(s.decided_venue_id) || null;
        const venueObj = v;
        const venueName = v?.name || "the spot you picked";
        // Café = same-afternoon ask; everything else waits for Monday.
        // Case-INSENSITIVE and loose on purpose: the data holds "cafe",
        // "Cafe" and could hold "Café" or "Coffee shop" — the second bug
        // behind the missing nudge was `=== "cafe"` failing on a capital C.
        const t = (v?.type || "").toLowerCase();
        const isDaytime = t.includes("caf") || t.includes("coffee");
        // DATED plan (decided_for meaningfully after the decide write) →
        // ask the morning after the night. Right-now decides keep the
        // outing-aware rule: café = same afternoon, else following Monday.
        const dated =
          s.decided_for &&
          new Date(s.decided_for).getTime() -
            new Date(s.updated_at).getTime() >
            60 * 60 * 1000;
        const start = dated
          ? morningAfter(ref)
          : isDaytime
          ? afternoonAfter(ref)
          : followingMonday(ref).getTime();
        if (now < start || now >= start + WEEK) continue;
        nudges.push({
          kind: "session_nudge",
          id: `sn_${s.id}`,
          sessionId: s.id,
          venueId: s.decided_venue_id,
          venueName,
          venueObj,
          sessionName: s.name || null,
          refTimestamp: s.event_at || s.updated_at,
          timestamp: new Date(start).toISOString(), // NEW when the ask opens
        });
      }
      return nudges;
    })();

    // ---- "[Friend] added [Name] as a friend" — social-graph news via the
    // friends_new_friendships SECURITY DEFINER RPC (friendships RLS is
    // party-only). 7-day window; errors (RPC not yet run) fail silent.
    const friendNewsP = (async () => {
      const newsItems = [];
      const since = new Date(
        Date.now() - 7 * 24 * 60 * 60 * 1000
      ).toISOString();
      const { data: rows, error } = await supabase.rpc(
        "friends_new_friendships",
        { p_since: since }
      );
      if (error || !rows || rows.length === 0) return newsItems;
      // Both-sides-my-friend pairs come back twice — dedupe by pair.
      const seenPair = new Set();
      const clean = rows
        .filter((r) => {
          const k = [r.friend_id, r.other_id].sort().join("_");
          if (seenPair.has(k)) return false;
          seenPair.add(k);
          return true;
        })
        .slice(0, 15);
      const ids = Array.from(
        new Set(clean.flatMap((r) => [r.friend_id, r.other_id]))
      );
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", ids);
      const pById = Object.fromEntries((profs || []).map((p) => [p.id, p]));
      for (const r of clean) {
        newsItems.push({
          kind: "friend_new_friend",
          id: `fnf_${[r.friend_id, r.other_id].sort().join("_")}`,
          friendId: r.friend_id,
          otherId: r.other_id,
          friendProfile: pById[r.friend_id] || null,
          otherProfile: pById[r.other_id] || null,
          timestamp: r.responded_at,
        });
      }
      return newsItems;
    })();

    // ---- Comments + reactions on MY check-ins ----
    const commentP = (async () => {
      // Comments + reactions across MY NIGHTS (July 25 doctrine, Mark-
      // approved): comments are conversation — every participant gets the
      // item, wherever in the night they landed. Reactions: card-level →
      // every participant; photo/comment reactions → only the author.
      // Night = my shard's root + one level (same walk as the photo items).
      let commentItems = [];
      let reactionItems = [];
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: myActs } = await supabase
        .from("activities")
        .select("id, venue_id, created_at, label, joined_from")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .gte("created_at", weekAgo);
      if (myActs && myActs.length > 0) {
        const cRootIds = Array.from(
          new Set(myActs.map((a) => a.joined_from || a.id))
        );
        const [cRootsRes, cKidsRes] = await Promise.all([
          supabase
            .from("activities")
            .select("id, joined_from")
            .in("id", cRootIds),
          supabase
            .from("activities")
            .select("id, joined_from")
            .in("joined_from", cRootIds),
        ]);
        const cActById = {};
        for (const a of [
          ...(cRootsRes.data || []),
          ...(cKidsRes.data || []),
          ...myActs,
        ])
          cActById[a.id] = a;
        const cNightIds = Object.keys(cActById).map(Number);
        const cRootOf = (id) => {
          const a = cActById[id];
          return a ? a.joined_from || a.id : id;
        };
        const myShardByRoot = {};
        for (const m of myActs) {
          const r = m.joined_from || m.id;
          if (!myShardByRoot[r]) myShardByRoot[r] = m;
        }
        const [cRes, rRes] = await Promise.all([
          supabase
            .from("activity_comments")
            .select("id, activity_id, user_id, body, created_at, photo_id")
            .in("activity_id", cNightIds)
            .neq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(20),
          supabase
            .from("activity_reactions")
            .select("id, activity_id, photo_id, comment_id, user_id, emoji, created_at")
            .in("activity_id", cNightIds)
            .neq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(30),
        ]);
        const cRows = (cRes.data || []).filter(
          (c) => myShardByRoot[cRootOf(c.activity_id)]
        );
        let rRows = (rRes.data || []).filter(
          (r) => myShardByRoot[cRootOf(r.activity_id)]
        );
        // Targeted reactions (photo/comment) are applause for the AUTHOR —
        // keep only the ones on MY content.
        const targeted = rRows.filter((r) => r.photo_id || r.comment_id);
        if (targeted.length > 0) {
          const phIds = Array.from(
            new Set(targeted.map((r) => r.photo_id).filter(Boolean))
          );
          const cmIds = Array.from(
            new Set(targeted.map((r) => r.comment_id).filter(Boolean))
          );
          const [phRes, cmRes] = await Promise.all([
            phIds.length
              ? supabase
                  .from("activity_photos")
                  .select("id, user_id")
                  .in("id", phIds)
              : Promise.resolve({ data: [] }),
            cmIds.length
              ? supabase
                  .from("activity_comments")
                  .select("id, user_id")
                  .in("id", cmIds)
              : Promise.resolve({ data: [] }),
          ]);
          const phOwner = Object.fromEntries(
            (phRes.data || []).map((x) => [x.id, x.user_id])
          );
          const cmOwner = Object.fromEntries(
            (cmRes.data || []).map((x) => [x.id, x.user_id])
          );
          rRows = rRows.filter((r) => {
            if (!r.photo_id && !r.comment_id) return true; // card-level
            const owner = r.photo_id ? phOwner[r.photo_id] : cmOwner[r.comment_id];
            return owner === userId;
          });
        }
        if (cRows.length > 0 || rRows.length > 0) {
          const personIds = Array.from(
            new Set([...cRows, ...rRows].map((x) => x.user_id))
          );
          const venueIds = Array.from(
            new Set(
              [...cRows, ...rRows]
                .map(
                  (x) => myShardByRoot[cRootOf(x.activity_id)]?.venue_id
                )
                .filter(Boolean)
            )
          );
          const [profsRes, venuesRes] = await Promise.all([
            supabase
              .from("profiles")
              .select("id, display_name, username, avatar_url")
              .in("id", personIds),
            venueIds.length
              ? supabase.from("venues").select("*").in("id", venueIds)
              : Promise.resolve({ data: [] }),
          ]);
          const profById2 = Object.fromEntries(
            (profsRes.data || []).map((p) => [p.id, p])
          );
          const vById = Object.fromEntries(
            (venuesRes.data || []).map((v) => [v.id, v])
          );
          // One item per NIGHT (latest comment shown), not one per comment.
          const seenAct = new Set();
          for (const c of cRows) {
            const root = cRootOf(c.activity_id);
            if (seenAct.has(root)) continue;
            seenAct.add(root);
            const shard = myShardByRoot[root];
            commentItems.push({
              kind: "checkin_comment",
              id: `cmt_${c.id}`,
              activityId: shard.id, // MY shard — card merges the cluster
              ownerId: userId,
              profile: profById2[c.user_id] || null,
              venueName: vById[shard.venue_id]?.name || "your check-in",
              venueObj: vById[shard.venue_id] || null,
              body: c.body,
              photoId: c.photo_id || null,
              label: shard.label || null,
              checkinTimestamp: shard.created_at,
              timestamp: c.created_at,
            });
          }
          // Same rule for reactions: latest per night.
          const seenRx = new Set();
          for (const r of rRows) {
            const root = cRootOf(r.activity_id);
            if (seenRx.has(root)) continue;
            seenRx.add(root);
            const shard = myShardByRoot[root];
            reactionItems.push({
              kind: "checkin_reaction",
              id: `rx_${r.id}`,
              activityId: shard.id,
              ownerId: userId,
              profile: profById2[r.user_id] || null,
              emoji: r.emoji,
              onPhoto: !!r.photo_id,
              photoId: r.photo_id || null,
              venueName: vById[shard.venue_id]?.name || "your check-in",
              venueObj: vById[shard.venue_id] || null,
              label: shard.label || null,
              checkinTimestamp: shard.created_at,
              timestamp: r.created_at,
            });
          }
        }
      }
      return [commentItems, reactionItems];
    })();

    // ---- Session invites a friend sent me (not ones I've already joined) ----
    const inviteP = (async () => {
      const myPartSessionIds = new Set(myPartRows.map((p) => p.session_id));
      const inviteRows = (invitesRes.data || []).filter(
        (r) => !myPartSessionIds.has(r.session_id)
      );
      let inviteItems = [];
      if (inviteRows.length === 0) return inviteItems;
      const inviterIds = Array.from(new Set(inviteRows.map((r) => r.inviter_id)));
      const invSessionIds = Array.from(new Set(inviteRows.map((r) => r.session_id)));
      const [inviterProfsRes, invSessRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", inviterIds),
        supabase.from("match_sessions").select("id, name").in("id", invSessionIds),
      ]);
      const inviterById = Object.fromEntries(
        (inviterProfsRes.data || []).map((p) => [p.id, p])
      );
      const sessNameById = Object.fromEntries(
        (invSessRes.data || []).map((s) => [s.id, s.name])
      );
      inviteItems = inviteRows.map((r) => {
        const inviter = inviterById[r.inviter_id];
        const inviterName =
          inviter?.display_name?.trim() ||
          (inviter?.username ? `@${inviter.username}` : "A friend");
        return {
          kind: "session_invite",
          id: `inv_${r.session_id}_${r.inviter_id}`,
          sessionId: r.session_id,
          inviterName,
          avatar: inviter?.avatar_url || null,
          sessionName: sessNameById[r.session_id] || "a session",
          timestamp: r.created_at,
        };
      });
      return inviteItems;
    })();

    // ---- Venue shares: "[X] shared [venue] with you" → opens the card ----
    const venueShareP = (async () => {
      const { data: rows } = await supabase
        .from("venue_shares")
        .select("id, from_user, venue_id, created_at")
        .eq("to_user", userId)
        .order("created_at", { ascending: false })
        .limit(10);
      if (!rows || rows.length === 0) return [];
      const fromIds = Array.from(new Set(rows.map((r) => r.from_user)));
      const vIds = Array.from(new Set(rows.map((r) => r.venue_id)));
      const [profsRes, vRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", fromIds),
        supabase.from("venues").select("*").in("id", vIds),
      ]);
      const pById = Object.fromEntries(
        (profsRes.data || []).map((p) => [p.id, p])
      );
      const vShareById = Object.fromEntries(
        (vRes.data || []).map((v) => [v.id, v])
      );
      return rows
        .filter((r) => vShareById[r.venue_id])
        .map((r) => ({
          kind: "venue_share",
          id: `vshare_${r.id}`,
          otherId: r.from_user,
          profile: pById[r.from_user] || null,
          venueName: vShareById[r.venue_id]?.name || "a spot",
          venueObj: vShareById[r.venue_id] || null,
          timestamp: r.created_at,
        }));
    })();

    // ---- New photos on MY nights (July 25 v2): "[Name] added N photos at
    // [venue]". Covers BOTH via-link guests (photos parked on my shard) and
    // participants uploading from the card (photos on THEIR shard in my
    // night) — the in-app path was silent (Mark's field test). Night = my
    // shard's root + one level, same walk as meet-people. ----
    const guestUploadP = (async () => {
      const since = new Date(Date.now() - 7 * 864e5).toISOString();
      const { data: mineRows } = await supabase
        .from("activities")
        .select("id, venue_id, label, joined_from, created_at")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .gte("created_at", new Date(Date.now() - 30 * 864e5).toISOString())
        .order("created_at", { ascending: false })
        .limit(10);
      const myShards = mineRows || [];
      if (myShards.length === 0) return [];
      const guRootIds = Array.from(
        new Set(myShards.map((a) => a.joined_from || a.id))
      );
      const [guRootsRes, guKidsRes] = await Promise.all([
        supabase
          .from("activities")
          .select("id, user_id, joined_from")
          .in("id", guRootIds),
        supabase
          .from("activities")
          .select("id, user_id, joined_from")
          .in("joined_from", guRootIds),
      ]);
      const gActById = {};
      for (const a of [
        ...(guRootsRes.data || []),
        ...(guKidsRes.data || []),
        ...myShards,
      ])
        gActById[a.id] = a;
      const nightIds = Object.keys(gActById).map(Number);
      const { data: ph } = await supabase
        .from("activity_photos")
        .select("id, activity_id, user_id, created_at")
        .in("activity_id", nightIds)
        .neq("user_id", userId)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(30);
      if (!ph || ph.length === 0) return [];
      const rootOf = (id) => {
        const a = gActById[id];
        return a ? a.joined_from || a.id : id;
      };
      const myShardByRoot = {};
      for (const m of myShards) {
        const r = m.joined_from || m.id;
        if (!myShardByRoot[r]) myShardByRoot[r] = m;
      }
      // One item per (night, uploader): count + newest photo for deep-link.
      const groups = new Map();
      for (const r of ph) {
        const root = rootOf(r.activity_id);
        if (!myShardByRoot[root]) continue;
        const k = `${root}_${r.user_id}`;
        const g =
          groups.get(k) || {
            count: 0,
            latest: r.created_at,
            photoId: r.id,
            root,
            user_id: r.user_id,
          };
        g.count += 1;
        if (r.created_at > g.latest) {
          g.latest = r.created_at;
          g.photoId = r.id;
        }
        groups.set(k, g);
      }
      const list = Array.from(groups.values());
      if (list.length === 0) return [];
      const upIds = Array.from(new Set(list.map((g) => g.user_id)));
      const gVenueIds = Array.from(
        new Set(
          list
            .map((g) => myShardByRoot[g.root]?.venue_id)
            .filter(Boolean)
        )
      );
      const [profsRes, vRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", upIds),
        gVenueIds.length
          ? supabase.from("venues").select("*").in("id", gVenueIds)
          : { data: [] },
      ]);
      const gpById = Object.fromEntries(
        (profsRes.data || []).map((p) => [p.id, p])
      );
      const gvById = Object.fromEntries(
        (vRes.data || []).map((v) => [v.id, v])
      );
      return list.map((g) => {
        const shard = myShardByRoot[g.root];
        return {
          kind: "guest_upload",
          id: `gup_${g.root}_${g.user_id}`,
          activityId: shard.id, // open the card as MY shard; cluster merges
          ownerId: userId,
          photoId: g.photoId,
          count: g.count,
          profile: gpById[g.user_id] || null,
          venueId: shard.venue_id,
          venueName: gvById[shard.venue_id]?.name || "your check-in",
          venueObj: gvById[shard.venue_id] || null,
          label: shard.label || null,
          timestamp: g.latest,
        };
      });
    })();

    // ---- Meet the people from your check-ins (July 25, Mark): for each
    // recent night of MINE with other participants, one item listing
    // everyone — Add buttons for non-friends, display-only for friends.
    // Surfaces only while someone's still addable; ages out after 14 days.
    const meetPeopleP = (async () => {
      const since = new Date(Date.now() - 14 * 864e5).toISOString();
      const { data: mine } = await supabase
        .from("activities")
        .select("id, venue_id, joined_from, created_at")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(5);
      if (!mine || mine.length === 0) return [];
      // Night members, one level around each shard: parent (or self) +
      // direct joins + accepted tags. Deep chains are rare; the card
      // handles them — this is a nudge, not the source of truth.
      const rootIds = Array.from(
        new Set(mine.map((a) => a.joined_from || a.id))
      );
      const [rootsRes, kidsRes] = await Promise.all([
        supabase
          .from("activities")
          .select("id, user_id, joined_from")
          .in("id", rootIds),
        supabase
          .from("activities")
          .select("id, user_id, joined_from")
          .in("joined_from", rootIds),
      ]);
      const nightActs = [...(rootsRes.data || []), ...(kidsRes.data || [])];
      const allActIds = Array.from(
        new Set([...nightActs.map((a) => a.id), ...mine.map((a) => a.id)])
      );
      const { data: tagRows2 } = await supabase
        .from("activity_tags")
        .select("activity_id, tagged_user_id")
        .in("activity_id", allActIds)
        .eq("status", "accepted");
      // My standing with everyone (accepted + pending, either direction).
      const { data: frRows } = await supabase
        .from("friendships")
        .select("requester_id, addressee_id, status")
        .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`);
      const relById = {};
      for (const f of frRows || []) {
        const other =
          f.requester_id === userId ? f.addressee_id : f.requester_id;
        if (f.status === "accepted") relById[other] = "friend";
        // Direction-aware (July 25): they asked → Accept, I asked →
        // Requested. Same rule as the check-in card.
        else if (f.status === "pending" && !relById[other])
          relById[other] =
            f.requester_id === userId ? "pending_out" : "pending_in";
      }
      // Group people per night root.
      const peopleByRoot = new Map();
      const addPerson = (root, uid) => {
        if (!uid || uid === userId) return;
        if (!peopleByRoot.has(root)) peopleByRoot.set(root, new Set());
        peopleByRoot.get(root).add(uid);
      };
      const rootOf = (actId) => {
        const a =
          nightActs.find((x) => x.id === actId) ||
          mine.find((x) => x.id === actId);
        return a ? a.joined_from || a.id : actId;
      };
      for (const a of nightActs) addPerson(a.joined_from || a.id, a.user_id);
      for (const t of tagRows2 || [])
        addPerson(rootOf(t.activity_id), t.tagged_user_id);
      // Build one item per MY shard whose night has ≥1 non-friend.
      const candidates = [];
      const seenRoots = new Set();
      for (const m of mine) {
        const root = m.joined_from || m.id;
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        const people = Array.from(peopleByRoot.get(root) || []);
        if (people.length === 0) continue;
        if (!people.some((uid) => !relById[uid])) continue; // all connected
        candidates.push({ shard: m, people });
      }
      if (candidates.length === 0) return [];
      const pplIds = Array.from(
        new Set(candidates.flatMap((c) => c.people))
      );
      const mpVenueIds = Array.from(
        new Set(candidates.map((c) => c.shard.venue_id).filter(Boolean))
      );
      const [pplRes, mvRes] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, display_name, username, avatar_url")
          .in("id", pplIds),
        mpVenueIds.length
          ? supabase.from("venues").select("id, name").in("id", mpVenueIds)
          : { data: [] },
      ]);
      const mpProfById = Object.fromEntries(
        (pplRes.data || []).map((p) => [p.id, p])
      );
      const mvById = Object.fromEntries(
        (mvRes.data || []).map((v) => [v.id, v])
      );
      return candidates.map((c) => ({
        kind: "meet_people",
        id: `meet_${c.shard.joined_from || c.shard.id}`,
        activityId: c.shard.id,
        venueName: mvById[c.shard.venue_id]?.name || "your check-in",
        people: c.people.map((uid) => ({
          id: uid,
          profile: mpProfById[uid] || null,
          rel: relById[uid] || "none",
        })),
        timestamp: c.shard.created_at,
      }));
    })();

    // Everything lands together — one concurrent wave instead of a waterfall.
    // Each block is FUSED (July 25: one failing block was blanking the whole
    // drawer — Promise.all rejects as a unit). A failure logs its name and
    // contributes nothing; everyone else still renders.
    const fuse = (p, name, empty = []) =>
      p.catch((e) => {
        console.error(`Drawer block failed: ${name}`, e);
        return empty;
      });
    const [
      [incomingItems, acceptedItems],
      submittedItems,
      timeUpItems,
      decidedItems,
      connectItems,
      checkinItems,
      tagNudgeItems,
      [commentItems, reactionItems],
      inviteItems,
      photoNudgeItems,
      sessionNudgeItems,
      friendNewsItems,
      joinReqItems,
      venueShareItems,
      guestUploadItems,
      meetPeopleItems,
    ] = await Promise.all([
      fuse(requestsP, "requests", [[], []]),
      fuse(submittedP, "submitted"),
      fuse(timeUpP, "timeUp"),
      fuse(decidedP, "decided"),
      fuse(connectP, "connect"),
      fuse(checkinP, "checkins"),
      fuse(tagNudgeP, "tagNudges"),
      fuse(commentP, "comments", [[], []]),
      fuse(inviteP, "invites"),
      fuse(photoNudgeP, "photoNudges"),
      fuse(sessionNudgeP, "sessionNudges"),
      fuse(friendNewsP, "friendNews"),
      fuse(joinReqP, "joinReqs"),
      fuse(venueShareP, "venueShares"),
      fuse(guestUploadP, "guestUploads"),
      fuse(meetPeopleP, "meetPeople"),
    ]);

    const all = [
      ...incomingItems,
      ...acceptedItems,
      ...submittedItems,
      ...timeUpItems,
      ...decidedItems,
      ...connectItems,
      ...inviteItems,
      ...checkinItems,
      ...commentItems,
      ...reactionItems,
      ...tagNudgeItems,
      ...photoNudgeItems,
      ...sessionNudgeItems,
      ...friendNewsItems,
      ...joinReqItems,
      ...venueShareItems,
      ...guestUploadItems,
      ...meetPeopleItems,
    ]
      // Weight before recency (Mark, July 18): items that DEAL WITH the
      // person — a pending tag, a friend request — outrank ambient news no
      // matter their age. Tiers: 0 = act-on-me, 1 = invitations/own nudges,
      // 2 = everything else; newest-first inside a tier.
      .sort(
        (a, b) =>
          itemWeight(a) - itemWeight(b) ||
          new Date(b.timestamp) - new Date(a.timestamp)
      );
    await applyNightNames(all);
    drawerCache = { uid: userId, items: all };
    setItems(all);
  }

  // NAME THE NIGHT, NOT THE LEG (July 31, Mark: "should the notification also
  // mention the venues and not just one of them?").
  //
  // Every block above names an item after the shard the content landed on. On
  // a night that hopped venues that's the wrong handle: Renasha uploads at the
  // third bar and you get "Everleigh" — somewhere you may never have been,
  // since you went home after the first one. Listing the whole trail doesn't
  // fix it either; a drawer row is one short line and "A → B → C" truncates to
  // nothing.
  //
  // So a night is named by its ROOT: the title if it has one, otherwise where
  // it started, plus "+N" for the other stops. Short, stable, and it doesn't
  // change as the night grows.
  //
  // Done ONCE here rather than in a dozen builders, and only for shards that
  // actually have a joined_from — a single-venue night takes no new code path.
  // Wrapped whole: this is presentation, and it must never be the reason the
  // drawer comes back empty (the lesson behind fuse()).
  async function applyNightNames(all) {
    try {
      const ids = Array.from(
        new Set(all.map((i) => i.activityId).filter(Boolean))
      );
      if (ids.length === 0) return;
      const { data: acts } = await supabase
        .from("activities")
        .select("id, joined_from, label")
        .in("id", ids);
      const actById = new Map((acts || []).map((a) => [a.id, a]));
      const linked = (acts || []).filter((a) => a.joined_from);

      // night_root is SECURITY DEFINER and walks the chain for us. Only the
      // linked few, so this stays a handful of calls at most.
      const rootByAct = new Map();
      await Promise.all(
        linked.map(async (a) => {
          const { data: root } = await supabase.rpc("night_root", {
            p_activity_id: a.id,
          });
          if (root) rootByAct.set(a.id, root);
        })
      );
      const rootIds = Array.from(new Set(rootByAct.values()));

      let rootById = new Map();
      let vName = new Map();
      const legCount = new Map();
      if (rootIds.length > 0) {
        const [{ data: roots }, { data: legs }] = await Promise.all([
          supabase
            .from("activities")
            .select("id, venue_id, label")
            .in("id", rootIds),
          supabase
            .from("activities")
            .select("id, joined_from")
            .in("joined_from", rootIds),
        ]);
        rootById = new Map((roots || []).map((r) => [r.id, r]));
        for (const l of legs || []) {
          legCount.set(l.joined_from, (legCount.get(l.joined_from) || 0) + 1);
        }
        const venueIds = Array.from(
          new Set((roots || []).map((r) => r.venue_id).filter(Boolean))
        );
        if (venueIds.length > 0) {
          const { data: vens } = await supabase
            .from("venues")
            .select("id, name")
            .in("id", venueIds);
          vName = new Map((vens || []).map((v) => [v.id, v.name]));
        }
      }

      for (const item of all) {
        if (!item.activityId) continue;
        const rootId = rootByAct.get(item.activityId);
        const root = rootId ? rootById.get(rootId) : null;

        // Where the night STARTED, with "+N" for the other stops.
        if (root) {
          const base = vName.get(root.venue_id);
          if (base) {
            const extra = legCount.get(rootId) || 0;
            item.venueName = extra > 0 ? `${base} +${extra}` : base;
          }
        }

        // TITLE FIRST (Mark, July 31: "prioritise the rest of the app that
        // way"). These rows read as sentences — "added photos at X" — so the
        // title has to occupy the venue slot rather than trail after it, or
        // the sentence names a place when the night has a better name. The
        // separate label suffix is cleared so it can't print twice.
        const title = root?.label || actById.get(item.activityId)?.label;
        if (title) {
          item.venueName = title;
          item.label = null;
        }
      }
    } catch (e) {
      console.error("Night naming skipped:", e);
    }
  }

  // Accept an incoming request by USER (the meet-people rows know uids,
  // not friendship ids). Row-count-checked — a stale request surfaces.
  async function acceptRequestFrom(otherId) {
    setActing(otherId);
    const ok = await acceptFriendRequest(userId, otherId);
    setActing(null);
    showToast?.(ok ? "You're friends now" : "Couldn't accept that");
    if (ok) await load();
  }

  // Shared with every other surface — see lib/friendships.js. The declined-row
  // and 23505 handling that used to live here moved there wholesale.
  async function sendRequest(otherId) {
    setActing(otherId);
    const result = await sendFriendRequest(userId, otherId);
    setActing(null);
    showToast?.(friendRequestToast(result));
    if (result !== "error") await load();
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

  // Accept a tag: create YOUR OWN check-in, copying the venue, label, and the
  // ORIGINAL timestamp — a late accept lands as history ("checked in at"),
  // never a false live "is at" pin.
  async function acceptTag(item) {
    setActing(item.tagId);
    // DUPE GUARD (Mark + Renasha field test, July 21): "I'm here too" then
    // Accept created TWO check-ins — join guarded, accept didn't. If a
    // same-night check-in at this venue already exists, accepting just LINKS
    // it (tag accepted + reciprocal) instead of minting a twin.
    const ts = new Date(item.checkinTimestamp).getTime();
    const W = 12 * 60 * 60 * 1000;
    const { data: existing } = await supabase
      .from("activities")
      .select("id, joined_from")
      .eq("user_id", userId)
      .eq("venue_id", item.venueId)
      .eq("kind", "checkin")
      .gte("created_at", new Date(ts - W).toISOString())
      .lte("created_at", new Date(ts + W).toISOString())
      .limit(1);
    let act = existing?.[0] || null;
    let error = null;
    if (act) {
      // Adopt the existing check-in into the tagger's night (edge only).
      if (!act.joined_from && act.id !== item.activityId) {
        await supabase
          .from("activities")
          .update({ joined_from: item.activityId })
          .eq("id", act.id);
      }
    } else {
      const ins = await supabase
        .from("activities")
        .insert({
          user_id: userId,
          kind: "checkin",
          venue_id: item.venueId,
          label: item.label || null,
          created_at: item.checkinTimestamp,
          joined_from: item.activityId, // the night-graph edge
        })
        .select("id")
        .single();
      act = ins.data;
      error = ins.error;
    }
    if (!error) {
      await supabase
        .from("activity_tags")
        .update({ status: "accepted", responded_at: new Date().toISOString() })
        .eq("id", item.tagId);
      // Reciprocal tag: YOUR check-in says "with [tagger]" too — so your Been
      // list carries the companionship, not just theirs. Consent holds: they
      // tapped to tag you, you tapped to accept — both agreed to the
      // association. Inserted pre-accepted so it never nudges them back.
      if (act?.id) {
        // Upsert-ignore: the reciprocal may already exist (re-accepts,
        // linked-existing-check-in path).
        await supabase.from("activity_tags").upsert(
          {
            activity_id: act.id,
            tagged_user_id: item.otherId,
            status: "accepted",
            responded_at: new Date().toISOString(),
          },
          { onConflict: "activity_id,tagged_user_id", ignoreDuplicates: true }
        );
      }
      sendPush(
        item.otherId,
        "Tag accepted 🎉",
        `Your check-in at ${item.venueName} just got company`
      );
    }
    setActing(null);
    if (error) {
      console.error("Tag accept failed:", error);
      showToast?.("Couldn't check in");
      return;
    }
    await load();
    // Land them ON their new check-in with the camera tile waiting —
    // "Mark checked you in here — add photos" should end in adding photos.
    if (act?.id) {
      setThread({
        activityId: act.id,
        ownerId: userId,
        ownerName: "You",
        venueName: item.venueName,
        label: item.label || null,
        venueObj: item.venueObj || null,
        timestamp: item.checkinTimestamp,
      });
    }
  }

  // "Did you go?" → Yes: backdated check-in at the decided venue (lands in
  // Been, past the fresh window so no live pin), then the card opens with the
  // camera tile ready. Same mechanics as accepting a tag.
  async function sessionNudgeYes(item) {
    setActing(item.id);
    const { data: act, error } = await supabase
      .from("activities")
      .insert({
        user_id: userId,
        kind: "checkin",
        venue_id: item.venueId,
        created_at: item.refTimestamp,
      })
      .select("*")
      .single();
    setActing(null);
    if (error) {
      console.error("Session nudge check-in failed:", error);
      showToast?.("Couldn't add that");
      return;
    }
    markNudgeDone(item.sessionId);
    setItems((prev) => (prev || []).filter((i) => i.id !== item.id));
    setThread({
      activityId: act.id,
      ownerId: userId,
      ownerName: "You",
      venueName: item.venueName,
      venueObj: item.venueObj,
      timestamp: act.created_at,
    });
  }

  function sessionNudgeNo(item) {
    markNudgeDone(item.sessionId);
    setItems((prev) => (prev || []).filter((i) => i.id !== item.id));
  }

  // Join requests: the OWNER answers. Accept → their name joins your
  // with-line; decline → the request disappears (their shard stays in the
  // night either way — the edge was their consent, the name is yours).
  async function acceptJoinReq(item) {
    setActing(item.tagId);
    const { error } = await supabase
      .from("activity_tags")
      .update({ status: "accepted", responded_at: new Date().toISOString() })
      .eq("id", item.tagId);
    setActing(null);
    if (error) {
      console.error("Join request accept failed:", error);
      showToast?.("Couldn't add them");
      return;
    }
    sendPush(item.otherId, "You're on the check-in 🎉", `Added at ${item.venueName}`);
    await load();
  }

  async function declineJoinReq(item) {
    setActing(item.tagId);
    const { error } = await supabase
      .from("activity_tags")
      .delete()
      .eq("id", item.tagId);
    setActing(null);
    if (error) {
      console.error("Join request decline failed:", error);
      showToast?.("Couldn't update");
      return;
    }
    await load();
  }

  // Remove: strips your name off the tagger's check-in too.
  async function removeTag(item) {
    setActing(item.tagId);
    const { error } = await supabase
      .from("activity_tags")
      .update({ status: "removed", responded_at: new Date().toISOString() })
      .eq("id", item.tagId);
    setActing(null);
    if (error) {
      console.error("Tag remove failed:", error);
      showToast?.("Couldn't update");
      return;
    }
    await load();
  }

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

  // Show the first 10 (NEW first), "Show more" reveals the rest — trims
  // render work on long histories. (Query cost is unchanged; the item
  // blocks still run — the cache is what makes reopen instant.)
  // Tier-0 items (pending tags, friend requests) sit in the TOP section
  // until dealt with — "seen" doesn't dismiss something awaiting an answer.
  // DISMISSED items (Aug, Mark) are filtered here: tier-0 can't be
  // dismissed (an unanswered ask isn't noise), everything else carries a ✕.
  const visibleItems = (items || []).filter((i) => !dismissed.has(i.id));
  const allNew = visibleItems.filter(
    (i) => itemWeight(i) === 0 || new Date(i.timestamp) > lastSeen
  );
  const allEarlier = visibleItems.filter(
    (i) => itemWeight(i) !== 0 && new Date(i.timestamp) <= lastSeen
  );
  const newItems = allNew.slice(0, visibleCount);
  const earlierItems = allEarlier.slice(
    0,
    Math.max(0, visibleCount - newItems.length)
  );
  const hiddenCount =
    allNew.length + allEarlier.length - newItems.length - earlierItems.length;

  const body = (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
        <div className="flex items-center gap-2">
          {/* Clear all (Aug, Mark: "a way to dismiss notifications") —
              sweeps everything dismissable; unanswered asks (tier 0) stay. */}
          {visibleItems.some((i) => itemWeight(i) !== 0) && (
            <button
              type="button"
              onClick={() =>
                dismiss(
                  visibleItems
                    .filter((i) => itemWeight(i) !== 0)
                    .map((i) => i.id)
                )
              }
              className="text-xs font-medium text-neutral-500 hover:text-neutral-700 px-2 py-1"
            >
              Clear all
            </button>
          )}
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
      </div>

      {pushPrompt && (
        <div className="w-full rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] p-3 flex items-center gap-3 mb-3">
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#455d3b] text-white text-base">
            🔔
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[#2f3f29]">
              Turn on notifications
            </p>
            <p className="text-[11px] text-[#455d3b]">
              {pushPrompt === "need-install"
                ? "Add Flanit to your home screen first — then friends' reactions and check-ins reach you"
                : "Know when friends react, comment or check you in"}
            </p>
          </div>
          {pushPrompt === "need-install" ? (
            <a
              href="/install"
              className="shrink-0 rounded-full bg-[#455d3b] text-white text-xs font-medium px-3 py-1.5"
            >
              How
            </a>
          ) : (
            <button
              type="button"
              onClick={async () => {
                const r = await enablePush(userId);
                if (r === "granted") {
                  setPushPrompt(null);
                  showToast?.("Notifications on 🔔");
                } else if (r === "denied") {
                  setPushPrompt(null);
                } else {
                  showToast?.("Couldn't turn those on");
                }
              }}
              className="shrink-0 rounded-full bg-[#455d3b] text-white text-xs font-medium px-3 py-1.5"
            >
              Turn on
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setPushPrompt(null);
              try {
                localStorage.setItem("flanit_push_prompt_dismissed", "1");
              } catch {}
            }}
            className="shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-neutral-400 hover:bg-white"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {profileIncomplete && (
        <button
          type="button"
          onClick={onFinishProfile}
          className="w-full text-left rounded-2xl bg-[#edf2eb] border border-[#cdd9c6] p-3 flex items-center gap-3 mb-3 active:scale-[0.99] transition"
        >
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#455d3b] text-white">
            <UserPlus size={16} />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[#2f3f29]">Finish your profile</p>
            <p className="text-[11px] text-[#455d3b]">
              Add a username and photo so friends recognise you
            </p>
          </div>
          <span className="text-[#455d3b] text-lg leading-none shrink-0">›</span>
        </button>
      )}

      {items === null && (
        <p className="text-sm text-neutral-500 text-center py-8">Loading…</p>
      )}

      {items !== null && items.length === 0 && !profileIncomplete && (
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
              <div key={item.id} className="relative">
              {/* Per-item dismiss (Aug, Mark) — not on tier-0: an
                  unanswered ask has its own buttons, not a ✕. */}
              {itemWeight(item) !== 0 && (
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => dismiss([item.id])}
                  className="absolute top-1 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-full text-neutral-300 hover:text-neutral-500 hover:bg-neutral-100"
                >
                  <X size={13} />
                </button>
              )}
              <ActivityItem
                item={item}
                isNew
                acting={
                  acting === item.friendshipId ||
                  acting === item.otherId ||
                  acting === item.tagId ||
                  acting === item.id
                }
                onAccept={() => setStatus(item.friendshipId, "accepted")}
                onDecline={() => setStatus(item.friendshipId, "declined")}
                onAddFriend={() => sendRequest(item.otherId)}
                onAddAnyFriend={(uid) => sendRequest(uid)}
                onAcceptAnyFriend={(uid) => acceptRequestFrom(uid)}
                onAcceptTag={() => acceptTag(item)}
                onRemoveTag={() => removeTag(item)}
                onSessionNudgeYes={() => sessionNudgeYes(item)}
                onSessionNudgeNo={() => sessionNudgeNo(item)}
                onAcceptJoinReq={() => acceptJoinReq(item)}
                onDeclineJoinReq={() => declineJoinReq(item)}
                onOpenProfile={onOpenProfile}
                onOpenSession={onOpenSession}
                onOpenVenue={onOpenVenue}
                onOpenThread={setThread}
              />
              </div>
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
              <div key={item.id} className="relative">
              {itemWeight(item) !== 0 && (
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => dismiss([item.id])}
                  className="absolute top-1 right-1 z-10 flex h-6 w-6 items-center justify-center rounded-full text-neutral-300 hover:text-neutral-500 hover:bg-neutral-100"
                >
                  <X size={13} />
                </button>
              )}
              <ActivityItem
                item={item}
                acting={
                  acting === item.friendshipId ||
                  acting === item.otherId ||
                  acting === item.tagId ||
                  acting === item.id
                }
                onAccept={() => setStatus(item.friendshipId, "accepted")}
                onDecline={() => setStatus(item.friendshipId, "declined")}
                onAddFriend={() => sendRequest(item.otherId)}
                onAddAnyFriend={(uid) => sendRequest(uid)}
                onAcceptAnyFriend={(uid) => acceptRequestFrom(uid)}
                onAcceptTag={() => acceptTag(item)}
                onRemoveTag={() => removeTag(item)}
                onSessionNudgeYes={() => sessionNudgeYes(item)}
                onSessionNudgeNo={() => sessionNudgeNo(item)}
                onAcceptJoinReq={() => acceptJoinReq(item)}
                onDeclineJoinReq={() => declineJoinReq(item)}
                onOpenProfile={onOpenProfile}
                onOpenSession={onOpenSession}
                onOpenVenue={onOpenVenue}
                onOpenThread={setThread}
              />
              </div>
            ))}
          </div>
        </>
      )}

      {hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setVisibleCount((c) => c + 20)}
          className="mt-3 w-full rounded-full border border-neutral-200 bg-white py-2.5 text-xs font-medium text-neutral-600 active:scale-[0.99] transition"
        >
          Show {hiddenCount} more
        </button>
      )}

      {thread && (
        <CheckinThreadSheet
          thread={thread}
          userId={userId}
          showToast={showToast}
          onClose={() => {
            setThread(null);
            load(); // refresh comment counts / items after the conversation
          }}
          onOpenProfile={(uid) => {
            // Lookup renders ABOVE the card — keep the card open so Back
            // returns exactly here. Close only for self (Profile tab).
            if (uid === userId) setThread(null);
            onOpenProfile?.(uid);
          }}
          onOpenVenue={(v) => {
            // Thread stays open underneath; the venue card stacks above it.
            onOpenVenue?.(v);
          }}
          onCheckIn={onCheckIn}
        />
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
function ActivityItem({ item, isNew, acting, onAccept, onDecline, onAddFriend, onAddAnyFriend, onAcceptAnyFriend, onAcceptTag, onRemoveTag, onSessionNudgeYes, onSessionNudgeNo, onAcceptJoinReq, onDeclineJoinReq, onOpenProfile, onOpenSession, onOpenVenue, onOpenThread }) {
  // In-card timestamp (July 25, Mark: 'it should go here') — appended to
  // each card's own meta line instead of floating in a corner.
  const when = whenLabel(item.timestamp);
  const whenSuffix = when ? ` \u00b7 ${when}` : "";
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
              <p className="text-[11px] text-neutral-500 truncate">{handle}{whenSuffix}</p>
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
            <p className="text-[11px] text-neutral-500 truncate">{handle}{whenSuffix}</p>
          )}
        </div>
        <Check size={16} className="text-[#455d3b]" />
      </button>
    );
  }

  if (item.kind === "session_invite") {
    return (
      <button
        type="button"
        onClick={() => window.location.assign(`/s/${item.sessionId}`)}
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        {item.avatar ? (
          <img
            src={item.avatar}
            alt={item.inviterName}
            className="h-9 w-9 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#455d3b] text-white">
            <UserPlus size={16} />
          </span>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            <strong className="font-medium">{item.inviterName}</strong> invited you to a session
          </p>
          <p className="text-[11px] text-neutral-500 truncate">
            {item.sessionName} · tap to join{whenSuffix}
          </p>
        </div>
        <span className="text-neutral-400 text-lg leading-none shrink-0">›</span>
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
          <p className="text-[11px] text-neutral-500 truncate">
            See if there's a match{item.sessionName ? ` · ${item.sessionName}` : ""}{whenSuffix}
          </p>
        </div>
        <span className="text-neutral-400 text-lg leading-none shrink-0">›</span>
      </button>
    );
  }

  if (item.kind === "session_timeup") {
    return (
      <button
        type="button"
        onClick={() => onOpenSession?.(item.sessionId)}
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#f0e6dc] text-[#6b5f54]">
          <Clock size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            Time's up on <strong className="font-medium">{item.sessionName}</strong>
          </p>
          <p className="text-[11px] text-neutral-500 truncate">
            {item.submitted} of {item.expected} sent picks — see the results
            {whenSuffix}
          </p>
        </div>
        <span className="text-neutral-400 text-lg leading-none shrink-0">›</span>
      </button>
    );
  }

  if (item.kind === "session_decided") {
    return (
      <button
        type="button"
        // The board, not the business card (Aug 1, Mark) — tap lands on the
        // results list with the pick pinned + highlighted and the plan's
        // time/date banner above it. Where + when in one view.
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
          {/* The plan's when leads the detail line (Aug 1 — a scheduled plan
              without its time told the recipient nothing actionable). Only
              shown when it's a real FUTURE slot; a right-now decide's
              timestamp adds nothing over the corner time. */}
          <p className="text-[11px] text-neutral-500 truncate">
            {item.decidedFor &&
            new Date(item.decidedFor).getTime() > Date.now() + 60 * 60 * 1000
              ? `${new Date(item.decidedFor).toLocaleDateString("en-AU", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                })} · ${new Date(item.decidedFor).toLocaleTimeString("en-AU", {
                  hour: "numeric",
                  minute: "2-digit",
                })} · `
              : ""}
            {item.sessionName}
            {whenSuffix}
          </p>
        </div>
        <span className="text-neutral-400 text-lg leading-none shrink-0">›</span>
      </button>
    );
  }

  if (item.kind === "tag_nudge") {
    // Consent nudge: you appear on the tagger's check-in (their audience);
    // accepting creates YOUR check-in, backdated to the original moment.
    const fresh =
      Date.now() - new Date(item.checkinTimestamp || item.timestamp).getTime() <
      3 * 60 * 60 * 1000;
    return (
      <div className={`rounded-2xl ${bg} border border-neutral-100 p-3`}>
        <button
          type="button"
          onClick={() => onOpenProfile?.(item.otherId)}
          className="w-full flex items-center gap-3 text-left mb-1.5"
        >
          <FriendAvatar profile={item.profile} small />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-neutral-900">
              <strong className="font-medium">{name}</strong> checked you in at{" "}
              <strong className="font-medium">{item.venueName}</strong>
              {item.label ? ` · ${item.label}` : ""}
            </p>
          </div>
        </button>
        <p className="mb-2.5 px-0.5 text-[11px] text-neutral-500">
          Accept and it's on your Been list too — add your photos and
          videos. Decline takes your name off {name}'s check-in.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={acting}
            onClick={onAcceptTag}
            className="flex-1 rounded-full bg-[#455d3b] text-white text-xs font-medium py-2 disabled:opacity-50"
          >
            {fresh ? "Accept — I'm here" : "Accept"}
          </button>
          <button
            type="button"
            disabled={acting}
            onClick={onRemoveTag}
            className="flex-1 rounded-full border border-neutral-300 text-xs font-medium py-2 disabled:opacity-50"
          >
            Decline
          </button>
        </div>
      </div>
    );
  }

  if (item.kind === "meet_people") {
    return (
      <div className={`rounded-2xl ${bg} border border-neutral-100 p-3`}>
        <p className="mb-2 text-sm text-neutral-900">
          You were at{" "}
          <strong className="font-medium">{item.venueName}</strong> — add the
          people from it{whenSuffix}
        </p>
        <div className="space-y-2">
          {item.people.map((p) => (
            <div key={p.id} className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => onOpenProfile?.(p.id)}
                className="flex flex-1 min-w-0 items-center gap-2.5 text-left"
              >
                <FriendAvatar profile={p.profile} small />
                <span className="truncate text-sm text-neutral-800">
                  {p.profile?.display_name || "Someone"}
                </span>
              </button>
              {p.rel === "friend" ? (
                <span className="shrink-0 text-[11px] font-medium text-neutral-400">
                  Friends ✓
                </span>
              ) : (
                <button
                  type="button"
                  disabled={p.rel === "pending_out" || acting}
                  onClick={() =>
                    p.rel === "pending_in"
                      ? onAcceptAnyFriend?.(p.id)
                      : onAddAnyFriend?.(p.id)
                  }
                  className="shrink-0 rounded-full bg-[#455d3b] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 active:scale-95 transition"
                >
                  {p.rel === "pending_in"
                    ? "Accept"
                    : p.rel === "pending_out"
                    ? "Requested"
                    : "Add"}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (item.kind === "guest_upload") {
    return (
      <div className={`rounded-2xl ${bg} border border-neutral-100 p-3`}>
        <button
          type="button"
          onClick={() =>
            onOpenThread?.({
              activityId: item.activityId,
              ownerId: item.ownerId,
              ownerName: "You",
              venueName: item.venueName,
              label: item.label || null,
              venueObj: item.venueObj || null,
              timestamp: item.timestamp,
              photoId: item.photoId, // lightbox deep-link
            })
          }
          className="flex w-full items-center gap-3 text-left"
        >
          <FriendAvatar profile={item.profile} small />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-neutral-900">
              <strong className="font-medium">{name}</strong> added{" "}
              {item.count === 1 ? "a photo" : `${item.count} photos`} to your
              check-in at{" "}
              <strong className="font-medium">{item.venueName}</strong>
            </p>
            <p className="text-[11px] text-[#455d3b]">Tap to see{whenSuffix}</p>
          </div>
        </button>
      </div>
    );
  }

  if (item.kind === "venue_share") {
    return (
      <div className={`rounded-2xl ${bg} border border-neutral-100 p-3`}>
        <button
          type="button"
          onClick={() => item.venueObj && onOpenVenue?.(item.venueObj)}
          className="flex w-full items-center gap-3 text-left"
        >
          <FriendAvatar profile={item.profile} small />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-neutral-900">
              <strong className="font-medium">{name}</strong> shared{" "}
              <strong className="font-medium">{item.venueName}</strong> with
              you
            </p>
            <p className="text-[11px] text-[#455d3b]">Tap to have a look{whenSuffix}</p>
          </div>
        </button>
      </div>
    );
  }

  if (item.kind === "friend_checkin") {
    // Present tense while plausibly still there (< 3h), past tense after.
    // Quiet check-ins (show_live off — Aug, Mark's toggle) are NEVER
    // present tense: presence is the toggle, not the timestamp.
    const fresh =
      item.showLive !== false &&
      Date.now() - new Date(item.timestamp).getTime() < 3 * 60 * 60 * 1000;
    return (
      <div className={`rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3`}>
        <button
          type="button"
          onClick={() =>
            onOpenThread?.({
              activityId: item.activityId,
              ownerId: item.otherId,
              ownerName: name,
              ownerProfile: item.profile || null,
              venueName: item.venueName,
              label: item.label || null,
              venueObj: item.venueObj || null,
              timestamp: item.timestamp,
            })
          }
          className="flex items-center gap-3 flex-1 min-w-0 text-left"
        >
          <FriendAvatar profile={item.profile} small />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-neutral-900">
              <strong className="font-medium">{name}</strong>{" "}
              {fresh ? "is at" : "checked in at"}{" "}
              <strong className="font-medium">{item.venueName}</strong>
              {item.label ? ` · ${item.label}` : ""}
              {item.withNames && item.withNames.length > 0
                ? ` · with ${item.withNames.join(", ")}`
                : ""}
            </p>
            {fresh ? (
              <p className="text-[11px] text-[#455d3b]">Right now · tap to open</p>
            ) : (
              when && <p className="text-[11px] text-neutral-400">{when}</p>
            )}
          </div>
        </button>
        <button
          type="button"
          aria-label="Comments"
          onClick={() =>
            onOpenThread?.({
              activityId: item.activityId,
              ownerId: item.otherId,
              ownerName: name,
              ownerProfile: item.profile || null,
              venueName: item.venueName,
              label: item.label || null,
              venueObj: item.venueObj || null,
              timestamp: item.timestamp,
            })
          }
          className="shrink-0 flex items-center gap-1 rounded-full border border-neutral-200 px-2.5 py-1.5 text-xs font-medium text-neutral-600 hover:bg-neutral-50 active:scale-95 transition"
        >
          <MessageCircle size={14} />
          {item.commentCount > 0 ? item.commentCount : ""}
        </button>
      </div>
    );
  }

  if (item.kind === "checkin_comment") {
    return (
      <button
        type="button"
        onClick={() =>
          onOpenThread?.({
            activityId: item.activityId,
            ownerId: item.ownerId,
            ownerName: "You",
            venueName: item.venueName,
            venueObj: item.venueObj || null,
            photoId: item.photoId || null, // photo comment → lightbox opens
            label: item.label || null,
            timestamp: item.checkinTimestamp || item.timestamp,
          })
        }
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <FriendAvatar profile={item.profile} small />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            <strong className="font-medium">{name}</strong> commented on your{" "}
            {item.photoId ? "photo" : "check-in"} at{" "}
            <strong className="font-medium">{item.venueName}</strong>
          </p>
          <p className="text-[11px] text-neutral-500 truncate">“{item.body}”{whenSuffix}</p>
        </div>
        <MessageCircle size={16} className="text-[#455d3b] shrink-0" />
      </button>
    );
  }

  if (item.kind === "join_request") {
    return (
      <div className={`rounded-2xl ${bg} border border-neutral-100 p-3`}>
        <button
          type="button"
          onClick={() => onOpenProfile?.(item.otherId)}
          className="w-full flex items-center gap-3 text-left mb-2.5"
        >
          <FriendAvatar profile={item.profile} small />
          <div className="flex-1 min-w-0">
            <p className="text-sm text-neutral-900">
              <strong className="font-medium">{name}</strong> is here too at{" "}
              <strong className="font-medium">{item.venueName}</strong>
            </p>
            <p className="text-[11px] text-neutral-500">
              Add them to your check-in? Your friends will see you're together.{whenSuffix}
            </p>
          </div>
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={acting}
            onClick={onAcceptJoinReq}
            className="flex-1 rounded-full bg-[#455d3b] text-white text-xs font-medium py-2 disabled:opacity-50"
          >
            Add them
          </button>
          <button
            type="button"
            disabled={acting}
            onClick={onDeclineJoinReq}
            className="flex-1 rounded-full border border-neutral-300 text-xs font-medium py-2 disabled:opacity-50"
          >
            Not this time
          </button>
        </div>
      </div>
    );
  }

  if (item.kind === "friend_new_friend") {
    const friendName =
      (item.friendProfile?.display_name || "A friend").split(" ")[0];
    const otherName =
      (item.otherProfile?.display_name || "someone").split(" ")[0];
    return (
      <button
        type="button"
        onClick={() => onOpenProfile?.(item.otherId)}
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <span className="flex shrink-0 -space-x-2">
          <FriendAvatar profile={item.friendProfile} small />
          <FriendAvatar profile={item.otherProfile} small />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            <strong className="font-medium">{friendName}</strong> added{" "}
            <strong className="font-medium">{otherName}</strong> as a friend
          </p>
          <p className="text-[11px] text-neutral-500">
            Tap to see {otherName}'s profile
          </p>
        </div>
      </button>
    );
  }

  if (item.kind === "session_nudge") {
    // Monday-after ask for a decided session. Yes → backdated check-in +
    // photos; Not yet → dismissed for good on this session.
    const when = new Date(item.refTimestamp).toLocaleDateString(undefined, {
      weekday: "long",
    });
    return (
      <div className={`rounded-2xl ${bg} border border-neutral-100 p-3`}>
        <div className="flex items-center gap-3 mb-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#edf2eb]">
            <MapPin size={17} className="text-[#455d3b]" />
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm text-neutral-900">
              Did you go to{" "}
              <strong className="font-medium">{item.venueName}</strong>?
            </p>
            <p className="text-[11px] text-neutral-500">
              {item.sessionName
                ? `Your pick from “${item.sessionName}”`
                : `Your session pick from ${when}`}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={acting}
            onClick={onSessionNudgeYes}
            className="flex-1 rounded-full bg-[#455d3b] text-white text-xs font-medium py-2 disabled:opacity-50"
          >
            Yes
          </button>
          <button
            type="button"
            disabled={acting}
            onClick={onSessionNudgeNo}
            className="flex-1 rounded-full border border-neutral-300 text-xs font-medium py-2 disabled:opacity-50"
          >
            Not yet
          </button>
        </div>
      </div>
    );
  }

  if (item.kind === "checkin_reaction") {
    return (
      <button
        type="button"
        onClick={() =>
          onOpenThread?.({
            activityId: item.activityId,
            ownerId: item.ownerId,
            ownerName: "You",
            venueName: item.venueName,
            venueObj: item.venueObj || null,
            photoId: item.photoId || null, // photo reaction → lightbox opens
            label: item.label || null,
            timestamp: item.checkinTimestamp || item.timestamp,
          })
        }
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <FriendAvatar profile={item.profile} small />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            <strong className="font-medium">{name}</strong> reacted {item.emoji}{" "}
            to your {item.onPhoto ? "photo" : "check-in"} at{" "}
            <strong className="font-medium">{item.venueName}</strong>
            {whenSuffix}
          </p>
        </div>
        <span className="text-lg shrink-0">{item.emoji}</span>
      </button>
    );
  }

  if (item.kind === "photo_nudge") {
    // Morning-after collection prompt: your own photoless check-in from last
    // night. Opens your check-in card, where the camera tile is waiting.
    return (
      <button
        type="button"
        onClick={() =>
          onOpenThread?.({
            activityId: item.activityId,
            ownerId: item.ownerId,
            ownerName: "You",
            venueName: item.venueName,
            venueObj: item.venueObj,
            label: item.label,
            timestamp: item.checkinTimestamp,
          })
        }
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#edf2eb]">
          <Camera size={17} className="text-[#455d3b]" />
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            Add photos from{" "}
            <strong className="font-medium">{item.venueName}</strong>?
          </p>
          <p className="text-[11px] text-neutral-500">
            Last night's check-in — while it's still fresh{whenSuffix}
          </p>
        </div>
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
          {item.avatar ? (
            <img
              src={item.avatar}
              alt={item.name}
              className="h-9 w-9 shrink-0 rounded-full object-cover"
            />
          ) : (
            <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#edf2eb] text-[#3f5a3a] text-sm font-medium">
              {(item.name || "?").charAt(0).toUpperCase()}
            </span>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm text-neutral-900">
              <strong className="font-medium">{item.name}</strong> was in your session{whenSuffix}
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