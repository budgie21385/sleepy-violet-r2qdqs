// Shared session / filter UI constants. Extracted from App.js so the form-field
// components and the session-setup screens can import them too.

export const ALL = "All";

// 1-3 per Mark (July 9, 2026) — a match target above 3 stops being decisive.
export const MATCH_OPTIONS = [1, 2, 3];
// 0 = the suburb itself; >0 extends that far past its border.
export const RADIUS_OPTIONS = [0, 1, 3, 5, 10];

// PARTICIPANT_OPTIONS and TIME_LIMIT_OPTIONS_* removed July 9, 2026 with the
// dead ParticipantsField / TimeLimitField controls. Sessions now always get
// the 24h default expires_at at create (see startSwiping); if per-session
// expiry ever returns it needs actual enforcement first (see 04-next.md).
