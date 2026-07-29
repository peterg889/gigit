import { describe, expect, it, vi } from "vitest";

const nodeEnv = vi.hoisted(() => ({ value: "test" as string }));

vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  return {
    ...actual,
    env: () => ({ ...actual.env(), NODE_ENV: nodeEnv.value }),
  };
});

const { otpCode } = await import("./otp");

/**
 * The CSPRNG branch used to be reachable only when NODE_ENV === "production",
 * which no test sets — so the one line standing between sign-in codes and a
 * seeded PRNG was asserted by nothing. It also failed open: NODE_ENV defaults to
 * "development" when unset, so a deploy that forgot to set it would issue the
 * fixed code to everyone.
 */
describe("sign-in code generation", () => {
  it("uses the fixed code only in development and test", () => {
    for (const e of ["development", "test"]) {
      nodeEnv.value = e;
      expect(otpCode()).toBe("000000");
    }
  });

  it("issues a random 6-digit code everywhere else", () => {
    nodeEnv.value = "production";
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const code = otpCode();
      expect(code).toMatch(/^[0-9]{6}$/);
      expect(code).not.toBe("000000");
      codes.add(code);
    }
    // a CSPRNG over 900k values will not repeat itself 200 times in a row
    expect(codes.size).toBeGreaterThan(190);
  });

  it("fails safe on an unrecognized environment", () => {
    // The old ternary treated anything-but-production as dev. If NODE_ENV is
    // ever unset or renamed, a random code is the safe wrong answer.
    nodeEnv.value = "staging";
    expect(otpCode()).not.toBe("000000");
    nodeEnv.value = "";
    expect(otpCode()).not.toBe("000000");
  });
});
