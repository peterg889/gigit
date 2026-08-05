import { and, eq } from "drizzle-orm";
import { newId } from "@gigit/domain";
import { db } from "./client.js";
import { lockActiveProfileOwners } from "./account-gate.js";
import { applications, slots } from "./schema.js";
import {
  createOffer,
  SlotUnavailableError,
  type CreateOfferInput,
} from "./transition.js";

export type CreateInvitedOfferInput = Omit<CreateOfferInput, "applicationId">;

/**
 * Prepare a venue-initiated application and its firm offer as one unit.
 *
 * The slot is locked before the application is created or revived. If another
 * live offer already holds the slot, createOffer fails and the surrounding
 * transaction rolls every application change back with it.
 */
export async function createInvitedOffer(
  input: CreateInvitedOfferInput,
): Promise<{ bookingId: string; applicationId: string }> {
  return db().transaction(async (tx) => {
    // Account/profile locks precede the slot lock everywhere. This keeps
    // invite creation serialized with deactivation without lock inversions.
    await lockActiveProfileOwners(tx, {
      performerIds: [input.performerId],
      venueIds: [input.venueId],
    });
    const [slot] = await tx
      .select({ id: slots.id, status: slots.status })
      .from(slots)
      .where(eq(slots.id, input.slotId))
      .for("update");
    if (!slot || slot.status !== "open")
      throw new SlotUnavailableError(input.slotId);

    const candidateId = newId("application");
    await tx
      .insert(applications)
      .values({
        id: candidateId,
        slotId: input.slotId,
        performerId: input.performerId,
        status: "submitted",
      })
      .onConflictDoNothing({
        target: [applications.slotId, applications.performerId],
      });

    const [application] = await tx
      .select({ id: applications.id, status: applications.status })
      .from(applications)
      .where(
        and(
          eq(applications.slotId, input.slotId),
          eq(applications.performerId, input.performerId),
        ),
      )
      .for("update");
    if (!application)
      throw new Error("failed to prepare the invited application");

    if (application.status !== "submitted")
      await tx
        .update(applications)
        .set({ status: "submitted", declineReason: null })
        .where(eq(applications.id, application.id));

    const bookingId = await createOffer(
      { ...input, applicationId: application.id },
      tx,
    );
    return { bookingId, applicationId: application.id };
  });
}
