import { ApiForm } from "@/components/ApiForm";
import { SlotParseWidget } from "@/components/AiAssist";
import { venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import Link from "next/link";
import { venueLocationIsComplete } from "@/lib/date-time";

export default async function NewSlotPage() {
  const userId = await sessionUserId();
  const venue = userId ? await venueOwnedBy(userId) : null;
  if (!venue)
    return (
      <div className="card">
        <Link href="/me">Create a venue profile</Link> before posting a slot.
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
      <h1>Post a slot</h1>
      <p className="muted">
        The pay goes on the poster. Every slot shows its budget — that&apos;s
        policy, and it&apos;s why good acts apply.
      </p>
      <p className="muted">
        Times are entered in {venue.timeZone.replaceAll("_", " ")}.
      </p>
      <ApiForm
        endpoint="/api/slots"
        submitLabel="Post slot"
        redirectTo="/slots"
        dateTimeZone={venue.timeZone}
        fields={[
          { name: "startsAt", label: "Date & start time", type: "datetime-local", required: true },
          { name: "durationMinutes", label: "Duration (minutes)", type: "number", required: true },
          { name: "format", label: "Format", type: "select", options: ["music", "comedy", "either"], required: true },
          { name: "budgetCents", label: "Budget (USD)", type: "number", required: true, placeholder: "500" },
          { name: "notes", label: "About the night (vibe, load-in, parking)", type: "textarea" },
        ]}
      />
    </div>

    <div className="card">
      <h2>Make it a series</h2>
      <p className="muted">
        Weekly music night, first-Tuesday comedy — recurring slots are how a
        room becomes a scene. The next four nights post automatically and stay
        topped up; cancel anytime and booked nights still stand.
      </p>
      <ApiForm
        endpoint="/api/series"
        submitLabel="Start the series"
        redirectTo="/slots"
        dateTimeZone={venue.timeZone}
        fields={[
          { name: "startsAt", label: "First night — date & start time", type: "datetime-local", required: true },
          { name: "freq", label: "Repeats", type: "select", options: ["weekly", "monthly_dow"], required: true },
          { name: "durationMinutes", label: "Duration (minutes)", type: "number", required: true },
          { name: "format", label: "Format", type: "select", options: ["music", "comedy", "either"], required: true },
          { name: "budgetCents", label: "Budget per night (USD)", type: "number", required: true, placeholder: "400" },
          { name: "notes", label: "About the night", type: "textarea" },
        ]}
      />
      <p className="muted">
        “monthly_dow” = same weekday each month (e.g. first Tuesday).
      </p>
    </div>
    </div>
  );
}
