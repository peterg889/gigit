/**
 * Dev/demo seed: isolated E2E identities, including a second act for the sound
 * overlap journey, two retry-safe lifecycle venues, two no-commitment accounts,
 * five E2E admins, a demo comic and sound tech, plus open dates. Safe to rerun.
 * Run: pnpm db:seed.
 */
import { localDateTimeParts, newId, zonedDateTimeToDate } from "@gigit/domain";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import { performers, slots, techs, users, venues } from "./schema.js";
import { E2E_JOURNEYS, performerRow, venueRow } from "./seed-fixtures.js";
import { ensureAgedSlotE2EJourneys } from "./seed-aged-slot.js";
import { ensureAccountLifecycleE2EJourneys } from "./seed-account-lifecycle.js";
import {
  ensureActiveSeedUser,
  ensurePostGigE2EJourney,
} from "./seed-postgig.js";

type Database = ReturnType<typeof db>;

async function ensureAdditionalE2EJourneys(d: Database) {
  for (const journey of [E2E_JOURNEYS.decline, E2E_JOURNEYS.sound]) {
    const venueOwner = await ensureActiveSeedUser(d, journey.venue.email);
    const [existingVenue] = await d
      .select({ id: venues.id })
      .from(venues)
      .where(and(eq(venues.ownerUserId, venueOwner), eq(venues.status, "live")));
    const venueValues = venueRow(journey.venue);
    if (existingVenue)
      await d
        .update(venues)
        .set(venueValues)
        .where(eq(venues.id, existingVenue.id));
    else
      await d.insert(venues).values({
        id: newId("venue"),
        ownerUserId: venueOwner,
        ...venueValues,
      });

    const journeyPerformers =
      journey === E2E_JOURNEYS.sound
        ? [journey.performer, journey.overlapPerformer]
        : [journey.performer];
    for (const performer of journeyPerformers) {
      const performerOwner = await ensureActiveSeedUser(d, performer.email);
      const [existingPerformer] = await d
        .select({ id: performers.id })
        .from(performers)
        .where(
          and(
            eq(performers.ownerUserId, performerOwner),
            eq(performers.status, "live"),
          ),
        );
      const performerValues = performerRow(performer);
      if (existingPerformer)
        await d
          .update(performers)
          .set(performerValues)
          .where(eq(performers.id, existingPerformer.id));
      else
        await d.insert(performers).values({
          id: newId("performer"),
          ownerUserId: performerOwner,
          ...performerValues,
        });
    }
  }
}

async function main() {
  const d = db();
  // These accounts are separate because Playwright runs spec files in parallel:
  // sharing an email would make their one-time-code verification requests race.
  await ensureAdditionalE2EJourneys(d);
  await ensurePostGigE2EJourney(d);
  await ensureAgedSlotE2EJourneys(d);
  await ensureAccountLifecycleE2EJourneys(d);
  const core = E2E_JOURNEYS.core;
  const existing = await d
    .select({ id: venues.id })
    .from(venues)
    .where(eq(venues.name, core.venue.name));
  if (existing.length > 0) {
    // Keep older local databases useful after the address/timezone migration.
    await d
      .update(venues)
      .set({
        addressLine1: core.venue.addressLine1,
        city: core.venue.city,
        region: core.venue.region,
        postalCode: core.venue.postalCode,
        timeZone: core.venue.timeZone,
        lat: core.venue.lat,
        lng: core.venue.lng,
      })
      .where(eq(venues.id, existing[0]!.id));
    console.log("seed: already present; refreshed E2E browser journeys");
    return;
  }

  const venueOwner = newId("user");
  const bandOwner = newId("user");
  const comicOwner = newId("user");
  const techOwner = newId("user");
  await d.insert(users).values([
    { id: venueOwner, email: core.venue.email },
    { id: bandOwner, email: core.performer.email },
    { id: comicOwner, email: "comic@example.com" },
    { id: techOwner, email: "tech@example.com" },
  ]);

  const venueId = newId("venue");
  await d.insert(venues).values({
    id: venueId,
    ownerUserId: venueOwner,
    ...venueRow(core.venue),
  });

  await d.insert(performers).values([
    {
      id: newId("performer"),
      ownerUserId: bandOwner,
      ...performerRow(core.performer),
    },
    {
      id: newId("performer"),
      ownerUserId: comicOwner,
      kind: "comedian",
      name: "Jess Marek",
      bio: "Stand-up. Host of the Riverwest open mic; clean-ish 30 or rowdy 45, your call.",
      genreTags: ["stand-up", "host"],
      homeMetro: "milwaukee",
      travelRadiusMiles: 25,
      rateMinCents: 10_000,
      rateMaxCents: 30_000,
      setLengthsMinutes: [15, 30, 45],
      techNeeds: { inputs: 1, micsNeeded: 1 },
    },
  ]);

  await d.insert(techs).values({
    id: newId("tech"),
    ownerUserId: techOwner,
    name: "Sam Okafor",
    bio: "Freelance live engineer, 8 years. Full small-room rig in a van (12ch, 2 wedges).",
    gear: "full_rig",
    rateLaborCents: 15_000,
    rateWithRigCents: 30_000,
    travelRadiusMiles: 35,
  });

  const friday = nextWeekday(5, 20, "America/Chicago");
  const tuesday = nextWeekday(2, 19, "America/Chicago");
  await d.insert(slots).values([
    {
      id: newId("slot"),
      venueId,
      metro: "milwaukee",
      startsAt: friday,
      durationMinutes: 180,
      format: "music",
      genrePrefs: ["americana", "roots rock"],
      budgetCents: 50_000,
      provides: { pa: true, meal: true },
      notes: "Friday patio season opener. Two sets with a break.",
    },
    {
      id: newId("slot"),
      venueId,
      metro: "milwaukee",
      startsAt: tuesday,
      durationMinutes: 120,
      format: "comedy",
      budgetCents: 20_000,
      provides: { pa: true },
      notes: "First-ever comedy night — host plus two short sets?",
    },
  ]);

  console.log(
    "seed: done (8 E2E venues, 8 performers, 5 E2E admins, 2 no-commitment accounts, tech, 4 future and 2 aged open slots)",
  );
}

function nextWeekday(dow: number, hour: number, timeZone: string): Date {
  const local = localDateTimeParts(new Date(), timeZone);
  const civil = new Date(Date.UTC(local.year, local.month - 1, local.day));
  civil.setUTCDate(civil.getUTCDate() + ((dow - civil.getUTCDay() + 7) % 7 || 7));
  return zonedDateTimeToDate(
    {
      year: civil.getUTCFullYear(),
      month: civil.getUTCMonth() + 1,
      day: civil.getUTCDate(),
      hour,
      minute: 0,
    },
    timeZone,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
