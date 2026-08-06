#!/usr/bin/env node
/**
 * Grant the first admin.
 *
 * Production has no admin at all, which means: the support queue is unreadable
 * (the escalation email is only a link behind an admin gate), /admin is
 * unreachable, and nobody can suspend anyone. That last one matters — suspension
 * is the only moderation lever the product has, and migration 0031 just made it
 * survive self-deletion.
 *
 * Idempotent: re-running reports what already exists and changes nothing.
 *
 * Usage (from a host with DATABASE_URL, e.g. the prod EC2 box):
 *
 *   docker run --rm --env-file /etc/gigit.env \
 *     -v "$PWD/scripts/seed-admin.cjs:/app/packages/db/seed-admin.cjs" \
 *     -w /app/packages/db \
 *     <account>.dkr.ecr.<region>.amazonaws.com/gigit-worker-prod:<sha> \
 *     node seed-admin.cjs admin@example.com
 *
 * The email is stored LOWERCASE, which is now what sign-in itself does:
 * `signInEmailSchema` folds case on both the request and verify sides, and
 * migration 0032 backfilled existing rows behind a unique index on
 * `lower(email)`. Folding here keeps this script agreeing with that index —
 * before 0032 it also stopped a mixed-case sign-in from missing this row and
 * minting a second, non-admin account.
 */
const { Pool } = require("pg");
const { newId } = require("@gigit/domain");

const email = (process.argv[2] || "").trim().toLocaleLowerCase("en-US");
if (!email || !email.includes("@")) {
  console.error("usage: node seed-admin.cjs <email>");
  process.exit(2);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

(async () => {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const found = await client.query(
      "select id, status from users where email = $1",
      [email],
    );
    let userId = found.rows[0]?.id;
    if (!userId) {
      userId = newId("user");
      await client.query("insert into users (id, email) values ($1, $2)", [
        userId,
        email,
      ]);
      console.log(`created user ${userId} <${email}>`);
    } else {
      console.log(
        `user already exists: ${userId} <${email}> status=${found.rows[0].status}`,
      );
    }

    const existing = await client.query(
      "select id from actor_roles where user_id = $1 and kind = 'admin'",
      [userId],
    );
    if (existing.rows.length > 0) {
      console.log(`already an admin (role ${existing.rows[0].id}) — no change`);
    } else {
      const roleId = newId("role");
      await client.query(
        "insert into actor_roles (id, user_id, kind) values ($1, $2, 'admin')",
        [roleId, userId],
      );
      // Granting moderation power is exactly what the audit log is for.
      await client.query(
        `insert into events (actor, kind, subject_type, subject_id, payload)
         values ($1, 'user.role_granted', 'user', $2, $3::jsonb)`,
        [userId, userId, JSON.stringify({ kind: "admin", grantedBy: "bootstrap", email })],
      );
      console.log(`granted admin (role ${roleId})`);
    }

    await client.query("commit");

    const check = await client.query(
      `select u.id, u.email, u.status, coalesce(ar.kind, '(none)') as role
         from users u
         left join actor_roles ar on ar.user_id = u.id
        where u.email = $1`,
      [email],
    );
    console.log("final state:", JSON.stringify(check.rows));
  } catch (err) {
    await client.query("rollback");
    console.error("failed, rolled back:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
