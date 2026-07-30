import { db, schema } from "@gigit/db";
import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { formatRelativeTime } from "@/lib/date-time";
import { sessionUserId } from "@/lib/session";

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
  const mine = d
    .select({ threadId: schema.threadParticipants.threadId })
    .from(schema.threadParticipants)
    .where(eq(schema.threadParticipants.userId, userId));
  const threads = await d
    .select()
    .from(schema.threads)
    .where(inArray(schema.threads.id, mine))
    .orderBy(desc(schema.threads.createdAt))
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
          .select({
            threadId: schema.messages.threadId,
            body: schema.messages.body,
            createdAt: schema.messages.createdAt,
          })
          .from(schema.messages)
          .where(inArray(schema.messages.threadId, threadIds))
          .orderBy(desc(schema.messages.createdAt)),
      ])
    : [[], []];

  const otherUserIds = [
    ...new Set(participants.filter((p) => p.userId !== userId).map((p) => p.userId)),
  ];
  const nameByUser = new Map<string, string>();
  if (otherUserIds.length > 0) {
    const [perf, ven, tec] = await Promise.all([
      d.select({ u: schema.performers.ownerUserId, n: schema.performers.name })
        .from(schema.performers).where(inArray(schema.performers.ownerUserId, otherUserIds)),
      d.select({ u: schema.venues.ownerUserId, n: schema.venues.name })
        .from(schema.venues).where(inArray(schema.venues.ownerUserId, otherUserIds)),
      d.select({ u: schema.techs.ownerUserId, n: schema.techs.name })
        .from(schema.techs).where(inArray(schema.techs.ownerUserId, otherUserIds)),
    ]);
    for (const r of [...perf, ...ven, ...tec])
      if (r.u && !nameByUser.has(r.u)) nameByUser.set(r.u, r.n);
  }
  const otherNameFor = (threadId: string) =>
    participants
      .filter((p) => p.threadId === threadId && p.userId !== userId)
      .map((p) => nameByUser.get(p.userId))
      .find(Boolean);
  // Ordered desc, so the first hit per thread is the latest message.
  const lastByThread = new Map<string, { body: string; createdAt: Date }>();
  for (const m of lastMessages)
    if (!lastByThread.has(m.threadId))
      lastByThread.set(m.threadId, { body: m.body, createdAt: m.createdAt });

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
        return (
          // The whole card is the link now — it used to be the badge alone,
          // a ~17px tap target on a phone.
          <Link className="card thread-row" href={`/inbox/${t.id}`} key={t.id}>
            <strong>{who ?? "Conversation"}</strong>{" "}
            <span className="badge">{threadScopeLabel(t.scope)}</span>
            <p className="muted thread-preview">
              {last?.body?.trim() || "No messages yet."}
            </p>
            <span className="muted">
              {formatRelativeTime(last?.createdAt ?? t.createdAt)}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
