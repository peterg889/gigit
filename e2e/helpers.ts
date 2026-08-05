import { expect, type Page } from "@playwright/test";

/**
 * The CSS primitives the specs navigate by.
 *
 * These class names were spelled out at 19 call sites across four files, so
 * renaming one in the stylesheet meant hunting them down — in the suite that
 * gates the staging deploy. Naming them here makes a rename one edit.
 *
 * This does not truly decouple tests from styling (that needs test ids in the
 * markup, on dozens of elements), but it removes the scattered magic strings and
 * `assertPrimitives` turns a rename into an obvious failure rather than a pile of
 * "element not found".
 */
export const CARD = ".card";
export const BADGE = ".badge";
export const MONEY = ".money";

/**
 * Fail early and legibly if the primitives have been renamed out from under the
 * suite. Call once per spec after the first page load.
 */
export async function assertPrimitives(page: Page) {
  const cards = await page.locator(CARD).count();
  if (cards === 0)
    throw new Error(
      `No "${CARD}" elements on ${page.url()} — the primitive was probably ` +
        `renamed in globals.css. Update CARD/BADGE/MONEY in e2e/helpers.ts.`,
    );
}

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
): Promise<string> {
  const startsAt = new Date(Date.now() + daysOut * 86_400_000);
  return postSlotAt(page, marker, budgetUsd, startsAt);
}

/** Post at an exact shared instant, used by interval-boundary journeys. */
export async function postSlotAt(
  page: Page,
  marker: string,
  budgetUsd: string,
  startsAt: Date,
): Promise<string> {
  await page.goto("/slots/new");
  const dtLocal = new Date(startsAt.getTime() - startsAt.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  // Scope to the single-date form. /slots/new renders two forms sharing these
  // field names; both labels used to point at the FIRST form's inputs because
  // ApiForm keyed DOM ids off the field name, so an unscoped getByLabel resolved
  // to one element by accident. Ids are per-form now, so the form has to be named.
  const form = page.locator("form", { has: page.getByRole("button", { name: "Post open date" }) });
  await form.getByLabel("Date & start time").fill(dtLocal);
  await form.getByLabel("Duration (minutes)").fill("120");
  await form.getByLabel("Format", { exact: true }).selectOption("music");
  await form.getByLabel("Pay for the night, in dollars").fill(budgetUsd);
  await form.getByLabel(/About the night/).fill(marker);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/slots",
  );
  await form.getByRole("button", { name: "Post open date" }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as { id?: string };
  if (!payload.id) throw new Error("slot creation did not return an id");
  await page.waitForURL("**/slots");
  return `/slots/${payload.id}`;
}

/** Open the exact slot created by this journey and apply. */
export async function applyToSlot(page: Page, slotUrl: string) {
  await page.goto(slotUrl);
  await page.getByRole("button", { name: /Apply/ }).click();
  await expect(page.getByText("Application sent")).toBeVisible();
}

/** As the venue, open the exact slot and send the firm offer. */
export async function sendOffer(page: Page, slotUrl: string): Promise<string> {
  await page.goto(slotUrl);
  await expect(page.getByText(/Applicants \(/)).toBeVisible();
  const offered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /^\/api\/applications\/[^/]+\/offer$/.test(new URL(response.url()).pathname),
  );
  await page.getByRole("button", { name: "Send firm offer" }).click();
  const response = await offered;
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as { bookingId?: string };
  if (!payload.bookingId) throw new Error("offer creation did not return a booking id");
  await expect(page.getByText("Firm offer sent.")).toBeVisible();
  return `/bookings/${payload.bookingId}`;
}

/** Invite an act to a specific open date from the venue-facing directory. */
export async function invitePerformer(
  page: Page,
  performerName: string,
  slotUrl: string,
): Promise<string> {
  const slotId = slotUrl.split("/").at(-1);
  if (!slotId) throw new Error(`could not read slot id from ${slotUrl}`);
  await page.goto("/performers");
  const card = page.locator(CARD, { hasText: performerName });
  await expect(card).toBeVisible();
  await card.getByLabel("Which night?").selectOption(slotId);
  const invited = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/api/slots/${slotId}/invite`,
  );
  await card
    .getByRole("button", { name: `Invite ${performerName} to a date` })
    .click();
  const response = await invited;
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as { bookingId?: string };
  if (!payload.bookingId) throw new Error("invite did not return a booking id");
  return `/bookings/${payload.bookingId}`;
}

/** As the performer, open the exact offer created by this journey and accept it. */
export async function acceptOffer(page: Page, bookingUrl: string) {
  await page.goto(bookingUrl);
  const accepted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/accept"),
  );
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Accept this firm offer" }).click();
  expect((await accepted).status()).toBe(200);
  return bookingUrl;
}

/** Poll the exact booking until it reaches the expected state. */
export async function expectBookingBadge(
  page: Page,
  bookingUrl: string,
  badge: string,
) {
  await expect
    .poll(
      async () => {
        await page.goto(bookingUrl);
        return page.locator(BADGE, { hasText: badge }).first().count();
      },
      { timeout: 20_000, message: `booking should show "${badge}"` },
    )
    .toBeGreaterThan(0);
}
