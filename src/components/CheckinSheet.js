// Post-check-in sheet — the check-in's own moment, lifted OFF the venue card
// (Mark: the embedded version felt too glued to the card). Opens over the card
// after a fresh check-in with: confirmation, the optional "what's on" label,
// and the with-friends tag chips (adaptive search once the friend list is
// long). Everything applies live; Done just closes.
import { useState, useEffect } from "react";
import { X, Check, MapPin } from "lucide-react";
import { supabase } from "../supabaseClient";
import { FriendAvatar } from "./FriendAvatar";

const SEARCH_THRESHOLD = 8; // chips-only below this many friends

export function CheckinSheet({ venue, activity, userId, onClose, showToast }) {
  const [labelText, setLabelText] = useState("");
  const [labelState, setLabelState] = useState("idle"); // idle|saving|done
  const [friends, setFriends] = useState(null); // null = loading
  const [taggedIds, setTaggedIds] = useState(() => new Set());
  const [q, setQ] = useState("");

  useEffect(() => {
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
        if (!cancelled) setFriends([]);
        return;
      }
      const { data: profs } = await supabase
        .from("profiles")
        .select("id, display_name, username, avatar_url")
        .in("id", ids)
        .order("display_name", { ascending: true });
      if (!cancelled) setFriends(profs || []);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  async function saveLabel() {
    const text = labelText.trim().slice(0, 80);
    if (!text || labelState === "saving") return;
    setLabelState("saving");
    const { error } = await supabase
      .from("activities")
      .update({ label: text })
      .eq("id", activity.id);
    setLabelState(error ? "idle" : "done");
    if (error) showToast?.("Couldn't add that");
  }

  async function toggleTag(friendId) {
    const isTagged = taggedIds.has(friendId);
    setTaggedIds((prev) => {
      const next = new Set(prev);
      if (isTagged) next.delete(friendId);
      else next.add(friendId);
      return next;
    });
    if (isTagged) {
      await supabase
        .from("activity_tags")
        .delete()
        .eq("activity_id", activity.id)
        .eq("tagged_user_id", friendId);
    } else {
      const { error } = await supabase
        .from("activity_tags")
        .insert({ activity_id: activity.id, tagged_user_id: friendId });
      if (error) {
        console.error("Tag failed:", error);
        setTaggedIds((prev) => {
          const next = new Set(prev);
          next.delete(friendId);
          return next;
        });
      }
    }
  }

  const ql = q.trim().toLowerCase();
  const shownFriends = (friends || []).filter(
    (f) =>
      !ql ||
      (f.display_name || "").toLowerCase().includes(ql) ||
      (f.username || "").toLowerCase().includes(ql)
  );

  return (
    <div className="fixed inset-0 z-[3300]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div className="absolute left-0 right-0 bottom-0 max-h-[80%] flex flex-col bg-white rounded-t-3xl shadow-2xl">
        <div className="px-5 pt-3 pb-4 overflow-y-auto">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
          <div className="flex items-center gap-3 mb-4">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[#edf2eb]">
              <Check size={19} className="text-[#455d3b]" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[15px] font-semibold leading-tight truncate">
                You're at {venue.name}
              </p>
              <p className="text-[11px] text-neutral-500">
                Friends can see you're here
              </p>
            </div>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-neutral-500 hover:bg-neutral-100"
            >
              <X size={16} />
            </button>
          </div>

          {labelState !== "done" ? (
            <div className="mb-4 flex items-center gap-2 rounded-full border border-neutral-200 pl-4 pr-1.5 py-1.5">
              <MapPin size={15} className="shrink-0 text-neutral-400" />
              {/* text-base: sub-16px inputs make iOS Safari auto-zoom on focus. */}
              <input
                value={labelText}
                onChange={(e) => setLabelText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveLabel()}
                placeholder="What's on tonight?"
                maxLength={80}
                className="flex-1 min-w-0 bg-transparent text-base focus:outline-none"
              />
              {labelText.trim() && (
                <button
                  type="button"
                  aria-label="Save"
                  disabled={labelState === "saving"}
                  onClick={saveLabel}
                  className="w-8 h-8 shrink-0 rounded-full bg-[#455d3b] text-white flex items-center justify-center disabled:opacity-50 active:scale-95 transition"
                >
                  ✓
                </button>
              )}
            </div>
          ) : (
            <p className="mb-4 text-center text-xs font-medium text-[#455d3b]">
              Added — friends see "{labelText.trim()}"
            </p>
          )}

          {friends && friends.length > 0 && (
            <div className="mb-4">
              <p className="mb-1.5 px-1 text-[11px] font-medium text-neutral-500">
                With friends? They'll be asked before their friends see anything.
              </p>
              {friends.length > SEARCH_THRESHOLD && (
                <input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search friends"
                  className="mb-2 w-full rounded-full border border-neutral-200 px-4 py-2 text-base focus:outline-none focus:border-[#455d3b]"
                />
              )}
              <div className="flex flex-wrap gap-2">
                {shownFriends.map((f) => {
                  const on = taggedIds.has(f.id);
                  return (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => toggleTag(f.id)}
                      className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-medium active:scale-95 transition ${
                        on
                          ? "bg-[#455d3b] border-[#455d3b] text-white"
                          : "border-neutral-200 text-neutral-700"
                      }`}
                    >
                      <FriendAvatar profile={f} small />
                      {(f.display_name || "?").split(" ")[0]}
                      {on ? " ✓" : ""}
                    </button>
                  );
                })}
                {shownFriends.length === 0 && (
                  <p className="text-xs text-neutral-400 py-1">No matches.</p>
                )}
              </div>
            </div>
          )}

          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-full bg-[#455d3b] py-3 text-sm font-medium text-white active:scale-[0.99] transition"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
