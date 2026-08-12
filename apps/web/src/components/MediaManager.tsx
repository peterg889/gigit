"use client";

/**
 * Attach media to a profile by link (engineering-spec §8: media is link-only).
 * EightGig hosts no user files, so there is nothing to upload here — a photo, a
 * track and a video are all URLs on a host that already serves them.
 */
import {
  EMBED_PROVIDER_HOSTS,
  type EmbedProvider,
  type MediaKind,
  embedProviders,
  mediaKinds,
} from "@gigit/domain";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/** Each provider spelled the way it spells itself. */
const PROVIDER_LABEL: Record<EmbedProvider, string> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  flickr: "Flickr",
  imgur: "Imgur",
  soundcloud: "SoundCloud",
  bandcamp: "Bandcamp",
};

const KIND_LABEL: Record<MediaKind, string> = {
  photo: "Photos",
  audio: "Music",
  video: "Video",
};

/**
 * Derived from the same allow-list the server enforces, so a provider added to
 * @gigit/domain cannot quietly go unlisted here. This sentence is the only
 * place a user finds out *before* pasting that a Dropbox link will be refused
 * for being a Dropbox link — a bare "that link isn't from a site we support"
 * after the fact reads as a bug.
 */
export const ACCEPTED_SERVICES = mediaKinds.map((kind) => {
  const names = embedProviders
    .filter((p) => EMBED_PROVIDER_HOSTS[p].kind === kind)
    .map((p) => PROVIDER_LABEL[p]);
  return `${KIND_LABEL[kind]}: ${names.join(" or ")}`;
});

/** What we call the thing that just arrived, by the kind the server resolved. */
const ADDED: Record<MediaKind, string> = {
  photo: "Photo added",
  audio: "Track added",
  video: "Video added",
};

/**
 * POST the link and turn the response into one line for the user.
 *
 * `subjectType` is sent explicitly because the route defaults to `performer`:
 * without it a venue pasting a room photo would file it against their act
 * profile, or be told to "create an act profile first" while standing on their
 * venue.
 */
export async function submitMediaLink(
  subjectType: "performer" | "venue" | "tech",
  url: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await fetch("/api/media/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: url.trim(), subjectType }),
  });
  const data = (await res.json().catch(() => null)) as
    | { kind?: MediaKind; error?: { message?: string } }
    | null;
  if (!res.ok)
    return {
      ok: false,
      message:
        data?.error?.message ??
        "Couldn't add that — check the link and try again.",
    };
  return {
    ok: true,
    message: (data?.kind && ADDED[data.kind]) ?? "Link added",
  };
}

export function MediaManager({
  subjectType,
}: {
  subjectType: "performer" | "venue" | "tech";
}) {
  const router = useRouter();
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [url, setUrl] = useState("");

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
      <label htmlFor={`${uid}-link`}>
        Add a photo, a track, or a video — paste its link
      </label>
      <input
        id={`${uid}-link`}
        type="url"
        placeholder="https://soundcloud.com/your-band/your-track"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button
        disabled={busy || !url.trim()}
        onClick={async () => {
          setBusy(true);
          setMsg(null);
          const result = await submitMediaLink(subjectType, url).catch(() => ({
            ok: false,
            message: "Couldn't add that — check the link and try again.",
          }));
          setMsg(result.message);
          if (result.ok) {
            setUrl("");
            router.refresh();
          }
          setBusy(false);
        }}
      >
        Add link
      </button>
      <p className="muted">
        Your files stay where they already live — we only keep the link.{" "}
        {ACCEPTED_SERVICES.join(" · ")}. A link from anywhere else (Dropbox,
        Google Drive, your own site) won&rsquo;t attach.
      </p>
      {/* A live region, matching ApiForm: a link that fails is otherwise
          silent for a screen-reader user, who gets no signal at all that what
          they pasted did not take. */}
      <div aria-live="polite" role="status">
        {msg && <p className="muted">{msg}</p>}
      </div>
    </div>
  );
}
