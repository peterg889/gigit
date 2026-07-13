import { appendEvent, db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { requireUser, respondError } from "@/lib/auth";
import { ok } from "@/lib/respond";
import { destroySession } from "@/lib/session";

/**
 * Deactivate access and remove login identifiers immediately. Marketplace
 * records remain so completed bookings, reviews, disputes, and audit history
 * do not become misleading when one party leaves.
 */
export async function DELETE() {
  try {
    const userId = await requireUser();
    const d = db();
    await d.transaction(async (tx) => {
      await tx
        .update(schema.users)
        .set({
          status: "deleted",
          email: null,
          phone: null,
          smsOptedOutAt: new Date(),
        })
        .where(eq(schema.users.id, userId));
      await appendEvent(tx, {
        actor: userId,
        kind: "user.deactivated",
        subjectType: "user",
        subjectId: userId,
      });
    });
    await destroySession();
    return ok({ deactivated: true });
  } catch (e) {
    return respondError(e);
  }
}
