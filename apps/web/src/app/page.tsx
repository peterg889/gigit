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
        <span className="eyebrow">Live work for local rooms</span>
        <h1>Find the room. Fill the night. Get the gig.</h1>
        <p className="lede">
          Gigit connects independent venues with bands, solo acts, comedians,
          and sound professionals. Every open slot shows the pay before anyone
          applies.
        </p>
        <div className="button-row">
          <Link className="btn" href="/slots">See open slots</Link>
          <Link className="btn secondary" href={userId ? "/onboarding" : "/onboarding?role=venue"}>
            {userId ? "Choose your role" : "Start as a venue"}
          </Link>
        </div>
        <p className="trust-line">
          Free to join and apply · No platform cut · Gig payment stays between
          the people doing the work
        </p>
      </section>

      {userId && (
        <section className="card welcome-card">
          <span className="badge">Welcome back</span>
          <h2>Your next move</h2>
          {!performer && !venue && !tech ? (
            <p>
              Your account is ready. <Link href="/onboarding">Choose a role</Link>{" "}
              to create the right profile and get to first value.
            </p>
          ) : (
            <div className="button-row">
              {venue && <Link className="btn" href="/slots/new">Post a slot</Link>}
              {performer && <Link className="btn" href="/slots">Find a gig</Link>}
              {tech && <Link className="btn" href="/bookings">View sound work</Link>}
              <Link className="btn secondary" href="/bookings">Bookings</Link>
            </div>
          )}
        </section>
      )}

      <section>
        <span className="eyebrow">Pick your side of the stage</span>
        <h2>Built for the long tail</h2>
        <div className="role-grid">
          <div className="card role-card">
            <span className="badge">Venues</span>
            <h3>Turn an open night into a real offer</h3>
            <p>
              Bars, restaurants, breweries, coffee shops, and small rooms post
              a date, honest pay, and the practical details acts need.
            </p>
            <Link href="/onboarding?role=venue">Set up a venue</Link>
          </div>
          <div className="card role-card">
            <span className="badge">Performers</span>
            <h3>Spend less time chasing bookers</h3>
            <p>
              Create one useful profile, discover nearby paid dates, apply, and
              keep the agreement and conversation together.
            </p>
            <Link href="/onboarding?role=performer">Set up an act</Link>
          </div>
          <div className="card role-card">
            <span className="badge">Sound</span>
            <h3>Be findable when the room needs help</h3>
            <p>
              List your experience, rates, rig, and travel range so local gigs
              can find the right operator.
            </p>
            <Link href="/onboarding?role=tech">Set up a sound profile</Link>
          </div>
        </div>
      </section>

      <section className="how-it-works">
        <span className="eyebrow">A clean handshake</span>
        <h2>How a booking works</h2>
        <ol className="steps">
          <li><strong>The venue posts the truth.</strong> Date, local time, pay, room, and sound expectations.</li>
          <li><strong>Performers put their profile forward.</strong> The venue compares real applicants in one place.</li>
          <li><strong>One clear offer gets accepted.</strong> Both sides keep the agreed details, contact, and messages together.</li>
          <li><strong>The gig happens and both sides review.</strong> Reliability grows from real work, not follower counts.</li>
        </ol>
      </section>

      <section className="card direct-pay">
        <h2>Gigit does not sit between you and your money</h2>
        <p>
          During the pilot, venues pay performers and sound professionals
          directly under the terms they accept. Gigit organizes discovery,
          commitment, logistics, and accountability—not payment processing.
        </p>
        <Link className="btn" href="/slots">Browse the board</Link>
      </section>
    </div>
  );
}
