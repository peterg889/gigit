import { db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

const GEAR_LABEL: Record<string, string> = {
  none: "labor only — no rig",
  partial: "partial rig",
  full_rig: "full PA rig",
};

/** Public sound-tech page (PRD F1.4): gear, rates, travel. */
export default async function TechPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [t] = await db().select().from(schema.techs).where(eq(schema.techs.id, id));
  if (!t) notFound();

  return (
    <div>
      <div className="card">
        <h1>
          {t.name} <span className="badge">{GEAR_LABEL[t.gear] ?? t.gear}</span>
        </h1>
        <p className="muted">Travels {t.travelRadiusKm} km</p>
        <p>{t.bio || <span className="muted">No bio yet.</span>}</p>
        <p className="muted">
          {t.rateLaborCents != null && (
            <>
              labor <span className="money">${(t.rateLaborCents / 100).toFixed(0)}</span>
            </>
          )}
          {t.rateWithRigCents != null && (
            <>
              {" "}
              · with rig{" "}
              <span className="money">${(t.rateWithRigCents / 100).toFixed(0)}</span>
            </>
          )}
          {t.rateLaborCents == null && t.rateWithRigCents == null && "Rates on request."}
        </p>
      </div>
    </div>
  );
}
