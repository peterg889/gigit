import { ApiForm } from "@/components/ApiForm";
import { SlotParseWidget } from "@/components/AiAssist";
import { venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import Link from "next/link";
import { friendlyTimeZoneName, venueLocationIsComplete } from "@/lib/date-time";

export default async function NewSlotPage() {
  const userId = await sessionUserId();
  const venue = userId ? await venueOwnedBy(userId) : null;
  if (!venue)
    return (
      <div className="card">
        <Link href="/onboarding?role=venue">Create a venue profile</Link> before
        posting an open date.
      </div>
    );
  if (!venueLocationIsComplete(venue))
    return (
      <div className="card">
        <h1>Finish your venue location</h1>
        <p>
          Add the street address and timezone on <Link href="/me">your venue profile</Link>{" "}
          before posting. They keep the listing, offer, and calendar invite aligned.
        </p>
      </div>
    );
  return (
    <div>
    <SlotParseWidget timeZone={venue.timeZone} />
    <div className="card">
      <h1>Post an open date</h1>
      <p className="muted">
        Add the pay up front so acts know what the gig offers before they
        apply.
      </p>
      <p className="muted">
        Times are entered in {friendlyTimeZoneName(venue.timeZone)}.
      </p>
      <ApiForm
        endpoint="/api/slots"
        submitLabel="Post open date"
        redirectTo="/slots"
        dateTimeZone={venue.timeZone}
        fields={[
          { name: "startsAt", label: "Date & start time", type: "datetime-local", required: true },
          { name: "durationMinutes", label: "Duration (minutes)", type: "number", required: true, placeholder: "120" },
          { name: "format", label: "Format", type: "select", options: ["music", "comedy", "either"], required: true },
          { name: "budgetCents", label: "Budget (USD)", type: "number", required: true, placeholder: "500" },
          { name: "notes", label: "About the night (vibe, load-in, parking)", type: "textarea" },
        ]}
      />
    </div>

    <div className="card">
      <details>
        <summary style={{ cursor: "pointer" }}>
          <strong>Make it a series</strong>{" "}
          <span className="muted">— weekly music night, first-Tuesday comedy</span>
        </summary>
        <p className="muted">
          Recurring nights help a room become a scene. We&apos;ll keep the next
          four dates posted. You can end the series anytime; existing bookings
          stay confirmed.
        </p>
      <ApiForm
        endpoint="/api/series"
        submitLabel="Start the series"
        redirectTo="/slots"
        dateTimeZone={venue.timeZone}
        fields={[
          { name: "startsAt", label: "First night — date & start time", type: "datetime-local", required: true },
          { name: "freq", label: "Repeats", type: "select", options: ["weekly", "monthly_dow"], required: true },
          { name: "durationMinutes", label: "Duration (minutes)", type: "number", required: true, placeholder: "120" },
          { name: "format", label: "Format", type: "select", options: ["music", "comedy", "either"], required: true },
          { name: "budgetCents", label: "Budget per night (USD)", type: "number", required: true, placeholder: "400" },
          { name: "notes", label: "About the night", type: "textarea" },
        ]}
      />
      </details>
    </div>
    </div>
  );
}
