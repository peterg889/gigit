import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "About — EightGig",
  description:
    "Why EightGig is called EightGig and what we’re building for independent venues and local acts.",
};

export default function AboutPage() {
  return (
    <div className="landing">
      <section className="hero">
        <span className="eyebrow">About EightGig</span>
        <h1>Eight gigs a week.</h1>
        <p className="lede">
          More good nights for independent venues. More places for local acts
          to play. That’s the idea behind EightGig.
        </p>
      </section>

      <section className="card">
        <span className="badge">The name</span>
        <h2>Where it comes from</h2>
        <p>
          EightGig is short for <strong>eight gigs a week</strong>—an ambitious
          calendar for a working act and a livelier week for independent rooms.
        </p>
        <p>
          It’s a play on the Beatles’ <cite>Eight Days a Week</cite>. Bonus deep
          cut: <cite>Eight Gigs a Week: The Steve Winwood Years</cite> is a
          Spencer Davis Group collection. If you caught that one, you’re our
          kind of person.
        </p>
      </section>

      <section className="card">
        <span className="badge">What we’re building</span>
        <h2>Put more good nights on the calendar</h2>
        <p>
          EightGig gives independent venues, local acts, and sound techs one
          straightforward place to find each other, agree on the important
          details, and keep the gig moving. Pay is clear up front, the plan
          stays together, and EightGig doesn’t take a cut of gig pay.
        </p>
        <div className="button-row">
          <Link className="btn" href="/slots">
            See open gigs
          </Link>
          <Link className="btn secondary" href="/onboarding">
            Get started
          </Link>
        </div>
      </section>
    </div>
  );
}
