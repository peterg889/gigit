import { expect, test, type Page } from "@playwright/test";
import { E2E_JOURNEYS } from "../packages/db/src/seed-fixtures";
import { BADGE, CARD, signIn } from "./helpers";

type FixtureBooking = {
  booking: {
    id: string;
    performerId: string;
    state: string;
    terms: {
      amountCents: number;
      notes?: string;
    };
  };
  performerName: string;
  venueName: string;
};

const fixture = E2E_JOURNEYS.postgig;

async function loadFixtureBooking(page: Page): Promise<FixtureBooking> {
  const response = await page.request.get(
    new URL("/api/bookings", page.url()).toString(),
  );
  expect(response.status()).toBe(200);
  const payload = (await response.json()) as {
    bookings: FixtureBooking[];
  };
  const matches = payload.bookings.filter(
    ({ booking, performerName, venueName }) =>
      performerName === fixture.performer.name &&
      venueName === fixture.venue.name &&
      booking.terms.amountCents === fixture.booking.amountCents &&
      booking.terms.notes === fixture.booking.marker,
  );
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

async function submitReview(
  page: Page,
  bookingUrl: string,
  role: "venue" | "performer",
): Promise<void> {
  await page.goto(bookingUrl);
  const form = page.locator("form", {
    has: page.getByRole("button", { name: "Submit review" }),
  });
  if ((await form.count()) === 0) {
    await expect(page.getByText(/You reviewed this booking/)).toBeVisible();
    return;
  }

  await form.getByLabel("Overall (1–5)").fill("5");
  if (role === "venue") {
    await form.getByLabel(/Draw/).fill("4");
    await form.getByLabel("Professionalism (1–5)").fill("5");
    await form.getByLabel("Performance quality (1–5)").fill("5");
    await form.getByLabel("Comments").fill(fixture.booking.venueReviewBody);
  } else {
    await form.getByLabel("Hospitality (1–5)").fill("5");
    await form.getByLabel(/Room as described/).fill("4");
    await form.getByLabel(/Payment & terms/).fill("5");
    await form.getByLabel("Comments").fill(fixture.booking.performerReviewBody);
  }

  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname.endsWith("/review"),
  );
  await form.getByRole("button", { name: "Submit review" }).click();
  const response = await submitted;
  expect(response.status()).toBe(201);
  await expect(page.getByText(/You reviewed this booking/)).toBeVisible();
}

test("post-gig dispute is resolved as played, then both sides review", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const venueContext = await browser.newContext();
  const performerContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const venuePage = await venueContext.newPage();
  const performerPage = await performerContext.newPage();
  const adminPage = await adminContext.newPage();

  try {
    await signIn(venuePage, fixture.venue.email);
    await signIn(performerPage, fixture.performer.email);
    await signIn(adminPage, fixture.admin.email);

    // Discover the seeded record exactly as each booking party does. The test
    // never imports a DB client or reaches around the product's API.
    let venueBooking = await loadFixtureBooking(venuePage);
    const performerBooking = await loadFixtureBooking(performerPage);
    expect(performerBooking.booking.id).toBe(venueBooking.booking.id);
    const bookingUrl = `/bookings/${venueBooking.booking.id}`;
    const publicPerformerUrl = `/p/${venueBooking.booking.performerId}`;

    // A retry may resume after an earlier attempt already crossed one of these
    // durable boundaries. Fresh runs still exercise and assert every mutation.
    if (venueBooking.booking.state === "awaiting_confirmation") {
      await venuePage.goto(bookingUrl);
      await expect(
        venuePage
          .locator(BADGE, { hasText: "Gig played — awaiting confirmation" })
          .first(),
      ).toBeVisible();
      const disputeForm = venuePage.locator("form", {
        has: venuePage.getByRole("button", { name: "Open a dispute" }),
      });
      await disputeForm
        .getByLabel("Issue")
        .selectOption(fixture.booking.disputeCategory);
      await disputeForm
        .getByLabel("What happened?")
        .fill(fixture.booking.disputeReason);
      const disputed = venuePage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname.endsWith("/dispute"),
      );
      await disputeForm
        .getByRole("button", { name: "Open a dispute" })
        .click();
      const response = await disputed;
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ state: "disputed" });
      venueBooking = await loadFixtureBooking(venuePage);
    }

    if (venueBooking.booking.state === "disputed") {
      await performerPage.goto(bookingUrl);
      // The customer-facing label for the durable `disputed` state is “Under
      // review”; assert both so copy and state are covered.
      await expect(
        performerPage.locator(BADGE, { hasText: "Under review" }).first(),
      ).toBeVisible();
      expect((await loadFixtureBooking(performerPage)).booking.state).toBe(
        "disputed",
      );

      await adminPage.goto("/admin/disputes");
      const report = adminPage.locator(CARD).filter({
        has: adminPage.getByRole("heading", {
          name: `${fixture.performer.name} at ${fixture.venue.name}`,
        }),
      });
      await expect(report).toHaveCount(1);
      await expect(report).toContainText(fixture.booking.disputeReason);
      const playedForm = report.locator("form", {
        has: adminPage.getByRole("button", { name: "Close as played" }),
      });
      await playedForm
        .getByLabel("Responsible side")
        .selectOption("neither");
      const resolved = adminPage.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          /\/api\/admin\/disputes\/[^/]+\/resolve$/.test(
            new URL(response.url()).pathname,
          ),
      );
      await playedForm
        .getByRole("button", { name: "Close as played" })
        .click();
      const response = await resolved;
      expect(response.status()).toBe(200);
      expect(await response.json()).toMatchObject({ state: "released" });
      venueBooking = await loadFixtureBooking(venuePage);
    }

    expect(venueBooking.booking.state).toBe("released");
    await performerPage.goto(bookingUrl);
    await expect(
      performerPage.locator(BADGE, { hasText: "Completed" }).first(),
    ).toBeVisible();
    await expect(
      performerPage
        .getByRole("heading", { name: "Leave a review" })
        .or(performerPage.getByText(/You reviewed this booking/)),
    ).toBeVisible();

    await submitReview(venuePage, bookingUrl, "venue");
    await submitReview(performerPage, bookingUrl, "performer");

    await venuePage.goto(publicPerformerUrl);
    await expect(
      venuePage.getByRole("heading", { name: fixture.performer.name }),
    ).toBeVisible();
    await expect(
      venuePage.getByRole("heading", { name: "Reviews from venues" }),
    ).toBeVisible();
    await expect(
      venuePage.getByText(fixture.booking.venueReviewBody),
    ).toBeVisible();
  } finally {
    await Promise.all([
      venueContext.close(),
      performerContext.close(),
      adminContext.close(),
    ]);
  }
});
