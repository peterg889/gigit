import { defineConfig } from "vitest/config";

/**
 * Worker tests run against the same Postgres as the db package, which (running
 * first in topological order) applies the migrations. We only supply the env.
 */
export default defineConfig({
  test: {
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://gigit:gigit@localhost:5433/gigit",
      SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
      NODE_ENV: "test",
    },
    fileParallelism: false,
  },
});
