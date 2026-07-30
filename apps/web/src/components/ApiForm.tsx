"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import {
  ACT_KIND_LABEL,
  GEAR_LABELS,
  GIG_FORMAT_LABEL,
  VENUE_KIND_LABEL,
} from "@/lib/labels";
import { venueLocalInputToIso } from "@/lib/date-time";
import { applyTransform, type TransformName } from "@/lib/form-transforms";

type SelectOption = string | { value: string; label: string };

interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "datetime-local" | "textarea" | "select";
  options?: SelectOption[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number;
}

// Built FROM the canonical maps, not alongside them. These were restated here
// with different wording, so a venue picked "Music" in this dropdown and the
// feed card it produced was badged "Live music" — and `other` was "Other" here
// and "Other act" on the profile. labels.ts exists to prevent exactly that; its
// own docstring cites the last time this drifted.
const OPTION_LABELS: Record<string, string> = {
  "": "Any",
  false: "No",
  true: "Yes",
  ...ACT_KIND_LABEL,
  ...VENUE_KIND_LABEL,
  ...GEAR_LABELS,
  ...GIG_FORMAT_LABEL,
  weekly: "Weekly",
  monthly_dow: "Monthly — same week and weekday",
  no_show: "No-show",
  venue_unavailable: "Venue unavailable",
  misrepresentation: "Listing or profile was inaccurate",
  venue: "Venue",
  performer: "Act",
  neither: "Neither",
  refund_venue: "Refund venue",
  pay_performer: "Pay act",
  "America/New_York": "Eastern Time",
  "America/Chicago": "Central Time",
  "America/Denver": "Mountain Time",
  "America/Phoenix": "Arizona Time",
  "America/Los_Angeles": "Pacific Time",
  "America/Anchorage": "Alaska Time",
  "Pacific/Honolulu": "Hawaii Time",
};

function optionDetails(option: SelectOption): { value: string; label: string } {
  if (typeof option !== "string") return option;
  return {
    value: option,
    label:
      OPTION_LABELS[option] ??
      option
        .replaceAll("_", " ")
        .replace(/\b\w/g, (letter) => letter.toUpperCase()),
  };
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
  dateTimeZone,
  method = "POST",
}: {
  endpoint: string;
  fields: Field[];
  submitLabel: string;
  redirectTo?: string;
  transform?: string; // name of a built-in transform; serializable for server components
  extra?: Record<string, unknown>; // constant fields merged into the payload
  /** Interpret datetime-local fields in this venue timezone, not the browser timezone. */
  dateTimeZone?: string;
  method?: "POST" | "PATCH"; // PATCH for edit-in-place (partial update) forms
}) {
  const router = useRouter();
  const uid = useId();
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
      else if (f.type === "datetime-local") {
        try {
          body[f.name] = dateTimeZone
            ? venueLocalInputToIso(raw, dateTimeZone)
            : new Date(raw).toISOString();
        } catch (err) {
          setBusy(false);
          setError(err instanceof Error ? err.message : "Enter a valid date and time.");
          return;
        }
      }
      else body[f.name] = raw;
    }
    applyTransform(body, transform as TransformName | undefined);
    // `:name` placeholders in the endpoint are filled from the body and then
    // dropped from it — so a form can pick WHICH resource it posts to (invite
    // this act to *that* night) without a client component per row.
    let url = endpoint;
    for (const [key, value] of Object.entries(body)) {
      if (!url.includes(`:${key}`)) continue;
      url = url.replace(`:${key}`, encodeURIComponent(String(value)));
      delete body[key];
    }
    if (url.includes("/:")) {
      setBusy(false);
      setError("Pick an option before submitting.");
      return;
    }
    const res = await fetch(url, {
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
        // Ids must be unique per FORM, not per field name. Using the raw name
        // meant any page with two forms sharing a field emitted duplicate ids,
        // and <label for> resolves to the first match in the document — so on
        // /slots/new, tapping "Duration" under "Make it a series" focused the
        // single-date form's input. /me had id="name" three times, and the
        // directory pages rendered up to 100 elements with id="body".
        <div key={f.name}>
          <label htmlFor={`${uid}-${f.name}`}>{f.label}</label>
          {f.type === "textarea" ? (
            <textarea
              id={`${uid}-${f.name}`}
              name={f.name}
              rows={3}
              placeholder={f.placeholder}
              defaultValue={f.defaultValue}
            />
          ) : f.type === "select" ? (
            <select id={`${uid}-${f.name}`} name={f.name} required={f.required} defaultValue={f.defaultValue}>
              {f.options?.map((option) => {
                const { value, label } = optionDetails(option);
                return (
                  <option key={value} value={value}>
                    {label}
                  </option>
                );
              })}
            </select>
          ) : (
            <input
              id={`${uid}-${f.name}`}
              name={f.name}
              type={f.type === "datetime-local" ? "datetime-local" : f.type ?? "text"}
              required={f.required}
              placeholder={f.placeholder}
              defaultValue={f.defaultValue}
            />
          )}
        </div>
      ))}
      {/* Errors are the whole point of this component's feedback; without a
          live region a screen-reader user submits and hears nothing. */}
      <div aria-live="polite" role="status">
        {error && <p className="error">{error}</p>}
      </div>
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
          else setNote("Payment setup is unavailable right now. Please contact support.");
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
  variant,
}: {
  endpoint: string;
  label: string;
  body?: Record<string, unknown>;
  method?: "POST" | "DELETE";
  confirm?: string; // when set, ask before firing (irreversible actions)
  /** "quiet" for destructive/secondary actions so they don't read as the next step. */
  variant?: "quiet";
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <span>
      <button
        className={variant}
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
      <span aria-live="polite" role="status">
        {error && <span className="error"> {error}</span>}
      </span>
    </span>
  );
}
