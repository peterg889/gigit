import { ApiForm } from "@/components/ApiForm";
import { SlotParseWidget } from "@/components/AiAssist";

export default function NewSlotPage() {
  return (
    <div>
    <SlotParseWidget />
    <div className="card">
      <h1>Post a slot</h1>
      <p className="muted">
        Budget is required and shown to performers — pay transparency is policy.
      </p>
      <ApiForm
        endpoint="/api/slots"
        submitLabel="Post slot"
        redirectTo="/"
        fields={[
          { name: "startsAt", label: "Date & start time", type: "datetime-local", required: true },
          { name: "durationMinutes", label: "Duration (minutes)", type: "number", required: true },
          { name: "format", label: "Format", type: "select", options: ["music", "comedy", "either"], required: true },
          { name: "budgetCents", label: "Budget (USD)", type: "number", required: true, placeholder: "500" },
          { name: "notes", label: "Notes for performers", type: "textarea" },
        ]}
      />
    </div>
    </div>
  );
}
