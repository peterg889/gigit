import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: "./src/test/global-setup.ts",
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? "postgres://gigit:gigit@localhost:5433/gigit",
      SESSION_SECRET: "test-session-secret-0123456789abcdef0123456789",
      NODE_ENV: "test",
      TZ: "UTC",
    },
    // db tests share one database; run serially
    fileParallelism: false,
  },
});
