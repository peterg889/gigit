import { AiNotConfiguredError, profileIngest } from "@gigit/db";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { aiUnavailable, fail, ok, parseBody } from "@/lib/respond";

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
    // Unconfigured and broken look the same to the user, and the answer is the
    // same either way: use the form. Never surface the exception — it names an
    // environment variable.
    if (e instanceof AiNotConfiguredError) return aiUnavailable("profile");
    console.log(JSON.stringify({ kind: "ai.ingest_failed", err: String(e) }));
    return aiUnavailable("profile");
  }
}
