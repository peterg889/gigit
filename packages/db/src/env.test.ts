import { describe, expect, it } from "vitest";
import { envSchema } from "./env.js";

const baseEnv = {
  DATABASE_URL: "postgres://gigit:gigit@localhost:5433/gigit",
  SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
};

describe("SUPPORT_EMAIL_TO environment validation", () => {
  it.each([undefined, "", "   "])(
    "accepts the unset/empty Secrets Manager value (%j)",
    (supportEmail) => {
      const input: Record<string, string> = { ...baseEnv };
      if (supportEmail !== undefined) input.SUPPORT_EMAIL_TO = supportEmail;

      const parsed = envSchema.parse(input);

      expect(parsed.SUPPORT_EMAIL_TO).toBeUndefined();
    },
  );

  it("accepts a valid operator mailbox", () => {
    const parsed = envSchema.parse({
      ...baseEnv,
      SUPPORT_EMAIL_TO: "support-ops@example.com",
    });

    expect(parsed.SUPPORT_EMAIL_TO).toBe("support-ops@example.com");
  });

  it("rejects a malformed non-empty operator mailbox", () => {
    const parsed = envSchema.safeParse({
      ...baseEnv,
      SUPPORT_EMAIL_TO: "not-an-email-address",
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: ["SUPPORT_EMAIL_TO"] }),
        ]),
      );
    }
  });
});
