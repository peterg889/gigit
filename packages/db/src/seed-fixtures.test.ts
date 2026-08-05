import { describe, expect, it } from "vitest";
import { E2E_JOURNEYS } from "./seed-fixtures.js";

describe("E2E seed journey contract", () => {
  it("gives every parallel journey its own complete venue and performer identity", () => {
    const journeys = [
      E2E_JOURNEYS.core,
      E2E_JOURNEYS.decline,
      E2E_JOURNEYS.sound,
      E2E_JOURNEYS.postgig,
    ];
    const emails = journeys.flatMap(({ venue, performer }) => [
      venue.email,
      performer.email,
    ]);

    expect(journeys).toHaveLength(4);
    expect(new Set(emails).size).toBe(emails.length);
    expect(new Set(journeys.map(({ venue }) => venue.name)).size).toBe(
      journeys.length,
    );
    expect(new Set(journeys.map(({ performer }) => performer.name)).size).toBe(
      journeys.length,
    );

    for (const { venue, performer } of journeys) {
      expect(venue.email).not.toBe(performer.email);
      expect(venue.addressLine1).toBeTruthy();
      expect(venue.timeZone).toBe("America/Chicago");
      expect(performer.kind).toBe("band");
      expect(performer.homeMetro).toBe(venue.metro);
      expect(performer.setLengthsMinutes).toContain(120);
    }
  });

  it("keeps sound gaps and a distinct act for deterministic overlap", () => {
    const { venue, performer, overlapPerformer } = E2E_JOURNEYS.sound;

    expect(performer.techNeeds.inputs).toBeGreaterThan(
      venue.paInventory.mixerChannels,
    );
    expect(overlapPerformer.techNeeds.inputs).toBeGreaterThan(
      venue.paInventory.mixerChannels,
    );
    expect(venue.paInventory.hasOperator).toBe(false);
    expect(
      new Set([venue.email, performer.email, overlapPerformer.email]).size,
    ).toBe(3);
    expect(overlapPerformer.setLengthsMinutes).toContain(120);
  });

  it("defines a unique post-gig booking and active admin identity", () => {
    const { admin, booking, performer, venue } = E2E_JOURNEYS.postgig;

    expect(admin.email).toBe("admin-e2e@example.com");
    expect(new Set([admin.email, performer.email, venue.email]).size).toBe(3);
    expect(booking.amountCents).toBeGreaterThan(0);
    expect(booking.durationMinutes).toBeGreaterThanOrEqual(30);
    expect(booking.marker).toMatch(/post-gig/i);
    expect(booking.disputeReason.length).toBeGreaterThanOrEqual(5);
    expect(booking.venueReviewBody).not.toBe(booking.performerReviewBody);
  });

  it("reserves a different venue and admin identity for every lifecycle retry", () => {
    const attempts = E2E_JOURNEYS.lifecycle.attempts;
    const emails = attempts.flatMap(({ admin, venue }) => [
      admin.email,
      venue.email,
    ]);

    expect(attempts).toHaveLength(2);
    expect(new Set(emails).size).toBe(emails.length);
    expect(
      new Set(attempts.map(({ venue }) => venue.name)).size,
    ).toBe(attempts.length);
    for (const { admin, slot, venue } of attempts) {
      expect(admin.email).not.toBe(venue.email);
      expect(venue.timeZone).toBe("America/Chicago");
      expect(slot.marker).toMatch(/account lifecycle/i);
      expect(slot.amountCents).toBeGreaterThan(0);
      expect(slot.durationMinutes).toBeGreaterThanOrEqual(30);
    }
  });

  it("reserves fixed, distinct identities for no-commitment deactivation retries", () => {
    const attempts = E2E_JOURNEYS.lifecycle.deactivationAttempts;
    const ids = attempts.flatMap(({ account, admin }) => [
      account.id,
      admin.id,
    ]);
    const emails = attempts.flatMap(({ account, admin }) => [
      account.email,
      admin.email,
    ]);

    expect(attempts).toHaveLength(2);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(emails).size).toBe(emails.length);
    for (const { account, admin } of attempts) {
      expect(account.id).toMatch(/^usr_/);
      expect(admin.id).toMatch(/^usr_/);
      expect(account.email).not.toBe(admin.email);
    }
  });
});
