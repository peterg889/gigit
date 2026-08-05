import React from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
vi.stubGlobal("React", React);

import { ActionButton, ApiForm } from "@/components/ApiForm";

const controls = vi.hoisted(() => ({
  paymentsEnabled: true,
  sessionUserId: null as string | null,
}));
vi.mock("@gigit/db", async (original) => ({
  ...(await original<typeof import("@gigit/db")>()),
  paymentsEnabled: () => controls.paymentsEnabled,
}));
vi.mock("@/lib/session", () => ({
  sessionUserId: () => Promise.resolve(controls.sessionUserId),
}));

import AdminSearchPage from "./page";

function elements(node: React.ReactNode): React.ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const children = (node.props as { children?: React.ReactNode }).children;
  return [node, ...elements(children)];
}

function text(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (!React.isValidElement(node)) return "";
  return text((node.props as { children?: React.ReactNode }).children);
}

describe("ops search adjustment controls", () => {
  const adminId = newId("user");
  const venueOwnerId = newId("user");
  const performerOwnerId = newId("user");
  const deletedUserId = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const chargedBookingId = newId("booking");
  const settledBookingId = newId("booking");
  const unchargedBookingId = newId("booking");

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: adminId, email: `${adminId}@admin-search.test` },
      { id: venueOwnerId, email: `${venueOwnerId}@admin-search.test` },
      { id: performerOwnerId, email: `${performerOwnerId}@admin-search.test` },
      { id: deletedUserId, status: "deleted" },
    ]);
    await d.insert(schema.actorRoles).values({
      id: newId("role"),
      userId: adminId,
      kind: "admin",
    });
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: venueOwnerId,
      kind: "bar",
      name: "Admin Search Room",
      metro: "admin-search",
      addressLine1: "1 Test St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: performerOwnerId,
      kind: "band",
      name: "Admin Search Act",
      homeMetro: "admin-search",
    });

    const startsAt = new Date(Date.now() + 30 * 86_400_000);
    for (const [bookingId, state, charged] of [
      [chargedBookingId, "confirmed", true],
      [settledBookingId, "released", true],
      [unchargedBookingId, "offered", false],
    ] as const) {
      const slotId = newId("slot");
      await d.insert(schema.slots).values({
        id: slotId,
        venueId,
        metro: "admin-search",
        startsAt,
        durationMinutes: 120,
        format: "music",
        budgetCents: 30_000,
        status: "filled",
      });
      const paymentRef = charged ? `pi_${bookingId}` : null;
      await d.insert(schema.bookings).values({
        id: bookingId,
        slotId,
        performerId,
        venueId,
        state,
        paymentRef,
        offerExpiresAt: startsAt,
        terms: {
          amountCents: 30_000,
          startsAt: startsAt.toISOString(),
          endsAt: new Date(startsAt.getTime() + 2 * 3_600_000).toISOString(),
        },
      });
      if (paymentRef)
        await d.insert(schema.ledgerEntries).values({
          bookingId,
          entryType: "charge",
          debitParty: `venue:${venueId}`,
          creditParty: "platform",
          amountCents: 30_000,
          paymentRef,
          idempotencyKey: `${bookingId}:charge`,
        });
    }
  });

  beforeEach(() => {
    controls.sessionUserId = adminId;
    controls.paymentsEnabled = true;
  });

  afterAll(async () => {
    await closeDb();
    vi.unstubAllGlobals();
  });

  const renderSearch = (q: string) =>
    AdminSearchPage({ searchParams: Promise.resolve({ q }) });

  it("uses a fresh operation key whenever the successful form refreshes", async () => {
    const firstPage = await renderSearch(chargedBookingId);
    const first = elements(firstPage).find(
      (element) => element.type === ApiForm,
    );
    const second = elements(await renderSearch(chargedBookingId)).find(
      (element) => element.type === ApiForm,
    );
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    const firstProps = first!.props as {
      submitLabel: string;
      confirm: string;
      resetOnSuccess: boolean;
      successMessage: string;
      extra: { idempotencyKey: string };
      fields: Array<{
        name: string;
        options?: string[];
      }>;
    };
    const secondProps = second!.props as {
      extra: { idempotencyKey: string };
    };
    expect(firstProps.submitLabel).toBe("Execute adjustment");
    expect(firstProps.confirm).toContain("Verify the direction, amount, and reason");
    expect(firstProps.resetOnSuccess).toBe(true);
    expect(firstProps.successMessage).toBe(
      "Adjustment submitted. Enter new details to make another adjustment.",
    );
    expect(firstProps.extra.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(secondProps.extra.idempotencyKey).not.toBe(
      firstProps.extra.idempotencyKey,
    );
    expect(
      firstProps.fields.find((field) => field.name === "direction")?.options,
    ).toEqual(["pay_performer"]);
    expect(text(firstPage)).toContain(
      "Venue refunds become available after cancellation or settlement finishes.",
    );
  });

  it("offers venue refunds once lifecycle settlement is complete", async () => {
    const page = await renderSearch(settledBookingId);
    const form = elements(page).find((element) => element.type === ApiForm);
    expect(form).toBeTruthy();
    const props = form!.props as {
      fields: Array<{
        name: string;
        options?: string[];
      }>;
    };
    expect(
      props.fields.find((field) => field.name === "direction")?.options,
    ).toEqual(["refund_venue", "pay_performer"]);
    expect(text(page)).toContain(
      "refund returns part of the original charge to the venue",
    );
  });

  it("hides money actions when payments are off or no parent charge exists", async () => {
    controls.paymentsEnabled = false;
    const disabled = await renderSearch(chargedBookingId);
    expect(elements(disabled).some((element) => element.type === ApiForm)).toBe(false);
    expect(text(disabled)).toContain(
      "Money adjustments are unavailable while platform payments are turned off.",
    );

    controls.paymentsEnabled = true;
    const uncharged = await renderSearch(unchargedBookingId);
    expect(elements(uncharged).some((element) => element.type === ApiForm)).toBe(false);
    expect(text(uncharged)).toContain(
      "No completed platform charge is available to adjust.",
    );
  });

  it("does not offer suspend/reinstate actions for deleted accounts", async () => {
    const page = await renderSearch(deletedUserId);
    expect(text(page)).toContain("Deactivated permanently");
    expect(
      elements(page).some((element) => element.type === ActionButton),
    ).toBe(false);
  });
});
