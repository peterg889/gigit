import { expect, type Page } from "@playwright/test";

/** Dev-stack sign-in: seeded users, dev OTP 000000. */
export async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Send code" }).click();
  await page.getByLabel(/Enter the code/).fill("000000");
  await page.getByRole("button", { name: "Verify code" }).click();
  await page.waitForURL("**/onboarding");
}

/** Post an open date as the signed-in venue; the marker identifies it later. */
export async function postSlot(
  page: Page,
  marker: string,
  budgetUsd: string,
  daysOut = 14,
) {
  await page.goto("/slots/new");
  const startsAt = new Date(Date.now() + daysOut * 86_400_000);
  const dtLocal = new Date(startsAt.getTime() - startsAt.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  await page.getByLabel("Date & start time").fill(dtLocal);
  await page.getByLabel("Duration (minutes)").fill("120");
  await page.getByLabel("Format", { exact: true }).selectOption("music");
  await page.getByLabel("Budget (USD)").fill(budgetUsd);
  await page.getByLabel(/About the night/).fill(marker);
  await page.getByRole("button", { name: "Post open date" }).click();
  await page.waitForURL("**/slots");
}

/** From the feed, open the slot card carrying the marker and apply. */
export async function applyToSlot(page: Page, marker: string) {
  await page.goto("/slots");
  const card = page.locator(".card", { hasText: marker });
  await expect(card).toBeVisible();
  await card.getByRole("link").first().click();
  await page.getByRole("button", { name: /Apply/ }).click();
}

/** As the venue, open the marked slot and send the firm offer. */
export async function sendOffer(page: Page, marker: string) {
  await page.goto("/slots");
  await page.locator(".card", { hasText: marker }).getByRole("link").first().click();
  await expect(page.getByText(/Applicants \(/)).toBeVisible();
  await page.getByRole("button", { name: "Send firm offer" }).click();
  await expect(page.getByText("Firm offer sent.")).toBeVisible();
}

/** As the performer, open the newest offer for `budgetText` and accept it. */
export async function acceptOffer(page: Page, budgetText: string) {
  await page.goto("/bookings");
  await page
    .locator(".card", { hasText: budgetText })
    .first()
    .getByRole("link", { name: "Review the deal and respond" })
    .click();
  const accepted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/accept"),
  );
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Accept this firm offer" }).click();
  expect((await accepted).status()).toBe(200);
  return page.url();
}

/** Poll /bookings until the card for `budgetText` shows the badge. */
export async function expectBookingBadge(
  page: Page,
  budgetText: string,
  badge: string,
) {
  await expect
    .poll(
      async () => {
        await page.goto("/bookings");
        return page
          .locator(".card", { hasText: budgetText })
          .first()
          .locator(".badge", { hasText: badge })
          .count();
      },
      { timeout: 20_000, message: `booking should show "${badge}"` },
    )
    .toBeGreaterThan(0);
}
