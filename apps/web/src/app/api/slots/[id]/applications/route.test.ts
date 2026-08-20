import { afterAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  createOffer,
  db,
  makePerformer,
  makeVenue,
  schema,
} from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST } from "./route";
// A5 (withdraw) is the other half of this journey and the only way to reach the
// application states this route creates. Its route lives one directory over;
// the lifecycle test below starts with a real apply, so it lives with A4.
import { POST as applicationStatus } from "@/app/api/applications/[id]/status/route";

const apply = (slotId: string, note = "We'd love to play.") =>
  POST(
    new Request(`http://test/api/slots/${slotId}/applications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note }),
    }),
    { params: Promise.resolve({ id: slotId }) },
  );

/** Apply with no `note` key at all — the field is optional on the form. */
const applyWithoutNote = (slotId: string) =>
  POST(
    new Request(`http://test/api/slots/${slotId}/applications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ id: slotId }) },
  );

const withdraw = (applicationId: string) =>
  applicationStatus(
    new Request(`http://test/api/applications/${applicationId}/status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "withdraw" }),
    }),
    { params: Promise.resolve({ id: applicationId }) },
  );

const applicationsFor = (slotId: string) =>
  db()
    .select()
    .from(schema.applications)
    .where(eq(schema.applications.slotId, slotId));

describe("slot applications", () => {
  afterAll(async () => {
    await closeDb();
  });

  async function slotAt(startsAt: Date) {
    const venue = await makeVenue({ name: "Application Room" });
    const slotId = newId("slot");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "application-test",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
    });
    return { slotId, venueId: venue.id, venueOwnerUserId: venue.ownerUserId };
  }

  const futureSlot = () => slotAt(new Date(Date.now() + 7 * 86_400_000));

  it("rejects a stale submission after downbeat even before the expiry sweep", async () => {
    const performer = await makePerformer({ name: "Past Applicant" });
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const { slotId } = await slotAt(new Date(Date.now() - 60_000));

    const response = await apply(slotId);
    expect(response.status).toBe(409);
    expect((await response.json()).error.message).toMatch(/passed/i);
    const rows = await db()
      .select({ id: schema.applications.id })
      .from(schema.applications)
      .where(eq(schema.applications.slotId, slotId));
    expect(rows).toHaveLength(0);
  });

  it("still creates a submitted application for a future open date", async () => {
    const performer = await makePerformer({ name: "Future Applicant" });
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const { slotId } = await futureSlot();

    const response = await apply(slotId, "Two strong sets ready.");
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const [application] = await db()
      .select()
      .from(schema.applications)
      .where(eq(schema.applications.id, id));
    expect(application).toMatchObject({
      slotId,
      performerId: performer.id,
      status: "submitted",
      note: "Two strong sets ready.",
    });
  });

  it("stores a note at the 1000-character bound whole, and refuses 1001", async () => {
    const performer = await makePerformer({ name: "Verbose Applicant" });
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const { slotId } = await futureSlot();

    // The note is the only free text an act sends a venue, and nothing between
    // the textarea and the `text` column enforces a length but this schema. A
    // bound that drifted (or was dropped) either lets an act paste a novel into
    // every venue's applicant list, or silently clips the sentence that
    // explains the lineup — so pin BOTH sides of it.
    const over = await apply(slotId, "x".repeat(1001));
    expect(over.status).toBe(422);
    expect((await over.json()).error.message).toMatch(/too long/i);
    expect(await applicationsFor(slotId)).toHaveLength(0);

    const atTheBound = "y".repeat(1000);
    const accepted = await apply(slotId, atTheBound);
    expect(accepted.status).toBe(201);
    const [stored] = await applicationsFor(slotId);
    // Compare the whole string, not its length: a truncating column would keep
    // the first 255 characters and still look like a stored note.
    expect(stored!.note).toBe(atTheBound);
  });

  it("409s a second application and keeps the note the act first sent", async () => {
    const performer = await makePerformer({ name: "Eager Applicant" });
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const { slotId } = await futureSlot();

    expect((await apply(slotId, "First and only.")).status).toBe(201);
    const duplicate = await apply(slotId, "Second thoughts.");
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).error.message).toMatch(/already applied/i);

    // `onConflictDoNothing` returns no id on the duplicate — the route must not
    // report a 201 carrying an id it never inserted, and the double-tap must
    // not become a back door for rewriting a note the venue has already read.
    const rows = await applicationsFor(slotId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.note).toBe("First and only.");
  });

  it("404s an unknown date instead of inserting an application against it", async () => {
    const performer = await makePerformer({ name: "Lost Applicant" });
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const ghost = newId("slot");

    const response = await apply(ghost);
    expect(response.status).toBe(404);
    expect(await applicationsFor(ghost)).toHaveLength(0);
  });

  it("403s a signed-in user with no act profile", async () => {
    // The venue owner of the very slot is the realistic case: signed in, on the
    // page, no act profile. This check is the only thing standing between that
    // click and a foreign-key error surfacing as a 500.
    const { slotId, venueOwnerUserId } = await futureSlot();
    sessionUserId.mockResolvedValue(venueOwnerUserId);

    const response = await apply(slotId);
    expect(response.status).toBe(403);
    expect((await response.json()).error.message).toMatch(/act profile/i);
    expect(await applicationsFor(slotId)).toHaveLength(0);

    // Same route, no session at all: 401 before any profile lookup.
    sessionUserId.mockResolvedValue(null);
    expect((await apply(slotId)).status).toBe(401);
    expect(await applicationsFor(slotId)).toHaveLength(0);
  });

  it("accepts an application with no note at all", async () => {
    // The field is optional on the form; `note: undefined` must land as NULL
    // rather than the string "undefined" or a validation error.
    const performer = await makePerformer({ name: "Quiet Applicant" });
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const { slotId } = await futureSlot();

    expect((await applyWithoutNote(slotId)).status).toBe(201);
    const [stored] = await applicationsFor(slotId);
    expect(stored!.note).toBeNull();
  });

  it("refuses to withdraw an application the venue has already made an offer on", async () => {
    const performer = await makePerformer({ name: "Offered Applicant" });
    sessionUserId.mockResolvedValue(performer.ownerUserId);
    const startsAt = new Date(Date.now() + 7 * 86_400_000);
    const { slotId, venueId, venueOwnerUserId } = await slotAt(startsAt);
    const created = await apply(slotId, "Ready to go.");
    expect(created.status).toBe(201);
    const { id: applicationId } = await created.json();

    await createOffer({
      applicationId,
      slotId,
      performerId: performer.id,
      venueId,
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 120 * 60_000).toISOString(),
      },
      actor: venueOwnerUserId,
    });
    // The offer is what the venue actually did; the act's session is restored
    // so the withdrawal below is the act's own click, not an authz failure.
    sessionUserId.mockResolvedValue(performer.ownerUserId);

    // The act's page can still be showing "Withdraw application" when the offer
    // lands. Withdrawing then would move the application out from under a live
    // booking: the venue holds a firm offer against a row that says the act
    // walked away, and nothing reopens the slot. The row lock plus this status
    // re-check exist for exactly that race, and no test drove it.
    const late = await withdraw(applicationId);
    expect(late.status).toBe(409);
    expect((await late.json()).error.message).toMatch(/already has an answer/i);

    const [after] = await applicationsFor(slotId);
    expect(after!.status).toBe("offered");
    const [booking] = await db()
      .select({ state: schema.bookings.state })
      .from(schema.bookings)
      .where(eq(schema.bookings.slotId, slotId));
    expect(booking!.state).toBe("offered");

    // No `application.withdrawn` event may be written either — the outbox is
    // what the rest of the system reacts to, so a committed event with no
    // matching status change is the same failure one layer down.
    const events = await db()
      .select({ kind: schema.events.kind })
      .from(schema.events)
      .where(eq(schema.events.subjectId, slotId));
    expect(events.map((e) => e.kind)).not.toContain("application.withdrawn");
  });
});
