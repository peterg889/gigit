import Link from "next/link";

export const metadata = { title: "Privacy Notice — Gigit" };

export default function PrivacyPage() {
  return (
    <article className="legal-copy">
      <span className="eyebrow">Launch draft · July 13, 2026</span>
      <h1>Privacy Notice</h1>
      <p className="lede">
        This notice explains what Gigit collects, why we use it, and the choices
        you have while we run the early-access service.
      </p>

      <h2>Information we collect</h2>
      <p>
        We collect the email address or phone number you use to sign in;
        performer, venue, or sound-tech profile details you choose to publish;
        slot, application, booking, message, review, support, and dispute
        records; uploaded media; and basic security and delivery logs.
      </p>
      <p>
        Venue addresses, and coordinates derived from them when available, are
        used to show where a gig happens and support local discovery.
        Confirmed-booking participants may see contact and logistics details
        that are not public.
      </p>

      <h2>How we use information</h2>
      <p>
        We use it to operate the marketplace, match people to local work,
        deliver sign-in codes and booking notices, prevent abuse, moderate
        content, answer support requests, resolve disputes, measure whether the
        marketplace works, and comply with law.
      </p>

      <h2>Who receives information</h2>
      <p>
        Public profile and open-slot information can be seen by anyone.
        Information you send in an application, booking, thread, or review is
        shared with the relevant participants as the product indicates.
      </p>
      <p>
        We use service providers for hosting, storage, email or text delivery,
        monitoring, and carefully scoped AI-assisted drafting, screening, and
        support. They process information for Gigit under their service terms.
        We do not sell personal information or use it for third-party targeted
        advertising.
      </p>

      <h2>Retention and account choices</h2>
      <p>
        You can edit profile information in Gigit and deactivate access from
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
        Gigit uses a secure, HTTP-only session cookie to keep you signed in. We
        use reasonable safeguards, but no internet service can promise absolute
        security. Gigit is intended for adults who can enter contracts, not
        children under 18.
      </p>

      <h2>Changes and contact</h2>
      <p>
        We may update this notice as the pilot changes. We will post the new
        date here and give additional notice if a change materially affects how
        we use information. Questions belong in{" "}
        <Link href="/help">Help &amp; Support</Link>.
      </p>

      <div className="notice">
        This is an early-access privacy notice, not a substitute for
        jurisdiction-specific legal review before a broad public launch.
      </div>
    </article>
  );
}
