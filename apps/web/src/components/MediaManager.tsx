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

/** What we call ONE attached thing, by the kind the server resolved. */
const ITEM_LABEL: Record<MediaKind, string> = {
  photo: "Photo",
  audio: "Track",
  video: "Video",
};

/** One row of what is already attached, as the server page loads it. */
export type MediaItem = {
  id: string;
  kind: MediaKind;
  /** The provider's oEmbed title, or null when the fetch gave us none. */
  title: string | null;
  embedUrl: string;
  status: "held" | "ready" | "blocked";
};

/**
 * Why a link is not on the public page yet.
 *
 * Nothing told the owner this before: a held link simply never appeared, and the
 * profile prompt kept asking for media they had already added (docs/journeys.md
 * — "a held link is invisible to its owner"). `ready` says nothing because the
 * absence of a caveat is the message.
 */
const STATUS_NOTE: Record<MediaItem["status"], string | null> = {
  ready: null,
  held: "being checked — not on your page yet",
  blocked: "not shown — our review turned this one down",
};

/**
 * DELETE one attached link.
 *
 * Split out from the component for the same reason submitMediaLink is: this is
 * the half that has to agree with the route, and it is the half a render test
 * cannot reach.
 */
export async function removeMediaLink(
  id: string,
): Promise<{ ok: boolean; message: string }> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  const data = (await res.json().catch(() => null)) as
    | { error?: { message?: string } }
    | null;
  if (!res.ok)
    return {
      ok: false,
      message: data?.error?.message ?? "Couldn't remove that — try again.",
    };
  return { ok: true, message: "Removed" };
}

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
    message: (data?.kind && `${ITEM_LABEL[data.kind]} added`) ?? "Link added",
  };
}

export function MediaManager({
  subjectType,
  items,
}: {
  subjectType: "performer" | "venue" | "tech";
  /**
   * Required, not defaulted to []. A default would render "nothing attached
   * yet" on a page that simply forgot to load the list — which is the one
   * message that must never be wrong, since it invites the owner to add a
   * duplicate of something they already have.
   */
  items: MediaItem[];
}) {
  const router = useRouter();
  const uid = useId();
  const [busy, setBusy] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  return (
    <div>
      {/* What is already attached. This list is the precondition for everything
          else on this card: the quota refusal says "Remove one to add another",
          and until there was a list the owner could not see the one to remove —
          or even that the link they pasted yesterday landed at all. */}
      {items.length === 0 ? (
        <p className="muted">Nothing attached yet.</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <span className="badge">{ITEM_LABEL[item.kind]}</span>{" "}
              {/* The link itself when the provider gave us no title — two
                  untitled videos are otherwise the same row twice, and the
                  owner has to know which one they are removing. */}
              <a href={item.embedUrl} target="_blank" rel="noreferrer">
                {item.title ?? item.embedUrl}
              </a>{" "}
              {STATUS_NOTE[item.status] && (
                <span className="muted">{STATUS_NOTE[item.status]}</span>
              )}{" "}
              <button
                disabled={busy || removingId !== null}
                onClick={async () => {
                  setRemovingId(item.id);
                  setMsg(null);
                  const result = await removeMediaLink(item.id).catch(() => ({
                    ok: false,
                    message: "Couldn't remove that — try again.",
                  }));
                  setMsg(result.message);
                  // Refresh either way: a failure is most often the row already
                  // being gone, and re-rendering a stale list would leave a
                  // Remove button pointing at nothing.
                  router.refresh();
                  setRemovingId(null);
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
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
