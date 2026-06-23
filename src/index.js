import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { PublicVenuePage } from "./components/PublicVenuePage";

const rootElement = document.getElementById("root");
const root = createRoot(rootElement);

// Public shareable venue card: flanit.co/v/<id> renders a standalone, no-login
// card (the heavy app never mounts). Anything else → the app.
const publicVenue = window.location.pathname.match(/^\/v\/(\d+)/);

root.render(
  <StrictMode>
    {publicVenue ? (
      <PublicVenuePage venueId={publicVenue[1]} />
    ) : (
      <App />
    )}
  </StrictMode>
);
