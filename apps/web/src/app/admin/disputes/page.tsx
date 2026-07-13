import { db, schema } from "@gigit/db";
import { and, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { isAdmin } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ApiForm } from "@/components/ApiForm";

export const dynamic = "force-dynamic";

export default async function AdminDisputesPage() {
  const userId = await sessionUserId();
  if (!userId || !(await isAdmin(userId)))
    return <div className="card">Admin only. <Link href="/login">Sign in</Link></div>;

  const d = db();
  const rows = await d
    .select({
      booking: schema.bookings,
      performerName: schema.performers.name,
      venueName: schema.venues.name,
    })
    .from(schema.bookings)
    .innerJoin(schema.performers, eq(schema.bookings.performerId, schema.performers.id))
    .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
    .where(eq(schema.bookings.state, "disputed"))
    .orderBy(desc(schema.bookings.createdAt));

  const withReports = await Promise.all(rows.map(async (row) => {
    const events = await d
      .select({ payload: schema.events.payload, occurredAt: schema.events.occurredAt })
      .from(schema.events)
      .where(and(
        eq(schema.events.kind, "booking.transition"),
        eq(schema.events.subjectId, row.booking.id),
      ))
      .orderBy(desc(schema.events.id));
    const report = events.find((event) => event.payload.event === "DISPUTE_OPENED");
    return { ...row, report };
  }));

  return (
    <div>
      <h1>Reliability reports</h1>
      <p className="muted">
        A human decides what happened and which side, if either, receives a
        reliability strike. Gig money stays outside Gigit.
      </p>
      {withReports.length === 0 && <div className="card">No open reports.</div>}
      {withReports.map(({ booking, performerName, venueName, report }) => (
        <div className="card" key={booking.id}>
          <h2>{performerName} at {venueName}</h2>
          <p>
            <span className="badge">{String(report?.payload.openedBy ?? "unknown")} reported</span>{" "}
            <Link href={"/admin/dispute-brief?bookingId=" + booking.id}>Draft evidence brief</Link>
          </p>
          <p>{String(report?.payload.reason ?? "No reason recorded.")}</p>
          <p className="muted">
            Choose responsibility deliberately. “Neither” closes the report
            without changing either side’s standing.
          </p>
          <div className="card">
            <h3>Gig happened</h3>
            <ApiForm
              endpoint={"/api/admin/disputes/" + booking.id + "/resolve"}
              submitLabel="Close as played"
              extra={{ kind: "release_full" }}
              fields={[
                {
                  name: "fault",
                  label: "Responsible side",
                  type: "select",
                  options: ["neither", "venue", "performer"],
                  required: true,
                },
              ]}
            />
          </div>
          <div className="card">
            <h3>Gig did not happen</h3>
            <ApiForm
              endpoint={"/api/admin/disputes/" + booking.id + "/resolve"}
              submitLabel="Close as not played"
              extra={{ kind: "refund_full" }}
              fields={[
                {
                  name: "fault",
                  label: "Responsible side",
                  type: "select",
                  options: ["performer", "venue", "neither"],
                  required: true,
                },
              ]}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
