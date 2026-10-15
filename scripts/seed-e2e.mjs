// E2E SEED (Oct 16, 2026 — testing stage 2). Creates the two robot accounts
// the Playwright suite drives, their friendship, and the known list they
// match from. Idempotent: run it again and it converges on the same state.
//
// Run ONCE (and again only after wiping test data), in cmd from swipes-app:
//   set SUPABASE_SERVICE_ROLE_KEY=...   (Supabase dashboard → settings → API)
//   set E2E_PASSWORD=...                (any strong password; the suite reuses it)
//   node scripts/seed-e2e.mjs
//
// The service key is read from the environment only — never written to disk.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";

const HOST_EMAIL = "e2e.host@example.com";
const GUEST_EMAIL = "e2e.guest@example.com";
const LIST_NAME = "E2E Coffee";
const LIST_SIZE = 5;

function loadDotEnv() {
  try {
    const raw = readFileSync(new URL("../.env", import.meta.url), "utf8")
      .replace(/^﻿/, ""); // Windows BOM
    for (const line of raw.split(/\r?\n/)) {
      const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  } catch (e) {
    console.error("(couldn't read .env:", e.message + ")");
  }
}
loadDotEnv();

const url = process.env.SUPABASE_URL || process.env.REACT_APP_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const password = process.env.E2E_PASSWORD;
if (!url || !serviceKey || !password) {
  const missing = [
    !url && "Supabase URL (REACT_APP_SUPABASE_URL in .env)",
    !serviceKey && "SUPABASE_SERVICE_ROLE_KEY",
    !password && "E2E_PASSWORD",
  ].filter(Boolean);
  console.error("Missing: " + missing.join(", ") + ". Nothing was changed.");
  process.exit(1);
}

const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

async function ensureUser(email, displayName, username) {
  const { data: created, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  let user = created?.user;
  if (error) {
    // Already exists — find them and make sure the password matches.
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 500 });
    user = (list?.users || []).find((u) => u.email === email);
    if (!user) throw new Error(`Couldn't create or find ${email}: ${error.message}`);
    await admin.auth.admin.updateUserById(user.id, { password, email_confirm: true });
  }
  const { error: pErr } = await admin
    .from("profiles")
    .upsert({ id: user.id, display_name: displayName, username }, { onConflict: "id" });
  if (pErr) throw new Error(`profiles upsert for ${email}: ${pErr.message}`);
  return user;
}

const host = await ensureUser(HOST_EMAIL, "E2E Host", "e2ehost");
const guest = await ensureUser(GUEST_EMAIL, "E2E Guest", "e2eguest");
console.log("users:", host.id, guest.id);

const { error: fErr } = await admin.from("friendships").upsert(
  {
    requester_id: host.id,
    addressee_id: guest.id,
    status: "accepted",
    responded_at: new Date().toISOString(),
  },
  { onConflict: "requester_id,addressee_id" }
);
if (fErr) throw new Error(`friendship: ${fErr.message}`);
console.log("friendship: accepted");

let { data: list } = await admin
  .from("venue_lists")
  .select("id")
  .eq("owner_id", host.id)
  .eq("name", LIST_NAME)
  .maybeSingle();
if (!list) {
  const { data: made, error: lErr } = await admin
    .from("venue_lists")
    .insert({ owner_id: host.id, name: LIST_NAME, emoji: "☕", is_public: false })
    .select("id")
    .single();
  if (lErr) throw new Error(`list: ${lErr.message}`);
  list = made;
}

const { data: venues, error: vErr } = await admin
  .from("venues")
  .select("id, name")
  .eq("verified", true)
  .order("id", { ascending: true })
  .limit(LIST_SIZE);
if (vErr || !venues?.length) throw new Error(`venues: ${vErr?.message || "none found"}`);

await admin.from("venue_list_items").delete().eq("list_id", list.id);
const { error: iErr } = await admin.from("venue_list_items").insert(
  venues.map((v) => ({ list_id: list.id, venue_id: v.id, added_by: host.id }))
);
if (iErr) throw new Error(`list items: ${iErr.message}`);

console.log(
  `list "${LIST_NAME}" (#${list.id}):`,
  venues.map((v) => v.name).join(" · ")
);
console.log("Seed complete. The e2e suite can run now.");
