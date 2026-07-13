"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { venueLocalInputToIso } from "@/lib/date-time";

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

const OPTION_LABELS: Record<string, string> = {
  "": "Any",
  false: "No",
  true: "Yes",
  band: "Band",
  solo: "Solo act",
  comedian: "Comedian",
  other: "Other",
  bar: "Bar",
  restaurant: "Restaurant",
  coffee_shop: "Coffee shop",
  brewery: "Brewery",
  none: "Labor only — no rig",
  partial: "Partial rig",
  full_rig: "Full PA rig",
  music: "Music",
  comedy: "Comedy",
  either: "Music or comedy",
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
    if (
      (transform === "genreTagsCsv" || transform === "performerProfile") &&
      typeof body.genreTags === "string"
    ) {
      body.genreTags = (body.genreTags as string)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (transform === "performerProfile") {
      if (typeof body.setLengthsMinutes === "string") {
        body.setLengthsMinutes = body.setLengthsMinutes
          .split(",")
          .map((s) => Number(s.trim()))
          .filter((n) => Number.isInteger(n) && n > 0);
      }
      const techNeeds: Record<string, number | boolean> = {};
      for (const key of ["inputs", "micsNeeded", "monitorsNeeded"] as const) {
        if (typeof body[key] === "number") techNeeds[key] = body[key] as number;
        delete body[key];
      }
      if (typeof body.canPlayUnamplified === "string") {
        techNeeds.canPlayUnamplified = body.canPlayUnamplified === "true";
        delete body.canPlayUnamplified;
      }
      if (Object.keys(techNeeds).length > 0) body.techNeeds = techNeeds;
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
