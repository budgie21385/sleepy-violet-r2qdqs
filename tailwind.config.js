/** Build-time Tailwind (July 21, 2026 — speed pair, part 1).
 * Replaces the cdn.tailwindcss.com runtime compiler, which shipped ~350KB of
 * JS and compiled styles ON THE PHONE (the "should not be used in production"
 * console warning, and a big slice of the slow-device jank).
 * CRA 5 picks this up automatically once `tailwindcss` is installed.
 * Arbitrary values (z-[3600], bg-[#455d3b], etc.) are supported natively —
 * they just need to appear as complete literal strings in source, which ours do.
 */
module.exports = {
  content: ["./src/**/*.{js,jsx}", "./public/index.html"],
  theme: {
    extend: {},
  },
  plugins: [],
};
