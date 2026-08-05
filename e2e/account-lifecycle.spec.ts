import { expect, test, type Page } from "@playwright/test";
import { E2E_JOURNEYS } from "../packages/db/src/seed-fixtures";
import { BADGE, CARD, signIn } from "./helpers";

async function deactivateFromAccount(page: Page): Promise<void> {
  await page.getByLabel("Type DEACTIVATE to confirm").fill("DEACTIVATE");
  const deactivateButton = page.getByRole("button", {
    name: "Deactivate my account",
  });
  await expect(deactivateButton).toBeEnabled();
  const deactivated = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === "/api/account",
  );
  await deactivateButton.click();
  const response = await deactivated;
  expect(response.status()).toBe(200);
  await page.waitForURL((url) => url.pathname === "/");
}

async function expectSignedOutAccount(page: Page): Promise<void> {
  await page.goto("/account");
  const heading = page.getByRole("heading", { name: "Your account" });
  await expect(heading).toBeVisible();
  const signedOutAccount = page.locator(CARD).filter({ has: heading });
  await expect(
    signedOutAccount.getByRole("link", { name: "Sign in", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Deactivate account" }),
  ).toHaveCount(0);
}

test("admin suspension winds down a venue before the owner self-deactivates", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = E2E_JOURNEYS.lifecycle.attempts[testInfo.retry];
  if (!fixture) {
    throw new Error(
      `No account-lifecycle seed identity exists for Playwright retry ${testInfo.retry}`,
    );
  }

  const venueContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const venuePage = await venueContext.newPage();
  const adminPage = await adminContext.newPage();

  try {
    // Keep the owner's session open before the staff action. This proves the
    // suspended-session account path itself, not a new login after suspension.
    await signIn(venuePage, fixture.venue.email);
    await signIn(adminPage, fixture.admin.email);

    await venuePage.goto("/venues");
    const venueCard = venuePage.locator(CARD).filter({
      has: venuePage.getByRole("link", {
        name: fixture.venue.name,
        exact: true,
      }),
    });
    await expect(venueCard).toHaveCount(1);
    await expect(venueCard).toContainText("1 open night");
    const venueHref = await venueCard
      .getByRole("link", { name: fixture.venue.name, exact: true })
      .getAttribute("href");
    if (!venueHref) throw new Error("lifecycle venue did not expose its public URL");

    await venuePage.goto("/slots");
    const slotCard = venuePage.locator(CARD).filter({
      hasText: fixture.slot.marker,
    });
    await expect(slotCard).toHaveCount(1);
    await expect(slotCard).toContainText(fixture.venue.name);
    const slotHref = await slotCard
      .locator('a[href^="/slots/"]')
      .first()
      .getAttribute("href");
    if (!slotHref) throw new Error("lifecycle open date did not expose its URL");

    await adminPage.goto(
      `/admin/search?q=${encodeURIComponent(fixture.venue.email)}`,
    );
    const accountCard = adminPage.locator(CARD).filter({
      hasText: fixture.venue.email,
    });
    await expect(accountCard).toHaveCount(1);
    await expect(
      accountCard.locator(BADGE, { hasText: "active" }),
    ).toBeVisible();

    const suspended = adminPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /^\/api\/admin\/users\/[^/]+\/status$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await accountCard
      .getByRole("button", { name: "Suspend", exact: true })
      .click();
    const suspensionResponse = await suspended;
    expect(suspensionResponse.status()).toBe(200);
    await expect(
      accountCard.locator(BADGE, { hasText: "suspended" }),
    ).toBeVisible();
    await expect(
      accountCard.getByRole("button", { name: "Reinstate", exact: true }),
    ).toBeVisible();

    // The same atomic staff action closes the future commitment and hides the
    // marketplace presence. Assert discovery, direct slot state, and profile.
    await venuePage.goto("/slots");
    await expect(venuePage.getByText(fixture.slot.marker)).toHaveCount(0);

    await venuePage.goto(slotHref);
    await expect(
      venuePage.locator(BADGE, { hasText: "Cancelled" }).first(),
    ).toBeVisible();
    await expect(
      venuePage.getByRole("heading", { name: "Manage this open date" }),
    ).toHaveCount(0);

    const hiddenProfileResponse = await venuePage.goto(venueHref);
    expect(hiddenProfileResponse?.status()).toBe(404);

    await venuePage.goto("/account");
    const suspensionNotice = venuePage.getByRole("status").filter({
      hasText: "Account suspended.",
    });
    await expect(suspensionNotice).toBeVisible();
    await expect(suspensionNotice).toContainText(
      "Your profiles are not public and marketplace actions are unavailable.",
    );
    await expect(suspensionNotice).toContainText(
      "You can still deactivate your account below",
    );

    await deactivateFromAccount(venuePage);

    // Deactivation destroys the existing session; the account page returns to
    // the signed-out state rather than rendering stale controls.
    await expectSignedOutAccount(venuePage);
  } finally {
    await Promise.all([venueContext.close(), adminContext.close()]);
  }
});

test("active account with no commitments can deactivate permanently", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const fixture =
    E2E_JOURNEYS.lifecycle.deactivationAttempts[testInfo.retry];
  if (!fixture) {
    throw new Error(
      `No no-commitment deactivation identity exists for Playwright retry ${testInfo.retry}`,
    );
  }

  const accountContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const accountPage = await accountContext.newPage();
  const adminPage = await adminContext.newPage();

  try {
    await signIn(accountPage, fixture.account.email);
    await signIn(adminPage, fixture.admin.email);

    await adminPage.goto(
      `/admin/search?q=${encodeURIComponent(fixture.account.email)}`,
    );
    const activeAccount = adminPage.locator(CARD).filter({
      hasText: fixture.account.email,
    });
    await expect(activeAccount).toHaveCount(1);
    await expect(activeAccount).toContainText(fixture.account.id);
    await expect(
      activeAccount.locator(BADGE, { hasText: "active" }),
    ).toBeVisible();

    await accountPage.goto("/account");
    const dangerZone = accountPage.locator(CARD).filter({
      has: accountPage.getByRole("heading", { name: "Deactivate account" }),
    });
    await expect(dangerZone).toBeVisible();
    await expect(dangerZone).toContainText(
      "This immediately signs you out and removes your email or phone from the account. You will lose access to your profiles.",
    );
    await expect(dangerZone).toContainText(
      "Booking, review, dispute, and audit records are retained where needed to preserve the history shared with other participants.",
    );
    await expect(
      dangerZone.getByRole("button", { name: "Deactivate my account" }),
    ).toBeDisabled();

    await deactivateFromAccount(accountPage);
    await expectSignedOutAccount(accountPage);

    // The separate staff session proves the lifecycle change is durable, not
    // only a cleared browser cookie. Deleted accounts expose no reinstate or
    // suspension action in the real ops UI.
    await adminPage.goto(
      `/admin/search?q=${encodeURIComponent(fixture.account.id)}`,
    );
    const deletedAccount = adminPage.locator(CARD).filter({
      hasText: fixture.account.id,
    });
    await expect(deletedAccount).toHaveCount(1);
    await expect(
      deletedAccount.locator(BADGE, { hasText: "deleted" }),
    ).toBeVisible();
    await expect(deletedAccount).toContainText("Deactivated permanently");
    await expect(
      deletedAccount.getByRole("button", { name: /Suspend|Reinstate/ }),
    ).toHaveCount(0);
  } finally {
    await Promise.all([accountContext.close(), adminContext.close()]);
  }
});
