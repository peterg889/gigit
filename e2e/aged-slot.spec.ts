import { expect, test } from "@playwright/test";
import { E2E_JOURNEYS } from "../packages/db/src/seed-fixtures";
import { BADGE, CARD, signIn } from "./helpers";

test("a past open date expires, leaves discovery, and rejects every booking action", async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const fixture = E2E_JOURNEYS.aged.attempts[testInfo.retry];
  if (!fixture) {
    throw new Error(
      `No aged-slot seed identity exists for Playwright retry ${testInfo.retry}`,
    );
  }

  const venueContext = await browser.newContext();
  const performerContext = await browser.newContext();
  const venuePage = await venueContext.newPage();
  const performerPage = await performerContext.newPage();
  const slotUrl = `/slots/${fixture.slot.id}`;

  try {
    await signIn(performerPage, fixture.performer.email);
    await signIn(venuePage, fixture.venue.email);

    // Time-aware reads remove the stale row immediately, even before the
    // worker's persisted expiry sweep completes.
    await performerPage.goto("/slots");
    await expect(performerPage.getByText(fixture.slot.marker)).toHaveCount(0);

    // Wait on the user-visible application outcome rather than worker logs.
    // This proves the boot reconciler persisted both slot expiry and the
    // pending application's truthful close reason.
    const expiryOutcome =
      "This date passed without a booking, so your application was closed.";
    await expect
      .poll(
        async () => {
          await performerPage.goto(slotUrl);
          return performerPage.getByText(expiryOutcome, { exact: true }).count();
        },
        {
          timeout: 30_000,
          message: "the worker should reconcile the past open date",
        },
      )
      .toBe(1);

    await expect(
      performerPage.locator(BADGE, { hasText: "Date passed" }).first(),
    ).toBeVisible();
    await expect(
      performerPage.getByText("This date has passed.", { exact: true }),
    ).toBeVisible();
    await expect(
      performerPage.getByRole("button", { name: /Apply/ }),
    ).toHaveCount(0);

    // A stale client cannot bypass the hidden apply control.
    const blockedApply = await performerPage.request.post(
      new URL(
        `/api/slots/${fixture.slot.id}/applications`,
        performerPage.url(),
      ).toString(),
      { data: { note: "This request must not revive a past date." } },
    );
    expect(blockedApply.status()).toBe(409);
    expect(await blockedApply.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "This date is no longer open.",
      },
    });

    // Owners retain the historical applicant view, but no offer action.
    await venuePage.goto(slotUrl);
    await expect(
      venuePage.locator(BADGE, { hasText: "Date passed" }).first(),
    ).toBeVisible();
    await expect(
      venuePage.getByRole("heading", { name: "Manage this open date" }),
    ).toHaveCount(0);
    const applicantCard = venuePage
      .locator(`${CARD} ${CARD}`)
      .filter({
        has: venuePage.getByRole("link", {
          name: fixture.performer.name,
          exact: true,
        }),
      });
    await expect(applicantCard).toHaveCount(1);
    await expect(
      applicantCard.getByText("Not selected", { exact: true }),
    ).toBeVisible();
    await expect(
      applicantCard.getByRole("button", { name: "Send firm offer" }),
    ).toHaveCount(0);

    const performerHref = await applicantCard
      .getByRole("link", { name: fixture.performer.name, exact: true })
      .getAttribute("href");
    const performerId = performerHref?.split("/").at(-1);
    if (!performerId) {
      throw new Error("aged-slot applicant did not expose a performer id");
    }

    // The production offer endpoint agrees with the read model.
    const blockedOffer = await venuePage.request.post(
      new URL(
        `/api/applications/${fixture.slot.applicationId}/offer`,
        venuePage.url(),
      ).toString(),
      { data: { amountCents: fixture.slot.amountCents } },
    );
    expect(blockedOffer.status()).toBe(409);
    expect(await blockedOffer.json()).toMatchObject({
      error: {
        code: "conflict",
        message:
          "This application is no longer open, so it can't be offered the night.",
      },
    });

    // The venue directory must not offer a past date in its invite selector.
    await venuePage.goto("/performers");
    const performerCard = venuePage.locator(CARD).filter({
      has: venuePage.getByRole("link", {
        name: fixture.performer.name,
        exact: true,
      }),
    });
    await expect(performerCard).toHaveCount(1);
    await expect(
      performerCard.getByRole("button", {
        name: `Invite ${fixture.performer.name} to a date`,
      }),
    ).toHaveCount(0);
    await expect(performerCard.getByLabel("Which night?")).toHaveCount(0);

    // A stale invite request is rejected too. The direct slot page above
    // already proved the id exists, so this 404 is specifically the route's
    // future-date guard rather than a fabricated resource.
    const blockedInvite = await venuePage.request.post(
      new URL(`/api/slots/${fixture.slot.id}/invite`, venuePage.url()).toString(),
      { data: { performerId } },
    );
    expect(blockedInvite.status()).toBe(404);
    expect(await blockedInvite.json()).toMatchObject({
      error: {
        code: "not_found",
        message: "We couldn't find that date.",
      },
    });
  } finally {
    await Promise.all([venueContext.close(), performerContext.close()]);
  }
});
