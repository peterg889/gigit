import { AiNotConfiguredError, profileIngest } from "@gigit/db";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

const bodySchema = z.object({ url: z.string().url() });

/**
 * Link-in onboarding (F1.8): URL → drafted profile. Returns a DRAFT for the
 * user to review and submit — nothing is created here (K9 invariant).
 */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const result = await profileIngest(parsed.data.url, userId);
    return ok(result);
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    if (e instanceof AiNotConfiguredError)
      return fail("ai_not_configured", e.message, 503);
    return fail("ingest_failed", String(e), 502);
  }
}
