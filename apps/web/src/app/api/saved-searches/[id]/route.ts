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
    if (!performer) return fail("forbidden", "performer profile required", 403);

    const [row] = await db()
      .select()
      .from(schema.savedSearches)
      .where(eq(schema.savedSearches.id, id));
    if (!row) return fail("not_found", "saved search not found", 404);
    if (row.performerId !== performer.id)
      return fail("forbidden", "not your saved search", 403);

    await db().delete(schema.savedSearches).where(eq(schema.savedSearches.id, id));
    return ok({ deleted: true });
  } catch (e) {
    return respondError(e);
  }
}
