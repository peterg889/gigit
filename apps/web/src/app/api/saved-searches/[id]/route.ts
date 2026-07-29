import { db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { performerOwnedBy, requireUser, respondError } from "@/lib/auth";
import { fail, ok } from "@/lib/respond";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const userId = await requireUser();
    const performer = await performerOwnedBy(userId);
    if (!performer) return fail("forbidden", "You need an act profile to do that.", 403);

    const [row] = await db()
      .select()
      .from(schema.savedSearches)
      .where(eq(schema.savedSearches.id, id));
    if (!row) return fail("not_found", "We couldn't find that saved search.", 404);
    if (row.performerId !== performer.id)
      return fail("forbidden", "That saved search isn't yours.", 403);

    await db().delete(schema.savedSearches).where(eq(schema.savedSearches.id, id));
    return ok({ deleted: true });
  } catch (e) {
    return respondError(e);
  }
}
