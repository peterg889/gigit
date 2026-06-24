"use client";

/**
 * AI-assist widgets (K9 invariant: AI drafts, the human reviews and submits).
 * Both degrade gracefully when GEMINI_API_KEY isn't configured.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

async function post(url: string, body: unknown, method: "POST" | "PATCH" = "POST") {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `failed (${res.status})`);
  return data;
}

/** Paste a link → drafted performer profile → review/edit → create (F1.8). */
export function ProfileIngestWidget() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    name: string;
    kind: string;
    bio: string;
    genreTags: string[];
    mediaLinks?: string[];
    confidenceNote: string;
  } | null>(null);
  const [homeMetro, setHomeMetro] = useState("");

  return (
    <div>
      <p className="muted">
        Or paste your YouTube / Bandcamp / website link — we&apos;ll draft the
        profile, you approve every word. Nothing publishes until you say so.
      </p>
      <input
        placeholder="https://…"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button
        disabled={busy || !url}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await post("/api/ai/profile-ingest", { url });
            setDraft(r.draft);
          } catch (e) {
            setError(String(e instanceof Error ? e.message : e));
          }
          setBusy(false);
        }}
      >
        {busy ? "Drafting…" : "Draft my profile"}
      </button>
      {error && <p className="error">{error}</p>}
      {draft && (
        <div className="card">
          <p className="muted">
            Your draft. Fix anything we got wrong — it&apos;s your name on the
            poster.
          </p>
          <p className="muted">{draft.confidenceNote}</p>
          <label>Act name</label>
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
          <label>Type</label>
          <select
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value })}
          >
            {["band", "solo", "comedian", "other"].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <label>Bio</label>
          <textarea
            rows={3}
            value={draft.bio}
            onChange={(e) => setDraft({ ...draft, bio: e.target.value })}
          />
          <label>Genres (comma-separated)</label>
          <input
            value={draft.genreTags.join(", ")}
            onChange={(e) =>
              setDraft({
                ...draft,
                genreTags: e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
              })
            }
          />
          <label>Home metro</label>
          <input
            placeholder="e.g. milwaukee"
            value={homeMetro}
            onChange={(e) => setHomeMetro(e.target.value)}
          />
          <button
            disabled={busy || !homeMetro}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const { mediaLinks, ...profile } = draft;
                await post("/api/performers", { ...profile, homeMetro });
                // videos found on their page attach as embeds (best effort —
                // each one still goes through screening before it's public)
                for (const url of mediaLinks ?? []) {
                  await post("/api/media/embed", { url }).catch(() => null);
                }
                router.refresh();
              } catch (e) {
                setError(String(e instanceof Error ? e.message : e));
              }
              setBusy(false);
            }}
          >
            Create profile
          </button>
        </div>
      )}
    </div>
  );
}

/** Describe the night in plain English → confirm the parsed slot (F2.8). */
export function SlotParseWidget() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    startsAt: string;
    durationMinutes: number;
    format: string;
    budgetCents: number;
    notes: string;
    clarificationNeeded: string;
  } | null>(null);

  return (
    <div className="card">
      <h2>Or just say the night</h2>
      <p className="muted">
        “Something chill for Sunday brunch, two hours, $200ish” — the same thing
        you&apos;ll soon be able to text us.
      </p>
      <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} />
      <button
        disabled={busy || text.length < 5}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            const r = await post("/api/ai/slot-parse", { text });
            setDraft(r.draft);
          } catch (e) {
            setError(String(e instanceof Error ? e.message : e));
          }
          setBusy(false);
        }}
      >
        {busy ? "Reading…" : "Draft the slot"}
      </button>
      {error && <p className="error">{error}</p>}
      {draft && (
        <div className="card">
          {draft.clarificationNeeded && (
            <p className="error">Needs clarifying: {draft.clarificationNeeded}</p>
          )}
          <p>
            <span className="badge">{draft.format}</span>{" "}
            {new Date(draft.startsAt).toLocaleString("en-US", {
              dateStyle: "full",
              timeStyle: "short",
              timeZone: "UTC",
            })}{" "}
            · {draft.durationMinutes} min ·{" "}
            <span className="money">${(draft.budgetCents / 100).toFixed(0)}</span>
          </p>
          {draft.notes && <p className="muted">{draft.notes}</p>}
          <button
            disabled={busy || draft.budgetCents < 1 || !!draft.clarificationNeeded}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await post("/api/slots", {
                  startsAt: draft.startsAt,
                  durationMinutes: draft.durationMinutes,
                  format: draft.format,
                  budgetCents: draft.budgetCents,
                  notes: draft.notes || undefined,
                });
                router.push("/");
                router.refresh();
              } catch (e) {
                setError(String(e instanceof Error ? e.message : e));
              }
              setBusy(false);
            }}
          >
            Post this slot
          </button>
          {draft.budgetCents < 1 && (
            <p className="muted">
              Name the pay — every slot on Gigit shows its budget.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Photo-to-specs gear capture (F6.6 / F-AI.11) — the venue side. */
export function GearExtractWidget({ venueId }: { venueId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{
    hasPA: boolean;
    mixerChannels: number;
    micsAvailable: number;
    monitors: number;
    hasOperator: boolean;
    uncertainties: string;
  } | null>(null);

  return (
    <div>
      <p className="muted">
        Snap your PA / gear closet (or describe it) — we draft the room specs,
        you confirm. This is what tells acts and techs what they&apos;re
        walking into.
      </p>
      <textarea
        rows={2}
        placeholder="e.g. 12-channel Mackie, two mains, two wedges, 3 SM58s, nobody runs it"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
      />
      <button
        disabled={busy || (text.length < 5 && !file)}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            let imageBase64: string | undefined;
            let imageMimeType: string | undefined;
            if (file) {
              const buf = await file.arrayBuffer();
              imageBase64 = btoa(
                Array.from(new Uint8Array(buf), (b) => String.fromCharCode(b)).join(""),
              );
              imageMimeType = file.type;
            }
            const r = await post("/api/ai/gear-extract", {
              description: text,
              ...(imageBase64 ? { imageBase64, imageMimeType } : {}),
            });
            setDraft(r.draft);
          } catch (e) {
            setError(String(e instanceof Error ? e.message : e));
          }
          setBusy(false);
        }}
      >
        {busy ? "Reading…" : "Draft my room specs"}
      </button>
      {error && <p className="error">{error}</p>}
      {draft && (
        <div className="card">
          <p className="muted">
            Check the counts — the sound plan is only as good as these numbers.
          </p>
          <label>PA?</label>
          <select
            value={String(draft.hasPA)}
            onChange={(e) => setDraft({ ...draft, hasPA: e.target.value === "true" })}
          >
            <option value="true">yes</option>
            <option value="false">no</option>
          </select>
          {(["mixerChannels", "micsAvailable", "monitors"] as const).map((k) => (
            <div key={k}>
              <label>{k}</label>
              <input
                type="number"
                value={draft[k]}
                onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })}
              />
            </div>
          ))}
          <label>Someone runs sound?</label>
          <select
            value={String(draft.hasOperator)}
            onChange={(e) => setDraft({ ...draft, hasOperator: e.target.value === "true" })}
          >
            <option value="true">yes</option>
            <option value="false">no</option>
          </select>
          {draft.uncertainties && <p className="muted">Unsure about: {draft.uncertainties}</p>}
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await post(
                  `/api/venues/${venueId}`,
                  {
                    paInventory: {
                      hasPA: draft.hasPA,
                      mixerChannels: draft.mixerChannels,
                      micsAvailable: draft.micsAvailable,
                      monitors: draft.monitors,
                      hasOperator: draft.hasOperator,
                    },
                  },
                  "PATCH",
                );
                setDraft(null);
                router.refresh();
              } catch (e) {
                setError(String(e instanceof Error ? e.message : e));
              }
              setBusy(false);
            }}
          >
            Save room specs
          </button>
        </div>
      )}
    </div>
  );
}
