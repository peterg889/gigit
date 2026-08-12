import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Migrate before anything connects. The web suite owns no schema of its own
    // but every route test inserts fixtures, so a fresh database must be built
    // here rather than assumed to have been built by the db package's run.
    globalSetup: "./src/test/global-setup.ts",
    setupFiles: ["./src/test/setup.ts"],
    // Web route tests hit the SAME Postgres as the db package's, and several
    // assert exact row counts. Without this, ~30 files ran in parallel against
    // one database, each opening a max:10 pool — which made
    // `--workspace-concurrency=1` in the root script load-bearing rather than
    // belt-and-braces, and made `pnpm --filter @gigit/web test` unusable alone.
    fileParallelism: false,
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://gigit:gigit@localhost:5433/gigit",
      SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
      NODE_ENV: "test",
      // Pinned so a formatted-date assertion can't pass on one machine and fail
      // on another. Every gig-facing date carries an explicit venue timezone,
      // but the ops/relative helpers fall back to the process zone.
      TZ: "UTC",
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
});
