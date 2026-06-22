// Post-match-reveal CTA for guests: "[Host] hosted this session — add as a
// friend?" Hides itself when viewer is the host, already friends, or the host
// already sent the viewer a pending request. Extracted from App.js.
import { useState, useEffect } from "react";
import { supabase } from "../supabaseClient";
import { Check, UserPlus } from "lucide-react";

export function AddHostFriendCard({ hostUserId, hostName, viewerUserId, showToast }) {
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
