import { db, schema } from "@gigit/db";
import { desc, eq, inArray, sql } from "drizzle-orm";
import Link from "next/link";
import {
  formatRelativeTime,
  formatVenueDateTime,
  shortTimeZoneName,
} from "@/lib/date-time";
import { sessionUserId } from "@/lib/session";
import { counterpartyLabel } from "@/lib/thread-display";
import { loadParticipantLabels } from "@/lib/thread-profile-labels";

export const dynamic = "force-dynamic";

const THREAD_SCOPE_LABELS: Record<string, string> = {
  inquiry: "Act inquiry",
  application: "Application",
  booking: "Booking",
  support: "Support",
};

function threadScopeLabel(scope: string) {
  return THREAD_SCOPE_LABELS[scope] ?? "Conversation";
}

export default async function InboxPage() {
  const userId = await sessionUserId();
  if (!userId)
    return (
      <div className="card">
        <Link href="/login">Sign in</Link> to see your messages.
      </div>
    );
  const d = db();
  const latestActivity = sql<Date>`coalesce(max(${schema.messages.createdAt}), ${schema.threads.createdAt})`;
  const threads = await d
    .select({
      id: schema.threads.id,
      scope: schema.threads.scope,
      subjectId: schema.threads.subjectId,
      createdAt: schema.threads.createdAt,
      lastActivityAt: latestActivity,
    })
    .from(schema.threadParticipants)
    .innerJoin(
      schema.threads,
      eq(schema.threadParticipants.threadId, schema.threads.id),
    )
    .leftJoin(schema.messages, eq(schema.messages.threadId, schema.threads.id))
    .where(eq(schema.threadParticipants.userId, userId))
    .groupBy(schema.threads.id)
    .orderBy(desc(latestActivity))
    .limit(50);

  // A row used to be a scope badge and a date, so a venue with a dozen
  // conversations saw a dozen identical rows and could not tell who any of them
  // was with. Resolve the counterparty and the last line, the way the thread
  // page already does one level down.
  const threadIds = threads.map((t) => t.id);
  const [participants, lastMessages] = threadIds.length
    ? await Promise.all([
        d
          .select({
            threadId: schema.threadParticipants.threadId,
            userId: schema.threadParticipants.userId,
          })
          .from(schema.threadParticipants)
          .where(inArray(schema.threadParticipants.threadId, threadIds)),
        d
          .selectDistinctOn([schema.messages.threadId], {
            threadId: schema.messages.threadId,
            body: schema.messages.body,
            createdAt: schema.messages.createdAt,
          })
          .from(schema.messages)
          .where(inArray(schema.messages.threadId, threadIds))
          .orderBy(schema.messages.threadId, desc(schema.messages.createdAt)),
      ])
    : [[], []];

  const otherUserIds = [
    ...new Set(participants.filter((p) => p.userId !== userId).map((p) => p.userId)),
  ];
  const nameByUser = await loadParticipantLabels(otherUserIds);
  const otherNameFor = (threadId: string) =>
    counterpartyLabel(
      participants.filter((p) => p.threadId === threadId).map((p) => p.userId),
      userId,
      nameByUser,
    );
  // Ordered desc, so the first hit per thread is the latest message.
  const lastByThread = new Map<string, { body: string; createdAt: Date }>();
  for (const m of lastMessages)
    if (!lastByThread.has(m.threadId))
      lastByThread.set(m.threadId, { body: m.body, createdAt: m.createdAt });

  const bookingIds = threads
    .filter((thread) => thread.scope === "booking" && thread.subjectId)
    .map((thread) => thread.subjectId!);
  const bookingRows = bookingIds.length
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
        .where(inArray(schema.bookings.id, bookingIds))
    : [];
  const bookingById = new Map(bookingRows.map((row) => [row.id, row]));

  return (
    <div>
      <h1>Inbox</h1>
      {threads.length === 0 && (
        <div className="card">
          <p>
            No messages yet. Conversations appear here when you contact an act or
            sound tech, or discuss a booking.
          </p>
          <p className="muted">
            Start something: <Link href="/slots">browse open gigs</Link>,{" "}
            <Link href="/performers">find an act</Link>, or{" "}
            <Link href="/techs">find a sound tech</Link>.
          </p>
        </div>
      )}
      {threads.map((t) => {
        const last = lastByThread.get(t.id);
        const who = otherNameFor(t.id);
        const booking =
          t.scope === "booking" && t.subjectId
            ? bookingById.get(t.subjectId)
            : undefined;
        return (
          // The whole card is the link now — it used to be the badge alone,
          // a ~17px tap target on a phone.
          <Link className="card thread-row" href={`/inbox/${t.id}`} key={t.id}>
            <strong>{who ?? "Conversation"}</strong>{" "}
            <span className="badge">{threadScopeLabel(t.scope)}</span>
            {booking && (
              <p className="gig-line thread-context">
                {booking.performerName} at {booking.venueName} ·{" "}
                {formatVenueDateTime(
                  booking.terms.startsAt,
                  booking.terms.timeZone ?? booking.venueTimeZone,
                )}{" "}
                {shortTimeZoneName(
                  booking.terms.startsAt,
                  booking.terms.timeZone ?? booking.venueTimeZone,
                )}
              </p>
            )}
            <p className="muted thread-preview">
              {last?.body?.trim() || "No messages yet."}
            </p>
            <span className="muted">
              {formatRelativeTime(last?.createdAt ?? t.lastActivityAt)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
