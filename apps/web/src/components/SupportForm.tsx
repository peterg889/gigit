"use client";

import { useState } from "react";

export function SupportForm({ anonymous = false }: { anonymous?: boolean }) {
  const [message, setMessage] = useState("");
  const [email, setEmail] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [escalated, setEscalated] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setReply(null);
        setEscalated(false);
        setRequestId(null);
        setError(null);
        try {
          const res = await fetch("/api/support", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message, ...(anonymous ? { email } : {}) }),
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            setError(data?.error?.message ?? "We couldn’t send that. Please try again.");
            return;
          }
          setReply(data?.reply ?? "Thanks — we received your message.");
          setEscalated(Boolean(data?.escalated));
          setRequestId(typeof data?.requestId === "string" ? data.requestId : null);
          setMessage("");
        } catch {
          setError("We couldn’t reach EightGig support. Check your connection and try again.");
        } finally {
          setBusy(false);
        }
      }}
    >
      {anonymous && (
        <div>
          <label htmlFor="support-email">Email for our reply</label>
          <input
            id="support-email"
            type="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
      )}
      <label htmlFor="support-message">What can we help with?</label>
      <textarea
        id="support-message"
        rows={6}
        minLength={5}
        maxLength={2000}
        required
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder="Tell us what you were trying to do and what happened. Include the gig date or venue name if it helps."
      />
      <button disabled={busy}>{busy ? "Sending…" : "Send to EightGig support"}</button>
      <div aria-live="polite">
        {reply && (
          <div className="notice success" role="status">
            <strong>{escalated ? "A person will take a look." : "Here’s what we found."}</strong>
            <p>{reply}</p>
            {requestId && <p className="muted">Reference: {requestId}</p>}
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}
