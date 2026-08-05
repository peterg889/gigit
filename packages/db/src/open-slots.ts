import { newId } from "@gigit/domain";
import { db } from "./client.js";
import { appendEvent } from "./events.js";
import { lockActiveProfileOwners } from "./account-gate.js";
import { slots } from "./schema.js";

export interface CreateOpenSlotInput {
  venueId: string;
  actor: string;
  startsAt: Date;
  durationMinutes: number;
  format: string;
  genrePrefs: string[];
  budgetCents: number;
  provides: { pa?: boolean; meal?: boolean; parking?: boolean };
  notes?: string | null;
  source: "web" | "sms";
}

export class OpenSlotStartTimeError extends Error {
  readonly code = "slot_not_future";
  constructor(readonly startsAt: Date) {
    super("an open date must start in the future");
  }
}

/** Active venue gate + slot + outbox event, committed as one unit. */
export async function createOpenSlot(input: CreateOpenSlotInput): Promise<string> {
  const id = newId("slot");
  await db().transaction(async (tx) => {
    const active = await lockActiveProfileOwners(tx, {
      venueIds: [input.venueId],
      additionalUserIds: [input.actor],
    });
    const venue = active.venues.get(input.venueId)!;
    // Validate again at the persistence boundary. Web input is checked when it
    // is parsed, but an SMS draft can sit awaiting YES until after downbeat, and
    // either path can wait behind the account lock long enough to cross it.
    const startsAtMs = input.startsAt.getTime();
    if (!Number.isFinite(startsAtMs) || startsAtMs <= Date.now())
      throw new OpenSlotStartTimeError(input.startsAt);

    await tx.insert(slots).values({
      id,
      venueId: venue.id,
      metro: venue.metro,
      startsAt: input.startsAt,
      durationMinutes: input.durationMinutes,
      format: input.format,
      genrePrefs: input.genrePrefs,
      budgetCents: input.budgetCents,
      provides: input.provides,
      notes: input.notes ?? null,
      status: "open",
      source: input.source,
    });
    await appendEvent(tx, {
      actor: input.actor,
      kind: "slot.created",
      subjectType: "slot",
      subjectId: id,
      payload: {
        venueId: venue.id,
        budgetCents: input.budgetCents,
        source: input.source,
      },
    });
  });
  return id;
}
