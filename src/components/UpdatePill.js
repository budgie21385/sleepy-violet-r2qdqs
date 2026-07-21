// "New version — tap to refresh" (July 21, 2026). Polls /version.json (which
// every deploy rewrites via the prebuild stamp) and compares against the id
// baked into this bundle. Checks on load, every 5 minutes, and whenever the
// app returns to the foreground — the exact moment stale bundles bite.
import { useEffect, useState } from "react";
import { BUILD_ID } from "../buildId";

export function UpdatePill() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (BUILD_ID === "dev") return; // local dev — nothing to compare
    let stopped = false;
    async function check() {
      try {
        const r = await fetch(`/version.json?t=${Date.now()}`, {
          cache: "no-store",
        });
        const j = await r.json();
        if (!stopped && j?.v && j.v !== BUILD_ID) setStale(true);
      } catch {}
    }
    const t = setTimeout(check, 8000); // after boot settles
    const iv = setInterval(check, 5 * 60 * 1000);
    const onVis = () => {
      if (document.visibilityState === "visible") check();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stopped = true;
      clearTimeout(t);
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  if (!stale) return null;
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="fixed top-3 left-1/2 -translate-x-1/2 z-[6000] rounded-full bg-neutral-900 text-white text-xs font-medium px-4 py-2 shadow-lg active:scale-95 transition"
    >
      New version — tap to refresh
    </button>
  );
}
