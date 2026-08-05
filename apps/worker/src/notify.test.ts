import { describe, expect, it } from "vitest";
import { TEMPLATE_NAMES, renderTemplate } from "./notify.js";

describe("notification copy", () => {
  it("explains account deactivation truthfully when platform payments are on", () => {
    const rendered = renderTemplate("booking_account_deactivated", {}, true);
    expect(rendered.subject).toBe("This booking was cancelled");
    expect(rendered.body).toContain("no longer active");
    expect(rendered.body).toContain("will be refunded");
    expect(rendered.body.toLowerCase()).not.toContain("charge failed");
  });

  it.each(["booking_account_deactivated", "payment_late_refunded"])(
    "uses direct-pay copy for %s at discovery-first launch",
    (template) => {
      const rendered = renderTemplate(template, {}, false);
      expect(rendered.body).toContain("arranged payment directly");
      expect(rendered.body.toLowerCase()).not.toContain("refund");
      expect(rendered.body.toLowerCase()).not.toContain("processing");
    },
  );

  it("uses role-neutral conversation copy with a direct inbox link", () => {
    const vars = { threadId: "thr_copy_test" };
    const inquiry = renderTemplate("new_inquiry", vars);
    const message = renderTemplate("new_message", vars);
    expect(inquiry.subject).toBe("New inquiry");
    expect(inquiry.body).toContain("/inbox/thr_copy_test");
    expect(inquiry.body.toLowerCase()).not.toContain("venue");
    expect(message.body).toContain("/inbox/thr_copy_test");
    expect(`${inquiry.body}${message.body}`).not.toContain("{threadId}");
  });
});

/**
 * A placeholder that no caller supplies renders as the literal string —
 * "{bookingId}" in the body of a real email. That is worse than a wrong link and
 * invisible to every test that renders one template with the vars it happens to
 * know about. So enumerate them.
 *
 * SUPPLIED is the union of what the notifiers actually pass:
 *   notifySlotVenue -> slotId            notifyApplicationPerformer -> slotId
 *   notifyBookingParties -> bookingId, performerName, venueName, autoConfirmHours
 *   notifySubslotParties -> subslotId    notifyOtp -> code
 *   review prompt -> bookingId, days     new_act -> performerId
 *   thread notifies -> threadId          support -> requestId
 */
const SUPPLIED = {
  url: "https://x.test",
  slotId: "slt_1",
  bookingId: "bkg_1",
  subslotId: "sub_1",
  threadId: "thr_1",
  performerId: "prf_1",
  requestId: "spr_1",
  performerName: "The Bishops",
  venueName: "Lakefront Taproom",
  autoConfirmHours: "24",
  days: "7",
  code: "424242",
};

describe("every template resolves", () => {
  for (const name of TEMPLATE_NAMES)
    it(`${name} leaves no placeholder unresolved`, () => {
      for (const paymentsOn of [true, false]) {
        const { subject, body } = renderTemplate(name, SUPPLIED, paymentsOn);
        // A stray {foo} means a typo or a var no caller passes.
        expect(subject).not.toMatch(/\{\w+\}/);
        expect(body).not.toMatch(/\{\w+\}/);
      }
    });

  it("never points a subject-specific email at the marketing homepage", () => {
    // new_application is the email that closes the venue funnel and it linked to
    // a bare {url}; subslot_new_application linked to the bookings LIST.
    const deepLinked = {
      new_application: "/slots/slt_1",
      subslot_new_application: "/sound/sub_1",
      new_inquiry: "/inbox/thr_1",
      slot_match: "/slots/slt_1",
      new_act: "/p/prf_1",
    };
    for (const [name, path] of Object.entries(deepLinked))
      expect(renderTemplate(name, SUPPLIED).body).toContain(
        `https://x.test${path}`,
      );
  });
});
