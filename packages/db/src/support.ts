import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import { supportRequests, users } from "./schema.js";

export interface CreateSupportRequestInput {
  requesterUserId?: string;
  contactEmail?: string;
  contactPhone?: string;
  channel: "web" | "sms";
  category: string;
  escalationReason: "anonymous" | "explicit" | "triage" | "triage_error";
  message: string;
  requestIp?: string;
}

/** Persist the operator work item and its outbox notification atomically. */
export async function createSupportRequest(
  input: CreateSupportRequestInput,
): Promise<string> {
  const id = newId("supportRequest");
  const d = db();
  await d.transaction(async (tx) => {
    let contactEmail = input.contactEmail;
    let contactPhone = input.contactPhone;
    if (input.requesterUserId && (!contactEmail || !contactPhone)) {
      const [requester] = await tx
        .select({ email: users.email, phone: users.phone })
        .from(users)
        .where(eq(users.id, input.requesterUserId));
      contactEmail ??= requester?.email ?? undefined;
      contactPhone ??= requester?.phone ?? undefined;
    }

    await tx.insert(supportRequests).values({
      id,
      requesterUserId: input.requesterUserId ?? null,
      contactEmail: contactEmail ?? null,
      contactPhone: contactPhone ?? null,
      channel: input.channel,
      category: input.category,
      escalationReason: input.escalationReason,
      message: input.message,
      requestIp: input.requestIp ?? null,
    });
    await appendEvent(tx, {
      actor: input.requesterUserId ?? "anonymous",
      kind: "support.escalated",
      subjectType: "support_request",
      subjectId: id,
      payload: {
        category: input.category,
        channel: input.channel,
        ...(input.requestIp ? { requestIp: input.requestIp } : {}),
      },
    });
  });
  return id;
}
