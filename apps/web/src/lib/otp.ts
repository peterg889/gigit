import { env } from "@gigit/db";
import { randomInt } from "node:crypto";

/**
 * Sign-in codes are a credential, so they come from a CSPRNG. Math.random() is a
 * seeded PRNG whose future output can be derived from observed values — and
 * codes are observable to anyone who can request one for their own address.
 *
 * The random path is the DEFAULT and the fixed dev code is the opt-in. Written
 * the other way round (`NODE_ENV === "production" ? random : "000000"`) it
 * failed open: NODE_ENV defaults to "development" when unset, so a deploy that
 * forgot to set it would have issued 000000 to every user, silently. It also
 * meant the CSPRNG branch ran in no test at all.
 */
export function otpCode(): string {
  const e = env().NODE_ENV;
  if (e === "development" || e === "test") return "000000"; // fixed + logged
  return String(randomInt(100000, 1000000));
}
