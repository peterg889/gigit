import { db, schema } from "@gigit/db";
import { asc, desc, eq } from "drizzle-orm";
import Link from "next/link";
import { isAdmin } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

function friendly(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default async function SupportQueuePage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const userId = await sessionUserId();
  if (!userId || !(await isAdmin(userId)))
    return (
      <div className="card">
        Admin only. <Link href="/login">Sign in</Link>
      </div>
    );

  const { state: requestedState } = await searchParams;
  const state = requestedState === "resolved" ? "resolved" : "open";
  const rows = await db()
    .select({
      request: schema.supportRequests,
      userEmail: schema.users.email,
      userPhone: schema.users.phone,
    })
    .from(schema.supportRequests)
    .leftJoin(
      schema.users,
      eq(schema.supportRequests.requesterUserId, schema.users.id),
    )
    .where(eq(schema.supportRequests.status, state))
    .orderBy(
      state === "resolved"
        ? desc(schema.supportRequests.resolvedAt)
        : asc(schema.supportRequests.createdAt),
    )
    .limit(100);

  return (
    <div>
      <h1>Support queue</h1>
      <p className="muted">
        Every request here needs a person. Claim one before replying, leave the
        useful context, and resolve it only after the requester hears back.
      </p>
      <p>
        <Link href="/admin/support">Open</Link> ·{" "}
        <Link href="/admin/support?state=resolved">Resolved</Link> ·{" "}
        <Link href="/admin">Back to ops</Link>
      </p>
      {rows.length === 0 && (
        <div className="card">
          {state === "open" ? "Queue’s clear." : "No resolved requests yet."}
        </div>
      )}
      {rows.map(({ request, userEmail, userPhone }) => {
        const email = request.contactEmail ?? userEmail;
        const phone = request.contactPhone ?? userPhone;
        const contacts = request.channel === "sms"
          ? [phone, email]
          : [email, phone];
        const contact = contacts.filter(Boolean).join(" · ") || "No reply contact";
        const queueState =
          request.status === "resolved"
            ? "Resolved"
            : request.claimedByUserId
              ? "Claimed"
              : "Unclaimed";
        return (
          <div className="card" key={request.id}>
            <span className="badge">{queueState}</span>{" "}
            <span className="badge">{friendly(request.category)}</span>{" "}
            <span className="badge">{request.channel.toUpperCase()}</span>
            <h2>
              <Link href={`/admin/support/${request.id}`}>{request.id}</Link>
            </h2>
            <p>
              {request.message.slice(0, 240)}
              {request.message.length > 240 ? "…" : ""}
            </p>
            <p className="muted">
              {contact} · {request.createdAt.toLocaleString()}
            </p>
            {request.requesterUserId && (
              <p className="muted">
                Account:{" "}
                <Link href={`/admin/search?q=${encodeURIComponent(request.requesterUserId)}`}>
                  {request.requesterUserId}
                </Link>
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
