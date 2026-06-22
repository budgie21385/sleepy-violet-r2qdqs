// Shared session / filter UI constants. Extracted from App.js so the form-field
// components and the session-setup screens can import them too.

export const ALL = "All";
export const MATCH_OPTIONS = [1, 2, 3, 4];
export const RADIUS_OPTIONS = [1, 3, 5, 10];

// 2-4 because 1 is solo (no session needed) and >4 stops being playful.
// If you change this, update the schema CHECK / validation too.
export const PARTICIPANT_OPTIONS = [2, 3, 4];

// Time-limit options per mode, in minutes. Used to compute the session's
// expires_at when it's created. "Right now" is short by design — get to a
// decision in the next 10 min or two. "Later" is generous — host curates,
// guests can swipe at their own pace over hours or days.
export const TIME_LIMIT_OPTIONS_CONCURRENT = [
  { label: "10 min", minutes: 10 },
  { label: "30 min", minutes: 30 },
  { label: "1 hour", minutes: 60 },
  { label: "2 hours", minutes: 120 },
];
export const TIME_LIMIT_OPTIONS_CURATED = [
  { label: "6 hours", minutes: 60 * 6 },
  { label: "24 hours", minutes: 60 * 24 },
  { label: "3 days", minutes: 60 * 24 * 3 },
  { label: "7 days", minutes: 60 * 24 * 7 },
];
