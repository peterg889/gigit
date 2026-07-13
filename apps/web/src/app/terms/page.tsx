import Link from "next/link";

export const metadata = { title: "Terms — Gigit" };

export default function TermsPage() {
  return (
    <article className="legal-copy">
      <span className="eyebrow">Beta · Effective July 13, 2026</span>
      <h1>Terms of Use</h1>
      <p className="lede">
        These terms are the ground rules for using Gigit while the service is
        in beta. By creating or using an account, you agree to them.
      </p>

      <h2>What Gigit does</h2>
      <p>
        Gigit helps venues, acts, and sound professionals find one another and
        record booking terms. Gigit is not the venue, act,
        employer, agent, insurer, payment processor, or event producer. We do
        not guarantee that an open date will fill, a gig will happen, or either party
        will perform or pay.
      </p>

      <h2>Who may use it</h2>
      <p>
        You must be at least 18 and able to enter a binding agreement. You must
        provide accurate information, control the profiles you create, keep
        access to your sign-in method secure, and promptly correct material
        errors.
      </p>

      <h2>Beta and Founding Memberships</h2>
      <p>
        Gigit is free during beta. The first 500 eligible act profiles and first
        500 eligible venue profiles we confirm as onboarded receive a Founding
        Membership with no recurring standard-membership fee for as long as
        Gigit operates and the account remains in good standing.
      </p>
      <p>
        We count profiles in the order we confirm onboarding. To qualify, a
        profile must be complete, authentic, and non-duplicate. The offer is
        limited to one Founding Membership per real-world act or venue. We
        confirm Founding status after onboarding.
      </p>
      <p>
        A Founding Membership is non-transferable and does not cover gig pay,
        taxes, third-party costs, or separately offered optional services. We
        will explain any future pricing before asking anyone to pay, and we
        will not charge a payment method without authorization.
      </p>

      <h2>Bookings and payment</h2>
      <p>
        A venue must publish honest pay and logistics. An offer and acceptance
        create a commitment between the venue and act on the displayed terms.
        Unless Gigit explicitly says otherwise, participants arrange and
        make payment directly; Gigit does not hold or guarantee gig money.
      </p>
      <p>
        Review the venue, local date and time, address, duration, pay, sound
        expectations, and provided equipment before accepting. Use the product
        controls to cancel or raise a dispute. Repeated cancellations, no-shows,
        unsafe conduct, or dishonest listings can lead to restrictions.
      </p>

      <h2>Your responsibilities</h2>
      <p>
        You are responsible for permits, taxes, insurance, worker
        classification, music and performance licenses, accessibility,
        age restrictions, safety, equipment, and compliance that applies to
        your role and event. Information on Gigit is general information, not
        legal, tax, or safety advice.
      </p>

      <h2>Content and conduct</h2>
      <p>
        Do not impersonate others; harass or discriminate; post deceptive,
        illegal, infringing, or unsafe content; scrape or disrupt the service;
        evade moderation; or use contact information outside legitimate
        booking activity. You keep ownership of your content and give
        Gigit a non-exclusive license to host, display, process, and transmit it
        as needed to operate and promote your listing or profile.
      </p>

      <h2>Moderation and account action</h2>
      <p>
        We may screen content, investigate reports, remove material, limit
        features, suspend accounts, or preserve evidence when reasonably needed
        for safety, booking integrity, legal compliance, or service
        security. You may ask for review through support.
      </p>

      <h2>Service limits</h2>
      <p>
        Gigit is currently in beta. Features may change, and the service may
        experience interruptions. To the extent the law allows, Gigit is not liable for
        indirect, incidental, special, consequential, or lost-profit damages,
        or for acts, omissions, injury, property damage, payment disputes, or
        content from other participants. Rights that cannot legally be
        waived remain in effect.
      </p>

      <h2>Ending use and changes</h2>
      <p>
        You may deactivate your account. Terms that protect shared booking
        history, content rights already granted, disputes, and service integrity
        may survive. We may update these terms; material changes will receive
        reasonable notice before taking effect.
      </p>

      <h2>Questions</h2>
      <p>
        Contact us through <Link href="/help">Help &amp; Support</Link>. Our{" "}
        <Link href="/privacy">Privacy Notice</Link> explains data handling.
      </p>
    </article>
  );
}
