import { expect, test } from "@playwright/test";
import {
  BADGE,
  CARD,
  MONEY,
  acceptOffer,
  assertPrimitives,
  expectBookingBadge,
  sendOffer,
  signIn,
} from "./helpers";

/**
 * The critical journey (engineering-spec §13 E2E #2): post open date → apply →
 * offer → accept → CONFIRMED. Exercises web UI, API, state machine, and the
 * worker's payment round-trip (Null gateway) in one pass.
 *
 * `pnpm e2e` owns an isolated migrated/seeded database plus the production web
 * and worker processes (dev OTP 000000).
 */

test("venue posts an open date; performer applies; offer; accept; booking confirms", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const runMarker = `${Date.now()}-${testInfo.retry}`;
  const seriesMarker = `e2e anchored series ${runMarker}`;
  const venue = await browser.newContext();
  const performer = await browser.newContext();
  const vp = await venue.newPage();
  const pp = await performer.newPage();

  // ── venue posts an open date ──
  await signIn(vp, "venue@example.com");

  // A venue may deliberately choose a first recurring night several matching
  // weekdays out. The selected night—not the next matching weekday after
  // today—is the first listing. Use a unique note and the series form's own
  // button so this remains independent of the one-off form beside it.
  const venueTimeZone = "America/Chicago";
  // Playwright retries share the same isolated database. Keep attempt one
  // clear of attempt zero's confirmed original and repeat bookings.
  const firstNightDaysOut = 35 * (testInfo.retry + 1);
  const targetLocalParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: venueTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(Date.now() + firstNightDaysOut * 86_400_000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const firstNightLocal = [
    targetLocalParts.year,
    targetLocalParts.month,
    targetLocalParts.day,
  ].join("-") + "T20:15";

  await vp.goto("/slots/new");
  await vp.getByText("Make it a series", { exact: true }).click();
  const seriesForm = vp.locator("form", {
    has: vp.getByRole("button", { name: "Start the series" }),
  });
  await seriesForm
    .getByLabel("First night — date & start time")
    .fill(firstNightLocal);
  await seriesForm.getByLabel("Repeats").selectOption("weekly");
  await seriesForm.getByLabel("Duration (minutes)").fill("120");
  await seriesForm.getByLabel("Format", { exact: true }).selectOption("music");
  await seriesForm.getByLabel("Pay per night, in dollars").fill("415");
  await seriesForm.getByLabel("About the night").fill(seriesMarker);
  const seriesCreated = vp.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/series",
  );
  await seriesForm.getByRole("button", { name: "Start the series" }).click();
  const seriesResponse = await seriesCreated;
  expect(seriesResponse.status()).toBe(201);
  const { seriesId } = (await seriesResponse.json()) as { seriesId: string };
  await vp.waitForURL("**/slots");

  const listedSeriesResponse = await vp.request.get(
    new URL("/api/series", vp.url()).toString(),
  );
  expect(listedSeriesResponse.status()).toBe(200);
  const listedSeries = (await listedSeriesResponse.json()) as {
    series: Array<{
      id: string;
      pattern: { firstStartsAt?: string };
    }>;
  };
  const firstStartsAt = listedSeries.series.find(
    (series) => series.id === seriesId,
  )?.pattern.firstStartsAt;
  expect(firstStartsAt).toBeTruthy();
  const selectedFirstNight = new Date(firstStartsAt!);
  const persistedLocalParts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: venueTimeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(selectedFirstNight)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  expect(
    `${persistedLocalParts.year}-${persistedLocalParts.month}-${persistedLocalParts.day}` +
      `T${persistedLocalParts.hour}:${persistedLocalParts.minute}`,
  ).toBe(firstNightLocal);

  const anchoredCards = vp.locator(CARD).filter({ hasText: seriesMarker });
  await expect(anchoredCards).toHaveCount(4);
  const selectedFirstNightLabel = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: venueTimeZone,
  }).format(selectedFirstNight);
  await expect(anchoredCards.first()).toContainText(selectedFirstNightLabel);
  await expect(
    anchoredCards.filter({ hasText: selectedFirstNightLabel }),
  ).toHaveCount(1);
  const slotUrl = await anchoredCards
    .first()
    .locator('a[href^="/slots/"]')
    .first()
    .getAttribute("href");
  if (!slotUrl) throw new Error("created series did not render a slot link");
  // Fail loudly if the CSS primitives were renamed out from under the suite.
  await assertPrimitives(vp);

  // ── performer opens the exact new listing and applies ──
  await signIn(pp, "band@example.com");
  await pp.goto(slotUrl);
  await expect(pp.locator(MONEY).first()).toHaveText("$415"); // the pay is on the poster
  await pp.getByRole("button", { name: /Apply/ }).click();
  await expect(pp.getByText("Application sent")).toBeVisible();

  // ── venue sees the applicant and sends the offer ──
  const bookingUrl = await sendOffer(vp, slotUrl);

  // Performer reviews the complete deal, explicitly accepts, and the worker
  // (Null gateway) confirms it.
  await pp.goto(bookingUrl);
  await expect(
    pp.getByRole("heading", { name: "The deal, in writing" }),
  ).toBeVisible();
  await expect(pp.getByText(/\$415/).first()).toBeVisible();

  // The offer transaction opens the shared conversation before either side
  // commits. Exercise both directions and the booking context deep link.
  const conversationUrl = await pp
    .getByRole("link", { name: "Open the conversation" })
    .getAttribute("href");
  if (!conversationUrl)
    throw new Error("firm offer did not create a booking conversation");
  const performerQuestion = `Load-in question ${runMarker}`;
  await pp.goto(conversationUrl);
  await pp.getByLabel("Reply").fill(performerQuestion);
  const questionSent = pp.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/messages"),
  );
  await pp.getByRole("button", { name: "Send" }).click();
  expect((await questionSent).status()).toBe(201);

  const venueReply = `Doors at six ${runMarker}`;
  await vp.goto(conversationUrl);
  await expect(vp.getByText(performerQuestion)).toBeVisible();
  await vp.getByLabel("Reply").fill(venueReply);
  const replySent = vp.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/messages"),
  );
  await vp.getByRole("button", { name: "Send" }).click();
  expect((await replySent).status()).toBe(201);
  await pp.goto(conversationUrl);
  await expect(pp.getByText(venueReply)).toBeVisible();

  await pp.goto(bookingUrl);
  const accepted = pp.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().endsWith("/accept"),
  );

  pp.once("dialog", (dialog) => dialog.accept());
  await pp
    .getByRole("button", { name: "Accept this firm offer" })
    .click();
  expect((await accepted).status()).toBe(200);

  await expectBookingBadge(pp, bookingUrl, "Confirmed");

  // The next materialized occurrence in the same series is the preferred
  // repeat target. Rebooking creates a new firm offer at that listing's terms.
  await vp.goto(bookingUrl);
  const rebook = vp.getByRole("button", { name: /Book them again/ });
  await expect(rebook).toBeVisible();
  const rebooked = vp.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/rebook"),
  );
  vp.once("dialog", (dialog) => dialog.accept());
  await rebook.click();
  const rebookResponse = await rebooked;
  expect(rebookResponse.status()).toBe(201);
  const rebookPayload = (await rebookResponse.json()) as { bookingId?: string };
  if (!rebookPayload.bookingId) {
    throw new Error("rebook did not return a booking id");
  }
  const repeatBookingUrl = `/bookings/${rebookPayload.bookingId}`;
  await pp.goto(repeatBookingUrl);
  await expectBookingBadge(pp, repeatBookingUrl, "Offer awaiting response");
  await expect(pp.getByText("Firm offer.", { exact: true })).toBeVisible();
  await expect(pp.getByText(/\$415/).first()).toBeVisible();
  await acceptOffer(pp, repeatBookingUrl);
  await expectBookingBadge(pp, repeatBookingUrl, "Confirmed");

  // A future cancellation is not a completed gig. Neither party should see a
  // review form, and calling the endpoint directly must also be rejected.
  await pp.goto(bookingUrl);
  const cancelled = pp.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().endsWith("/cancel"),
  );
  pp.once("dialog", (dialog) => dialog.accept());
  await pp.getByRole("button", { name: "Cancel booking" }).click();
  expect((await cancelled).status()).toBe(200);
  await expect(
    pp.locator(BADGE, { hasText: "Cancelled by act" }).first(),
  ).toBeVisible();
  await expect(
    pp.getByRole("heading", { name: "Leave a review" }),
  ).toHaveCount(0);

  const bookingId = bookingUrl.split("/").at(-1)!;
  const blockedReview = await pp.request.post(
    new URL(`/api/bookings/${bookingId}/review`, pp.url()).toString(),
    { data: { ratings: { overall: 5 } } },
  );
  expect(blockedReview.status()).toBe(409);
  expect(await blockedReview.json()).toMatchObject({
    error: { code: "conflict", message: "Reviews open once the gig is done." },
  });

  await vp.goto(bookingUrl);
  await expect(
    vp.locator(BADGE, { hasText: "Cancelled by act" }).first(),
  ).toBeVisible();
  await expect(
    vp.getByRole("heading", { name: "Leave a review" }),
  ).toHaveCount(0);

  await venue.close();
  await performer.close();
});
