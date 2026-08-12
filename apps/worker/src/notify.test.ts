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

  it("welcomes a new act identically whether or not the payment rail is on", () => {
    // The welcome makes no claim about money, so it deliberately has no
    // DISCOVERY_OVERRIDES twin. Assert the two modes are byte-identical rather
    // than trusting that nobody later adds an escrow/payout clause to the base
    // copy, which would then ship as-is with PAYMENTS_ENABLED false in prod.
    const vars = { url: "https://x.test" };
    const on = renderTemplate("act_welcome", vars, true);
    const off = renderTemplate("act_welcome", vars, false);
    expect(off).toEqual(on);
    expect(on.subject).toBe("Your act page is live");
    expect(on.body).toContain("https://x.test/me");
    // Media is link-only: the welcome used to say "add photos, audio, or
    // video", which sent a new act to /me looking for a file picker that isn't
    // there. It has to ask for the thing the product takes — a link — and name
    // where those links come from.
    expect(on.body).toMatch(/paste the links/i);
    expect(on.body).not.toMatch(/upload/i);
    expect(on.body).toContain("SoundCloud");
    // Cross-mode identity alone cannot catch the failure described above: a
    // money clause added to the BASE copy is identical in both modes by
    // construction, so `off === on` stays green while the claim ships. With
    // PAYMENTS_ENABLED false in production this is the copy that actually goes
    // out, so the body itself has to be checked for money vocabulary.
    for (const rendered of [on, off])
      expect(rendered.body.toLowerCase()).not.toMatch(
        /escrow|payout|paid out|we hold|deposit|refund|charge/,
      );
    for (const rendered of [on, off]) {
      expect(rendered.subject).not.toMatch(/\{\w+\}/);
      expect(rendered.body).not.toMatch(/\{\w+\}/);
    }
  });

  it("reports a dead link without promising it is a video", () => {
    // Media is link-only, so the rot recheck now covers photos and audio too.
    // The old copy said "A video link went dead" / "no longer plays", which
    // sends the owner of a dead Flickr photo looking at the wrong thing.
    const rendered = renderTemplate("embed_dead", {}, false);
    expect(rendered.subject.toLowerCase()).not.toContain("video link");
    expect(rendered.body).toContain("photos, tracks or videos");
  });

  it("has no copy left for a file that failed a content check", () => {
    // media_rejected's only trigger was the magic-byte sniff on an uploaded
    // file. Nothing is uploaded any more, so the template could only ever be
    // dead copy pointing users at a step that no longer exists.
    expect(TEMPLATE_NAMES).not.toContain("media_rejected");
  });

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
      // The welcome's whole job is getting media onto the page; /me is the
      // only act-facing place to paste a link, and /p/{id} (the public page)
      // has no editor on it.
      act_welcome: "/me",
    };
    for (const [name, path] of Object.entries(deepLinked))
      expect(renderTemplate(name, SUPPLIED).body).toContain(
        `https://x.test${path}`,
      );
  });
});
