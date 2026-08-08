import { randomUUID } from "node:crypto";
import { db, getPool, paymentsEnabled, schema } from "@gigit/db";
import { MONEY_SETTLED_STATES } from "@gigit/domain";
import { and, eq } from "drizzle-orm";
import Link from "next/link";
import { adminUserId } from "@/lib/auth";
import { AdminOnly } from "../AdminOnly";
import { ActionButton, ApiForm } from "@/components/ApiForm";

export const dynamic = "force-dynamic";

/** Ops search (F9.1): users, profiles, bookings — with the manual levers. */
export default async function AdminSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const userId = await adminUserId();
  if (!userId) return <AdminOnly />;
  const { q } = await searchParams;
  void db(); // primes the pool that getPool() below returns — not dead
  const pool = getPool();

  const like = `%${q ?? ""}%`;
  const users = q
    ? (
        await pool.query(
          `select id, email, phone, status from users
            where email ilike $1 or phone ilike $1 or id = $2 limit 20`,
          [like, q],
        )
      ).rows
    : [];
  const profiles = q
    ? (
        await pool.query(
          `select 'performer' as kind, id, name, owner_user_id from performers where name ilike $1
           union all
           select 'venue', id, name, owner_user_id from venues where name ilike $1
           union all
           select 'tech', id, name, owner_user_id from techs where name ilike $1
           limit 20`,
          [like],
        )
      ).rows
    : [];
  const booking = q?.startsWith("bkg_")
    ? (await db().select().from(schema.bookings).where(eq(schema.bookings.id, q)))[0]
    : null;
  const platformPaymentsOn = paymentsEnabled();
  const charge =
    booking?.paymentRef && platformPaymentsOn
      ? (
          await db()
            .select({ id: schema.ledgerEntries.id })
            .from(schema.ledgerEntries)
            .where(
              and(
                eq(schema.ledgerEntries.bookingId, booking.id),
                eq(schema.ledgerEntries.entryType, "charge"),
                eq(schema.ledgerEntries.paymentRef, booking.paymentRef),
                eq(schema.ledgerEntries.idempotencyKey, `${booking.id}:charge`),
              ),
            )
            .limit(1)
        )[0]
      : null;
  const canAdjust = !!booking?.paymentRef && !!charge && platformPaymentsOn;
  const canRefundVenue =
    !!booking && MONEY_SETTLED_STATES.some((state) => state === booking.state);

  return (
    <div>
      <h1>Ops search</h1>
      <p className="muted">
        Find anyone, see everything, and leave a paper trail — every action
        here lands in the events table under your name.
      </p>
      <div className="card">
        <form method="get">
          <label htmlFor="q">Email, phone, name, or booking id</label>
          <input id="q" name="q" defaultValue={q ?? ""} />
          <button>Search</button>
        </form>
      </div>

      {users.map((u) => (
        <div className="card" key={u.id}>
          <strong>{u.email ?? u.phone}</strong> <span className="badge">{u.status}</span>{" "}
          <span className="muted">{u.id}</span>{" "}
          {u.status === "deleted" ? (
            <span className="muted">Deactivated permanently</span>
          ) : (
            <ActionButton
              endpoint={`/api/admin/users/${u.id}/status`}
              label={u.status === "suspended" ? "Reinstate" : "Suspend"}
              body={{ status: u.status === "suspended" ? "active" : "suspended" }}
            />
          )}
        </div>
      ))}
      {profiles.map((p) => (
        <div className="card" key={p.id}>
          <span className="badge">{p.kind}</span> <strong>{p.name}</strong>{" "}
          <span className="muted">
            {p.id} · owner {p.owner_user_id}
          </span>
        </div>
      ))}
      {booking && (
        <div className="card">
          <span className="badge">booking</span>{" "}
          <Link href={`/bookings/${booking.id}`}>{booking.id}</Link>{" "}
          <span className="badge">{booking.state}</span>{" "}
          <span className="money">
            ${(booking.terms.amountCents / 100).toFixed(0)}
          </span>
          {canAdjust ? (
            <>
              <p className="muted">
                {canRefundVenue
                  ? "This moves money: refund returns part of the original charge to the venue; pay act sends a separate platform-funded transfer to the performer."
                  : "Pay act sends a separate platform-funded transfer to the performer. Venue refunds become available after cancellation or settlement finishes."}{" "}
                The reason stays in the audit trail.
              </p>
              <ApiForm
                endpoint={`/api/admin/bookings/${booking.id}/adjust`}
                submitLabel="Execute adjustment"
                confirm="Execute this money adjustment? Verify the direction, amount, and reason before continuing."
                resetOnSuccess
                successMessage="Adjustment submitted. Enter new details to make another adjustment."
                extra={{ idempotencyKey: randomUUID() }}
                fields={[
                  {
                    name: "direction",
                    label: "Direction",
                    type: "select",
                    options: canRefundVenue
                      ? ["refund_venue", "pay_performer"]
                      : ["pay_performer"],
                    required: true,
                  },
                  { name: "amountCents", label: "Amount, in dollars", type: "number", required: true },
                  { name: "reason", label: "Reason (saved to the audit trail)", type: "textarea", required: true },
                ]}
              />
            </>
          ) : (
            <p className="muted">
              {platformPaymentsOn
                ? "No completed platform charge is available to adjust."
                : "Money adjustments are unavailable while platform payments are turned off."}
            </p>
          )}
        </div>
      )}
      {q && users.length === 0 && profiles.length === 0 && !booking && (
        <div className="card">Nothing matches.</div>
      )}
    </div>
  );
}
