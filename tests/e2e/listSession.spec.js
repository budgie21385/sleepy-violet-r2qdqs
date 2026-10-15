// THE FIELD TEST, AUTOMATED (testing stage 2, Oct 16 2026). This is the
// exact evening Mark and Renasha run by hand: host starts a pick-together
// from a custom list, guest opens the /s/ link, both swipe, the likes land.
// Every assertion here is an Oct 14-15 field bug:
//   - host deck = the LIST, untrimmed by their filters ("all 15 places")
//   - guest deck = the SAME list (not 151 random places)
//   - both people's likes reach the aggregate the board reads
// Host likes the first two venues, guest likes the last two — deliberately
// disjoint so no live match ends the game early and the flow stays
// deterministic.
const { test, expect } = require("@playwright/test");
const { signIn, authedContext } = require("./helpers");

const HOST_EMAIL = "e2e.host@example.com";
const GUEST_EMAIL = "e2e.guest@example.com";
const LIST_NAME = "E2E Coffee";
const LIST_SIZE = 5;

test("list session: host and guest share the deck, likes land for both", async ({
  browser,
  baseURL,
}) => {
  const host = await signIn(HOST_EMAIL);
  const guest = await signIn(GUEST_EMAIL);
  let sessionId = null;

  try {
    // ---------- HOST: start a pick-together from the list ----------
    const hostCtx = await authedContext(browser, baseURL, host.session);
    const page = await hostCtx.newPage();
    await page.goto("/");
    await page.getByRole("button", { name: "With friends" }).click();
    await page.getByText("Pick together", { exact: true }).click();
    await page.getByRole("button", { name: "Continue" }).first().click();

    // Party size: starts at 0 — one guest coming.
    await page.getByLabel("More people").click();

    // Pool: from the seeded list. dispatchEvent, not click: the sheet's
    // lower rows sit in the tab bar's hit area and Playwright refuses an
    // intercepted click (first-run finding, Oct 16).
    await page.getByRole("button", { name: /From a list/ }).click();
    await page
      .getByRole("button", { name: new RegExp(LIST_NAME) })
      .dispatchEvent("click");

    // Filters screen → creates the session row.
    await page.getByRole("button", { name: "Start swiping" }).click();
    // WAIT for the invite screen before clicking again — both clicks were
    // landing on the filters button pre-rerender (first-run finding).
    await expect(page.getByText("Share this link")).toBeVisible({
      timeout: 20_000,
    });
    // Invite screen → into the deck.
    await page.getByRole("button", { name: "Start swiping" }).click();

    // THE DECK IS THE LIST: "1 of 5", whatever the host's filters say.
    await expect(page.getByText(`1 of ${LIST_SIZE}`)).toBeVisible({
      timeout: 20_000,
    });

    // Like the first two, pass the rest; deck end lands on the waiting card.
    for (let i = 0; i < LIST_SIZE; i++) {
      await page
        .getByRole("button", { name: i < 2 ? "Like" : "Pass" })
        .click();
    }
    await expect(page.getByText("Your picks are in")).toBeVisible({
      timeout: 20_000,
    });

    // The session row (host's newest) — the /s/ link's id.
    const { data: srow, error: sErr } = await host.sb
      .from("match_sessions")
      .select("id, source_type, filters")
      .eq("host_user_id", host.session.user.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();
    if (sErr) throw new Error(`session row: ${sErr.message}`);
    sessionId = srow.id;

    // THE ROW CARRIES THE LIST (the 151-places bug): exactly LIST_SIZE ids.
    expect(srow.source_type).toBe("list");
    expect(srow.filters?.viewVenueIds?.length).toBe(LIST_SIZE);

    // ---------- GUEST: open the link, auto-join, swipe ----------
    const guestCtx = await authedContext(browser, baseURL, guest.session);
    const gpage = await guestCtx.newPage();
    await gpage.goto(`/s/${sessionId}`);

    // Known-guest auto-join → the deck header counts the SAME pool.
    await expect(gpage.getByText(`${LIST_SIZE} places`)).toBeVisible({
      timeout: 30_000,
    });

    // Like the LAST two (disjoint from the host — no early match).
    for (let i = 0; i < LIST_SIZE; i++) {
      await gpage
        .getByRole("button", { name: i < LIST_SIZE - 2 ? "Pass" : "Like" })
        .click();
    }

    // ---------- BOTH SETS OF LIKES LANDED (Renasha's invisible likes) ----------
    await expect
      .poll(
        async () => {
          const { data } = await host.sb.rpc("get_session_likes", {
            p_session_id: sessionId,
          });
          const uids = new Set(
            (data || []).flatMap((r) => r.liker_user_ids || [])
          );
          return uids.size;
        },
        { timeout: 25_000, message: "both users' likes in get_session_likes" }
      )
      .toBe(2);

    await hostCtx.close();
    await guestCtx.close();
  } finally {
    // Leave no trace: the robots' session dies with the test.
    if (sessionId) {
      await host.sb.from("match_sessions").delete().eq("id", sessionId);
    }
  }
});
