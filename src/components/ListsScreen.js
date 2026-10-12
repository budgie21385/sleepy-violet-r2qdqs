// LISTS (Oct 12, 2026 — profile doctrine, Mark's My Lists mock, v1).
// The index: the three SYSTEM lists (Saved / Been / Haven't Been) wearing
// the custom-lists clothes — they're derived, not rows, which is why they
// can't be renamed or deleted. "Create a list" ships greyed with "soon":
// a feature promise, not a door (custom + collaborative lists are the
// next stage). Hidden-venue management moved to the settings cog.
// The detail: venue rows with photo, type/suburb/rating, your Been ×N and
// the friends who've been — the knowledge layer wearing list clothes.
// Row tap → the full venue card (with Plan).
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Bookmark } from "lucide-react";
import { supabase } from "../supabaseClient";
import { sendPush } from "../lib/push";
import { FriendAvatar } from "./FriendAvatar";
import { MapVenueSheet } from "./MapVenueSheet";
import { SPOT_CATEGORIES } from "./SpotSheet";

function Thumb({ v }) {
  const raw = v.primary_image || null;
  const src = raw
    ? raw.includes("googleapis.com")
      ? `/api/place-photo?url=${encodeURIComponent(raw)}`
      : raw
    : null;
  return (
    <span className="relative flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-[#edf2eb] text-sm font-semibold text-[#455d3b]">
      {(v.name || "?").charAt(0).toUpperCase()}
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </span>
  );
}

export function ListsScreen({
  userId,
  venues,
  savedIds,
  onUnsave,
  onBack,
  onCheckIn,
  onOpenThread,
  onOpenProfile,
  onOpenSpot,
  onViewOnMap,
  onListContext,
  showToast,
}) {
  // ONE humble inline button (Oct 12, Mark: "no floating bottom"; the
  // session pills died — sessions start from the +, which knows the open
  // list via onListContext and seeds the pool from it).
  const actionPills = (meta, ids) =>
    ids.length > 0 && (
      <div className="mb-3">
        <button
          type="button"
          onClick={() => onViewOnMap?.(meta, ids)}
          className="rounded-full bg-[#455d3b] px-3.5 py-2 text-xs font-medium text-white active:scale-95 transition"
        >
          🗺 View on map
        </button>
      </div>
    );
  const [list, setList] = useState(null); // null | "saved"|"been"|"not_been"|custom id (number)
  const [selectedVenue, setSelectedVenue] = useState(null);
  // CUSTOM LISTS (Oct 12 — stage 1 solo): owned + member lists, their
  // items, create/rename/privacy/delete. Adding venues happens through
  // the bookmark grammar on any venue card (hold = straight to a list).
  // MY SPOTS (Oct 12, Mark: "you did happen to miss the Spots list") —
  // own spots + ones saved from friends; rows open the SpotSheet.
  const [mySpots, setMySpots] = useState(null);
  const [customs, setCustoms] = useState(null); // [{id,name,emoji,is_public,owner_id,shared}]
  const [customItems, setCustomItems] = useState(new Map()); // listId -> [venueId]
  const [extraVenues, setExtraVenues] = useState(new Map()); // venues not in the pool
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  // STICKER (Oct 12, Mark: "a sticker with a border as the list display
  // item") — the emoji IS the sticker: white tile, olive border, a tilt.
  const [stickering, setStickering] = useState(false);
  const [stickerDraft, setStickerDraft] = useState("");
  // COLLABORATORS (Oct 12, stage 2 — "list with Tiff means they can both
  // edit"): owner invites friends as members; members add/remove venues;
  // the list appears in THEIR index too. Direct add + a push (no consent
  // gate v1 — being on a list is low-stakes; revisit if it's ever not).
  const [inviteOpen, setInviteOpen] = useState(false);
  const [friendProfiles, setFriendProfiles] = useState(null);
  const [members, setMembers] = useState([]); // profiles of activeCustom's members
  const [memberBusy, setMemberBusy] = useState(false);
  const [deleteArm, setDeleteArm] = useState(false);
  const [listsTick, setListsTick] = useState(0);
  // My been venue ids (marks + own check-ins with counts).
  const [beenData, setBeenData] = useState(null); // {counts: Map, ids: Set}
  // Friends who've been, per venue (avatars on rows).
  const [friendsAt, setFriendsAt] = useState(new Map());

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const [{ data: marks }, { data: acts }, { data: fr }] =
        await Promise.all([
          supabase
            .from("been_marks")
            .select("venue_id")
            .eq("user_id", userId),
          supabase
            .from("activities")
            .select("venue_id")
            .eq("user_id", userId)
            .eq("kind", "checkin")
            .not("venue_id", "is", null)
            .lte("created_at", new Date().toISOString())
            .limit(500),
          supabase
            .from("friendships")
            .select("requester_id, addressee_id")
            .eq("status", "accepted")
            .or(`requester_id.eq.${userId},addressee_id.eq.${userId}`),
        ]);
      const counts = new Map();
      for (const a of acts || []) {
        counts.set(a.venue_id, (counts.get(a.venue_id) || 0) + 1);
      }
      const ids = new Set([
        ...(marks || []).map((m) => m.venue_id),
        ...counts.keys(),
      ]);
      if (cancelled) return;
      setBeenData({ counts, ids });

      // Friends' presence at venues — marks + past check-ins, capped.
      const friendIds = Array.from(
        new Set(
          (fr || []).map((f) =>
            f.requester_id === userId ? f.addressee_id : f.requester_id
          )
        )
      );
      if (friendIds.length === 0) return;
      const [{ data: fMarks }, { data: fActs }, { data: profs }] =
        await Promise.all([
          supabase
            .from("been_marks")
            .select("venue_id, user_id")
            .in("user_id", friendIds)
            .limit(500),
          supabase
            .from("activities")
            .select("venue_id, user_id")
            .in("user_id", friendIds)
            .eq("kind", "checkin")
            .not("venue_id", "is", null)
            .lte("created_at", new Date().toISOString())
            .limit(500),
          supabase
            .from("profiles")
            .select("id, display_name, avatar_url")
            .in("id", friendIds),
        ]);
      const pById = Object.fromEntries((profs || []).map((p) => [p.id, p]));
      const at = new Map();
      for (const r of [...(fMarks || []), ...(fActs || [])]) {
        if (!r.venue_id) continue;
        if (!at.has(r.venue_id)) at.set(r.venue_id, new Map());
        const m = at.get(r.venue_id);
        if (!m.has(r.user_id) && pById[r.user_id])
          m.set(r.user_id, pById[r.user_id]);
      }
      if (!cancelled)
        setFriendsAt(
          new Map(
            Array.from(at.entries()).map(([vid, m]) => [
              vid,
              Array.from(m.values()),
            ])
          )
        );
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Own + saved spots for the Spots system list.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const [{ data: own }, { data: saves }] = await Promise.all([
        supabase
          .from("spots")
          .select("*")
          .eq("user_id", userId)
          .order("created_at", { ascending: false })
          .limit(100),
        supabase.from("spot_saves").select("spot_id").eq("user_id", userId),
      ]);
      let savedSpots = [];
      const saveIds = (saves || []).map((s) => s.spot_id);
      if (saveIds.length > 0) {
        const { data: sp } = await supabase
          .from("spots")
          .select("*")
          .in("id", saveIds);
        savedSpots = (sp || []).filter((s) => s.user_id !== userId);
      }
      if (!cancelled) setMySpots([...(own || []), ...savedSpots]);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Custom lists + their items (one items query across all writable
  // lists — counts AND detail rows from the same data).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    (async () => {
      const [{ data: ls }, { data: mem }] = await Promise.all([
        supabase
          .from("venue_lists")
          .select("id, name, emoji, is_public, owner_id")
          .order("created_at", { ascending: true }),
        supabase
          .from("venue_list_members")
          .select("list_id")
          .eq("user_id", userId),
      ]);
      if (cancelled) return;
      const memberIds = new Set((mem || []).map((m) => m.list_id));
      const mine = (ls || [])
        .filter((l) => l.owner_id === userId || memberIds.has(l.id))
        .map((l) => ({ ...l, shared: l.owner_id !== userId }));
      setCustoms(mine);
      const ids = mine.map((l) => l.id);
      if (ids.length === 0) {
        setCustomItems(new Map());
        return;
      }
      const { data: items } = await supabase
        .from("venue_list_items")
        .select("list_id, venue_id")
        .in("list_id", ids);
      if (cancelled) return;
      const byList = new Map();
      for (const i of items || []) {
        if (!byList.has(i.list_id)) byList.set(i.list_id, []);
        byList.get(i.list_id).push(i.venue_id);
      }
      setCustomItems(byList);
      // Venues missing from the bootstrap pool (e.g. a friend's add).
      const poolIds = new Set((venues || []).map((v) => v.id));
      const missing = Array.from(
        new Set((items || []).map((i) => i.venue_id))
      ).filter((id) => !poolIds.has(id));
      if (missing.length > 0) {
        const { data: vens } = await supabase
          .from("venues")
          .select("*")
          .in("id", missing);
        if (!cancelled)
          setExtraVenues(new Map((vens || []).map((v) => [v.id, v])));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, venues, listsTick]);

  async function createList() {
    const name = newName.trim();
    if (!name) return;
    const { error } = await supabase
      .from("venue_lists")
      .insert({ owner_id: userId, name });
    if (error) {
      console.error("List create failed:", error);
      showToast?.("Couldn't create the list");
      return;
    }
    setNewName("");
    setCreating(false);
    setListsTick((n) => n + 1);
  }

  // Tell the app which VENUE list is open (Oct 12) — the + reads this:
  // its We-can't-decide wears the list and seeds the session pool from
  // it. Spots and the index report nothing; cleared on unmount.
  useEffect(() => {
    let ctx = null;
    if (list === "saved" || list === "been" || list === "not_been") {
      const sys = {
        saved: { name: "Saved", emoji: "🔖", rows: savedList },
        been: { name: "Been", emoji: "✔️", rows: beenList },
        not_been: { name: "Haven't Been", emoji: "⏳", rows: notBeenList },
      }[list];
      ctx = {
        name: sys.name,
        emoji: sys.emoji,
        ids: sys.rows.map((v) => v.id),
      };
    } else if (typeof list === "number") {
      const l = (customs || []).find((x) => x.id === list);
      if (l)
        ctx = {
          name: l.name,
          emoji: l.emoji || "📍",
          ids: customItems.get(l.id) || [],
        };
    }
    onListContext?.(ctx && ctx.ids.length > 0 ? ctx : null);
  }, [list, customs, customItems, savedIds, beenData]);
  useEffect(() => () => onListContext?.(null), []);

  const activeCustom =
    typeof list === "number" ? (customs || []).find((l) => l.id === list) : null;

  async function renameList() {
    const name = renameDraft.trim();
    if (!name || !activeCustom) return;
    const { error } = await supabase
      .from("venue_lists")
      .update({ name })
      .eq("id", activeCustom.id);
    if (!error) {
      setRenaming(false);
      setListsTick((n) => n + 1);
    } else showToast?.("Couldn't rename");
  }
  // Members of the open custom list (avatars + the invite sheet's state).
  useEffect(() => {
    setMembers([]);
    if (!activeCustom) return;
    let cancelled = false;
    (async () => {
      const { data: mem } = await supabase
        .from("venue_list_members")
        .select("user_id")
        .eq("list_id", activeCustom.id);
      const ids = (mem || []).map((m) => m.user_id);
      if (ids.length === 0 || cancelled) return;
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, avatar_url")
        .in("id", ids);
      if (!cancelled) setMembers(profs || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCustom?.id, listsTick]);

  async function loadFriends() {
    if (friendProfiles !== null) return;
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
      setFriendProfiles([]);
      return;
    }
    const { data: profs } = await supabase
      .from("profiles")
      .select("id, display_name, avatar_url")
      .in("id", ids)
      .order("display_name", { ascending: true });
    setFriendProfiles(profs || []);
  }

  async function addMember(p) {
    if (!activeCustom || memberBusy) return;
    setMemberBusy(true);
    const { error } = await supabase
      .from("venue_list_members")
      .insert({ list_id: activeCustom.id, user_id: p.id });
    setMemberBusy(false);
    if (error && error.code !== "23505") {
      console.error("Invite failed:", error);
      showToast?.("Couldn't add them");
      return;
    }
    setMembers((prev) =>
      prev.some((m) => m.id === p.id) ? prev : [...prev, p]
    );
    sendPush(
      p.id,
      "You're on a list 📍",
      `${activeCustom.name}. You can both add places now`,
      "/",
      { kind: "list_invite" }
    );
  }

  async function removeMember(p) {
    if (!activeCustom || memberBusy) return;
    setMemberBusy(true);
    const { error } = await supabase
      .from("venue_list_members")
      .delete()
      .eq("list_id", activeCustom.id)
      .eq("user_id", p.id);
    setMemberBusy(false);
    if (!error) setMembers((prev) => prev.filter((m) => m.id !== p.id));
  }

  async function saveSticker() {
    // Grab the first grapheme-ish chunk — enough for any emoji.
    const e = stickerDraft.trim().slice(0, 4);
    if (!e || !activeCustom) return;
    const { error } = await supabase
      .from("venue_lists")
      .update({ emoji: e })
      .eq("id", activeCustom.id);
    if (!error) {
      setStickering(false);
      setStickerDraft("");
      setListsTick((n) => n + 1);
    } else showToast?.("Couldn't change the sticker");
  }
  async function togglePublic() {
    if (!activeCustom) return;
    const { error } = await supabase
      .from("venue_lists")
      .update({ is_public: !activeCustom.is_public })
      .eq("id", activeCustom.id);
    if (!error) setListsTick((n) => n + 1);
  }
  async function deleteList() {
    if (!activeCustom) return;
    const { error } = await supabase
      .from("venue_lists")
      .delete()
      .eq("id", activeCustom.id);
    if (!error) {
      setMenuOpen(false);
      setDeleteArm(false);
      setList(null);
      setListsTick((n) => n + 1);
    } else showToast?.("Couldn't delete");
  }
  async function removeItem(venueId) {
    if (!activeCustom) return;
    await supabase
      .from("venue_list_items")
      .delete()
      .eq("list_id", activeCustom.id)
      .eq("venue_id", venueId);
    setListsTick((n) => n + 1);
  }

  const vById = useMemo(
    () => new Map((venues || []).map((v) => [v.id, v])),
    [venues]
  );
  const beenIds = beenData?.ids || new Set();
  const savedList = Array.from(savedIds || [])
    .map((id) => vById.get(id))
    .filter(Boolean);
  const beenList = Array.from(beenIds)
    .map((id) => vById.get(id))
    .filter(Boolean);
  const notBeenList = savedList.filter((v) => !beenIds.has(v.id));

  const LISTS = {
    saved: { emoji: "🔖", name: "Saved", rows: savedList },
    been: { emoji: "✔️", name: "Been", rows: beenList },
    not_been: { emoji: "⏳", name: "Haven't Been", rows: notBeenList },
  };

  const row = (v) => {
    const beenCount =
      (beenData?.counts.get(v.id) || 0) || (beenIds.has(v.id) ? 1 : 0);
    const pals = (friendsAt.get(v.id) || []).slice(0, 3);
    return (
      <button
        key={v.id}
        type="button"
        onClick={() => setSelectedVenue(v)}
        className="mb-2 flex w-full items-center gap-3 rounded-2xl bg-white p-3 text-left shadow-sm border border-neutral-100 active:scale-[0.99] transition"
      >
        <Thumb v={v} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5 text-sm font-semibold text-neutral-900">
            <span className="truncate">{v.name}</span>
            {beenCount > 0 && (
              <span className="shrink-0 text-[10px] font-medium text-[#455d3b]">
                Been{beenCount > 1 ? ` ×${beenCount}` : ""}
              </span>
            )}
          </span>
          <span className="block truncate text-[11px] text-neutral-500">
            {[v.type, v.suburb, v.rating ? `★ ${v.rating}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </span>
        {pals.length > 0 && (
          <span className="flex shrink-0">
            {pals.map((p, i) => (
              <span key={p.id} style={i > 0 ? { marginLeft: -8 } : undefined}>
                <FriendAvatar profile={p} small />
              </span>
            ))}
          </span>
        )}
        {list === "saved" && (
          <span
            role="button"
            aria-label="Remove from Saved"
            onClick={(e) => {
              e.stopPropagation();
              onUnsave?.(v.id);
            }}
            className="shrink-0 p-1 text-[#455d3b]"
          >
            <Bookmark size={16} fill="#455d3b" />
          </span>
        )}
      </button>
    );
  };

  const active = list ? LISTS[list] : null;

  return (
    <div className="fixed inset-0 z-[2000] overflow-y-auto bg-[#fdf6f0] px-6 pt-6 pb-28 lg:pl-[108px]">
      <div className="mx-auto w-full max-w-sm">
        <button
          type="button"
          onClick={() => (list ? setList(null) : onBack())}
          className="mb-3 flex items-center gap-1.5 text-sm font-medium text-[#455d3b]"
        >
          <ArrowLeft size={16} /> {list ? "My Lists" : "Profile"}
        </button>

        {!list && (
          <>
            <h1 className="mb-5 text-2xl font-semibold tracking-tight">
              My Lists
            </h1>
            {Object.entries(LISTS).map(([key, l]) => (
              <button
                key={key}
                type="button"
                onClick={() => setList(key)}
                className="mb-2.5 flex w-full items-center gap-3 rounded-2xl bg-white p-3.5 text-left shadow-sm border border-neutral-100 active:scale-[0.99] transition"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#edf2eb] text-base">
                  {l.emoji}
                </span>
                <span className="flex-1">
                  <span className="block text-sm font-semibold text-neutral-900">
                    {l.name}
                  </span>
                  <span className="block text-[11px] text-neutral-500">
                    {beenData === null && key !== "saved"
                      ? "Loading…"
                      : `${l.rows.length} place${
                          l.rows.length === 1 ? "" : "s"
                        }`}
                  </span>
                </span>
                <span className="text-lg leading-none text-neutral-300">
                  ›
                </span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setList("spots")}
              className="mb-2.5 flex w-full items-center gap-3 rounded-2xl bg-white p-3.5 text-left shadow-sm border border-neutral-100 active:scale-[0.99] transition"
            >
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-[#edf2eb] text-base">
                📌
              </span>
              <span className="flex-1">
                <span className="block text-sm font-semibold text-neutral-900">
                  Spots
                </span>
                <span className="block text-[11px] text-neutral-500">
                  {mySpots === null
                    ? "Loading…"
                    : `${mySpots.length} spot${
                        mySpots.length === 1 ? "" : "s"
                      } · friends only`}
                </span>
              </span>
              <span className="text-lg leading-none text-neutral-300">›</span>
            </button>
            {/* CUSTOM LISTS (Oct 12 — live). Shared ones carry the badge;
                add venues from any venue card's bookmark (hold = pick). */}
            {(customs || []).map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setList(l.id)}
                className="mb-2.5 flex w-full items-center gap-3 rounded-2xl bg-white p-3.5 text-left shadow-sm border border-neutral-100 active:scale-[0.99] transition"
              >
                {/* The STICKER: white tile, olive border, a tilt — the
                    list's face wherever it appears. */}
                <span
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border-2 border-[#455d3b] bg-white text-lg shadow-sm"
                  style={{ transform: "rotate(-4deg)" }}
                >
                  {l.emoji || "📍"}
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block truncate text-sm font-semibold text-neutral-900">
                    {l.name}
                  </span>
                  <span className="block text-[11px] text-neutral-500">
                    {(customItems.get(l.id) || []).length} place
                    {(customItems.get(l.id) || []).length === 1 ? "" : "s"}
                    {l.shared ? " · shared" : l.is_public ? " · friends can see" : " · private"}
                  </span>
                </span>
                <span className="text-lg leading-none text-neutral-300">
                  ›
                </span>
              </button>
            ))}
            {creating ? (
              <div className="mt-1 flex w-full items-center gap-3 rounded-2xl border border-[#cfdcc9] bg-white p-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-full text-[#455d3b]">
                  <Plus size={16} />
                </span>
                <input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createList()}
                  placeholder="List name"
                  maxLength={60}
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-base focus:outline-none"
                />
                <button
                  type="button"
                  disabled={!newName.trim()}
                  onClick={createList}
                  className="shrink-0 rounded-full bg-[#455d3b] px-3.5 py-1.5 text-xs font-medium text-white active:scale-95 transition disabled:opacity-40"
                >
                  Create
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="mt-1 flex w-full items-center gap-3 rounded-2xl border border-dashed border-[#cfdcc9] p-3.5 text-left active:bg-[#edf2eb]/40 transition"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-full text-[#455d3b]">
                  <Plus size={16} />
                </span>
                <span className="flex-1 text-sm font-medium text-[#455d3b]">
                  Create a list
                </span>
              </button>
            )}
          </>
        )}

        {list === "spots" && (
          <>
            <h1 className="mb-4 text-2xl font-semibold tracking-tight">
              📌 Spots{" "}
              <span className="text-sm font-normal text-neutral-400">
                · {(mySpots || []).length}
              </span>
            </h1>
            {(mySpots || []).map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onOpenSpot?.(s)}
                className="mb-2 flex w-full items-center gap-3 rounded-2xl bg-white p-3 text-left shadow-sm border border-neutral-100 active:scale-[0.99] transition"
              >
                <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#edf2eb] text-lg">
                  {SPOT_CATEGORIES[s.category]?.emoji || "📍"}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-neutral-900">
                    {s.title || s.place_name}
                  </span>
                  <span className="block truncate text-[11px] text-neutral-500">
                    {[
                      s.user_id !== userId ? "saved from a friend" : null,
                      s.directions || s.details,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Your spot"}
                  </span>
                </span>
                <span className="text-lg leading-none text-neutral-300">
                  ›
                </span>
              </button>
            ))}
            {(mySpots || []).length === 0 && mySpots !== null && (
              <p className="py-8 text-center text-sm text-neutral-400">
                No spots yet. The + on the map knows what to do
              </p>
            )}
          </>
        )}

        {activeCustom && (
          <>
            <div className="mb-4 flex items-start justify-between">
              {renaming ? (
                <div className="flex flex-1 items-center gap-2">
                  <input
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && renameList()}
                    maxLength={60}
                    autoFocus
                    className="min-w-0 flex-1 rounded-full border border-neutral-200 bg-white px-4 py-2 text-base focus:outline-none focus:border-[#455d3b]"
                  />
                  <button
                    type="button"
                    onClick={renameList}
                    className="shrink-0 rounded-full bg-[#455d3b] px-3 py-1.5 text-xs font-medium text-white"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <h1 className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight">
                  <span
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-[#455d3b] bg-white text-xl shadow-sm"
                    style={{ transform: "rotate(-4deg)" }}
                  >
                    {activeCustom.emoji || "📍"}
                  </span>
                  <span>
                    {activeCustom.name}{" "}
                    <span className="text-sm font-normal text-neutral-400">
                      · {(customItems.get(activeCustom.id) || []).length}
                    </span>
                  </span>
                </h1>
              )}
              {activeCustom.owner_id === userId && !renaming && (
                <button
                  type="button"
                  aria-label="List options"
                  onClick={() => setMenuOpen((v) => !v)}
                  className="mt-1 flex h-9 w-9 items-center justify-center rounded-full bg-white border border-neutral-100 text-neutral-500 shadow-sm"
                >
                  ⋯
                </button>
              )}
            </div>
            {menuOpen && (
              <div className="mb-3 overflow-hidden rounded-2xl border border-neutral-100 bg-white shadow-sm">
                <button
                  type="button"
                  onClick={() => {
                    setRenameDraft(activeCustom.name);
                    setRenaming(true);
                    setMenuOpen(false);
                  }}
                  className="block w-full px-4 py-3 text-left text-sm text-neutral-800 active:bg-neutral-50"
                >
                  Rename
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setStickerDraft(activeCustom.emoji || "");
                    setStickering(true);
                    setMenuOpen(false);
                  }}
                  className="block w-full border-t border-neutral-50 px-4 py-3 text-left text-sm text-neutral-800 active:bg-neutral-50"
                >
                  Change sticker
                </button>
                <button
                  type="button"
                  onClick={togglePublic}
                  className="block w-full border-t border-neutral-50 px-4 py-3 text-left text-sm text-neutral-800 active:bg-neutral-50"
                >
                  {activeCustom.is_public
                    ? "Make private"
                    : "Let friends see this list"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    loadFriends();
                    setInviteOpen(true);
                    setMenuOpen(false);
                  }}
                  className="block w-full border-t border-neutral-50 px-4 py-3 text-left text-sm text-neutral-800 active:bg-neutral-50"
                >
                  Invite collaborators
                </button>
                <button
                  type="button"
                  onClick={() => (deleteArm ? deleteList() : setDeleteArm(true))}
                  className="block w-full border-t border-neutral-50 px-4 py-3 text-left text-sm text-red-600 active:bg-neutral-50"
                >
                  {deleteArm ? "Really delete this list?" : "Delete list"}
                </button>
              </div>
            )}
            {actionPills(
              { name: activeCustom.name, emoji: activeCustom.emoji },
              customItems.get(activeCustom.id) || []
            )}
            {members.length > 0 && (
              <div className="mb-3 flex items-center gap-2 px-1">
                <span className="flex">
                  {members.slice(0, 4).map((m, i) => (
                    <span
                      key={m.id}
                      style={i > 0 ? { marginLeft: -8 } : undefined}
                    >
                      <FriendAvatar profile={m} small />
                    </span>
                  ))}
                </span>
                <span className="text-[11px] text-neutral-500">
                  with{" "}
                  {members
                    .slice(0, 2)
                    .map((m) => (m.display_name || "a friend").split(" ")[0])
                    .join(", ")}
                  {members.length > 2 ? ` +${members.length - 2}` : ""}
                </span>
              </div>
            )}
            {inviteOpen && (
              <div className="mb-3 rounded-2xl border border-[#cfdcc9] bg-white p-3.5">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-xs font-semibold text-neutral-800">
                    Collaborators
                  </p>
                  <button
                    type="button"
                    onClick={() => setInviteOpen(false)}
                    className="text-xs text-neutral-400"
                  >
                    Done
                  </button>
                </div>
                {members.map((m) => (
                  <div key={m.id} className="flex items-center gap-2.5 py-1.5">
                    <FriendAvatar profile={m} small />
                    <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
                      {m.display_name || "Someone"}
                    </span>
                    <button
                      type="button"
                      disabled={memberBusy}
                      onClick={() => removeMember(m)}
                      className="shrink-0 rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] text-neutral-500 active:scale-95 transition disabled:opacity-50"
                    >
                      Remove
                    </button>
                  </div>
                ))}
                {friendProfiles === null && (
                  <p className="py-1 text-xs text-neutral-400">
                    Loading friends…
                  </p>
                )}
                {(friendProfiles || [])
                  .filter((f) => !members.some((m) => m.id === f.id))
                  .map((f) => (
                    <div key={f.id} className="flex items-center gap-2.5 py-1.5">
                      <FriendAvatar profile={f} small />
                      <span className="min-w-0 flex-1 truncate text-sm text-neutral-800">
                        {f.display_name || "Someone"}
                      </span>
                      <button
                        type="button"
                        disabled={memberBusy}
                        onClick={() => addMember(f)}
                        className="shrink-0 rounded-full bg-[#455d3b] px-3 py-1 text-[11px] font-medium text-white active:scale-95 transition disabled:opacity-50"
                      >
                        Add
                      </button>
                    </div>
                  ))}
                <p className="mt-1.5 text-[10px] text-neutral-400">
                  They can add and remove places. The list shows in their
                  My Lists too
                </p>
              </div>
            )}
            {stickering && (
              <div className="mb-3 flex items-center gap-2.5 rounded-2xl border border-[#cfdcc9] bg-white p-3">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border-2 border-[#455d3b] bg-white text-xl shadow-sm"
                  style={{ transform: "rotate(-4deg)" }}
                >
                  {stickerDraft.trim().slice(0, 4) || "📍"}
                </span>
                <input
                  value={stickerDraft}
                  onChange={(e) => setStickerDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && saveSticker()}
                  placeholder="Pick an emoji"
                  autoFocus
                  className="min-w-0 flex-1 bg-transparent text-base focus:outline-none"
                />
                <button
                  type="button"
                  disabled={!stickerDraft.trim()}
                  onClick={saveSticker}
                  className="shrink-0 rounded-full bg-[#455d3b] px-3.5 py-1.5 text-xs font-medium text-white active:scale-95 transition disabled:opacity-40"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setStickering(false)}
                  className="shrink-0 text-xs font-medium text-neutral-400"
                >
                  Cancel
                </button>
              </div>
            )}
            {(customItems.get(activeCustom.id) || []).map((vid) => {
              const v = vById.get(vid) || extraVenues.get(vid);
              if (!v) return null;
              return (
                <div key={vid} className="relative">
                  {row(v)}
                  <button
                    type="button"
                    aria-label="Remove from this list"
                    onClick={() => removeItem(vid)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 flex h-7 w-7 items-center justify-center rounded-full text-neutral-300"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            {(customItems.get(activeCustom.id) || []).length === 0 && (
              <p className="py-8 text-center text-sm text-neutral-400">
                Nothing here yet. Hold the bookmark on any venue card to
                save places straight into this list
              </p>
            )}
          </>
        )}

        {active && (
          <>
            <h1 className="mb-4 text-2xl font-semibold tracking-tight">
              {active.emoji} {active.name}{" "}
              <span className="text-sm font-normal text-neutral-400">
                · {active.rows.length}
              </span>
            </h1>
            {actionPills(
              { name: active.name, emoji: active.emoji },
              active.rows.map((v) => v.id)
            )}
            {active.rows.map(row)}
            {active.rows.length === 0 && (
              <p className="py-8 text-center text-sm text-neutral-400">
                {list === "saved"
                  ? "Nothing saved yet. The bookmark on any venue card starts this list"
                  : list === "been"
                  ? "Nowhere yet. Your nights fill this in"
                  : "Everywhere you've saved, you've been. Impressive"}
              </p>
            )}
          </>
        )}
      </div>

      {selectedVenue && (
        <MapVenueSheet
          venue={selectedVenue}
          onClose={() => setSelectedVenue(null)}
          savedIds={savedIds}
          onSave={() => {}}
          onUnsave={onUnsave}
          onHide={() => {}}
          userId={userId}
          onCheckIn={onCheckIn}
          onOpenThread={onOpenThread}
          onOpenProfile={onOpenProfile}
          zIndex={3100}
        />
      )}
    </div>
  );
}
