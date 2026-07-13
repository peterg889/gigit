"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function DeactivateAccount() {
  const router = useRouter();
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmed = confirmation.trim().toUpperCase() === "DEACTIVATE";

  return (
    <div>
      <label htmlFor="deactivate-confirmation">Type DEACTIVATE to confirm</label>
      <input
        id="deactivate-confirmation"
        autoComplete="off"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      <button
        className="danger"
        disabled={!confirmed || busy}
        onClick={async () => {
          if (!confirmed) return;
          setBusy(true);
          setError(null);
          const res = await fetch("/api/account", { method: "DELETE" });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            setBusy(false);
            setError(data?.error?.message ?? "We couldn’t deactivate your account.");
            return;
          }
          router.push("/");
          router.refresh();
        }}
      >
        {busy ? "Deactivating…" : "Deactivate my account"}
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
