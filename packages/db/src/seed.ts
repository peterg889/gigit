/**
 * Dev/demo seed: a Milwaukee venue, two performers, a sound tech, open slots.
 * Run: pnpm db:seed (idempotent — skips if the demo venue exists).
 */
import { localDateTimeParts, newId, zonedDateTimeToDate } from "@gigit/domain";
import { eq } from "drizzle-orm";
import { closeDb, db } from "./client.js";
import { performers, slots, techs, users, venues } from "./schema.js";

async function main() {
  const d = db();
  const existing = await d
    .select({ id: venues.id })
    .from(venues)
    .where(eq(venues.name, "Lakefront Taproom"));
  if (existing.length > 0) {
    // Keep older local databases useful after the address/timezone migration.
    await d
      .update(venues)
      .set({
        addressLine1: "1872 N Commerce St",
        city: "Milwaukee",
        region: "WI",
        postalCode: "53212",
        timeZone: "America/Chicago",
        lat: 43.0389,
        lng: -87.9065,
      })
      .where(eq(venues.id, existing[0]!.id));
    console.log("seed: already present; refreshed venue location");
    return;
  }

  const venueOwner = newId("user");
  const bandOwner = newId("user");
  const comicOwner = newId("user");
  const techOwner = newId("user");
  await d.insert(users).values([
    { id: venueOwner, email: "venue@example.com" },
    { id: bandOwner, email: "band@example.com" },
    { id: comicOwner, email: "comic@example.com" },
    { id: techOwner, email: "tech@example.com" },
  ]);

  const venueId = newId("venue");
  await d.insert(venues).values({
    id: venueId,
    ownerUserId: venueOwner,
    kind: "brewery",
    name: "Lakefront Taproom",
    bio: "Riverside taproom with a corner stage. We host live music Fridays and want to start a comedy night.",
    metro: "milwaukee",
    addressLine1: "1872 N Commerce St",
    city: "Milwaukee",
    region: "WI",
    postalCode: "53212",
    timeZone: "America/Chicago",
    lat: 43.0389,
    lng: -87.9065,
    capacity: 120,
    paInventory: { hasPA: true, mixerChannels: 8, micsAvailable: 2, monitors: 1 },
    noiseCurfew: "23:00",
  });

  await d.insert(performers).values([
    {
      id: newId("performer"),
      ownerUserId: bandOwner,
      kind: "band",
      name: "The Hollow Points",
      bio: "Four-piece roots-rock band. Tight two-hour sets of originals and crowd-pleasers.",
      genreTags: ["roots rock", "americana", "covers"],
      homeMetro: "milwaukee",
      travelRadiusKm: 80,
      rateMinCents: 40_000,
      rateMaxCents: 80_000,
      setLengthsMinutes: [60, 120],
      techNeeds: { inputs: 10, micsNeeded: 4, monitorsNeeded: 2 },
    },
    {
      id: newId("performer"),
      ownerUserId: comicOwner,
      kind: "comedian",
      name: "Jess Marek",
      bio: "Stand-up. Host of the Riverwest open mic; clean-ish 30 or rowdy 45, your call.",
      genreTags: ["stand-up", "host"],
      homeMetro: "milwaukee",
      travelRadiusKm: 40,
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
    travelRadiusKm: 60,
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

  console.log("seed: done (venue, 2 performers, tech, 2 open slots)");
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
