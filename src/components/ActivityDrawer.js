// Activity surface — renders as the Activity bottom tab (asTab) or the legacy
// right-side slide-in drawer. Items are derived on the fly from existing
// tables (no `notifications` table yet — that's D.5): friend requests (inline
// Accept/Decline), accepted-back, session invites, "sent their picks" (host),
// "you're going to X" (guest), and connect-with-session-people rows.
// NEW vs EARLIER split via a localStorage timestamp: `flanit_drawer_last_seen`.
// Items with their relevant timestamp after last_seen are NEW. Updated when
// the drawer closes. Extracted verbatim from App.js (July 10, 2026).
import { useState, useEffect } from "react";
import { X, UserPlus, Check, MapPin, MessageCircle } from "lucide-react";
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";
import { CheckinThreadSheet } from "./CheckinThreadSheet";

export function ActivityDrawer({ userId, onClose, onOpenProfile, onOpenSession, onOpenVenue, onCheckIn, profileIncomplete = false, onFinishProfile, showToast, asTab = false }) {
  const [items, setItems] = useState(null); // null = loading
  const [acting, setActing] = useState(null); // friendship.id mid-update
  const [thread, setThread] = useState(null); // open comment thread sheet
  const [lastSeen] = useState(() => {
    const stored = localStorage.getItem("flanit_drawer_last_seen");
    return stored ? new Date(stored) : new Date(0);
  });

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
    }

    // ---- Friend check-ins ("[Name] is at [venue]") — last 7 days ----
    const friendIds = Array.from(
      new Set(
        (myFriendsRes.data || []).map((f) =>
          f.requester_id === userId ? f.addressee_id : f.requester_id
        )
      )
    );
    let checkinItems = [];
    if (friendIds.length > 0) {
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
    }

    // ---- Tag nudges: "[Name] checked you in at [venue]" (pending only) ----
    let tagNudgeItems = [];
    {
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
            ? supabase.from("venues").select("id, name").in("id", venueIds)
            : { data: [] },
        ]);
        const tProfById = Object.fromEntries(
          (profsRes.data || []).map((p) => [p.id, p])
        );
        const vNameById2 = Object.fromEntries(
          (venuesRes.data || []).map((v) => [v.id, v.name])
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
              venueName: vNameById2[act.venue_id] || "a spot",
              label: act.label || null,
              checkinTimestamp: act.created_at,
              timestamp: t.created_at,
            };
          });
      }
    }

    // ---- Comments on MY check-ins ("[Name] commented on your check-in") ----
    let commentItems = [];
    {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: myActs } = await supabase
        .from("activities")
        .select("id, venue_id, created_at")
        .eq("user_id", userId)
        .eq("kind", "checkin")
        .gte("created_at", weekAgo);
      if (myActs && myActs.length > 0) {
        const { data: cRows } = await supabase
          .from("activity_comments")
          .select("id, activity_id, user_id, body, created_at")
          .in("activity_id", myActs.map((a) => a.id))
          .neq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(20);
        if (cRows && cRows.length > 0) {
          const actById = Object.fromEntries(myActs.map((a) => [a.id, a]));
          const commenterIds = Array.from(new Set(cRows.map((c) => c.user_id)));
          const venueIds = Array.from(
            new Set(cRows.map((c) => actById[c.activity_id]?.venue_id).filter(Boolean))
          );
          const [profsRes, venuesRes] = await Promise.all([
            supabase
              .from("profiles")
              .select("id, display_name, username, avatar_url")
              .in("id", commenterIds),
            supabase.from("venues").select("id, name").in("id", venueIds),
          ]);
          const profById2 = Object.fromEntries(
            (profsRes.data || []).map((p) => [p.id, p])
          );
          const vNameById = Object.fromEntries(
            (venuesRes.data || []).map((v) => [v.id, v.name])
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
              profile: profById2[c.user_id] || null,
              venueName: vNameById[act?.venue_id] || "your check-in",
              body: c.body,
              checkinTimestamp: act?.created_at,
              timestamp: c.created_at,
            });
          }
        }
      }
    }

    // ---- Session invites a friend sent me (not ones I've already joined) ----
    const myPartSessionIds = new Set(myPartRows.map((p) => p.session_id));
    const inviteRows = (invitesRes.data || []).filter(
      (r) => !myPartSessionIds.has(r.session_id)
    );
    let inviteItems = [];
    if (inviteRows.length > 0) {
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
    }

    const all = [
      ...incomingItems,
      ...acceptedItems,
      ...submittedItems,
      ...decidedItems,
      ...connectItems,
      ...inviteItems,
      ...checkinItems,
      ...commentItems,
      ...tagNudgeItems,
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

  // Accept a tag: create YOUR OWN check-in, copying the venue, label, and the
  // ORIGINAL timestamp — a late accept lands as history ("checked in at"),
  // never a false live "is at" pin.
  async function acceptTag(item) {
    setActing(item.tagId);
    const { error } = await supabase.from("activities").insert({
      user_id: userId,
      kind: "checkin",
      venue_id: item.venueId,
      label: item.label || null,
      created_at: item.checkinTimestamp,
    });
    if (!error) {
      await supabase
        .from("activity_tags")
        .update({ status: "accepted", responded_at: new Date().toISOString() })
        .eq("id", item.tagId);
    }
    setActing(null);
    if (error) {
      console.error("Tag accept failed:", error);
      showToast?.("Couldn't check in");
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
                  acting === item.tagId
                }
                onAccept={() => setStatus(item.friendshipId, "accepted")}
                onDecline={() => setStatus(item.friendshipId, "declined")}
                onAddFriend={() => sendRequest(item.otherId)}
                onAcceptTag={() => acceptTag(item)}
                onRemoveTag={() => removeTag(item)}
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
                  acting === item.tagId
                }
                onAccept={() => setStatus(item.friendshipId, "accepted")}
                onDecline={() => setStatus(item.friendshipId, "declined")}
                onAddFriend={() => sendRequest(item.otherId)}
                onAcceptTag={() => acceptTag(item)}
                onRemoveTag={() => removeTag(item)}
                onOpenProfile={onOpenProfile}
                onOpenSession={onOpenSession}
                onOpenVenue={onOpenVenue}
                onOpenThread={setThread}
              />
            ))}
          </div>
        </>
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
            setThread(null);
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
function ActivityItem({ item, isNew, acting, onAccept, onDecline, onAddFriend, onAcceptTag, onRemoveTag, onOpenProfile, onOpenSession, onOpenVenue, onOpenThread }) {
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
          You appear on {name}'s check-in to their friends. Check in too and
          yours will see it.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={acting}
            onClick={onAcceptTag}
            className="flex-1 rounded-full bg-[#455d3b] text-white text-xs font-medium py-2 disabled:opacity-50"
          >
            {fresh ? "I'm here too" : "Add to my history"}
          </button>
          <button
            type="button"
            disabled={acting}
            onClick={onRemoveTag}
            className="flex-1 rounded-full border border-neutral-300 text-xs font-medium py-2 disabled:opacity-50"
          >
            Remove me
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
            ownerName: "You",
            venueName: item.venueName,
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