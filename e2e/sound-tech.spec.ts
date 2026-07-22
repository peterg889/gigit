import { expect, test } from "@playwright/test";
import {
  acceptOffer,
  applyToSlot,
  expectBookingBadge,
  postSlot,
  sendOffer,
  signIn,
} from "./helpers";

/**
 * The differentiator journey (PRD F6): a confirmed booking whose sound plan
 * has gaps (seed: band needs 10 inputs, house PA has 8 channels) → venue
 * posts the sound job → tech finds it on /techs, sees pay, applies → payer
 * books the tech → the sub-slot reads "Tech booked" for everyone.
 */
test("sound gap: venue posts sound job, tech applies, payer books the tech", async ({
  browser,
}) => {
  const marker = `e2e sound ${Date.now()}`;
  const budget = "425";
  const techPay = "180";
  const venue = await browser.newContext();
  const performer = await browser.newContext();
  const tech = await browser.newContext();
  const vp = await venue.newPage();
  const pp = await performer.newPage();
  const tp = await tech.newPage();

  // ── confirmed booking with a sound gap ──
  await signIn(vp, "venue@example.com");
  // Different night from the other specs: the seeded band's calendar is shared
  // across parallel journeys and double-booking correctly 409s.
  await postSlot(vp, marker, budget, 28);
  await signIn(pp, "band@example.com");
  await applyToSlot(pp, marker);
  await sendOffer(vp, marker);
  const bookingUrl = await acceptOffer(pp, `$${budget}`);
  await expectBookingBadge(pp, `$${budget}`, "Confirmed");

  // ── venue posts the sound job from the booking page ──
  await vp.goto(bookingUrl);
  await expect(vp.getByText(/tech needed|tech \+ rig needed/i).first()).toBeVisible();
  await vp.getByLabel("Who pays the tech").selectOption("venue");
  await vp.getByLabel("Tech pay (USD)").fill(techPay);
  await vp.getByRole("button", { name: "Post the sound job" }).click();
  await expect(vp.locator(".badge", { hasText: "Open" }).first()).toBeVisible();

  // ── tech discovers the job with the pay visible, applies ──
  await signIn(tp, "tech@example.com");
  await tp.goto("/techs");
  const job = tp.locator(".card", { hasText: `$${techPay}` }).first();
  await expect(job).toBeVisible();
  await job.getByRole("button", { name: "Apply — pay as listed" }).click();
  await expect(tp.getByText("Application sent").first()).toBeVisible();

  // ── the payer books the tech ──
  await vp.goto(bookingUrl);
  await vp.getByRole("button", { name: "Book this tech" }).click();
  await expect(vp.locator(".badge", { hasText: "Tech booked" }).first()).toBeVisible();

  // ── the tech sees it booked on their side too ──
  await tp.goto("/bookings");
  await expect(
    tp.locator(".card", { hasText: `$${techPay}` }).first().locator(".badge", {
      hasText: "Booked",
    }),
  ).toBeVisible();

  await venue.close();
  await performer.close();
  await tech.close();
});
