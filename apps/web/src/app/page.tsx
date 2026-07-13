import Link from "next/link";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const userId = await sessionUserId();
  const [performer, venue, tech] = userId
    ? await Promise.all([
        performerOwnedBy(userId),
        venueOwnedBy(userId),
        techOwnedBy(userId),
      ])
    : [null, null, null];

  return (
    <div className="landing">
      <section className="hero">
        <span className="eyebrow">Live gigs for independent venues</span>
        <h1>Find the room. Fill the night. Get the gig.</h1>
        <p className="lede">
          Gigit connects independent venues with local bands, solo acts,
          comedians, and sound techs. Every open gig shows the pay before anyone
          applies.
        </p>
        <div className="button-row">
          <Link className="btn" href="/slots">See open gigs</Link>
          <Link className="btn secondary" href={userId ? "/onboarding" : "/onboarding?role=venue"}>
            {userId ? "Get started" : "Start as a venue"}
          </Link>
        </div>
        <p className="trust-line">
          Free during beta · Gigit takes no cut of gig pay · Payment stays
          between the people doing the work
        </p>
      </section>

      <section className="card founding-offer">
        <span className="badge">Gigit beta</span>
        <h2>Become a Founding Member</h2>
        <p>
          Gigit is free during beta. The first 500 eligible act profiles—including
          bands, solo artists, comedians, and other live acts—and the first 500
          eligible venue profiles we confirm as onboarded receive a Founding
          Membership.
        </p>
        <p className="muted">
          Founding Membership has no recurring standard-membership fee for as
          long as Gigit operates. No card needed. Pricing for later members has
          not been set, and we’ll explain it before asking anyone to pay.{" "}
          <Link href="/help">See offer details.</Link>
        </p>
        <div className="button-row">
          <Link className="btn" href="/onboarding?role=performer">
            Join as an act
          </Link>
          <Link className="btn secondary" href="/onboarding?role=venue">
            Join as a venue
          </Link>
        </div>
      </section>

      {userId && (
        <section className="card welcome-card">
          <span className="badge">Welcome back</span>
          <h2>Your next move</h2>
          {!performer && !venue && !tech ? (
            <p>
              Your account is ready. <Link href="/onboarding">Tell us what you do</Link>{" "}
              to create your first profile.
            </p>
          ) : (
            <div className="button-row">
              {venue && <Link className="btn" href="/slots/new">Post an open date</Link>}
              {performer && <Link className="btn" href="/slots">Find a gig</Link>}
              {tech && <Link className="btn" href="/bookings">View sound work</Link>}
              <Link className="btn secondary" href="/bookings">Bookings</Link>
            </div>
          )}
        </section>
      )}

      <section>
        <span className="eyebrow">Pick your side of the stage</span>
        <h2>Built for independent venues and local acts</h2>
        <div className="role-grid">
          <div className="card role-card">
            <span className="badge">Venues</span>
            <h3>Turn an open night into a real offer</h3>
            <p>
              Bars, restaurants, breweries, coffee shops, and small rooms post
              a date, clear pay, and the practical details acts need.
            </p>
            <Link href="/onboarding?role=venue">Set up a venue</Link>
          </div>
          <div className="card role-card">
            <span className="badge">Acts</span>
            <h3>Spend less time chasing bookers</h3>
            <p>
              Create one profile, discover nearby paid gigs, apply, and
              keep the agreement and conversation together.
            </p>
            <Link href="/onboarding?role=performer">Set up an act</Link>
          </div>
          <div className="card role-card">
            <span className="badge">Sound techs</span>
            <h3>Be findable when the room needs help</h3>
            <p>
              List your experience, rates, equipment, and travel range so venues
              and acts can find the right person for the night.
            </p>
            <Link href="/onboarding?role=tech">Set up a sound profile</Link>
          </div>
        </div>
      </section>

      <section className="how-it-works">
        <span className="eyebrow">From open date to booked gig</span>
        <h2>How a booking works</h2>
        <ol className="steps">
          <li><strong>The venue posts an open date.</strong> It includes the local start time, pay, set length, room details, and sound setup.</li>
          <li><strong>Acts apply with their profiles.</strong> The venue reviews every interested act in one place.</li>
          <li><strong>The venue sends an offer.</strong> The act reviews and accepts the exact gig details.</li>
          <li><strong>Everyone works from the same plan.</strong> The agreement, messages, and day-of contacts stay together, and both sides can review after the gig.</li>
        </ol>
      </section>

      <section className="card direct-pay">
        <h2>You handle gig payment directly</h2>
        <p>
          Venues pay acts and sound techs directly under the terms they
          accept. Gigit keeps the offer, agreement, messages, and gig details
          together without processing the gig payment or taking a cut.
        </p>
        <Link className="btn" href="/slots">Browse open gigs</Link>
      </section>
    </div>
  );
}
