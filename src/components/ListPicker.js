// LIST PICKER (Oct 12, 2026 — the bookmark grammar's one sheet). Reached
// three ways: the post-save snackbar's "Add to a list", HOLDING the
// bookmark (save straight into a list), and TAPPING a filled bookmark
// (manage memberships — Saved is the top toggle; unticking it IS the
// unsave, which killed the accidental one-tap unsave). Multi-select,
// instant writes, swipe-down/backdrop closes.
// Saved and custom lists are INDEPENDENT (ruling): unticking Saved never
// touches list memberships.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Plus, Bookmark, Check } from "lucide-react";
import { supabase } from "../supabaseClient";

export function ListPicker({
  userId,
  venue,
  saved, // boolean — current Saved state
  onSave,
  onUnsave,
  onClose,
  onMembershipChange, // (count) => bookmark fill bookkeeping upstream
}) {
  const [lists, setLists] = useState(null); // [{id,name,emoji,shared}]
  const [inIds, setInIds] = useState(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!userId || !venue?.id) return;
    let cancelled = false;
    (async () => {
      // My lists: owned + ones I'm a member of (RLS hands back exactly
      // those), plus this venue's memberships among them.
      const [{ data: ls }, { data: items }] = await Promise.all([
        supabase
          .from("venue_lists")
          .select("id, name, emoji, owner_id")
          .order("created_at", { ascending: true }),
        supabase
          .from("venue_list_items")
          .select("list_id")
          .eq("venue_id", venue.id),
      ]);
      if (cancelled) return;
      // RLS also returns friends' PUBLIC lists — the picker only offers
      // lists I can WRITE to: mine, or ones I'm a member of.
      const { data: mem } = await supabase
        .from("venue_list_members")
        .select("list_id")
        .eq("user_id", userId);
      const memberIds = new Set((mem || []).map((m) => m.list_id));
      if (cancelled) return;
      setLists(
        (ls || [])
          .filter((l) => l.owner_id === userId || memberIds.has(l.id))
          .map((l) => ({ ...l, shared: l.owner_id !== userId }))
      );
      setInIds(new Set((items || []).map((i) => i.list_id)));
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, venue?.id]);

  async function toggleList(l) {
    if (busy) return;
    setBusy(true);
    const on = inIds.has(l.id);
    const next = new Set(inIds);
    if (on) {
      next.delete(l.id);
      setInIds(next);
      const { error } = await supabase
        .from("venue_list_items")
        .delete()
        .eq("list_id", l.id)
        .eq("venue_id", venue.id);
      if (error) {
        console.error("List remove failed:", error);
        next.add(l.id);
        setInIds(new Set(next));
      }
    } else {
      next.add(l.id);
      setInIds(next);
      const { error } = await supabase.from("venue_list_items").insert({
        list_id: l.id,
        venue_id: venue.id,
        added_by: userId,
      });
      if (error && error.code !== "23505") {
        console.error("List add failed:", error);
        next.delete(l.id);
        setInIds(new Set(next));
      }
    }
    onMembershipChange?.(next.size);
    setBusy(false);
  }

  async function createList() {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    const { data, error } = await supabase
      .from("venue_lists")
      .insert({ owner_id: userId, name })
      .select("id, name, emoji, owner_id")
      .single();
    if (error || !data) {
      console.error("List create failed:", error);
      setBusy(false);
      return;
    }
    setLists((prev) => [...(prev || []), { ...data, shared: false }]);
    setNewName("");
    setCreating(false);
    setBusy(false);
    // Fresh list → the venue goes straight in (that's why you made it).
    toggleList(data);
  }

  const row = (icon, label, on, action, sub) => (
    <button
      type="button"
      disabled={busy}
      onClick={action}
      className="flex w-full items-center gap-3 border-t border-neutral-50 px-1 py-2.5 text-left first:border-t-0 disabled:opacity-60"
    >
      <span className="w-6 text-center text-base">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-neutral-900">
          {label}
        </span>
        {sub && (
          <span className="block text-[10px] text-neutral-400">{sub}</span>
        )}
      </span>
      <span
        className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full ${
          on ? "bg-[#455d3b] text-white" : "border-[1.5px] border-neutral-300"
        }`}
      >
        {on && <Check size={12} strokeWidth={3} />}
      </span>
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[3850]">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/30"
      />
      <div
        className="absolute left-0 right-0 bottom-0 mx-auto max-w-md rounded-t-3xl bg-white px-5 pt-3 shadow-2xl"
        style={{ paddingBottom: "max(18px, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-neutral-200" />
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold">Save to…</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-neutral-100 text-neutral-500 active:bg-neutral-200"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
        <p className="mb-2 truncate text-xs text-neutral-500">{venue?.name}</p>

        {row(
          <Bookmark size={15} className="inline text-[#455d3b]" />,
          "Saved",
          saved,
          () => (saved ? onUnsave?.(venue.id) : onSave?.(venue.id)),
          saved ? "Untick to remove from Saved" : null
        )}

        {lists === null && (
          <p className="py-2 text-xs text-neutral-400">Loading lists…</p>
        )}
        {(lists || []).map((l) =>
          row(
            l.emoji || "📍",
            l.name,
            inIds.has(l.id),
            () => toggleList(l),
            l.shared ? "shared" : null
          )
        )}

        {creating ? (
          <div className="mt-1 flex items-center gap-2 border-t border-neutral-50 px-1 py-2.5">
            <span className="w-6 text-center text-[#455d3b]">
              <Plus size={15} className="inline" />
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
              disabled={busy || !newName.trim()}
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
            className="flex w-full items-center gap-3 border-t border-neutral-50 px-1 py-2.5 text-left"
          >
            <span className="w-6 text-center text-[#455d3b]">
              <Plus size={15} className="inline" />
            </span>
            <span className="flex-1 text-sm font-medium text-[#455d3b]">
              New list
            </span>
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
