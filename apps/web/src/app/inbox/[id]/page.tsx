import { db, schema } from "@gigit/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sessionUserId } from "@/lib/session";
import { ApiForm } from "@/components/ApiForm";

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

  const messages = await d
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.threadId, id))
    .orderBy(asc(schema.messages.createdAt))
    .limit(200);

  // A user's display name lives on whichever profile they hold — resolve the
  // other parties' names so messages aren't attributed to a generic "Them".
  const others = [
    ...new Set(
      messages
        .map((m) => m.senderUserId)
        .filter((s): s is string => !!s && s !== userId),
    ),
  ];
  const nameByUser = new Map<string, string>();
  if (others.length > 0) {
    const [perf, ven, tec] = await Promise.all([
      d.select({ u: schema.performers.ownerUserId, n: schema.performers.name }).from(schema.performers).where(inArray(schema.performers.ownerUserId, others)),
      d.select({ u: schema.venues.ownerUserId, n: schema.venues.name }).from(schema.venues).where(inArray(schema.venues.ownerUserId, others)),
      d.select({ u: schema.techs.ownerUserId, n: schema.techs.name }).from(schema.techs).where(inArray(schema.techs.ownerUserId, others)),
    ]);
    for (const r of [...perf, ...ven, ...tec]) if (r.u && !nameByUser.has(r.u)) nameByUser.set(r.u, r.n);
  }
  const counterparty = others.map((u) => nameByUser.get(u)).find(Boolean);

  return (
    <div>
      <h1>{counterparty ? `Conversation with ${counterparty}` : "Conversation"}</h1>
      {messages.map((m) => (
        <div className="card" key={m.id}>
          <span className="muted">
            {m.senderUserId === userId
              ? "You"
              : (m.senderUserId && nameByUser.get(m.senderUserId)) || "Them"}{" "}
            ·{" "}
            {m.createdAt.toLocaleString("en-US", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
          <p>{m.body}</p>
        </div>
      ))}
      <div className="card">
        <ApiForm
          endpoint={`/api/threads/${id}/messages`}
          submitLabel="Send"
          fields={[{ name: "body", label: "Reply", type: "textarea", required: true }]}
        />
      </div>
    </div>
  );
}
