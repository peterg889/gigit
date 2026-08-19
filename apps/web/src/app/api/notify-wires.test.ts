import { afterAll, describe, expect, it, vi } from "vitest";
import {
  closeDb,
  db,
  getPool,
  makePerformer,
  makeUser,
  makeVenue,
  schema,
} from "@gigit/db";
import { newId } from "@gigit/domain";

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import { POST as applyToSlot } from "./slots/[id]/applications/route";
import { POST as createAct } from "./performers/route";
/**
 * The consumer half of these wires lives in the worker, and this is the only
 * place the two halves can meet. The worker's own suite cannot drive a route
 * handler — `next/server` is not resolvable from apps/worker — and apps/web does
 * not depend on @gigit/worker, so the drain is reached by path. That awkwardness
 * IS the finding: producer and consumer are joined by nothing but two string
 * literals (`kind`/`subject_type`) and an `effects` array, and
 * notify-routing.test.ts hand-builds the row it then routes, so both sides can
 * drift apart with every suite green.
 */
import { drainOutboxOnce } from "../../../../worker/src/index.js";

/**
 * Producer → outbox → notification, driven end to end.
 *
 * The two wires below are the ones whose failure stops the marketplace silently:
 * a venue that is never told an act applied never makes an offer, and the
 * applicant list it would have to check by hand is behind a page nobody has a
 * reason to open. Neither route's own test can see this — they assert rows and
 * status codes, and the event they emit is dispatched by a different process.
 */
describe("producer → notification wires", () => {
  afterAll(async () => {
    await closeDb();
  });

  /** No timers are armed by these events, so the boss is never touched. */
  const noBoss = {} as Parameters<typeof drainOutboxOnce>[0];

  /** Park everything already queued so a drain observes only this test's rows. */
  async function parkOutboxBacklog() {
    await getPool().query(
      `update events set dispatched_at = now()
        where dispatched_at is null and dead_lettered_at is null`,
    );
  }

  /**
   * With no Twilio/SES configured, delivery falls to a structured
   * `notify.log_sink` line — the recipient and template the worker actually
   * resolved, which is the thing under test.
   */
  async function drainAndCaptureSinks(): Promise<
    { userId?: string; template?: string; subject?: string }[]
  > {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    let calls: unknown[][] = [];
    try {
      await drainOutboxOnce(noBoss);
    } finally {
      // Copy before restoring: mockRestore drops the recorded calls, and an
      // assertion over an empty list is exactly the kind of test that cannot fail.
      calls = spy.mock.calls.slice();
      spy.mockRestore();
    }
    return calls
      .map((c) => {
        try {
          return JSON.parse(c[0] as string);
        } catch {
          return null;
        }
      })
      .filter((x) => x && x.kind === "notify.log_sink");
  }

  async function openSlot(venueId: string, metro: string, budgetCents: number) {
    const id = newId("slot");
    await db().insert(schema.slots).values({
      id,
      venueId,
      metro,
      startsAt: new Date(Date.now() + 10 * 86_400_000),
      durationMinutes: 120,
      format: "music",
      budgetCents,
    });
    return id;
  }

  /**
   * A fresh metro per run. The suite runs against a persistent database, so a
   * fixed metro accumulates every previous run's rooms and the fan-out
   * assertion below starts matching act-to-venue pairs it never created —
   * green on a clean DB, red on the second run.
   */
  const metroForRun = (label: string) => `${label}-${Date.now()}`;

  it("tells the venue owner when an act applies through the real apply route", async () => {
    const metro = metroForRun("wire-apply");
    const venue = await makeVenue({ name: "Applied-To Room", metro });
    const act = await makePerformer({ name: "Applying Act", homeMetro: metro });
    const slotId = await openSlot(venue.id, metro, 30_000);
    sessionUserId.mockResolvedValue(act.ownerUserId);

    await parkOutboxBacklog();
    const response = await applyToSlot(
      new Request(`http://test/api/slots/${slotId}/applications`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "We'd love this night." }),
      }),
      { params: Promise.resolve({ id: slotId }) },
    );
    expect(response.status).toBe(201);

    const sinks = await drainAndCaptureSinks();
    // The route emits `application.submitted` on subject_type `slot`; the worker
    // routes any non-`performer` slot notify to the slot's venue owner. Change
    // either the subject type or the effect target and the venue never learns
    // anyone applied — the applicant just waits, and both suites stay green.
    expect(sinks.filter((s) => s.template === "new_application").map((s) => s.userId)).toEqual([
      venue.ownerUserId,
    ]);
    // Never back to the act: `to: "performer"` on this event would route the
    // venue's own news to the applicant instead.
    expect(sinks.some((s) => s.userId === act.ownerUserId)).toBe(false);
  });

  it("fans a newly created act out to the venues whose open slot it fits", async () => {
    const metro = metroForRun("wire-new-act");
    const fitting = await makeVenue({ name: "Fitting Room", metro });
    const underBudget = await makeVenue({ name: "Under-Budget Room", metro });
    await openSlot(fitting.id, metro, 30_000);
    await openSlot(underBudget.id, metro, 5_000);
    const actOwner = await makeUser({ email: `${newId("user")}@wire-new-act.test` });
    sessionUserId.mockResolvedValue(actOwner);

    await parkOutboxBacklog();
    const response = await createAct(
      new Request("http://test/api/performers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "band",
          name: "Brand New Act",
          homeMetro: metro,
          rateMinCents: 20_000,
        }),
      }),
    );
    expect(response.status).toBe(201);

    const sinks = await drainAndCaptureSinks();
    // `performer.created` carries no `effects`, so this fan-out lives in a
    // kind-matched branch of the dispatcher rather than the effect loop — the
    // half of the feed moat that brings a venue back between its own posts, and
    // the half no test at any layer executed.
    expect(sinks.filter((s) => s.template === "new_act").map((s) => s.userId)).toEqual([
      fitting.ownerUserId,
    ]);
    // Scoped to an actionable slot rather than the metro: this room's budget is
    // below the act's stated floor, so it is not news for them.
    expect(sinks.some((s) => s.userId === underBudget.ownerUserId)).toBe(false);
    // The same event carries the act's own welcome, deliberately sent last so a
    // throw mid-fan-out cannot re-deliver it. It is the only day-one message an
    // act gets, and it must survive the real producer, not just a fixture.
    expect(sinks).toContainEqual(
      expect.objectContaining({ userId: actOwner, template: "act_welcome" }),
    );
  });
});
