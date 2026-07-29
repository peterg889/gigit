import Link from "next/link";

import { COPYRIGHT_VERSION, effectiveLabel } from "@/lib/legal";

export const metadata = { title: "Copyright & DMCA — EightGig" };

/**
 * Notice-and-takedown procedure and repeat-infringer policy.
 *
 * Acts upload audio that publishes to a public profile with a player on it, and
 * embed video from third-party hosts — so EightGig hosts and links to material
 * it doesn't own. The §512 safe harbors need a published procedure and a
 * communicated repeat-infringer policy in place BEFORE an infringement, because
 * eligibility is judged as of that moment and can't be cured afterward.
 */
export default function DmcaPage() {
  return (
    <article className="legal-copy">
      <span className="eyebrow">
        Effective {effectiveLabel(COPYRIGHT_VERSION)}
      </span>
      <h1>Copyright &amp; DMCA</h1>
      <p className="lede">
        Acts post their own recordings and videos here. If something on EightGig
        uses your work without permission, this page is how to get it taken
        down — and how to push back if yours came down by mistake.
      </p>

      <h2>Post only what's yours to post</h2>
      <p>
        When you upload audio, photos, or video, or embed a video from another
        site, you're telling us you own that material or have permission to use
        it. That includes the recording itself: a live video of your set at a
        room with a house PA is usually yours, a studio master someone else paid
        for usually isn't. Covers are fine to post — venues handle performance
        licensing for the room — but a recording someone else made and owns is
        not yours to publish.
      </p>

      <h2>Reporting something that infringes your copyright</h2>
      <p>
        Send a notice through <Link href="/help">Help &amp; Support</Link>, with
        &ldquo;Copyright&rdquo; as the subject. To be effective under the law, it
        needs all of the following:
      </p>
      <ul>
        <li>The work you say was infringed — a title, a link, or a description.</li>
        <li>
          Where the material is on EightGig. A link to the profile or page, and
          enough detail to identify the specific file or embed.
        </li>
        <li>Your name, address, phone number, and email.</li>
        <li>
          A statement that you believe in good faith the use isn&rsquo;t
          authorized by you, your agent, or the law.
        </li>
        <li>
          A statement that the information in your notice is accurate, and that
          under penalty of perjury you&rsquo;re the owner or authorized to act
          for them.
        </li>
        <li>Your physical or electronic signature.</li>
      </ul>
      <p>
        Leave any of these out and we may not be able to act on it, so we&rsquo;ll
        come back and ask. Notices that are knowingly false can carry liability
        for damages and legal fees, so read the material before you send one.
      </p>

      <h2>What we do with a notice</h2>
      <p>
        We remove or disable the material and tell whoever posted it, passing
        along your notice. We keep a record of the notice and what we did.
      </p>

      <h2>If your material came down by mistake</h2>
      <p>
        Send a counter notice the same way, including: which material was removed
        and where it was, a statement under penalty of perjury that you believe
        in good faith it was removed by mistake or misidentification, your name,
        address, phone, and email, your consent to the jurisdiction of the
        federal court where you live (or Milwaukee County, Wisconsin, if
        you&rsquo;re outside the United States), and your signature.
      </p>
      <p>
        We pass it to whoever sent the original notice. If they don&rsquo;t file
        a court action within 10 to 14 business days, we may restore what came
        down.
      </p>

      <h2>Repeat infringement ends the account</h2>
      <p>
        If the same account is the subject of repeated valid notices, we
        terminate it — profiles, listings, and all. We count notices that
        weren&rsquo;t successfully countered, we weigh the circumstances, and we
        don&rsquo;t require a court ruling first. Deleting the file after a
        notice doesn&rsquo;t reset the count, and neither does opening a new
        account: evading a termination is its own grounds for removal.
      </p>

      <h2>Videos hosted somewhere else</h2>
      <p>
        Video on EightGig is embedded from YouTube or Vimeo, not stored here. We
        can remove the embed, and we will — but the video itself stays up on
        that host until you report it there too.
      </p>

      <div className="notice">
        These terms sit alongside the <Link href="/terms">Terms of Use</Link>{" "}
        and the <Link href="/privacy">Privacy Notice</Link>.
      </div>
    </article>
  );
}
