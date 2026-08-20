import { expect, test, type Page } from "@playwright/test";
import {
  BADGE,
  acceptOffer,
  applyToSlot,
  assertPrimitives,
  expectBookingBadge,
  postSlotAt,
  sendOffer,
  signIn,
} from "./helpers";

const OVERLAP_COPY =
  "That sound tech is already booked for an overlapping gig. Choose another tech or a different time.";

async function postSoundJob(
  page: Page,
  bookingUrl: string,
  techPay: string,
  jobMarker: string,
): Promise<{ id: string; url: string }> {
  await page.goto(bookingUrl);
  // Exact, not a substring: "Needs a tech" is a PREFIX of "Needs a tech and a
  // rig", so the old regex matched either verdict. This scenario's seed (house
  // desk of 8 channels, act needing 10) is specifically the tech-only verdict —
  // a plan that silently escalated to demanding a rig would have gone unnoticed.
  await expect(
    page.getByText("Needs a tech", { exact: true }).first(),
  ).toBeVisible();
  await page.getByLabel("Who pays the tech").selectOption("venue");
  await page.getByLabel("Tech pay, in dollars").fill(techPay);
  await page.getByLabel("Anything the tech should know").fill(jobMarker);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /^\/api\/bookings\/[^/]+\/tech-subslot$/.test(
        new URL(response.url()).pathname,
      ),
  );
  await page.getByRole("button", { name: "Post the sound job" }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const payload = (await response.json()) as { subslotId?: string };
  if (!payload.subslotId)
    throw new Error("sound-job creation did not return an id");
  await expect(page.locator(BADGE, { hasText: "Open" }).first()).toBeVisible();
  return { id: payload.subslotId, url: `/sound/${payload.subslotId}` };
}

async function applyToSoundJob(page: Page, jobMarker: string) {
  await page.goto("/techs");
  // The marketplace panel and each job share the visual card primitive. Scope
  // by the job's semantic article role so a matching note in the nested card
  // cannot also select its containing panel.
  const job = page.getByRole("article").filter({ hasText: jobMarker });
  await expect(job).toBeVisible();
  await job.getByRole("button", { name: "Apply — pay as listed" }).click();
  await expect(job.getByText("Application sent")).toBeVisible();
}

/**
 * The differentiator journey (PRD F6): a confirmed booking whose sound plan
 * has gaps (seed: band needs 10 inputs, house PA has 8 channels) → venue
 * posts the sound job → tech finds it on /techs, sees pay, applies → payer
 * books the tech → an overlapping second selection is rejected without
 * consuming its pending application → the first sub-slot reads "Tech booked".
 */
test("sound work: booking one overlapping gig preserves the other application", async ({
  browser,
}, testInfo) => {
  const runId = Date.now();
  const marker = `e2e sound primary ${runId}`;
  const jobMarker = `primary sound job ${runId}`;
  const overlapMarker = `e2e sound overlap ${runId}`;
  const overlapJobMarker = `overlap sound job ${runId}`;
  // Strict selectors are only useful if the scenario data itself is unique.
  expect(jobMarker).not.toContain(overlapJobMarker);
  expect(overlapJobMarker).not.toContain(jobMarker);
  const budget = "425";
  const techPay = "180";
  const venue = await browser.newContext();
  const performer = await browser.newContext();
  const overlapPerformer = await browser.newContext();
  const tech = await browser.newContext();
  const vp = await venue.newPage();
  const pp = await performer.newPage();
  const op = await overlapPerformer.newPage();
  const tp = await tech.newPage();

  // ── two confirmed bookings at the exact same instant ──
  await signIn(vp, "venue-sound@example.com");
  // Retry attempts use a different night so an earlier committed attempt does
  // not overlap this one. Within an attempt both slots share the same minute,
  // making the tech-calendar conflict deterministic rather than timing-based.
  const startsAt = new Date(
    Date.now() + (28 + testInfo.retry * 3) * 86_400_000,
  );
  const slotUrl = await postSlotAt(vp, marker, budget, startsAt);
  const overlapSlotUrl = await postSlotAt(
    vp,
    overlapMarker,
    budget,
    startsAt,
  );
  // Fail loudly if the CSS primitives were renamed out from under the suite.
  await assertPrimitives(vp);
  await signIn(pp, "band-sound@example.com");
  await applyToSlot(pp, slotUrl);
  const bookingUrl = await sendOffer(vp, slotUrl);
  await acceptOffer(pp, bookingUrl);
  await expectBookingBadge(pp, bookingUrl, "Confirmed");

  await signIn(op, "band-sound-overlap@example.com");
  await applyToSlot(op, overlapSlotUrl);
  const overlapBookingUrl = await sendOffer(vp, overlapSlotUrl);
  await acceptOffer(op, overlapBookingUrl);
  await expectBookingBadge(op, overlapBookingUrl, "Confirmed");

  // ── venue posts sound work for both overlapping gigs ──
  const sound = await postSoundJob(vp, bookingUrl, techPay, jobMarker);
  const overlapSound = await postSoundJob(
    vp,
    overlapBookingUrl,
    techPay,
    overlapJobMarker,
  );

  // ── tech discovers both jobs with pay visible and applies to each ──
  await signIn(tp, "tech@example.com");
  await applyToSoundJob(tp, jobMarker);
  await applyToSoundJob(tp, overlapJobMarker);

  // ── payer books the first gig, then gets an actionable overlap conflict ──
  await vp.goto(bookingUrl);
  await vp.getByRole("button", { name: "Book this tech" }).click();
  await expect(vp.locator(BADGE, { hasText: "Tech booked" }).first()).toBeVisible();

  await vp.goto(overlapBookingUrl);
  const rejected = vp.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname ===
        `/api/tech-subslots/${overlapSound.id}/book`,
  );
  await vp.getByRole("button", { name: "Book this tech" }).click();
  const rejectedResponse = await rejected;
  expect(rejectedResponse.status()).toBe(409);
  expect(await rejectedResponse.json()).toEqual({
    error: { code: "tech_unavailable", message: OVERLAP_COPY },
  });
  await expect(vp.getByText(OVERLAP_COPY, { exact: true })).toBeVisible();
  await expect(vp.locator(BADGE, { hasText: "Open" }).first()).toBeVisible();
  await expect(
    vp.locator(BADGE, { hasText: "Application received" }),
  ).toBeVisible();

  // Reload from persistence: the failed selection consumed neither the open
  // job nor its pending application, so the venue can choose another tech.
  await vp.reload();
  await expect(vp.locator(BADGE, { hasText: "Open" }).first()).toBeVisible();
  await expect(
    vp.locator(BADGE, { hasText: "Application received" }),
  ).toBeVisible();
  await expect(
    vp.getByRole("button", { name: "Book this tech" }),
  ).toBeVisible();

  // ── the tech sees one booking and one still-pending application ──
  await tp.goto(sound.url);
  await expect(tp.getByRole("heading", { name: "You are booked" })).toBeVisible();
  await tp.goto(overlapSound.url);
  await expect(tp.getByRole("heading", { name: "Your application" })).toBeVisible();
  await expect(tp.locator(BADGE, { hasText: "Application sent" })).toBeVisible();

  await venue.close();
  await performer.close();
  await overlapPerformer.close();
  await tech.close();
});
