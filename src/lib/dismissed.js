// Dismissed Activity items (Aug, Mark: "I want a way to dismiss
// notifications"). The drawer DERIVES its items from source tables — there
// are no notification rows to delete — so dismissal is a per-device id set,
// the same trade the session-nudge done-list already makes. Capped so
// localStorage never grows unbounded; ancient ids age out harmlessly
// because their items left the query windows long ago.
const KEY = "flanit_dismissed_items_v1";
const CAP = 400;

export function readDismissed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) || "[]"));
  } catch {
    return new Set();
  }
}

export function dismissItems(ids) {
  const cur = Array.from(readDismissed());
  const merged = [...cur, ...ids.filter((id) => !cur.includes(id))].slice(-CAP);
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {}
}
