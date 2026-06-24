import Link from "next/link";
import { db, paymentsEnabled, seriesForVenue } from "@gigit/db";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ActionButton, ApiForm, RedirectButton } from "@/components/ApiForm";
import { GearExtractWidget, ProfileIngestWidget } from "@/components/AiAssist";
import { MediaManager } from "@/components/MediaManager";

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
              transform="genreTagsCsv"
              fields={[
                { name: "name", label: "Act name", defaultValue: performer.name },
                { name: "bio", label: "Bio", type: "textarea", defaultValue: performer.bio ?? "" },
                { name: "genreTags", label: "Genres (comma-separated)", defaultValue: (performer.genreTags ?? []).join(", ") },
                { name: "rateMinCents", label: "Rate floor ($)", type: "number", defaultValue: performer.rateMinCents != null ? performer.rateMinCents / 100 : undefined },
                { name: "rateMaxCents", label: "Rate ceiling ($)", type: "number", defaultValue: performer.rateMaxCents != null ? performer.rateMaxCents / 100 : undefined },
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
            transform="genreTagsCsv"
            fields={[
              { name: "name", label: "Act name", required: true },
              { name: "kind", label: "Type", type: "select", options: ["band", "solo", "comedian", "other"], required: true },
              { name: "homeMetro", label: "Home metro (e.g. milwaukee)", required: true },
              { name: "bio", label: "Bio", type: "textarea" },
              { name: "genreTags", label: "Genres (comma-separated)" },
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
                  · {s.pattern.startTimeUtc} UTC ·{" "}
                  <span className="money">${(s.defaults.budgetCents / 100).toFixed(0)}</span>{" "}
                  <ActionButton
                    endpoint={`/api/series/${s.id}/cancel`}
                    label="End series"
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
              { name: "metro", label: "Metro (e.g. milwaukee)", required: true },
              { name: "lat", label: "Latitude", type: "number", required: true },
              { name: "lng", label: "Longitude", type: "number", required: true },
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
              ]}
            />
          </details>
          </>
        ) : (
          <ApiForm
            endpoint="/api/techs"
            submitLabel="Create tech profile"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "gear", label: "Gear", type: "select", options: ["none", "partial", "full_rig"], required: true },
              { name: "bio", label: "Experience", type: "textarea" },
            ]}
          />
        )}
      </div>
    </div>
  );
}
