// E2E helpers (testing stage 2). Auth strategy: the app signs people in by
// email OTP, which a robot can't receive — so the seeded test accounts carry
// PASSWORDS (scripts/seed-e2e.mjs), we sign in via supabase-js here in Node,
// and inject the resulting session into the browser's localStorage under the
// exact key the app's client reads. The flanit_in cookie rides along so the
// edge middleware serves the app at "/" instead of the homepage.
const { createClient } = require("@supabase/supabase-js");
const fs = require("node:fs");
const path = require("node:path");

function loadDotEnv() {
  try {
    const raw = fs
      .readFileSync(path.join(__dirname, "..", "..", ".env"), "utf8")
      .replace(/^﻿/, ""); // Windows BOM
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch {}
}

function supabaseEnv() {
  loadDotEnv();
  const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
  const anon =
    process.env.SUPABASE_ANON_KEY || process.env.REACT_APP_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase URL/anon key not found (.env)");
  return { url, anon, ref: new URL(url).hostname.split(".")[0] };
}

// Sign a seeded robot in. Returns { session, sb } — sb is a Node-side client
// already authed as that user, for DB assertions and cleanup.
//
// The project has captcha protection on auth (Turnstile), which blocks a
// robot's signInWithPassword. So: the SERVICE key mints a magic-link token
// server-side and we exchange it for a session via verifyOtp, which takes
// no captcha. Fresh session every run — no stored tokens to go stale.
// Requires SUPABASE_SERVICE_ROLE_KEY in the environment for test runs too.
async function signIn(email) {
  const { url, anon } = supabaseEnv();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey)
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY not set — the e2e suite needs it each run " +
        "(captcha blocks password sign-in for robots)."
    );
  const admin = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (linkErr) throw new Error(`generateLink for ${email}: ${linkErr.message}`);
  const tokenHash = link?.properties?.hashed_token;
  if (!tokenHash) throw new Error(`no hashed_token in generateLink for ${email}`);

  const sb = createClient(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await sb.auth.verifyOtp({
    type: "email",
    token_hash: tokenHash,
  });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { session: data.session, sb };
}

// A browser context that loads the app already signed in as `session`'s user.
async function authedContext(browser, baseURL, session) {
  const { ref } = supabaseEnv();
  const context = await browser.newContext();
  await context.addCookies([
    { name: "flanit_in", value: "1", url: baseURL },
  ]);
  await context.addInitScript(
    ([key, value]) => {
      window.localStorage.setItem(key, value);
    },
    [`sb-${ref}-auth-token`, JSON.stringify(session)]
  );
  return context;
}

module.exports = { supabaseEnv, signIn, authedContext };
