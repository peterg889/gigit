import { db, schema } from "@gigit/db";
import { and, eq, sql } from "drizzle-orm";

/** Whether this booking ever crossed the confirmation boundary. */
export async function bookingWasConfirmed(bookingId: string): Promise<boolean> {
  const rows = await db()
    .select({ id: schema.events.id })
    .from(schema.events)
    .where(
      and(
        eq(schema.events.kind, "booking.transition"),
        eq(schema.events.subjectType, "booking"),
        eq(schema.events.subjectId, bookingId),
        sql`${schema.events.payload}->>${"to"} = ${"confirmed"}`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}
