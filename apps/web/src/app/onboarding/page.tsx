import Link from "next/link";
import { ApiForm } from "@/components/ApiForm";
import { performerOwnedBy, techOwnedBy, venueOwnedBy } from "@/lib/auth";
import { sessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

type Role = "venue" | "performer" | "tech";

const roleCopy: Record<Role, { label: string; headline: string; detail: string }> = {
  venue: {
    label: "I book a room",
    headline: "Fill your next open night",
    detail: "Post the date, pay, and room details. Compare local applicants and make one clear offer.",
  },
  performer: {
    label: "I perform",
    headline: "Put your act in the running",
    detail: "Build one useful profile, find paid local slots, and apply without writing the same pitch again.",
  },
  tech: {
    label: "I run sound",
    headline: "Join the local sound roster",
    detail: "Show venues what you carry, what you charge, and where you travel.",
  },
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: Promise<{ role?: string; source?: string; campaign?: string }>;
}) {
  const query = await searchParams;
  const requested = query.role;
  const role: Role | null =
    requested === "venue" || requested === "performer" || requested === "tech"
      ? requested
      : null;
  const userId = await sessionUserId();

  if (!userId) {
    const destination = role ? "/onboarding?role=" + role : "/onboarding";
    const loginParams = new URLSearchParams({ next: destination });
    if (query.source) loginParams.set("source", query.source.slice(0, 80));
    if (query.campaign) loginParams.set("campaign", query.campaign.slice(0, 120));

    return (
      <div>
        <span className="eyebrow">Get started</span>
        <h1>{role ? roleCopy[role].headline : "Find your place in the local scene"}</h1>
        <p className="lede">
          {role
            ? roleCopy[role].detail
            : "Tell us what you do. One account can add another role later."}
        </p>
        <div className="card">
          <h2>First, sign in</h2>
          <p>
            Gigit uses a six-digit email code—no password to remember. Creating
            a profile and applying are free.
          </p>
          <Link className="btn" href={"/login?" + loginParams.toString()}>
            Sign in to continue
          </Link>
        </div>
        <p>
          <Link href="/slots">Browse open slots first</Link>
        </p>
      </div>
    );
  }

  const [performer, venue, tech] = await Promise.all([
    performerOwnedBy(userId),
    venueOwnedBy(userId),
    techOwnedBy(userId),
  ]);

  if (!role) {
    return (
      <div>
        <span className="eyebrow">Get started</span>
        <h1>What brings you to Gigit?</h1>
        <p className="lede">
          Choose the job you want to do first. You can add another role from
          your profile whenever you need it.
        </p>
        <div className="role-grid">
          {(Object.keys(roleCopy) as Role[]).map((item) => (
            <div className="card role-card" key={item}>
              <span className="badge">{item}</span>
              <h2>{roleCopy[item].label}</h2>
              <p>{roleCopy[item].detail}</p>
              <Link className="btn" href={"/onboarding?role=" + item}>
                Continue
              </Link>
            </div>
          ))}
        </div>
        {(performer || venue || tech) && (
          <p className="muted">
            Already set up? Go to your <Link href="/me">profiles</Link> or{" "}
            <Link href="/bookings">bookings</Link>.
          </p>
        )}
      </div>
    );
  }

  const existing = role === "venue" ? venue : role === "performer" ? performer : tech;
  if (existing) {
    const nextHref = role === "venue" ? "/slots/new" : role === "performer" ? "/slots" : "/bookings";
    return (
      <div>
        <span className="eyebrow">You’re set up</span>
        <h1>{roleCopy[role].headline}</h1>
        <div className="card">
          <h2>{existing.name}</h2>
          <p>Your {role} profile is ready.</p>
          <Link className="btn" href={nextHref}>
            {role === "venue" ? "Post an open night" : role === "performer" ? "Find a gig" : "View sound work"}
          </Link>{" "}
          <Link href="/me">Edit profile</Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <span className="eyebrow">Step 1 of 1 · {role}</span>
      <h1>{roleCopy[role].headline}</h1>
      <p className="lede">{roleCopy[role].detail}</p>
      <p>
        Picked the wrong path? <Link href="/onboarding">Choose another role</Link>.
      </p>

      <div className="card">
        {role === "performer" && (
          <>
            <h2>Your performer profile</h2>
            <ApiForm
              endpoint="/api/performers"
              submitLabel="Create profile and find slots"
              redirectTo="/slots"
              transform="performerProfile"
              fields={[
                { name: "name", label: "Act name", required: true },
                { name: "kind", label: "Type", type: "select", options: ["band", "solo", "comedian", "other"], required: true },
                { name: "homeMetro", label: "Home metro", required: true, placeholder: "milwaukee" },
                { name: "bio", label: "What should a booker know?", type: "textarea" },
                { name: "genreTags", label: "Genres (comma-separated)" },
                { name: "rateMinCents", label: "Typical rate from ($)", type: "number" },
                { name: "rateMaxCents", label: "Typical rate to ($)", type: "number" },
                { name: "travelRadiusKm", label: "Travel radius (km)", type: "number", defaultValue: 50 },
                { name: "setLengthsMinutes", label: "Set lengths in minutes", placeholder: "45, 60, 120" },
                { name: "inputs", label: "Audio inputs needed", type: "number", defaultValue: 0 },
                { name: "micsNeeded", label: "Microphones needed", type: "number", defaultValue: 0 },
                { name: "monitorsNeeded", label: "Stage monitors needed", type: "number", defaultValue: 0 },
                { name: "canPlayUnamplified", label: "Can you play unamplified?", type: "select", options: ["false", "true"], defaultValue: "false" },
              ]}
            />
          </>
        )}

        {role === "venue" && (
          <>
            <h2>Your venue</h2>
            <p className="muted">
              The full address is shared where the gig happens; accurate
              timezone details keep every offer and calendar entry aligned.
            </p>
            <ApiForm
              endpoint="/api/venues"
              submitLabel="Create venue and post a slot"
              redirectTo="/slots/new"
              fields={[
                { name: "name", label: "Venue name", required: true },
                { name: "kind", label: "Type", type: "select", options: ["bar", "restaurant", "coffee_shop", "brewery", "other"], required: true },
                { name: "addressLine1", label: "Street address", required: true, placeholder: "1872 N Commerce St" },
                { name: "addressLine2", label: "Suite / unit (optional)" },
                { name: "city", label: "City", required: true, placeholder: "Milwaukee" },
                { name: "region", label: "State", required: true, placeholder: "WI" },
                { name: "postalCode", label: "ZIP code", required: true, placeholder: "53212" },
                { name: "metro", label: "Metro area", required: true, placeholder: "milwaukee" },
                {
                  name: "timeZone",
                  label: "Timezone",
                  type: "select",
                  options: [
                    "America/New_York",
                    "America/Chicago",
                    "America/Denver",
                    "America/Phoenix",
                    "America/Los_Angeles",
                    "America/Anchorage",
                    "Pacific/Honolulu",
                  ],
                  required: true,
                  defaultValue: "America/Chicago",
                },
                { name: "bio", label: "About the room", type: "textarea" },
                { name: "capacity", label: "Capacity", type: "number" },
              ]}
            />
          </>
        )}

        {role === "tech" && (
          <>
            <h2>Your sound profile</h2>
            <ApiForm
              endpoint="/api/techs"
              submitLabel="Create sound profile"
              redirectTo="/bookings"
              fields={[
                { name: "name", label: "Name or business name", required: true },
                { name: "gear", label: "Gear", type: "select", options: ["none", "partial", "full_rig"], required: true },
                { name: "bio", label: "Experience and typical rooms", type: "textarea" },
                { name: "rateLaborCents", label: "Labor rate ($)", type: "number" },
                { name: "rateWithRigCents", label: "Rate with rig ($)", type: "number" },
                { name: "travelRadiusKm", label: "Travel radius (km)", type: "number", defaultValue: 50 },
              ]}
            />
          </>
        )}
      </div>
    </div>
  );
}
