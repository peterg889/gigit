"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [stage, setStage] = useState<"request" | "verify">("request");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);

  async function call(path: string, body: unknown) {
    setError(null);
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(
        data?.error?.message ??
          "We couldn’t complete that request. Please try again.",
      );
      return false;
    }
    return true;
  }

  return (
    <div className="card">
      <h1>Sign in or join Gigit</h1>
      <p className="muted">
        Enter your email and we’ll send a six-digit sign-in code. No password
        needed.
      </p>
      {stage === "request" ? (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (await call("/api/auth/request", { email })) setStage("verify");
          }}
        >
          <label htmlFor="email">Email</label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <label className="check-row">
            <input
              type="checkbox"
              checked={termsAccepted}
              onChange={(event) => setTermsAccepted(event.target.checked)}
              required
            />
            <span>
              I agree to the <Link href="/terms">Terms</Link> and acknowledge the{" "}
              <Link href="/privacy">Privacy Notice</Link>.
            </span>
          </label>
          <button>Send code</button>
          <p className="muted">Gigit is free during beta. No card needed.</p>
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const query = new URLSearchParams(window.location.search);
            const source = query.get("source") || undefined;
            const campaign = query.get("campaign") || undefined;
            if (await call("/api/auth/verify", {
              email,
              code,
              termsAccepted: true,
              source,
              campaign,
            })) {
              const requested = query.get("next");
              const next = requested?.startsWith("/") && !requested.startsWith("//")
                ? requested
                : "/onboarding";
              router.push(next);
              router.refresh();
            }
          }}
        >
          <label htmlFor="code">Enter the code we sent to {email}</label>
          <input
            id="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            pattern="[0-9]{6}"
            required
          />
          <div className="button-row">
            <button>Verify code</button>
            <button
              className="btn secondary"
              type="button"
              onClick={() => {
                setStage("request");
                setCode("");
                setError(null);
              }}
            >
              Use a different email
            </button>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
