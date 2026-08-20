import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type PgBoss from "pg-boss";

const { sesSend } = vi.hoisted(() => ({ sesSend: vi.fn() }));

vi.mock("@aws-sdk/client-sesv2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-sesv2")>();
  return {
    ...actual,
    SESv2Client: class {
      send(command: unknown) {
        return sesSend(command);
      }
    },
  };
});

// A configured mailbox, so the notifier renders and SENDS instead of falling to
// the log sink — which records only the subject line. The body is the thing
// under test here: it is where the deep link lives.
vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  return {
    ...actual,
    env: () => ({ ...actual.env(), EMAIL_FROM: "verified-sender@example.com" }),
    emailConfigured: () => true,
  };
});

import {
  closeDb,
  createTechSubslot,
  db,
  getPool,
  makePerformer,
  makeVenue,
  schema,
} from "@gigit/db";
import { newId } from "@gigit/domain";
import { eq } from "drizzle-orm";
import { drainOutboxOnce } from "./index.js";

const noBoss = {} as unknown as PgBoss;

/**
 * The email that carries the consent gate.
 *
 * A sound job proposed in the payer's name is invisible to techs until the
 * payer accepts, and the accept button lives on the parent booking's page. So
 * the message has to reach the payer AND point at the page that can answer it.
 * The log sink used by the other routing tests records the subject only, so an
 * unresolved `{bookingId}` — a template var no notifier passes renders as the
 * literal braces in a real inbox — is invisible there. This drives the real
 * producer through the real outbox with a mailbox configured and reads the body
 * SES was handed.
 */
describe("sound-job proposal notification", () => {
  beforeEach(async () => {
    sesSend.mockReset();
    sesSend.mockResolvedValue({ MessageId: "ses_test" });
    await getPool().query(
      `update events set dispatched_at = now()
       where dispatched_at is null and dead_lettered_at is null`,
    );
  });

  afterAll(async () => {
    await closeDb();
  });

  it("mails the payer a working link to the page that can accept", async () => {
    const venue = await makeVenue({ name: "Consent Mail Room", metro: "consent-mail" });
    const act = await makePerformer({
      name: "Consent Mail Act",
      homeMetro: "consent-mail",
    });
    const startsAt = new Date(Date.now() + 20 * 86_400_000);
    const slotId = newId("slot");
    const bookingId = newId("booking");
    await db().insert(schema.slots).values({
      id: slotId,
      venueId: venue.id,
      metro: "consent-mail",
      startsAt,
      durationMinutes: 120,
      format: "music",
      budgetCents: 30_000,
      status: "filled",
    });
    await db().insert(schema.bookings).values({
      id: bookingId,
      slotId,
      performerId: act.id,
      venueId: venue.id,
      state: "confirmed",
      terms: {
        amountCents: 30_000,
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
      },
      offerExpiresAt: new Date(startsAt.getTime() - 86_400_000),
    });

    // The act posts it and names the ROOM as payer — the case that had no gate.
    await createTechSubslot({
      bookingId,
      payer: "venue",
      budgetCents: 15_000,
      actor: act.ownerUserId,
    });
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await drainOutboxOnce(noBoss);
    } finally {
      spy.mockRestore();
    }

    const [venueOwner] = await db()
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, venue.ownerUserId));
    const sent = sesSend.mock.calls
      .map(([command]) => (command as { input: SesInput }).input)
      .filter((input) => input.Destination.ToAddresses.includes(venueOwner!.email!));
    expect(sent).toHaveLength(1);
    const body = sent[0]!.Content.Simple.Body.Text.Data;
    expect(body).toContain(`/bookings/${bookingId}`);
    expect(body).toContain("Nothing is posted to techs until you accept");
    expect(body).not.toMatch(/\{\w+\}/);
    expect(sent[0]!.Content.Simple.Subject.Data).toBe(
      "Someone's asking you to cover sound",
    );
  });
});

interface SesInput {
  Destination: { ToAddresses: string[] };
  Content: {
    Simple: {
      Subject: { Data: string };
      Body: { Text: { Data: string } };
    };
  };
}
