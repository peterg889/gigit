"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

import {
  GEAR_LABELS,
  GIG_FORMAT_LABEL,
} from "@/lib/labels";
import { venueLocalInputToIso } from "@/lib/date-time";
import { applyTransform, type TransformName } from "@/lib/form-transforms";

type SelectOption = string | { value: string; label: string };

export type EmptyValueBehavior =
  | "omit"
  | "empty-string"
  | "null"
  | "empty-array";

export interface Field {
  name: string;
  label: string;
  type?: "text" | "number" | "datetime-local" | "textarea" | "select";
  options?: SelectOption[];
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | number;
  /**
   * What an explicitly blank control means. Omission remains the default so
   * create forms retain their schema defaults; PATCH fields opt into clearing.
   */
  emptyValue?: EmptyValueBehavior;
}

// Only globally unambiguous values belong here. Domain-specific options pass
// `{ value, label }` objects: act kind and venue kind both use `other`, so a
// value-only map cannot label both correctly.
const OPTION_LABELS: Record<string, string> = {
  "": "Any",
  false: "No",
  true: "Yes",
  ...GEAR_LABELS,
  ...GIG_FORMAT_LABEL,
  other: "Other",
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
export function submissionIsConfirmed(
  message: string | undefined,
  confirmImpl: (message: string) => boolean,
): boolean {
  return !message || confirmImpl(message);
}

export function completeSuccessfulSubmission(
  form: { reset(): void },
  resetOnSuccess: boolean | undefined,
  successMessage: string | undefined,
): string | null {
  if (resetOnSuccess) form.reset();
  return successMessage ?? null;
}

export function serializeApiFormBody({
  fields,
  form,
  extra,
  dateTimeZone,
  transform,
}: {
  fields: Field[];
  form: Pick<FormData, "get">;
  extra?: Record<string, unknown>;
  dateTimeZone?: string;
  transform?: TransformName;
}): Record<string, unknown> {
  const body: Record<string, unknown> = { ...extra };
  for (const field of fields) {
    const raw = String(form.get(field.name) ?? "").trim();
    if (raw === "") {
      if (field.emptyValue === "empty-string") body[field.name] = "";
      else if (field.emptyValue === "null") body[field.name] = null;
      else if (field.emptyValue === "empty-array") body[field.name] = [];
      continue;
    }
    if (field.name.endsWith("Cents"))
      body[field.name] = Math.round(Number(raw) * 100);
    else if (field.type === "number") body[field.name] = Number(raw);
    else if (field.type === "datetime-local")
      body[field.name] = dateTimeZone
        ? venueLocalInputToIso(raw, dateTimeZone)
        : new Date(raw).toISOString();
    else body[field.name] = raw;
  }
  return applyTransform(body, transform);
}

type ApiResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

export async function runApiRequest({
  request,
  onBusy,
  onError,
  onSuccess,
}: {
  request: () => Promise<ApiResponse>;
  onBusy: (busy: boolean) => void;
  onError: (message: string | null) => void;
  onSuccess: (response: ApiResponse) => void | Promise<void>;
}): Promise<boolean> {
  onBusy(true);
  onError(null);
  try {
    const response = await request();
    if (!response.ok) {
      const data = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      onError(
        data?.error?.message ??
          "Something went wrong on our end — give it another try in a moment.",
      );
      return false;
    }
    await onSuccess(response);
    return true;
  } catch {
    onError("Could not reach EightGig. Check your connection and try again.");
    return false;
  } finally {
    onBusy(false);
  }
}
export function ApiForm({
  endpoint,
  fields,
  submitLabel,
  redirectTo,
  transform,
  extra,
  dateTimeZone,
  confirm,
  resetOnSuccess,
  successMessage,
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
  confirm?: string;
  resetOnSuccess?: boolean;
  successMessage?: string;
  method?: "POST" | "PATCH"; // PATCH for edit-in-place (partial update) forms
}) {
  const router = useRouter();
  const uid = useId();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (
      !submissionIsConfirmed(confirm, (message) => window.confirm(message))
    )
      return;
    const formElement = e.currentTarget;
    setError(null);
    setSuccess(null);
    const form = new FormData(formElement);
    let body: Record<string, unknown>;
    try {
      body = serializeApiFormBody({
        fields,
        form,
        extra,
        dateTimeZone,
        transform: transform as TransformName | undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Enter a valid date and time.");
      return;
    }
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
      setError("Pick an option before submitting.");
      return;
    }
    await runApiRequest({
      request: () =>
        fetch(url, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      onBusy: setBusy,
      onError: setError,
      onSuccess: () => {
        setSuccess(
          completeSuccessfulSubmission(formElement, resetOnSuccess, successMessage),
        );
        if (redirectTo) router.push(redirectTo);
        router.refresh();
      },
    });
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
              required={f.required}
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
        {success && <p className="notice success">{success}</p>}
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
          await runApiRequest({
            request: () => fetch(endpoint, { method: "POST" }),
            onBusy: setBusy,
            onError: setNote,
            onSuccess: async (response) => {
              const data = (await response.json().catch(() => null)) as {
                url?: string;
              } | null;
              if (data?.url) window.location.href = data.url;
              else setNote("Payment setup is unavailable right now. Please contact support.");
            },
          });
        }}
      >
        {busy ? "Working…" : label}
      </button>
      <span aria-live="polite" role="status">
        {note && <span className="muted"> {note}</span>}
      </span>
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
          await runApiRequest({
            request: () => fetch(endpoint, {
              method,
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body ?? {}),
            }),
            onBusy: setBusy,
            onError: setError,
            onSuccess: () => router.refresh(),
          });
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
