import { describe, expect, it } from "vitest";
import { renderTemplate } from "./notify.js";

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
