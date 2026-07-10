// Small avatar that renders initials from display_name or @handle. Olive bg
// to match the rest of the app's primary palette. Extracted from App.js
// (July 10, 2026) — used by ActivityDrawer and the profile/friends screens.
export function FriendAvatar({ profile, small = false }) {
  const seed =
    (profile?.display_name || profile?.username || "?").trim() || "?";
  const initial = seed[0].toUpperCase();
  const size = small ? "w-8 h-8 text-xs" : "w-10 h-10 text-sm";
  if (profile?.avatar_url) {
    return (
      <img
        src={profile.avatar_url}
        alt={seed}
        className={`flex-shrink-0 ${size} rounded-full object-cover`}
      />
    );
  }
  return (
    <div
      className={`flex-shrink-0 ${size} rounded-full bg-[#455d3b]/10 text-[#455d3b] flex items-center justify-center font-medium`}
    >
      {initial}
    </div>
  );
}
