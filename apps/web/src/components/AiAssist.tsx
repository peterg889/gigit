"use client";

/**
 * AI-assist widgets (K9 invariant: AI drafts, the human reviews and submits).
 * Both degrade gracefully when GEMINI_API_KEY isn't configured.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
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
    confidenceNote: string;
  } | null>(null);
  const [homeMetro, setHomeMetro] = useState("");

  return (
    <div>
      <p className="muted">
        Or paste your YouTube / Bandcamp / website link and we’ll draft the
        profile for you to review:
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
          <p className="muted">Review the draft — nothing publishes until you submit.</p>
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
                await post("/api/performers", { ...draft, homeMetro });
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
      <h2>Describe it instead</h2>
      <p className="muted">
        e.g. “something chill for Sunday brunch, two hours, $200ish” — same
        thing you’ll be able to text us.
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
        {busy ? "Parsing…" : "Parse"}
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
            <strong>${(draft.budgetCents / 100).toFixed(0)}</strong>
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
            <p className="muted">Add a budget — it’s required (pay transparency).</p>
          )}
        </div>
      )}
    </div>
  );
}
