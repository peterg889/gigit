/**
 * Browser-test identities are deliberately distinct per journey. Playwright
 * runs spec files in parallel, while OTP verification consumes the newest code
 * for an email address; sharing an account would make simultaneous sign-ins
 * race each other.
 */
export const E2E_JOURNEYS = {
  core: {
    venue: {
      email: "venue@example.com",
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
      paInventory: {
        hasPA: true,
        mixerChannels: 8,
        micsAvailable: 2,
        monitors: 1,
        hasOperator: false,
      },
      noiseCurfew: "23:00",
    },
    performer: {
      email: "band@example.com",
      kind: "band",
      name: "The Hollow Points",
      bio: "Four-piece roots-rock band. Tight two-hour sets of originals and crowd-pleasers.",
      genreTags: ["roots rock", "americana", "covers"],
      homeMetro: "milwaukee",
      travelRadiusMiles: 50,
      rateMinCents: 40_000,
      rateMaxCents: 80_000,
      setLengthsMinutes: [60, 120],
      techNeeds: { inputs: 10, micsNeeded: 4, monitorsNeeded: 2 },
    },
  },
  decline: {
    venue: {
      email: "venue-decline@example.com",
      kind: "bar",
      name: "Riverwest Listening Room",
      bio: "A neighborhood room for intimate live sets.",
      metro: "milwaukee",
      addressLine1: "818 E Center St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53212",
      timeZone: "America/Chicago",
      lat: 43.0674,
      lng: -87.9003,
      capacity: 90,
      paInventory: {
        hasPA: true,
        mixerChannels: 12,
        micsAvailable: 4,
        monitors: 2,
        hasOperator: true,
      },
      noiseCurfew: "23:00",
    },
    performer: {
      email: "band-decline@example.com",
      kind: "band",
      name: "Copper Lines",
      bio: "Milwaukee indie-rock trio with a flexible two-hour show.",
      genreTags: ["indie rock", "alternative"],
      homeMetro: "milwaukee",
      travelRadiusMiles: 50,
      rateMinCents: 25_000,
      rateMaxCents: 60_000,
      setLengthsMinutes: [60, 120],
      techNeeds: { inputs: 8, micsNeeded: 3, monitorsNeeded: 2 },
    },
  },
  sound: {
    venue: {
      email: "venue-sound@example.com",
      kind: "brewery",
      name: "Bay View Sound Room",
      bio: "A small stage and house PA in the heart of Bay View.",
      metro: "milwaukee",
      addressLine1: "2301 S Kinnickinnic Ave",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53207",
      timeZone: "America/Chicago",
      lat: 43.002,
      lng: -87.9042,
      capacity: 110,
      paInventory: {
        hasPA: true,
        mixerChannels: 8,
        micsAvailable: 2,
        monitors: 1,
        hasOperator: false,
      },
      noiseCurfew: "23:00",
    },
    performer: {
      email: "band-sound@example.com",
      kind: "band",
      name: "Signal Fires",
      bio: "Four-piece rock band whose full input list needs an engineer and a larger board.",
      genreTags: ["rock", "indie"],
      homeMetro: "milwaukee",
      travelRadiusMiles: 50,
      rateMinCents: 35_000,
      rateMaxCents: 75_000,
      setLengthsMinutes: [60, 120],
      techNeeds: { inputs: 10, micsNeeded: 4, monitorsNeeded: 2 },
    },
    /** A distinct act can confirm a second gig at the same time. */
    overlapPerformer: {
      email: "band-sound-overlap@example.com",
      kind: "band",
      name: "Echo Relay",
      bio: "Dedicated browser-test act for overlapping sound-work selection.",
      genreTags: ["rock", "sound overlap e2e"],
      homeMetro: "milwaukee",
      travelRadiusMiles: 50,
      rateMinCents: 36_000,
      rateMaxCents: 76_000,
      setLengthsMinutes: [60, 120],
      techNeeds: { inputs: 10, micsNeeded: 4, monitorsNeeded: 2 },
    },
  },
  postgig: {
    venue: {
      email: "venue-postgig@example.com",
      kind: "bar",
      name: "Lantern Post-Gig Room",
      bio: "A dedicated browser-test room for completed-gig follow-up.",
      metro: "milwaukee",
      addressLine1: "729 E Center St",
      city: "Milwaukee",
      region: "WI",
      postalCode: "53212",
      timeZone: "America/Chicago",
      lat: 43.067,
      lng: -87.902,
      capacity: 80,
      paInventory: {
        hasPA: true,
        mixerChannels: 12,
        micsAvailable: 4,
        monitors: 2,
        hasOperator: true,
      },
      noiseCurfew: "23:00",
    },
    performer: {
      email: "band-postgig@example.com",
      kind: "band",
      name: "Post-Gig Paper Trail",
      bio: "Dedicated browser-test act for disputes, resolution, and reviews.",
      genreTags: ["indie rock", "post-gig e2e"],
      homeMetro: "milwaukee",
      travelRadiusMiles: 40,
      rateMinCents: 50_000,
      rateMaxCents: 75_000,
      setLengthsMinutes: [60, 120],
      techNeeds: { inputs: 8, micsNeeded: 3, monitorsNeeded: 2 },
    },
    admin: {
      email: "admin-e2e@example.com",
    },
    booking: {
      marker: "E2E post-gig dispute and double-blind review fixture",
      amountCents: 61_700,
      durationMinutes: 120,
      disputeCategory: "other",
      disputeReason:
        "The gig happened, but an end-of-night detail needs a staff decision.",
      venueReviewBody:
        "Post-gig E2E venue review: prepared, professional, and great with the room.",
      performerReviewBody:
        "Post-gig E2E act review: clear terms, welcoming staff, and an easy load-in.",
    },
  },
  aged: {
    /**
     * The production worker expires this fixture at boot. Playwright retries
     * share that database, so each attempt needs an untouched slot,
     * application, and pair of login identities.
     */
    attempts: [
      {
        venue: {
          email: "venue-aged-0@example.com",
          kind: "restaurant",
          name: "Aged Date Test Room Zero",
          bio: "A dedicated browser-test room for past-date reconciliation.",
          metro: "milwaukee",
          addressLine1: "1600 N Aged Date Ave",
          city: "Milwaukee",
          region: "WI",
          postalCode: "53202",
          timeZone: "America/Chicago",
          lat: 43.0501,
          lng: -87.9012,
          capacity: 75,
          paInventory: {
            hasPA: true,
            mixerChannels: 8,
            micsAvailable: 3,
            monitors: 2,
            hasOperator: true,
          },
          noiseCurfew: "22:00",
        },
        performer: {
          email: "band-aged-0@example.com",
          kind: "band",
          name: "Aged Date Test Act Zero",
          bio: "A dedicated browser-test act for past-date reconciliation.",
          genreTags: ["indie rock", "aged date e2e"],
          homeMetro: "milwaukee",
          travelRadiusMiles: 40,
          rateMinCents: 30_000,
          rateMaxCents: 55_000,
          setLengthsMinutes: [60, 120],
          techNeeds: { inputs: 8, micsNeeded: 3, monitorsNeeded: 2 },
        },
        slot: {
          id: "slot_e2e_aged_0",
          applicationId: "application_e2e_aged_0",
          marker: "E2E aged open-date fixture zero",
          applicationNote: "E2E pending application for aged date zero",
          amountCents: 37_500,
          durationMinutes: 120,
        },
      },
      {
        venue: {
          email: "venue-aged-1@example.com",
          kind: "restaurant",
          name: "Aged Date Test Room One",
          bio: "A retry-only browser-test room for past-date reconciliation.",
          metro: "milwaukee",
          addressLine1: "1601 N Aged Date Ave",
          city: "Milwaukee",
          region: "WI",
          postalCode: "53202",
          timeZone: "America/Chicago",
          lat: 43.0502,
          lng: -87.9013,
          capacity: 76,
          paInventory: {
            hasPA: true,
            mixerChannels: 8,
            micsAvailable: 3,
            monitors: 2,
            hasOperator: true,
          },
          noiseCurfew: "22:00",
        },
        performer: {
          email: "band-aged-1@example.com",
          kind: "band",
          name: "Aged Date Test Act One",
          bio: "A retry-only browser-test act for past-date reconciliation.",
          genreTags: ["indie rock", "aged date e2e"],
          homeMetro: "milwaukee",
          travelRadiusMiles: 40,
          rateMinCents: 31_000,
          rateMaxCents: 56_000,
          setLengthsMinutes: [60, 120],
          techNeeds: { inputs: 8, micsNeeded: 3, monitorsNeeded: 2 },
        },
        slot: {
          id: "slot_e2e_aged_1",
          applicationId: "application_e2e_aged_1",
          marker: "E2E aged open-date fixture one",
          applicationNote: "E2E pending application for aged date one",
          amountCents: 38_500,
          durationMinutes: 120,
        },
      },
    ],
  },
  lifecycle: {
    /**
     * Playwright retries share one seeded database. Each retry therefore gets
     * its own identity. The suspension journey intentionally deactivates its
     * venue account, so reusing attempt zero would make a retry unable to sign
     * in.
     */
    attempts: [
      {
        venue: {
          email: "venue-lifecycle-0@example.com",
          kind: "coffee_shop",
          name: "Lifecycle Test Room Zero",
          bio: "A dedicated browser-test room for account suspension and deactivation.",
          metro: "milwaukee",
          addressLine1: "1500 N Lifecycle Ave",
          city: "Milwaukee",
          region: "WI",
          postalCode: "53202",
          timeZone: "America/Chicago",
          lat: 43.049,
          lng: -87.901,
          capacity: 70,
          paInventory: {
            hasPA: true,
            mixerChannels: 8,
            micsAvailable: 3,
            monitors: 2,
            hasOperator: true,
          },
          noiseCurfew: "22:00",
        },
        admin: {
          email: "admin-lifecycle-0@example.com",
        },
        slot: {
          marker: "E2E account lifecycle open-date fixture zero",
          amountCents: 32_500,
          durationMinutes: 120,
        },
      },
      {
        venue: {
          email: "venue-lifecycle-1@example.com",
          kind: "coffee_shop",
          name: "Lifecycle Test Room One",
          bio: "A retry-only browser-test room for account suspension and deactivation.",
          metro: "milwaukee",
          addressLine1: "1501 N Lifecycle Ave",
          city: "Milwaukee",
          region: "WI",
          postalCode: "53202",
          timeZone: "America/Chicago",
          lat: 43.0491,
          lng: -87.9011,
          capacity: 71,
          paInventory: {
            hasPA: true,
            mixerChannels: 8,
            micsAvailable: 3,
            monitors: 2,
            hasOperator: true,
          },
          noiseCurfew: "22:00",
        },
        admin: {
          email: "admin-lifecycle-1@example.com",
        },
        slot: {
          marker: "E2E account lifecycle open-date fixture one",
          amountCents: 33_500,
          durationMinutes: 120,
        },
      },
    ],
    /**
     * A separate row proves direct deactivation when there are no profiles or
     * commitments to unwind. Stable ids let a later seed restore the reserved
     * user after deactivation has deliberately removed its email address.
     */
    deactivationAttempts: [
      {
        account: {
          id: "usr_01J00000000000000000000000",
          email: "account-deactivate-0@example.com",
        },
        admin: {
          id: "usr_01J00000000000000000000001",
          email: "admin-deactivate-0@example.com",
        },
      },
      {
        account: {
          id: "usr_01J00000000000000000000002",
          email: "account-deactivate-1@example.com",
        },
        admin: {
          id: "usr_01J00000000000000000000003",
          email: "admin-deactivate-1@example.com",
        },
      },
    ],
  },
} as const;

type VenueFixture = {
  kind: string;
  name: string;
  bio: string;
  metro: string;
  addressLine1: string;
  city: string;
  region: string;
  postalCode: string;
  timeZone: string;
  lat: number;
  lng: number;
  capacity: number;
  paInventory: {
    hasPA: boolean;
    mixerChannels?: number;
    micsAvailable?: number;
    monitors?: number;
    hasOperator?: boolean;
  };
  noiseCurfew: string;
};

type PerformerFixture = {
  kind: string;
  name: string;
  bio: string;
  genreTags: readonly string[];
  homeMetro: string;
  travelRadiusMiles: number;
  rateMinCents: number;
  rateMaxCents: number;
  setLengthsMinutes: readonly number[];
  techNeeds: {
    inputs: number;
    micsNeeded?: number;
    monitorsNeeded?: number;
    canPlayUnamplified?: boolean;
  };
};

/**
 * The column projection every seed site writes for a fixture venue. Only the
 * projection is shared: which row each seed looks up and which status it
 * writes are three different reset semantics, enforced by the partial unique
 * indexes on `status = 'live'`, and stay at their own call sites.
 */
export function venueRow(fixture: VenueFixture) {
  return {
    kind: fixture.kind,
    name: fixture.name,
    bio: fixture.bio,
    metro: fixture.metro,
    addressLine1: fixture.addressLine1,
    city: fixture.city,
    region: fixture.region,
    postalCode: fixture.postalCode,
    timeZone: fixture.timeZone,
    lat: fixture.lat,
    lng: fixture.lng,
    capacity: fixture.capacity,
    // hasOperator stated explicitly: omitting it now means "nobody has said",
    // which is a different verdict. A room with a PA and no house tech is the
    // scenario the sound-tech feature exists for, so say it.
    paInventory: { ...fixture.paInventory },
    noiseCurfew: fixture.noiseCurfew,
  };
}

/** The column projection every seed site writes for a fixture act. */
export function performerRow(fixture: PerformerFixture) {
  return {
    kind: fixture.kind,
    name: fixture.name,
    bio: fixture.bio,
    genreTags: [...fixture.genreTags],
    homeMetro: fixture.homeMetro,
    travelRadiusMiles: fixture.travelRadiusMiles,
    rateMinCents: fixture.rateMinCents,
    rateMaxCents: fixture.rateMaxCents,
    setLengthsMinutes: [...fixture.setLengthsMinutes],
    techNeeds: { ...fixture.techNeeds },
  };
}
