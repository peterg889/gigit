import { performerReliability } from "@gigit/domain";
import { db, performerReliabilityStats, schema } from "@gigit/db";
import { and, asc, eq, sql } from "drizzle-orm";
import Link from "next/link";
import { venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ApiForm } from "@/components/ApiForm";

export const dynamic = "force-dynamic";

const ACT_KIND_LABEL: Record<string, string> = {
  band: "Band",
  solo: "Solo act",
  comedian: "Comedian",
  other: "Other act",
};

/** Venue-facing performer search + invite (PRD F2.4). */
export default async function PerformerSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; genre?: string; metro?: string }>;
}) {
  const userId = await sessionUserId();
  const venue = userId ? await venueOwnedBy(userId) : null;
  if (!venue)
    return (
      <div className="card">
        <h1>Find local acts</h1>
        <p>
          Create a venue profile to browse and contact local bands, solo acts,
          and comedians near you.
        </p>
        <Link className="btn" href="/onboarding?role=venue">
          Set up your venue
        </Link>{" "}
        <Link href="/login">Sign in</Link>
      </div>
    );

  const { kind, genre, metro } = await searchParams;
  const conditions = [eq(schema.performers.status, "live")];
  if (kind) conditions.push(eq(schema.performers.kind, kind));
  if (metro)
    conditions.push(eq(schema.performers.homeMetro, metro.trim().toLocaleLowerCase("en-US")));
  if (genre)
    conditions.push(
      sql`${schema.performers.genreTags} @> ${JSON.stringify([genre])}::jsonb`,
    );
  const acts = await db()
    .select()
    .from(schema.performers)
    .where(and(...conditions))
    .orderBy(asc(schema.performers.reliabilityStrikes), asc(schema.performers.createdAt))
    .limit(100);
  const relStats = await performerReliabilityStats(acts.map((p) => p.id));

  return (
    <div>
      <h1>Find an act</h1>
      <p className="muted">
        Compare local acts by type, genre, typical rate, and verified show-up
        history. Message anyone who looks right for your room.
      </p>
      <div className="card">
        <form method="get">
          <label htmlFor="kind">Type</label>
          <select id="kind" name="kind" defaultValue={kind ?? ""}>
            <option value="">Any</option>
            {["band", "solo", "comedian", "other"].map((k) => (
              <option key={k} value={k}>
                {ACT_KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <label htmlFor="genre">Genre</label>
          <input id="genre" name="genre" defaultValue={genre ?? ""} placeholder="e.g. folk" />
          <label htmlFor="metro">City or metro area</label>
          <input id="metro" name="metro" defaultValue={metro ?? ""} placeholder="e.g. Milwaukee" />
          <button>Search</button>
        </form>
      </div>
      {acts.length === 0 && (
        <div className="card">No acts match those filters. Try removing one.</div>
      )}
      {acts.map((p) => {
        const rel = performerReliability(
          relStats.get(p.id) ?? { gigsCompleted: 0, cancellations: 0 },
        );
        return (
        <div className="card" key={p.id}>
          <strong>
            <Link href={`/p/${p.id}`}>{p.name}</Link>
          </strong>{" "}
          <span className="badge">{ACT_KIND_LABEL[p.kind] ?? "Act"}</span>{" "}
          <span className="badge" title="show-up history">{rel.label}</span>
          {p.genreTags.length > 0 && (
            <span className="muted"> · {p.genreTags.join(", ")}</span>
          )}
          <p className="muted">{p.bio}</p>
          {p.rateMinCents != null && p.rateMaxCents != null && (
            <p className="muted">
              Typical rate:{" "}
              <span className="money">
                ${(p.rateMinCents / 100).toFixed(0)}–${(p.rateMaxCents / 100).toFixed(0)}
              </span>
            </p>
          )}
          <ApiForm
            endpoint="/api/threads"
            submitLabel="Message this act"
            redirectTo="/inbox"
            fields={[
              {
                name: "body",
                label: `Message ${p.name}`,
                type: "textarea",
                required: true,
                placeholder: "Friday the 26th, 8–10pm, $400 — interested?",
              },
            ]}
            extra={{ performerId: p.id }}
          />
        </div>
        );
      })}
    </div>
  );
}
