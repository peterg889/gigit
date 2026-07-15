"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ActionButton } from "./ApiForm";

function NoteForm({
  requestId,
  kind,
}: {
  requestId: string;
  kind: "note" | "resolve";
}) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolving = kind === "resolve";
  const fieldId = resolving ? "support-resolution-note" : "support-internal-note";

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (resolving && !window.confirm("Resolve this support request?")) return;
        setBusy(true);
        setError(null);
        const res = await fetch(
          `/api/admin/support/${requestId}/${resolving ? "resolve" : "notes"}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ note }),
          },
        );
        const data = await res.json().catch(() => null);
        setBusy(false);
        if (!res.ok) {
          setError(data?.error?.message ?? "That action did not go through.");
          return;
        }
        setNote("");
        router.refresh();
      }}
    >
      <label htmlFor={fieldId}>
        {resolving ? "Resolution note" : "Internal note"}
      </label>
      <textarea
        id={fieldId}
        rows={3}
        minLength={1}
        maxLength={2000}
        required
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder={
          resolving
            ? "What was done, what was communicated, and why this can close"
            : "Context for the next person working this request"
        }
      />
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>
        {busy ? "Working…" : resolving ? "Resolve request" : "Add internal note"}
      </button>
    </form>
  );
}

export function SupportCaseActions({
  requestId,
  status,
  claimedByUserId,
  currentAdminId,
}: {
  requestId: string;
  status: string;
  claimedByUserId: string | null;
  currentAdminId: string;
}) {
  if (status !== "open") return null;
  return (
    <>
      {!claimedByUserId && (
        <p>
          <ActionButton
            endpoint={`/api/admin/support/${requestId}/claim`}
            label="Claim request"
          />
        </p>
      )}
      <div className="card">
        <h2>Add context</h2>
        <NoteForm requestId={requestId} kind="note" />
      </div>
      {claimedByUserId === currentAdminId && (
        <div className="card">
          <h2>Close the loop</h2>
          <p className="muted">
            Resolve only after the requester has received the promised follow-up.
          </p>
          <NoteForm requestId={requestId} kind="resolve" />
        </div>
      )}
    </>
  );
}
