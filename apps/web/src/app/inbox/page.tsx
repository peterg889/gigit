import { db, schema } from "@gigit/db";
import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
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

  return (
    <div>
      <h1>Inbox</h1>
      {threads.length === 0 && (
        <div className="card">
          No messages yet. Conversations appear here when you contact an act or
          sound tech, or discuss a booking.
        </div>
      )}
      {threads.map((t) => (
        <div className="card" key={t.id}>
          <Link href={`/inbox/${t.id}`}>
            <span className="badge">{threadScopeLabel(t.scope)}</span>
          </Link>{" "}
          <span className="muted">
            {t.createdAt.toLocaleDateString("en-US", { dateStyle: "medium" })}
          </span>
        </div>
      ))}
    </div>
  );
}
