import Link from "next/link";
import { db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import { SupportForm } from "@/components/SupportForm";
import { sessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HelpPage() {
  const sessionId = await sessionUserId();
  const [user] = sessionId
    ? await db()
        .select({ status: schema.users.status })
        .from(schema.users)
        .where(eq(schema.users.id, sessionId))
    : [];
  const userId = user?.status === "active" ? sessionId : null;

  return (
    <div>
      <span className="eyebrow">Help desk</span>
      <h1>How can we help?</h1>
      <p className="lede">
        Booking a real room with real people can get complicated. Tell us what
        happened and we’ll help untangle it.
      </p>

      <div className="card">
        <h2>Beta and Founding Memberships</h2>
        <p>
          EightGig is free during beta. The first 500 eligible act profiles and
          first 500 eligible venue profiles we confirm as onboarded receive a
          Founding Membership.
        </p>
        <p className="muted">
          Founding Membership has no recurring standard-membership fee for as
          long as EightGig operates. Gig pay, third-party costs, and optional
          services are separate. Pricing for later members has not been set;
          we’ll explain it before asking anyone to pay. We confirm eligibility
          after onboarding.
        </p>
      </div>

      <div className="card">
        <h2>Before the gig</h2>
        <p>
          Keep the date, local start time, pay, set length, sound plan, and
          anything the room provides in the booking. If a detail changes, agree
          in the booking thread so both sides have the same record.
        </p>
      </div>

      <div className="card">
        <h2>Cancellations and problems</h2>
        <p>
          Use the booking’s cancel or dispute controls when you can. If someone
          did not show, the venue was unavailable, or safety is involved, send
          us the booking link and a short factual account of what happened.
        </p>
        <p className="muted">
          If anyone is in immediate danger, contact local emergency services
          first. EightGig support is not an emergency service.
        </p>
      </div>

      <div className="card">
        <h2>Contact support</h2>
        {!userId && (
          <p className="muted">
            Have an account? <Link href={"/login?next=" + encodeURIComponent("/help")}>Sign in</Link>{" "}
            to connect this request to it, or leave a reply email below.
          </p>
        )}
        <SupportForm anonymous={!userId} />
      </div>
    </div>
  );
}
