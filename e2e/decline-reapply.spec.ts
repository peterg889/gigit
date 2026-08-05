import { expect, test } from "@playwright/test";
import {
  acceptOffer,
  assertPrimitives,
  expectBookingBadge,
  invitePerformer,
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
}, testInfo) => {
  const marker = `e2e decline ${Date.now()}`;
  const budget = "275";
  const venue = await browser.newContext();
  const performer = await browser.newContext();
  const vp = await venue.newPage();
  const pp = await performer.newPage();

  await signIn(vp, "venue-decline@example.com");
  // Retry attempts use a different night so a committed first attempt cannot
  // trip the calendar double-book guard on its retry.
  const slotUrl = await postSlot(vp, marker, budget, 21 + testInfo.retry * 2);
  // Fail loudly if the CSS primitives were renamed out from under the suite.
  await assertPrimitives(vp);

  // Venue-initiated outreach uses a real date and creates the firm offer
  // directly; the act does not have to reverse-engineer terms from a cold DM.
  const firstBookingUrl = await invitePerformer(
    vp,
    "Copper Lines",
    slotUrl,
  );
  await signIn(pp, "band-decline@example.com");

  // ── the act declines the firm offer ──
  await pp.goto(firstBookingUrl);
  const declined = pp.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/cancel"),
  );
  pp.once("dialog", (d) => d.accept());
  await pp.getByRole("button", { name: "Decline this offer" }).click();
  expect((await declined).status()).toBe(200);

  // ── the night is open again and the SAME act can re-apply ──
  await pp.goto(slotUrl);
  // The withdrawn application must not dead-end the pairing: the apply form
  // is offered again and re-applying revives it.
  await pp.getByRole("button", { name: /Apply/ }).click();
  await expect(pp.getByText("Application sent")).toBeVisible();

  // ── second offer sticks ──
  const secondBookingUrl = await sendOffer(vp, slotUrl);
  await acceptOffer(pp, secondBookingUrl);
  await expectBookingBadge(pp, secondBookingUrl, "Confirmed");

  await venue.close();
  await performer.close();
});
