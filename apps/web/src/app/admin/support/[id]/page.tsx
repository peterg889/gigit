import { db, schema } from "@gigit/db";
import { asc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SupportCaseActions } from "@/components/SupportCaseActions";
import { isAdmin } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

function friendly(value: string) {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export default async function SupportRequestPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const adminId = await sessionUserId();
  if (!adminId || !(await isAdmin(adminId)))
    return (
      <div className="card">
        Admin only. <Link href="/login">Sign in</Link>
      </div>
    );

  const { id } = await params;
  const d = db();
  const [row] = await d
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
    .where(eq(schema.supportRequests.id, id));
  if (!row) notFound();

  const notes = await d
    .select({
      note: schema.supportRequestNotes,
      authorEmail: schema.users.email,
      authorPhone: schema.users.phone,
    })
    .from(schema.supportRequestNotes)
    .innerJoin(
      schema.users,
      eq(schema.supportRequestNotes.authorUserId, schema.users.id),
    )
    .where(eq(schema.supportRequestNotes.supportRequestId, id))
    .orderBy(asc(schema.supportRequestNotes.createdAt));

  const staffIds = [
    row.request.claimedByUserId,
    row.request.resolvedByUserId,
  ].filter((value): value is string => Boolean(value));
  const staff = staffIds.length
    ? await d
        .select({
          id: schema.users.id,
          email: schema.users.email,
          phone: schema.users.phone,
        })
        .from(schema.users)
        .where(inArray(schema.users.id, staffIds))
    : [];
  const staffLabel = (userId: string | null) => {
    if (!userId) return "—";
    const user = staff.find((candidate) => candidate.id === userId);
    return user?.email ?? user?.phone ?? userId;
  };
  const email = row.request.contactEmail ?? row.userEmail;
  const phone = row.request.contactPhone ?? row.userPhone;

  return (
    <div>
      <p>
        <Link href="/admin/support">← Support queue</Link>
      </p>
      <h1>Support request</h1>
      <p>
        <span className="badge">{friendly(row.request.status)}</span>{" "}
        <span className="badge">{friendly(row.request.category)}</span>{" "}
        <span className="badge">{row.request.channel.toUpperCase()}</span>
      </p>
      <div className="card">
        <h2>{row.request.id}</h2>
        <p style={{ whiteSpace: "pre-wrap" }}>{row.request.message}</p>
        <p className="muted">
          Submitted {row.request.createdAt.toLocaleString()} ·{" "}
          {friendly(row.request.escalationReason)}
        </p>
      </div>
      <div className="card">
        <h2>Requester</h2>
        {email && (
          <p>
            Email: <strong><a href={`mailto:${email}`}>{email}</a></strong>
          </p>
        )}
        {phone && (
          <p>
            Phone: <strong><a href={`tel:${phone}`}>{phone}</a></strong>
          </p>
        )}
        {!email && !phone && <p className="error">No reply contact is available.</p>}
        {row.request.requesterUserId ? (
          <p>
            <Link
              href={`/admin/search?q=${encodeURIComponent(row.request.requesterUserId)}`}
            >
              View account {row.request.requesterUserId}
            </Link>
          </p>
        ) : (
          <p className="muted">Submitted without an active account session.</p>
        )}
      </div>
      <div className="card">
        <h2>Ownership</h2>
        <p>Claimed by: {staffLabel(row.request.claimedByUserId)}</p>
        {row.request.claimedAt && (
          <p className="muted">Claimed {row.request.claimedAt.toLocaleString()}</p>
        )}
        {row.request.resolvedAt && (
          <>
            <p>Resolved by: {staffLabel(row.request.resolvedByUserId)}</p>
            <p className="muted">Resolved {row.request.resolvedAt.toLocaleString()}</p>
          </>
        )}
      </div>
      <div className="card">
        <h2>Internal history</h2>
        {notes.length === 0 && <p className="muted">No internal notes yet.</p>}
        {notes.map(({ note, authorEmail, authorPhone }) => (
          <div key={note.id}>
            <p>
              <span className="badge">{friendly(note.kind)}</span>{" "}
              <strong>{authorEmail ?? authorPhone ?? note.authorUserId}</strong>{" "}
              <span className="muted">{note.createdAt.toLocaleString()}</span>
            </p>
            {note.body && <p style={{ whiteSpace: "pre-wrap" }}>{note.body}</p>}
          </div>
        ))}
      </div>
      <SupportCaseActions
        requestId={row.request.id}
        status={row.request.status}
        claimedByUserId={row.request.claimedByUserId}
        currentAdminId={adminId}
      />
    </div>
  );
}
