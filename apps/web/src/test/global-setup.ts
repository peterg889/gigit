/**
 * Applies the @gigit/db migrations to the test database before the web suite
 * runs — the same guarantee packages/db gives itself in its own global-setup.
 *
 * Without this, `pnpm --filter @gigit/web test` only passed because someone had
 * already run the db suite (or `drizzle-kit migrate`) against the shared local
 * Postgres first. Against a fresh database every route test died at fixture
 * insert with `relation "users" does not exist`, so a clean checkout could not
 * run the web suite at all.
 */
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

export default async function setup() {
  // globalSetup runs in vitest's main process, before `test.env` is applied to
  // the workers — so resolve the URL the same way the config does rather than
  // relying on process.env alone.
  const url =
    process.env.DATABASE_URL ?? "postgres://gigit:gigit@localhost:5433/gigit";
  // Absolute: drizzle resolves migrationsFolder against process.cwd(), which is
  // apps/web here, not the package that owns the SQL.
  const migrationsFolder = fileURLToPath(
    new URL("../../../../packages/db/migrations", import.meta.url),
  );
  const db = drizzle(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.$client.end();
  }
}
