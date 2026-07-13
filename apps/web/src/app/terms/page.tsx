import Link from "next/link";

export const metadata = { title: "Terms — Gigit" };

export default function TermsPage() {
  return (
    <article className="legal-copy">
      <span className="eyebrow">Launch draft · July 13, 2026</span>
      <h1>Terms of Use</h1>
      <p className="lede">
        These terms are the ground rules for using Gigit during early access.
        By creating or using an account, you agree to them.
      </p>

      <h2>What Gigit does</h2>
      <p>
        Gigit helps venues, performers, and sound professionals find one
        another and record booking terms. Gigit is not the venue, performer,
        employer, agent, insurer, payment processor, or event producer. We do
        not guarantee that a slot will fill, a gig will happen, or either party
        will perform or pay.
      </p>

      <h2>Who may use it</h2>
      <p>
        You must be at least 18 and able to enter a binding agreement. You must
        provide accurate information, control the profiles you create, keep
        access to your sign-in method secure, and promptly correct material
        errors.
      </p>

      <h2>Bookings and payment</h2>
      <p>
        A venue must publish honest pay and logistics. An offer and acceptance
        create a commitment between the venue and performer on the displayed
        terms. Unless Gigit explicitly says otherwise, participants arrange and
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
        your role and event. Gigit’s product copy is general information, not
        legal, tax, or safety advice.
      </p>

      <h2>Content and conduct</h2>
      <p>
        Do not impersonate others; harass or discriminate; post deceptive,
        illegal, infringing, or unsafe content; scrape or disrupt the service;
        evade moderation; or use contact information outside legitimate
        marketplace activity. You keep ownership of your content and give
        Gigit a non-exclusive license to host, display, process, and transmit it
        as needed to operate and promote your listing or profile.
      </p>

      <h2>Moderation and account action</h2>
      <p>
        We may screen content, investigate reports, remove material, limit
        features, suspend accounts, or preserve evidence when reasonably needed
        for safety, marketplace integrity, legal compliance, or service
        security. You may ask for review through support.
      </p>

      <h2>Service limits</h2>
      <p>
        Early access is provided “as is” and may change or experience
        interruptions. To the extent the law allows, Gigit is not liable for
        indirect, incidental, special, consequential, or lost-profit damages,
        or for acts, omissions, injury, property damage, payment disputes, or
        content of marketplace participants. Rights that cannot legally be
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

      <div className="notice">
        These pilot terms need jurisdiction, company-identity, governing-law,
        and liability-cap review by counsel before a broad public launch.
      </div>
    </article>
  );
}
