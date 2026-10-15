// E2E config (testing stage 2, Oct 16 2026). One worker — the scenarios are
// multi-user already (two browser contexts inside one test), and parallel
// sessions against the shared Supabase would trip over each other.
// Target: E2E_BASE_URL (a Vercel preview URL, or localhost:3000 with
// `npm start` running) — defaults to production, same place field tests run.
const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL || "https://flanit.co",
    viewport: { width: 390, height: 844 }, // the app is phone-first
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    actionTimeout: 15_000, // fail fast and name the stuck step
  },
});
