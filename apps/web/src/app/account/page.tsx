import { db, schema } from "@gigit/db";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { DeactivateAccount } from "@/components/DeactivateAccount";
import { sessionUserId } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const userId = await sessionUserId();
  if (!userId) {
    return (
      <div className="card">
        <h1>Your account</h1>
        <p>
          <Link href={"/login?next=" + encodeURIComponent("/account")}>Sign in</Link>{" "}
          to manage your account.
        </p>
      </div>
    );
  }

  const [user] = await db()
    .select({
      email: schema.users.email,
      phone: schema.users.phone,
      status: schema.users.status,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId));

  return (
    <div>
      <span className="eyebrow">Account</span>
      <h1>Your account</h1>
      <div className="card">
        <h2>Sign-in details</h2>
        <p>{user?.email ?? user?.phone ?? "No sign-in address on file"}</p>
        <p className="muted">
          Member since {user?.createdAt.toLocaleDateString("en-US", { dateStyle: "medium" })}.
          To change your sign-in address, <Link href="/help">contact support</Link>.
        </p>
        <form action="/api/auth/logout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </div>

      <div className="card">
        <h2>Your data</h2>
        <p>
          Read our <Link href="/privacy">Privacy Notice</Link> to see what we
          collect and why. You can ask support for a copy or correction.
        </p>
      </div>

      <div className="card danger-zone">
        <h2>Deactivate account</h2>
        <p>
          This immediately signs you out and removes your email or phone from
          the account. You will lose access to your profiles.
        </p>
        <p className="muted">
          Booking, review, dispute, and audit records are retained where needed
          to preserve the history shared with other participants. Contact
          support if you also need a data-erasure review.
        </p>
        <DeactivateAccount />
      </div>
    </div>
  );
}
