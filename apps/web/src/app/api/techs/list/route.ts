import { db, schema } from "@gigit/db";
import { asc } from "drizzle-orm";
import { ok } from "@/lib/respond";

/** Public sound-tech directory (the third side; PRD F6). */
export async function GET() {
  const rows = await db()
    .select({
      id: schema.techs.id,
      name: schema.techs.name,
      bio: schema.techs.bio,
      gear: schema.techs.gear,
      rateLaborCents: schema.techs.rateLaborCents,
      rateWithRigCents: schema.techs.rateWithRigCents,
      reliabilityStrikes: schema.techs.reliabilityStrikes,
      travelRadiusKm: schema.techs.travelRadiusKm,
    })
    .from(schema.techs)
    .orderBy(asc(schema.techs.createdAt))
    .limit(100);
  return ok({ techs: rows });
}
