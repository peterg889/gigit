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
 * The recovery loop (audit: PERFORMER_DECLINED dead-end): a declined offer
 * must never lock the pairing out of the night. Decline → slot reopens →
 * the SAME act re-applies (revives the withdrawn application) → the venue
 * re-offers → the act accepts → CONFIRMED.
 */
test("declined offer: slot reopens, same act re-applies, second offer confirms", async ({
  browser,
}) => {
  const marker = `e2e decline ${Date.now()}`;
  const budget = "275";
  const venue = await browser.newContext();
  const performer = await browser.newContext();
  const vp = await venue.newPage();
  const pp = await performer.newPage();

  await signIn(vp, "venue@example.com");
  // Specs run in parallel against the same seeded band: each journey books a
  // DIFFERENT night or the calendar double-book guard correctly 409s the next.
  await postSlot(vp, marker, budget, 21);

  await signIn(pp, "band@example.com");
  await applyToSlot(pp, marker);
  await sendOffer(vp, marker);

  // ── the act declines the firm offer ──
  await pp.goto("/bookings");
  await pp
    .locator(".card", { hasText: `$${budget}` })
    .first()
    .getByRole("link", { name: "Review the deal and respond" })
    .click();
  const declined = pp.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/cancel"),
  );
  pp.once("dialog", (d) => d.accept());
  await pp.getByRole("button", { name: "Decline this offer" }).click();
  expect((await declined).status()).toBe(200);

  // ── the night is open again and the SAME act can re-apply ──
  await pp.goto("/slots");
  const card = pp.locator(".card", { hasText: marker });
  await expect(card).toBeVisible();
  await card.getByRole("link").first().click();
  // The withdrawn application must not dead-end the pairing: the apply form
  // is offered again and re-applying revives it.
  await pp.getByRole("button", { name: /Apply/ }).click();
  await expect(pp.getByText("Application sent")).toBeVisible();

  // ── second offer sticks ──
  await sendOffer(vp, marker);
  await acceptOffer(pp, `$${budget}`);
  await expectBookingBadge(pp, `$${budget}`, "Confirmed");

  await venue.close();
  await performer.close();
});
