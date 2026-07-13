import Link from "next/link";
import { SupportForm } from "@/components/SupportForm";
import { sessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function HelpPage() {
  const userId = await sessionUserId();

  return (
    <div>
      <span className="eyebrow">Help desk</span>
      <h1>How can we help?</h1>
      <p className="lede">
        Booking a real room with real people can get complicated. Tell us what
        happened and we’ll help untangle it.
      </p>

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
          us the booking and a short factual account.
        </p>
        <p className="muted">
          If anyone is in immediate danger, contact local emergency services
          first. Gigit support is not an emergency service.
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
