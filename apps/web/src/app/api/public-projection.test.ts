import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";

import { GET as venueGet } from "./venues/[id]/route";
import { GET as performerGet } from "./performers/[id]/route";
import { GET as techGet } from "./techs/[id]/route";

type GetHandler = (
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;
const get = (h: GetHandler, id: string) =>
  h(new Request(`http://test/x/${id}`), { params: Promise.resolve({ id }) });

/**
 * Public by-id profile GETs must not leak internal/owner/payment columns to
 * anonymous callers (audit authz #2/#3/#4). They now project explicit public
 * columns instead of `select()` the whole row.
 */
describe("public profile column projection", () => {
  const uOwner = newId("user");
  const venueId = newId("venue");
  const performerId = newId("performer");
  const techId = newId("tech");

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values({ id: uOwner, email: `${uOwner}@t.test` });
    await d.insert(schema.venues).values({
      id: venueId,
      ownerUserId: uOwner,
      kind: "bar",
      name: "Proj Bar",
      metro: "proj-tv",
      addressLine1: "10 Test Ave",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53202",
      timeZone: "America/Chicago",
      lat: 43,
      lng: -88,
      stripeCustomerId: "cus_secret",
      defaultPaymentMethodId: "pm_secret",
    });
    await d.insert(schema.performers).values({
      id: performerId,
      ownerUserId: uOwner,
      kind: "band",
      name: "Proj Band",
      homeMetro: "proj-tv",
      stripeAccountId: "acct_secret",
    });
    await d.insert(schema.techs).values({
      id: techId,
      ownerUserId: uOwner,
      name: "Proj Tech",
      gear: "full_rig",
    });
  });
  afterAll(async () => {
    await closeDb();
  });

  it("venue GET returns public fields but never ownerUserId or Stripe ids", async () => {
    const res = await get(venueGet, venueId);
    expect(res.status).toBe(200);
    const { venue } = await res.json();
    expect(venue.name).toBe("Proj Bar"); // public data still present
    expect(venue.addressLine1).toBe("10 Test Ave");
    expect(venue.timeZone).toBe("America/Chicago");
    expect(venue.lat).toBeUndefined();
    expect(venue.lng).toBeUndefined();
    expect(venue.ownerUserId).toBeUndefined();
    expect(venue.stripeCustomerId).toBeUndefined();
    expect(venue.defaultPaymentMethodId).toBeUndefined();
  });

  it("performer GET never returns ownerUserId or stripeAccountId", async () => {
    const { performer } = await (await get(performerGet, performerId)).json();
    expect(performer.name).toBe("Proj Band");
    expect(performer.ownerUserId).toBeUndefined();
    expect(performer.stripeAccountId).toBeUndefined();
  });

  it("tech GET never returns ownerUserId", async () => {
    const { tech } = await (await get(techGet, techId)).json();
    expect(tech.name).toBe("Proj Tech");
    expect(tech.ownerUserId).toBeUndefined();
  });

  it("missing id still 404s", async () => {
    expect((await get(venueGet, newId("venue"))).status).toBe(404);
  });
});
