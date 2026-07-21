import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { PublicVenuePage } from "./components/PublicVenuePage";
import { InstallScreen } from "./components/InstallScreen";
import { UpdatePill } from "./components/UpdatePill";

const rootElement = document.getElementById("root");
const root = createRoot(rootElement);

// Public shareable venue card: flanit.co/v/<id> renders a standalone, no-login
// card (the heavy app never mounts). flanit.co/install renders the app-store
// style install landing (QR on desktop, device-aware steps on mobile).
// Anything else → the app.
const publicVenue = window.location.pathname.match(/^\/v\/(\d+)/);
const installPage = /^\/install\/?$/.test(window.location.pathname);

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
    ) : (
      <App />
    )}
  </StrictMode>
);
