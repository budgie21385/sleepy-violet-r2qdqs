import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./tailwind.css";

import App from "./App";
import { PublicVenuePage } from "./components/PublicVenuePage";
import { InstallScreen } from "./components/InstallScreen";
import { CollectScreen } from "./components/CollectScreen";
import { EventsLanding } from "./components/EventsLanding";
import { UpdatePill } from "./components/UpdatePill";

const rootElement = document.getElementById("root");
const root = createRoot(rootElement);

// Public shareable venue card: flanit.co/v/<id> renders a standalone, no-login
// card (the heavy app never mounts). flanit.co/install renders the app-store
// style install landing (QR on desktop, device-aware steps on mobile).
// Anything else → the app.
const publicVenue = window.location.pathname.match(/^\/v\/(\d+)/);
const installPage = /^\/install\/?$/.test(window.location.pathname);
// Collect link: flanit.co/c/<token> — guest photo drop for a check-in.
const collectPage = window.location.pathname.match(/^\/c\/([A-Za-z0-9_-]+)/);
// Organiser landings (Aug 30): /weddings = wedding framing (Say I Do links
// here — source IS intent), /events = generic skin. Same component.
const landingPage = window.location.pathname.match(/^\/(weddings|events)\/?$/);

// MARKETING HOMEPAGE (Oct 4 — the new brand page, static at /home/).
// Signed-OUT visitors hitting bare "/" get the homepage BEFORE React mounts
// (no flash). Everything else passes through: any query string (?signin=1
// is the homepage's own CTA, ?night/?v are deep links), any path (/s/, /c/,
// /v/, /weddings...), and anyone with a Supabase session in localStorage —
// including anon guests mid-flow, who belong in the app, not on marketing.
const hasSession = (() => {
  try {
    return Object.keys(localStorage).some(
      (k) => k.startsWith("sb-") && k.includes("auth-token")
    );
  } catch {
    return false;
  }
})();
if (
  window.location.pathname === "/" &&
  !window.location.search &&
  !hasSession
) {
  window.location.replace("/home/");
}

// TEMP DEBUG (Oct 15) — standalone-only overflow hunter for the panning
// bottom bar. The bug only shows in the home-screen app, where the on-phone
// console can't be opened, so this alerts whatever element hangs past the
// screen edge 3s after load. REMOVE once the culprit is found.
if (window.navigator.standalone) {
  setTimeout(() => {
    try {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const doc = document.documentElement;
      const bad = Array.from(document.querySelectorAll("body *"))
        .filter((e) => {
          const r = e.getBoundingClientRect();
          return r.right > w + 2 || r.bottom > h + 2;
        })
        .slice(0, 6)
        .map((e) => {
          const r = e.getBoundingClientRect();
          return `${e.tagName}.${String(e.className).slice(0, 70)} [over bottom:${Math.round(
            r.bottom - h
          )} right:${Math.round(r.right - w)}]`;
        });
      window.alert(
        `page ${doc.scrollWidth}x${doc.scrollHeight} / screen ${w}x${h}\n\n` +
          (bad.length ? bad.join("\n\n") : "no overflowing elements found")
      );
    } catch (err) {}
  }, 3000);
}

// Keep the push service worker alive across visits (push-only SW — it never
// intercepts fetches, so it can't serve stale bundles).
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

root.render(
  <StrictMode>
    {/* Renders on every surface — a stale bundle announces itself. */}
    <UpdatePill />
    {publicVenue ? (
      <PublicVenuePage venueId={publicVenue[1]} />
    ) : installPage ? (
      <InstallScreen />
    ) : collectPage ? (
      <CollectScreen token={collectPage[1]} />
    ) : landingPage ? (
      <EventsLanding variant={landingPage[1]} />
    ) : (
      <App />
    )}
  </StrictMode>
);
