import { db, schema } from "@gigit/db";
import { desc, eq } from "drizzle-orm";
import { adminUserId } from "@/lib/auth";
import { AdminOnly } from "../AdminOnly";
import { ActionButton } from "@/components/ApiForm";

export const dynamic = "force-dynamic";

/** Moderation queue (F9.3): open fraud flags, decided by a person. */
export default async function ModerationPage() {
  const userId = await adminUserId();
  if (!userId) return <AdminOnly />;

  const flags = await db()
    .select()
    .from(schema.fraudFlags)
    .where(eq(schema.fraudFlags.state, "open"))
    .orderBy(desc(schema.fraudFlags.confidence))
    .limit(100);

  return (
    <div>
      <h1>Moderation queue</h1>
      <p className="muted">
        Screening flags it; a person decides it. Clearing a held asset
        publishes it; upholding rejects it. Both are recorded under your name.
      </p>
      {flags.length === 0 && <div className="card">Queue&apos;s clear.</div>}
      {flags.map((f) => (
        <div className="card" key={f.id}>
          <span className="badge">{f.kind}</span>{" "}
          <span className="badge">confidence {f.confidence}</span>{" "}
          <span className="muted">
            {f.subjectType} {f.subjectId}
          </span>
          <pre style={{ fontSize: "0.78rem" }}>{JSON.stringify(f.evidence, null, 1)}</pre>
          <ActionButton
            endpoint={`/api/admin/flags/${f.id}/resolve`}
            label="Clear — it's fine"
            body={{ action: "clear" }}
          />{" "}
          <ActionButton
            endpoint={`/api/admin/flags/${f.id}/resolve`}
            label="Uphold — reject it"
            body={{ action: "uphold" }}
          />
        </div>
      ))}
    </div>
  );
}
