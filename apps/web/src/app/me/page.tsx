import Link from "next/link";
import { db, paymentsEnabled, seriesForVenue } from "@gigit/db";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm, RedirectButton } from "@/components/ApiForm";
import { GearExtractWidget, ProfileIngestWidget } from "@/components/AiAssist";
import { MediaManager } from "@/components/MediaManager";
import {
  formatAddress,
  formatWallTime,
  venueLocationIsComplete,
} from "@/lib/date-time";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const userId = await sessionUserId();
  if (!userId)
    return (
      <div className="card">
        <Link href="/login">Sign in</Link> to set up your profile.
      </div>
    );
  const [performer, venue, tech] = await Promise.all([
    performerOwnedBy(userId),
    venueOwnedBy(userId),
    techOwnedBy(userId),
  ]);
  const series = venue ? await seriesForVenue(db(), venue.id) : [];
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const WEEK = ["", "first", "second", "third", "fourth", "last"];
  const US_TIME_ZONES = [
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Phoenix",
    "America/Los_Angeles",
    "America/Anchorage",
    "Pacific/Honolulu",
  ];

  return (
    <div>
      <h1>Your profiles</h1>
      <p className="muted">
        One account can hold multiple roles — a comedian who books rooms, a
        musician who runs sound. You&apos;ll never pay to be on Gigit.
      </p>

      <div className="card">
        <h2>Performer</h2>
        {performer ? (
          <>
          <p>
            <strong>{performer.name}</strong> <span className="badge">{performer.kind}</span>{" "}
            <Link href={`/p/${performer.id}`}>view public page</Link>
            <br />
            <span className="muted">{performer.bio}</span>
          </p>
          {paymentsEnabled() ? (
            <p>
              <RedirectButton
                endpoint="/api/payments/connect"
                label="Set up payouts"
              />{" "}
              <span className="muted">— where your money lands. Stripe handles the bank details; we never see them.</span>
            </p>
          ) : (
            <p className="muted">
              You arrange pay directly with the venue — Gigit never touches your money.
            </p>
          )}
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>Edit profile</summary>
            <ApiForm
              endpoint={`/api/performers/${performer.id}`}
              method="PATCH"
              submitLabel="Save changes"
              transform="performerProfile"
              fields={[
                { name: "name", label: "Act name", defaultValue: performer.name },
                { name: "bio", label: "Bio", type: "textarea", defaultValue: performer.bio ?? "" },
                { name: "genreTags", label: "Genres (comma-separated)", defaultValue: (performer.genreTags ?? []).join(", ") },
                { name: "rateMinCents", label: "Rate floor ($)", type: "number", defaultValue: performer.rateMinCents != null ? performer.rateMinCents / 100 : undefined },
                { name: "rateMaxCents", label: "Rate ceiling ($)", type: "number", defaultValue: performer.rateMaxCents != null ? performer.rateMaxCents / 100 : undefined },
                { name: "travelRadiusKm", label: "Travel radius (km)", type: "number", defaultValue: performer.travelRadiusKm },
                { name: "setLengthsMinutes", label: "Set lengths in minutes (comma-separated)", defaultValue: (performer.setLengthsMinutes ?? []).join(", ") },
                { name: "inputs", label: "Audio inputs needed", type: "number", defaultValue: performer.techNeeds.inputs },
                { name: "micsNeeded", label: "Microphones needed", type: "number", defaultValue: performer.techNeeds.micsNeeded ?? 0 },
                { name: "monitorsNeeded", label: "Stage monitors needed", type: "number", defaultValue: performer.techNeeds.monitorsNeeded ?? 0 },
                { name: "canPlayUnamplified", label: "Can you play unamplified?", type: "select", options: ["false", "true"], defaultValue: String(performer.techNeeds.canPlayUnamplified ?? false) },
              ]}
            />
          </details>
          <MediaManager subjectType="performer" />
          </>
        ) : (
          <>
          <ProfileIngestWidget />
          <ApiForm
            endpoint="/api/performers"
            submitLabel="Create performer profile"
            transform="performerProfile"
            fields={[
              { name: "name", label: "Act name", required: true },
              { name: "kind", label: "Type", type: "select", options: ["band", "solo", "comedian", "other"], required: true },
              { name: "homeMetro", label: "Home metro (e.g. milwaukee)", required: true },
              { name: "bio", label: "Bio", type: "textarea" },
              { name: "genreTags", label: "Genres (comma-separated)" },
              { name: "rateMinCents", label: "Typical rate from ($)", type: "number" },
              { name: "rateMaxCents", label: "Typical rate to ($)", type: "number" },
              { name: "travelRadiusKm", label: "Travel radius (km)", type: "number", defaultValue: 50 },
              { name: "setLengthsMinutes", label: "Set lengths in minutes (comma-separated)", placeholder: "45, 60, 120" },
              { name: "inputs", label: "Audio inputs needed", type: "number", defaultValue: 0 },
              { name: "micsNeeded", label: "Microphones needed", type: "number", defaultValue: 0 },
              { name: "monitorsNeeded", label: "Stage monitors needed", type: "number", defaultValue: 0 },
              { name: "canPlayUnamplified", label: "Can you play unamplified?", type: "select", options: ["false", "true"], defaultValue: "false" },
            ]}
          />
          </>
        )}
      </div>

      <div className="card">
        <h2>Venue</h2>
        <details>
          <summary className="muted" style={{ cursor: "pointer" }}>
            Music licensing — what hosting live music means for your room
          </summary>
          <div className="muted" style={{ marginTop: 8 }}>
            <p>
              If acts play cover songs in your room, US law says the venue (not
              the band) needs licenses from the performing-rights organizations
              — ASCAP, BMI, SESAC, and GMR. For a small room that&apos;s
              typically on the order of $1,500/year combined, scaled to your
              capacity. It&apos;s a real obligation: ASCAP actively pursues
              small venues, and statutory damages run far past the license
              cost.
            </p>
            <p>
              Two honest paths: budget the licenses as part of running live
              music, or program originals-only nights (which reduces, but
              doesn&apos;t eliminate, exposure — covers in a set are common).
              Check whether your state restaurant association offers PRO
              discounts; many do.
            </p>
            <p>
              This is guidance, not legal advice — confirm your situation with
              the PROs or a lawyer.
            </p>
          </div>
        </details>
        {venue ? (
          <>
          <p>
            <strong>{venue.name}</strong> <span className="badge">{venue.kind}</span>{" "}
            <Link href={`/v/${venue.id}`}>view public page</Link>
            <br />
            <span className="muted">{venue.bio}</span>
          </p>
          <p className="muted">
            {formatAddress(venue)} · {venue.timeZone.replaceAll("_", " ")}
          </p>
          {!venueLocationIsComplete(venue) && (
            <p className="error">
              Add the complete address and choose the venue timezone before posting a
              night. Existing UTC-only profiles cannot safely schedule a real gig.
            </p>
          )}
          {paymentsEnabled() ? (
            <p>
              <RedirectButton
                endpoint="/api/payments/setup"
                label="Add a payment method"
              />{" "}
              <span className="muted">— the card charged when an act accepts your offer. Required before you can send offers.</span>
            </p>
          ) : (
            <p className="muted">
              You pay the act directly — no card needed to post slots or send offers.
            </p>
          )}
          {series.length > 0 && (
            <div>
              <h3>Recurring nights</h3>
              {series.map((s) => (
                <p key={s.id}>
                  <span className="badge">{s.defaults.format}</span>{" "}
                  {s.pattern.freq === "weekly"
                    ? `every ${DOW[s.pattern.dayOfWeek]}`
                    : `${WEEK[s.pattern.week ?? 1]} ${DOW[s.pattern.dayOfWeek]} monthly`}{" "}
                  · {formatWallTime(s.pattern.startTimeLocal ?? s.pattern.startTimeUtc ?? "00:00")}{" "}
                  {s.pattern.timeZone
                    ? s.pattern.timeZone.replaceAll("_", " ")
                    : "UTC (legacy series)"}{" "}
                  ·{" "}
                  <span className="money">${(s.defaults.budgetCents / 100).toFixed(0)}</span>{" "}
                  <ActionButton
                    endpoint={`/api/series/${s.id}/cancel`}
                    label="End series"
                    confirm="End this recurring series? Future open nights will close. Existing bookings stay confirmed."
                  />
                </p>
              ))}
              <p className="muted">
                Ending a series closes its future open nights. Booked nights
                stand — they&apos;re contracts.
              </p>
            </div>
          )}
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>Edit details</summary>
            <ApiForm
              endpoint={`/api/venues/${venue.id}`}
              method="PATCH"
              submitLabel="Save changes"
              fields={[
                { name: "name", label: "Venue name", defaultValue: venue.name },
                { name: "bio", label: "About the room", type: "textarea", defaultValue: venue.bio ?? "" },
                { name: "addressLine1", label: "Street address", defaultValue: venue.addressLine1 },
                { name: "addressLine2", label: "Suite / unit (optional)", defaultValue: venue.addressLine2 ?? "" },
                { name: "city", label: "City", defaultValue: venue.city },
                { name: "region", label: "State", defaultValue: venue.region },
                { name: "postalCode", label: "ZIP code", defaultValue: venue.postalCode },
                {
                  name: "timeZone",
                  label: "Timezone",
                  type: "select",
                  options: US_TIME_ZONES.includes(venue.timeZone)
                    ? US_TIME_ZONES
                    : [venue.timeZone, ...US_TIME_ZONES],
                  defaultValue: venue.timeZone,
                },
                { name: "capacity", label: "Capacity", type: "number", defaultValue: venue.capacity ?? undefined },
                { name: "noiseCurfew", label: "Noise curfew (e.g. 11pm)", defaultValue: venue.noiseCurfew ?? "" },
              ]}
            />
          </details>
          <GearExtractWidget venueId={venue.id} />
          <MediaManager subjectType="venue" />
          </>
        ) : (
          <ApiForm
            endpoint="/api/venues"
            submitLabel="Create venue profile"
            fields={[
              { name: "name", label: "Venue name", required: true },
              { name: "kind", label: "Type", type: "select", options: ["bar", "restaurant", "coffee_shop", "brewery", "other"], required: true },
              { name: "addressLine1", label: "Street address", required: true, placeholder: "1872 N Commerce St" },
              { name: "addressLine2", label: "Suite / unit (optional)" },
              { name: "city", label: "City", required: true, placeholder: "Milwaukee" },
              { name: "region", label: "State", required: true, placeholder: "WI" },
              { name: "postalCode", label: "ZIP code", required: true, placeholder: "53212" },
              { name: "metro", label: "Metro area", required: true, placeholder: "milwaukee" },
              {
                name: "timeZone",
                label: "Timezone",
                type: "select",
                options: US_TIME_ZONES,
                required: true,
                defaultValue: "America/Chicago",
              },
              { name: "bio", label: "About the room", type: "textarea" },
            ]}
          />
        )}
      </div>

      <div className="card">
        <h2>Sound tech</h2>
        {tech ? (
          <>
          <p>
            <strong>{tech.name}</strong> <span className="badge">{tech.gear}</span>
            <br />
            <span className="muted">{tech.bio}</span>
          </p>
          <details>
            <summary className="muted" style={{ cursor: "pointer" }}>Edit profile</summary>
            <ApiForm
              endpoint={`/api/techs/${tech.id}`}
              method="PATCH"
              submitLabel="Save changes"
              fields={[
                { name: "name", label: "Name", defaultValue: tech.name },
                { name: "gear", label: "Gear", type: "select", options: ["none", "partial", "full_rig"], defaultValue: tech.gear },
                { name: "bio", label: "Experience", type: "textarea", defaultValue: tech.bio ?? "" },
                { name: "rateLaborCents", label: "Labor rate ($)", type: "number", defaultValue: tech.rateLaborCents != null ? tech.rateLaborCents / 100 : undefined },
                { name: "rateWithRigCents", label: "Rate with rig ($)", type: "number", defaultValue: tech.rateWithRigCents != null ? tech.rateWithRigCents / 100 : undefined },
                { name: "travelRadiusKm", label: "Travel radius (km)", type: "number", defaultValue: tech.travelRadiusKm },
              ]}
            />
          </details>
          <MediaManager subjectType="tech" />
          </>
        ) : (
          <ApiForm
            endpoint="/api/techs"
            submitLabel="Create tech profile"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "gear", label: "Gear", type: "select", options: ["none", "partial", "full_rig"], required: true },
              { name: "bio", label: "Experience", type: "textarea" },
              { name: "rateLaborCents", label: "Labor rate ($)", type: "number" },
              { name: "rateWithRigCents", label: "Rate with rig ($)", type: "number" },
              { name: "travelRadiusKm", label: "Travel radius (km)", type: "number", defaultValue: 50 },
            ]}
          />
        )}
      </div>
    </div>
  );
}
