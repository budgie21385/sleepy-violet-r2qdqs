// BREVO CONTACT UPSERT (Aug 30, 2026) — the marketing plumbing's ONE door.
// Called fire-and-forget from the client at funnel moments (landing signup,
// event created). Bearer-verified: the email written to Brevo is the
// AUTHENTICATED user's email, never a body field — the contact list can't
// be spammed by hitting this raw. Geo comes from Vercel's IP headers
// (x-vercel-ip-city/country) — never asked of the user; refined later by
// venue usage. Sequences, timing and copy live in Brevo's UI (separate
// account from Say I Do).
//
// POST body: { source?, attributes?, event? }
//   source     → SOURCE attribute ("weddings" | "events")
//   attributes → merged as-is (EVENT_CREATED, EVENT_DATE, EVENT_LABEL …)
//   event      → { name } fired via Brevo's events API for automations
// Silently no-ops (204) when BREVO_API_KEY is unset, so the app works
// before the account is wired.
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL =
  process.env.REACT_APP_SUPABASE_URL || process.env.SUPABASE_URL;

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST" });
  const key = process.env.BREVO_API_KEY;
  if (!key) return res.status(204).end();
  if (!SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: "not configured" });
  }

  // Who is this, really? The JWT answers; the body never does.
  const auth = req.headers.authorization || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!jwt) return res.status(401).json({ error: "no token" });
  const admin = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const email = userData?.user?.email;
  if (userErr || !email) return res.status(401).json({ error: "bad token" });

  const body = req.body || {};
  const attributes = { ...(body.attributes || {}) };
  if (body.source) attributes.SOURCE = String(body.source).slice(0, 40);
  const city = req.headers["x-vercel-ip-city"];
  const country = req.headers["x-vercel-ip-country"];
  if (city) attributes.CITY = decodeURIComponent(String(city)).slice(0, 60);
  if (country) attributes.COUNTRY = String(country).slice(0, 10);

  try {
    const up = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ email, attributes, updateEnabled: true }),
    });
    // 201 created / 204 updated are both fine; anything else gets logged.
    if (up.status >= 400) {
      console.error("Brevo upsert failed:", up.status, await up.text());
    }
    if (body.event?.name) {
      const ev = await fetch("https://api.brevo.com/v3/events", {
        method: "POST",
        headers: { "api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          event_name: String(body.event.name).slice(0, 60),
          identifiers: { email_id: email },
        }),
      });
      if (ev.status >= 400) {
        console.error("Brevo event failed:", ev.status, await ev.text());
      }
    }
  } catch (e) {
    console.error("Brevo call threw:", e.message);
  }
  return res.status(200).json({ ok: true });
}
