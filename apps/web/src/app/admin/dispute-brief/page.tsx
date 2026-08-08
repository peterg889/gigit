import { AiNotConfiguredError, disputeBrief } from "@gigit/db";
import Link from "next/link";
import { adminUserId } from "@/lib/auth";
import { AdminOnly } from "../AdminOnly";

export const dynamic = "force-dynamic";

/**
 * Dispute brief (F7.4/F-AI.13): the AI assembles the evidence and DRAFTS an
 * adjudication; the human resolves it on the booking via the dispute form.
 */
export default async function DisputeBriefPage({
  searchParams,
}: {
  searchParams: Promise<{ bookingId?: string }>;
}) {
  const userId = await adminUserId();
  if (!userId) return <AdminOnly />;
  const { bookingId } = await searchParams;
  if (!bookingId)
    return <div className="card">Pass ?bookingId=bkg_… to generate a brief.</div>;

  let brief;
  try {
    brief = await disputeBrief(bookingId, userId);
  } catch (e) {
    if (e instanceof AiNotConfiguredError)
      return (
        <div className="card">
          No AI configured in this environment — read the raw event log via ops
          search instead.
        </div>
      );
    throw e;
  }

  return (
    <div>
      <h1>Dispute brief</h1>
      <p className="muted">
        Assembled from the booking record. The adjudication below is a{" "}
        <strong>draft</strong> — you decide, on the{" "}
        <Link href={`/bookings/${bookingId}`}>booking page</Link>.
      </p>
      <div className="card">
        <h2>What happened</h2>
        <p>{brief.summary}</p>
        {brief.timeline.map((t, i) => (
          <p className="muted" key={i}>
            {t}
          </p>
        ))}
      </div>
      <div className="card">
        <h2>Draft adjudication</h2>
        <span className="badge">confidence {brief.confidence}</span>
        <p>{brief.draftAdjudication}</p>
      </div>
    </div>
  );
}
