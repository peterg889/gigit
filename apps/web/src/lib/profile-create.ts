import { pgErrorCode } from "@gigit/db";
import { respondError } from "./auth";
import { fail } from "./respond";

/**
 * A profile-owner preflight makes the ordinary duplicate-create response fast,
 * while the partial unique index is the concurrency boundary. Drizzle wraps
 * PostgreSQL errors, so every profile route uses this one mapper rather than
 * accidentally returning 500 for a simultaneous double submit.
 */
export function respondProfileCreateError(error: unknown, message: string) {
  if (pgErrorCode(error) === "23505")
    return fail("conflict", message, 409);
  return respondError(error);
}
