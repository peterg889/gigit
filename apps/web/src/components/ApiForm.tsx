"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "datetime-local" | "textarea" | "select";
  options?: string[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number;
}

/**
 * Tiny JSON form: posts field values to an API route. Numeric fields are sent
 * as numbers; *_cents fields accept dollars in the UI and convert.
 */
export function ApiForm({
  endpoint,
  fields,
  submitLabel,
  redirectTo,
  transform,
  extra,
  method = "POST",
}: {
  endpoint: string;
  fields: Field[];
  submitLabel: string;
  redirectTo?: string;
  transform?: string; // name of a built-in transform; serializable for server components
  extra?: Record<string, unknown>; // constant fields merged into the payload
  method?: "POST" | "PATCH"; // PATCH for edit-in-place (partial update) forms
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { ...extra };
    for (const f of fields) {
      const raw = String(form.get(f.name) ?? "").trim();
      if (raw === "") continue;
      if (f.name.endsWith("Cents")) body[f.name] = Math.round(Number(raw) * 100);
      else if (f.type === "number") body[f.name] = Number(raw);
      else if (f.type === "datetime-local")
        body[f.name] = new Date(raw).toISOString();
      else body[f.name] = raw;
    }
    if (transform === "ratingsOverall" && typeof body.overall === "number") {
      body.ratings = { overall: body.overall };
      delete body.overall;
    }
    if (transform === "ratingsMulti") {
      const ratings: Record<string, number> = {};
      for (const k of [
        "overall",
        "draw",
        "professionalism",
        "quality",
        "hospitality",
        "accuracy",
        "payment",
      ]) {
        if (typeof body[k] === "number") {
          ratings[k] = body[k] as number;
          delete body[k];
        }
      }
      body.ratings = ratings;
    }
    if (transform === "genreTagsCsv" && typeof body.genreTags === "string") {
      body.genreTags = (body.genreTags as string)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    const res = await fetch(endpoint, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? "Something went wrong on our end — give it another try in a moment.");
      return;
    }
    if (redirectTo) router.push(redirectTo);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit}>
      {fields.map((f) => (
        <div key={f.name}>
          <label htmlFor={f.name}>{f.label}</label>
          {f.type === "textarea" ? (
            <textarea
              id={f.name}
              name={f.name}
              rows={3}
              placeholder={f.placeholder}
              defaultValue={f.defaultValue}
            />
          ) : f.type === "select" ? (
            <select id={f.name} name={f.name} required={f.required} defaultValue={f.defaultValue}>
              {f.options?.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input
              id={f.name}
              name={f.name}
              type={f.type === "datetime-local" ? "datetime-local" : f.type ?? "text"}
              required={f.required}
              placeholder={f.placeholder}
              defaultValue={f.defaultValue}
            />
          )}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      <button disabled={busy}>{busy ? "Working…" : submitLabel}</button>
    </form>
  );
}

/** POST then follow the returned {url} — Stripe-hosted flows (payouts, card setup). */
export function RedirectButton({
  endpoint,
  label,
}: {
  endpoint: string;
  label: string;
}) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span>
      <button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setNote(null);
          const res = await fetch(endpoint, { method: "POST" });
          const data = await res.json().catch(() => null);
          setBusy(false);
          if (!res.ok) {
            setNote(data?.error?.message ?? "Something went wrong on our end — try again in a moment.");
            return;
          }
          if (data?.url) window.location.href = data.url;
          else setNote("Payments aren't configured in this environment — nothing to set up.");
        }}
      >
        {busy ? "Working…" : label}
      </button>
      {note && <span className="muted"> {note}</span>}
    </span>
  );
}

/** One-click action button (apply, accept, cancel, remove). */
export function ActionButton({
  endpoint,
  label,
  body,
  method = "POST",
  confirm,
}: {
  endpoint: string;
  label: string;
  body?: Record<string, unknown>;
  method?: "POST" | "DELETE";
  confirm?: string; // when set, ask before firing (irreversible actions)
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span>
      <button
        disabled={busy}
        onClick={async () => {
          if (confirm && !window.confirm(confirm)) return;
          setBusy(true);
          const res = await fetch(endpoint, {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body ?? {}),
          });
          setBusy(false);
          if (!res.ok) {
            const data = await res.json().catch(() => null);
            setError(data?.error?.message ?? "Something went wrong on our end — try again in a moment.");
            return;
          }
          router.refresh();
        }}
      >
        {busy ? "…" : label}
      </button>
      {error && <span className="error"> {error}</span>}
    </span>
  );
}
