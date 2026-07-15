import Link from "next/link";

export const metadata = { title: "Privacy Notice — EightGig" };

export default function PrivacyPage() {
  return (
    <article className="legal-copy">
      <span className="eyebrow">Beta · Effective July 14, 2026</span>
      <h1>Privacy Notice</h1>
      <p className="lede">
        This notice explains what EightGig collects, how we use it, and the
        choices available to you.
      </p>

      <h2>Information we collect</h2>
      <p>
        We collect the email address or phone number you use to sign in;
        act, venue, or sound tech profile details you choose to publish; open
        gig, application, booking, message, review, support, and dispute
        records; uploaded media; and basic security and delivery logs.
      </p>
      <p>
        Venue profiles and open gigs are public, including the venue name,
        full street address, room details, and schedule. Act and sound
        professional profile information submitted for publication is also public.
        Application notes, booking threads, contact details, and
        additional logistics are shared only with the relevant participants.
      </p>

      <h2>How we use information</h2>
      <p>
        We use it to operate EightGig, match people to local work,
        deliver sign-in codes and booking notices, prevent abuse, moderate
        content, answer support requests, resolve disputes, understand how
        EightGig is used, improve the service, and comply with law.
      </p>

      <h2>Who receives information</h2>
      <p>
        Public profile and open-gig information can be seen by anyone.
        Information you send in an application, booking, thread, or review is
        shared with the relevant participants as the product indicates.
      </p>
      <p>
        We use service providers for hosting, storage, email or text delivery,
        monitoring, and carefully scoped AI-assisted drafting, screening, and
        support. They process information for EightGig under their service terms.
        We do not sell personal information or use it for third-party targeted
        advertising.
      </p>

      <h2>Retention and account choices</h2>
      <p>
        You can edit profile information in EightGig and deactivate access from
        your account page. Deactivation removes your login identifiers.
        Booking, review, dispute, fraud-prevention, and audit records may remain
        when they are needed for the other participants’ records, safety,
        legal obligations, or legitimate dispute handling.
      </p>
      <p>
        To request access, correction, export, or an erasure review, use{" "}
        <Link href="/help">Help &amp; Support</Link>. We will verify the request
        before acting on account data.
      </p>

      <h2>Cookies, security, and age</h2>
      <p>
        EightGig uses a secure, HTTP-only session cookie to keep you signed in. We
        use reasonable safeguards, but no internet service can promise absolute
        security. EightGig is intended for adults who can enter contracts, not
        children under 18.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update this notice as EightGig changes. We will post the updated
        date here and give additional notice if a change materially affects how
        we use information. Questions belong in{" "}
        <Link href="/help">Help &amp; Support</Link>.
      </p>

      <div className="notice">
        EightGig is in beta. Features may change, but we will update this notice
        before using personal information in a materially different way.
      </div>
    </article>
  );
}
