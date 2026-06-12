import { AiNotConfiguredError, gearExtract } from "@gigit/db";
import { z } from "zod";
import { AuthError, requireUser } from "@/lib/auth";
import { fail, ok, parseBody } from "@/lib/respond";

const bodySchema = z.object({ description: z.string().min(5).max(2000) });

/** Gear extraction (F6.6): messy description → structured PA inventory draft. */
export async function POST(req: Request) {
  try {
    const userId = await requireUser();
    const parsed = await parseBody(req, bodySchema);
    if ("response" in parsed) return parsed.response;
    const draft = await gearExtract(parsed.data.description, userId);
    return ok({ draft });
  } catch (e) {
    if (e instanceof AuthError) return fail("auth", e.message, e.status);
    if (e instanceof AiNotConfiguredError)
      return fail("ai_not_configured", e.message, 503);
    return fail("extract_failed", String(e), 502);
  }
}
