"use client";

/** Upload photos/audio (presign → PUT → complete) and add video embeds. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function MediaManager({
  subjectType,
}: {
  subjectType: "performer" | "venue" | "tech";
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [embedUrl, setEmbedUrl] = useState("");

  async function upload(file: File) {
    setBusy(true);
    setMsg(null);
    try {
      const presign = await fetch("/api/media/presign", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subjectType,
          contentType: file.type,
          bytes: file.size,
        }),
      });
      const target = await presign.json();
      if (!presign.ok) throw new Error(target?.error?.message ?? "Couldn't start the upload — try again.");
      const put = await fetch(target.uploadUrl, {
        method: "PUT",
        headers: target.headers ?? {},
        body: file,
      });
      if (!put.ok) throw new Error("The upload didn't go through — try again.");
      const done = await fetch(`/api/media/${target.id}/complete`, { method: "POST" });
      if (!done.ok) throw new Error("Couldn't finish the upload — try again.");
      setMsg(`Uploaded ${file.name}`);
      router.refresh();
    } catch (e) {
      setMsg(String(e instanceof Error ? e.message : e));
    }
    setBusy(false);
  }

  return (
    <div>
      {/* §512(i) conditions every safe harbor on users being told the rules
          before they post, and it's the honest ask anyway — most people posting
          a live recording have never thought about who owns it. */}
      <p className="muted">
        Post only what&rsquo;s yours or you have permission to use. Repeated
        copyright complaints end an account —{" "}
        <Link href="/dmca">how that works</Link>.
      </p>
      <label>Add photos or audio (JPG/PNG/WebP, MP3/M4A)</label>
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp,audio/mpeg,audio/mp4,audio/x-m4a"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      {subjectType === "performer" && (
        <>
          <label>Add a YouTube/Vimeo video</label>
          <input
            placeholder="https://youtube.com/watch?v=…"
            value={embedUrl}
            onChange={(e) => setEmbedUrl(e.target.value)}
          />
          <button
            disabled={busy || !embedUrl}
            onClick={async () => {
              setBusy(true);
              setMsg(null);
              const res = await fetch("/api/media/embed", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ url: embedUrl }),
              });
              const data = await res.json().catch(() => null);
              setMsg(res.ok ? "Video added" : (data?.error?.message ?? "Couldn't add that — check the link and try again."));
              if (res.ok) {
                setEmbedUrl("");
                router.refresh();
              }
              setBusy(false);
            }}
          >
            Add video
          </button>
        </>
      )}
      {msg && <p className="muted">{msg}</p>}
    </div>
  );
}
