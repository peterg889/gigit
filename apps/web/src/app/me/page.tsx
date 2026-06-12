import Link from "next/link";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";
import { ApiForm } from "@/components/ApiForm";
import { ProfileIngestWidget } from "@/components/AiAssist";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const userId = await sessionUserId();
  if (!userId)
    return (
      <div className="card">
        <Link href="/login">Sign in</Link> to set up your profile.
      </div>
    );
  const [performer, venue, tech] = await Promise.all([
    performerOwnedBy(userId),
    venueOwnedBy(userId),
    techOwnedBy(userId),
  ]);

  return (
    <div>
      <h1>Your profiles</h1>
      <p className="muted">
        One account can hold multiple roles — a comedian who books rooms, a
        musician who runs sound.
      </p>

      <div className="card">
        <h2>Performer</h2>
        {performer ? (
          <p>
            <strong>{performer.name}</strong> <span className="badge">{performer.kind}</span>
            <br />
            <span className="muted">{performer.bio}</span>
          </p>
        ) : (
          <>
          <ProfileIngestWidget />
          <ApiForm
            endpoint="/api/performers"
            submitLabel="Create performer profile"
            transform="genreTagsCsv"
            fields={[
              { name: "name", label: "Act name", required: true },
              { name: "kind", label: "Type", type: "select", options: ["band", "solo", "comedian", "other"], required: true },
              { name: "homeMetro", label: "Home metro (e.g. milwaukee)", required: true },
              { name: "bio", label: "Bio", type: "textarea" },
              { name: "genreTags", label: "Genres (comma-separated)" },
            ]}
          />
          </>
        )}
      </div>

      <div className="card">
        <h2>Venue</h2>
        {venue ? (
          <p>
            <strong>{venue.name}</strong> <span className="badge">{venue.kind}</span>
            <br />
            <span className="muted">{venue.bio}</span>
          </p>
        ) : (
          <ApiForm
            endpoint="/api/venues"
            submitLabel="Create venue profile"
            fields={[
              { name: "name", label: "Venue name", required: true },
              { name: "kind", label: "Type", type: "select", options: ["bar", "restaurant", "coffee_shop", "brewery", "other"], required: true },
              { name: "metro", label: "Metro (e.g. milwaukee)", required: true },
              { name: "lat", label: "Latitude", type: "number", required: true },
              { name: "lng", label: "Longitude", type: "number", required: true },
              { name: "bio", label: "About the room", type: "textarea" },
            ]}
          />
        )}
      </div>

      <div className="card">
        <h2>Sound tech</h2>
        {tech ? (
          <p>
            <strong>{tech.name}</strong> <span className="badge">{tech.gear}</span>
            <br />
            <span className="muted">{tech.bio}</span>
          </p>
        ) : (
          <ApiForm
            endpoint="/api/techs"
            submitLabel="Create tech profile"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "gear", label: "Gear", type: "select", options: ["none", "partial", "full_rig"], required: true },
              { name: "bio", label: "Experience", type: "textarea" },
            ]}
          />
        )}
      </div>
    </div>
  );
}
