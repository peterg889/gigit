import Link from "next/link";

/**
 * What a non-admin sees at an /admin/* URL.
 *
 * Every ops page paired this card with its own copy of the session + role
 * check. Pair it with adminUserId() and nothing else: requireUser() THROWS on
 * an anonymous visitor, and a server component that throws renders the error
 * boundary — so the ops links people paste to each other would greet a
 * signed-out teammate with a crash page instead of a way in.
 */
export function AdminOnly() {
  return (
    <div className="card">
      Admin only. <Link href="/login">Sign in</Link>
    </div>
  );
}
