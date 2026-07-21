// Activity surface — renders as the Activity bottom tab (asTab) or the legacy
// right-side slide-in drawer. Items are derived on the fly from existing
// tables (no `notifications` table yet — that's D.5): friend requests (inline
// Accept/Decline), accepted-back, session invites, "sent their picks" (host),
// "you're going to X" (guest), and connect-with-session-people rows.
// NEW vs EARLIER split via a localStorage timestamp: `flanit_drawer_last_seen`.
// Items with their relevant timestamp after last_seen are NEW. Updated when
// the drawer closes. Extracted verbatim from App.js (July 10, 2026).
import { useState, useEffect } from "react";
import { X, UserPlus, Check, MapPin, MessageCircle, Camera } from "lucide-react";

// Priority tiers for the Activity list (Mark, July 18): items that deal
// with the person directly outrank ambient news regardless of age.
const KIND_WEIGHT = {
  tag_nudge: 0, // someone checked you in — answer them
  request_received: 0, // friend request — answer them
  session_invite: 1,
  session_nudge: 1,
  photo_nudge: 1,
};
function itemWeight(i) {
  return KIND_WEIGHT[i.kind] ?? 2;
}

// Local midnight of the Monday strictly AFTER the given time — the session
// "Did you go?" nudge fires then (Mark: following Monday, no matter what).
function followingMonday(ts) {
  const d = new Date(ts);
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  m.setDate(m.getDate() + (((8 - m.getDay()) % 7) || 7));
  return m;
}
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";
import { CheckinThreadSheet } from "./CheckinThreadSheet";

// Last loaded items, module-level — reopening the tab paints instantly from
// this while load() refreshes in the background (stale-while-revalidate).
let drawerCache = null; // { uid, items }

export function ActivityDrawer({ userId, onClose, onOpenProfile, onOpenSession, onOpenVenue, onCheckIn, profileIncomplete = false, onFinishProfile, showToast, asTab = false }) {
  const [items, setItems] = useState(() =>
    drawerCache && drawerCache.uid === userId ? drawerCache.items : null
  ); // null = loading
  const [acting, setActing] = useState(null); // friendship.id mid-update
  const [thread, setThread] = useState(null); // open comment thread sheet
  const [visibleCount, setVisibleCount] = useState(10); // "Show more" paging
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

    // ---- Guest: a host's final pick on a session I'm in (not hosting) ----
    const myPartRows = myPartsRes.data || [];
    const decidedP = (async () => {
      let decidedItems = [];
      if (myPartRows.length === 0) return decidedItems;
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
        const { data: avRows } = await supabase
          .from("profiles")
          .select("id, avatar_url")
          .in("id", coIds);
        const avatarByUid = new Map(
          (avRows || []).filter((r) => r.avatar_url).map((r) => [r.id, r.avatar_url])
        );
        connectItems = coIds.map((uid) => {
          const p = coById.get(uid);
          return {
            kind: signedUp.has(uid) ? "connect_add" : "connect_invite",
            id: `con_${uid}`,
            otherId: uid,
            name: p.display_name || "Someone",
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
        .select("id, user_id, venue_id, created_at, label")
        .eq("kind", "checkin")
        .in("user_id", friendIds)
        .gte("created_at", weekAgo)
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
        // "with [names]" — tags on these check-ins (pending + accepted both
        // render on the tagger's item; removed never does).
        const withByActivity = {};
        {
          const { data: tRows } = await supabase
            .from("activity_tags")
            .select("activity_id, tagged_user_id, status")
            .in("activity_id", checkinRows.map((r) => r.id))
            .neq("status", "removed");
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
          timestamp: r.created_at,
        }));
      }
      return checkinItems;
    })();

    // ---- Tag nudges: "[Name] checked you in at [venue]" (pending only) ----
    const tagNudgeP = (async () => {
      let tagNudgeItems = [];
      const { data: tagRows } = await supabase
        .from("activity_tags")
        .select("id, activity_id, created_at")
        .eq("tagged_user_id", userId)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(10);
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
      return tagNudgeItems;
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
          venueName: venById[a.venue_id]?.name || "last night's spot",
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
        .select("id, name, decided_venue_id, event_at, updated_at")
        .in("id", sessIds)
        .not("decided_venue_id", "is", null);
      const now = Date.now();
      const WEEK = 7 * 24 * 60 * 60 * 1000;
      const candidates = (sess || []).filter((s) => {
        if (doneSet.has(s.id)) return false;
        const ref = new Date(s.event_at || s.updated_at).getTime();
        if (ref > now) return false; // outing hasn't happened yet
        const start = followingMonday(ref).getTime();
        return now >= start && now < start + WEEK;
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
      for (const s of candidates) {
        const ref = new Date(s.event_at || s.updated_at).getTime();
        const went = (myCheckins || []).some(
          (c) =>
            c.venue_id === s.decided_venue_id &&
            Math.abs(new Date(c.created_at).getTime() - ref) <
              48 * 60 * 60 * 1000
        );
        if (went) continue;
        // Shortlist RPC resolves the venue even if RLS would hide it.
        let venueName = "the spot you picked";
        let venueObj = null;
        const { data: vts } = await supabase.rpc(
          "get_session_shortlist_venues",
          { p_session_id: s.id }
        );
        const v = (vts || []).find((x) => x.id === s.decided_venue_id);
        if (v) {
          venueObj = v;
          venueName = v.name || venueName;
        }
        nudges.push({
          kind: "session_nudge",
          id: `sn_${s.id}`,
          sessionId: s.id,
          venueId: s.decided_venue_id,
          venueName,
          venueObj,
          sessionName: s.name || null,
          refTimestamp: s.event_at || s.updated_at,
          timestamp: followingMonday(ref).toISOString(), // NEW on Monday
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
      let commentItems = [];
      let reactionItems = [];
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: myActs } = await supabase
        .from("activities")
        .select("id, venue_id, created_at")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .gte("created_at", weekAgo);
      if (myActs && myActs.length > 0) {
        const actIds = myActs.map((a) => a.id);
        const [cRes, rRes] = await Promise.all([
          supabase
            .from("activity_comments")
            .select("id, activity_id, user_id, body, created_at")
            .in("activity_id", actIds)
            .neq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(20),
          supabase
            .from("activity_reactions")
            .select("id, activity_id, photo_id, user_id, emoji, created_at")
            .in("activity_id", actIds)
            .neq("user_id", userId)
            .order("created_at", { ascending: false })
            .limit(20),
        ]);
        const cRows = cRes.data || [];
        const rRows = rRes.data || []; // table may predate SQL run → just empty
        if (cRows.length > 0 || rRows.length > 0) {
          const actById = Object.fromEntries(myActs.map((a) => [a.id, a]));
          const personIds = Array.from(
            new Set([...cRows, ...rRows].map((x) => x.user_id))
          );
          const venueIds = Array.from(
            new Set(
              [...cRows, ...rRows]
                .map((x) => actById[x.activity_id]?.venue_id)
                .filter(Boolean)
            )
          );
          const [profsRes, venuesRes] = await Promise.all([
            supabase
              .from("profiles")
              .select("id, display_name, username, avatar_url")
              .in("id", personIds),
            supabase.from("venues").select("*").in("id", venueIds),
          ]);
          const profById2 = Object.fromEntries(
            (profsRes.data || []).map((p) => [p.id, p])
          );
          const vById = Object.fromEntries(
            (venuesRes.data || []).map((v) => [v.id, v])
          );
          // One item per check-in (latest comment shown), not one per comment.
          const seenAct = new Set();
          for (const c of cRows) {
            if (seenAct.has(c.activity_id)) continue;
            seenAct.add(c.activity_id);
            const act = actById[c.activity_id];
            commentItems.push({
              kind: "checkin_comment",
              id: `cmt_${c.id}`,
              activityId: c.activity_id,
              ownerId: userId, // it's YOUR check-in — enables add-photos in the card
              profile: profById2[c.user_id] || null,
              venueName: vById[act?.venue_id]?.name || "your check-in",
              venueObj: vById[act?.venue_id] || null, // venue link inside the card
              body: c.body,
              checkinTimestamp: act?.created_at,
              timestamp: c.created_at,
            });
          }
          // Same rule for reactions: latest per check-in.
          const seenRx = new Set();
          for (const r of rRows) {
            if (seenRx.has(r.activity_id)) continue;
            seenRx.add(r.activity_id);
            const act = actById[r.activity_id];
            reactionItems.push({
              kind: "checkin_reaction",
              id: `rx_${r.id}`,
              activityId: r.activity_id,
              ownerId: userId,
              profile: profById2[r.user_id] || null,
              emoji: r.emoji,
              onPhoto: !!r.photo_id,
              venueName: vById[act?.venue_id]?.name || "your check-in",
              venueObj: vById[act?.venue_id] || null,
              checkinTimestamp: act?.created_at,
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

    // Everything lands together — one concurrent wave instead of a waterfall.
    const [
      [incomingItems, acceptedItems],
      submittedItems,
      decidedItems,
      connectItems,
      checkinItems,
      tagNudgeItems,
      [commentItems, reactionItems],
      inviteItems,
      photoNudgeItems,
      sessionNudgeItems,
      friendNewsItems,
    ] = await Promise.all([
      requestsP,
      submittedP,
      decidedP,
      connectP,
      checkinP,
      tagNudgeP,
      commentP,
      inviteP,
      photoNudgeP,
      sessionNudgeP,
      friendNewsP,
    ]);

    const all = [
      ...incomingItems,
      ...acceptedItems,
      ...submittedItems,
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
    drawerCache = { uid: userId, items: all };
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

  // Accept a tag: create YOUR OWN check-in, copying the venue, label, and the
  // ORIGINAL timestamp — a late accept lands as history ("checked in at"),
  // never a false live "is at" pin.
  async function acceptTag(item) {
    setActing(item.tagId);
    const { data: act, error } = await supabase
      .from("activities")
      .insert({
        user_id: userId,
        kind: "checkin",
        venue_id: item.venueId,
        label: item.label || null,
        created_at: item.checkinTimestamp,
      })
      .select("id")
      .single();
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
        await supabase.from("activity_tags").insert({
          activity_id: act.id,
          tagged_user_id: item.otherId,
          status: "accepted",
          responded_at: new Date().toISOString(),
        });
      }
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
  const allNew = (items || []).filter(
    (i) => itemWeight(i) === 0 || new Date(i.timestamp) > lastSeen
  );
  const allEarlier = (items || []).filter(
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
              <ActivityItem
                key={item.id}
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
                onAcceptTag={() => acceptTag(item)}
                onRemoveTag={() => removeTag(item)}
                onSessionNudgeYes={() => sessionNudgeYes(item)}
                onSessionNudgeNo={() => sessionNudgeNo(item)}
                onOpenProfile={onOpenProfile}
                onOpenSession={onOpenSession}
                onOpenVenue={onOpenVenue}
                onOpenThread={setThread}
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
                acting={
                  acting === item.friendshipId ||
                  acting === item.otherId ||
                  acting === item.tagId ||
                  acting === item.id
                }
                onAccept={() => setStatus(item.friendshipId, "accepted")}
                onDecline={() => setStatus(item.friendshipId, "declined")}
                onAddFriend={() => sendRequest(item.otherId)}
                onAcceptTag={() => acceptTag(item)}
                onRemoveTag={() => removeTag(item)}
                onSessionNudgeYes={() => sessionNudgeYes(item)}
                onSessionNudgeNo={() => sessionNudgeNo(item)}
                onOpenProfile={onOpenProfile}
                onOpenSession={onOpenSession}
                onOpenVenue={onOpenVenue}
                onOpenThread={setThread}
              />
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
            setThread(null); // sheet sits above the profile screen
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
function ActivityItem({ item, isNew, acting, onAccept, onDecline, onAddFriend, onAcceptTag, onRemoveTag, onSessionNudgeYes, onSessionNudgeNo, onOpenProfile, onOpenSession, onOpenVenue, onOpenThread }) {
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
            {item.sessionName} · tap to join
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
          Accept and it's on your Been list too — add your photos and videos
          of the night. Decline takes your name off {name}'s check-in.
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

  if (item.kind === "friend_checkin") {
    // Present tense while plausibly still there (< 3h), past tense after.
    const fresh = Date.now() - new Date(item.timestamp).getTime() < 3 * 60 * 60 * 1000;
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
            {fresh && (
              <p className="text-[11px] text-[#455d3b]">Right now · tap to open</p>
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
            timestamp: item.checkinTimestamp || item.timestamp,
          })
        }
        className={`w-full text-left rounded-2xl ${bg} border border-neutral-100 p-3 flex items-center gap-3 hover:bg-neutral-50 active:scale-[0.99] transition`}
      >
        <FriendAvatar profile={item.profile} small />
        <div className="flex-1 min-w-0">
          <p className="text-sm text-neutral-900">
            <strong className="font-medium">{name}</strong> commented on your
            check-in at <strong className="font-medium">{item.venueName}</strong>
          </p>
          <p className="text-[11px] text-neutral-500 truncate">“{item.body}”</p>
        </div>
        <MessageCircle size={16} className="text-[#455d3b] shrink-0" />
      </button>
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
            Last night's check-in — while it's still fresh
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