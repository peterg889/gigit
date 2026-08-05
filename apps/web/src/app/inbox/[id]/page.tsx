import { db, schema } from "@gigit/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import {
  formatRelativeTime,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";
import { notFound } from "next/navigation";
import { sessionUserId } from "@/lib/session";
import { ApiForm } from "@/components/ApiForm";
import { counterpartyLabel } from "@/lib/thread-display";
import { loadParticipantLabels } from "@/lib/thread-profile-labels";

export const dynamic = "force-dynamic";

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await sessionUserId();
  if (!userId)
    return (
      <div className="card">
        <Link href="/login">Sign in</Link> first.
      </div>
    );
  const d = db();
  const [participant] = await d
    .select()
    .from(schema.threadParticipants)
    .where(
      and(
        eq(schema.threadParticipants.threadId, id),
        eq(schema.threadParticipants.userId, userId),
      ),
    );
  if (!participant) notFound();

  const [[thread], threadParticipants] = await Promise.all([
    d.select().from(schema.threads).where(eq(schema.threads.id, id)),
    d
      .select({ userId: schema.threadParticipants.userId })
      .from(schema.threadParticipants)
      .where(eq(schema.threadParticipants.threadId, id)),
  ]);
  if (!thread) notFound();

  // Latest 200 (newest-first from the DB), reversed to ascending for display —
  // an asc+limit would show the oldest 200 and hide newer replies in long threads.
  const messages = (
    await d
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.threadId, id))
      .orderBy(desc(schema.messages.createdAt))
      .limit(200)
  ).reverse();

  // A user's display name lives on whichever profile they hold — resolve the
  // other parties' names so messages aren't attributed to a generic "Them".
  const others = [
    ...new Set(
      threadParticipants
        .map((row) => row.userId)
        .filter((participantUserId) => participantUserId !== userId),
    ),
  ];
  const participantAccounts = await d
    .select({ id: schema.users.id, status: schema.users.status })
    .from(schema.users)
    .where(
      inArray(
        schema.users.id,
        threadParticipants.map((row) => row.userId),
      ),
    );
  const accountStatus = new Map(
    participantAccounts.map((account) => [account.id, account.status]),
  );
  const counterpartUnavailable = others.some(
    (participantUserId) => accountStatus.get(participantUserId) !== "active",
  );
  const canReply =
    accountStatus.get(userId) === "active" && !counterpartUnavailable;
  const nameByUser = await loadParticipantLabels(others);
  const counterparty = counterpartyLabel(
    threadParticipants.map((row) => row.userId),
    userId,
    nameByUser,
  );
  const [booking] =
    thread.scope === "booking" && thread.subjectId
      ? await d
          .select({
            id: schema.bookings.id,
            terms: schema.bookings.terms,
            performerName: schema.performers.name,
            venueName: schema.venues.name,
            venueTimeZone: schema.venues.timeZone,
          })
          .from(schema.bookings)
          .innerJoin(
            schema.performers,
            eq(schema.bookings.performerId, schema.performers.id),
          )
          .innerJoin(schema.venues, eq(schema.bookings.venueId, schema.venues.id))
          .where(eq(schema.bookings.id, thread.subjectId))
      : [];

  return (
    <div>
      <h1>{counterparty ? `Conversation with ${counterparty}` : "Conversation"}</h1>
      {booking && (
        <div className="card thread-context-card">
          <strong>{booking.performerName} at {booking.venueName}</strong>
          <p className="gig-line">
            {formatVenueDateTime(
              booking.terms.startsAt,
              booking.terms.timeZone ?? booking.venueTimeZone,
            )}{" "}
            {shortTimeZoneName(
              booking.terms.startsAt,
              booking.terms.timeZone ?? booking.venueTimeZone,
            )}
          </p>
          <Link href={`/bookings/${booking.id}`}>View the booking</Link>
        </div>
      )}
      {messages.map((m) => (
        <div className="card" key={m.id}>
          <span className="muted">
            {m.senderUserId === userId
              ? "You"
              : m.senderUserId
                ? nameByUser.get(m.senderUserId) ?? "Participant"
                : "EightGig"}{" "}
            ·{" "}
            {formatRelativeTime(m.createdAt)}
          </span>
          <p>{m.body}</p>
        </div>
      ))}
      <div className="card">
        {canReply ? (
          <ApiForm
            endpoint={`/api/threads/${id}/messages`}
            submitLabel="Send"
            fields={[{ name: "body", label: "Reply", type: "textarea", required: true }]}
          />
        ) : (
          <>
            <h2>Replies unavailable</h2>
            <p className="muted">
              {counterpartUnavailable
                ? "This conversation is read-only because another participant's account is no longer active. You can still read the message history."
                : "Your account cannot send messages right now. You can still read the message history."}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
