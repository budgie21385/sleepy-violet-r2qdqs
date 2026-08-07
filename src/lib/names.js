// "Do we actually KNOW this person's name?" (July 31 — a returning anon
// auto-joined a session as "New user").
//
// The handle_new_user trigger seeds EVERY new auth user — anonymous included —
// with display_name "New user". So "has a display name" is not the same as
// "told us their name": every anon has the placeholder from birth. The
// known-guest auto-join and the collect-link door must gate on a REAL name,
// or the placeholder walks through the door and gets written onto participant
// rows as if someone chose it.
export function realName(name) {
  const n = (name || "").trim();
  if (!n) return null;
  if (n.toLowerCase() === "new user") return null;
  return n;
}
