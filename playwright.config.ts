import { defineConfig } from "@playwright/test";

/**
 * E2E (engineering-spec §13): local runs build and supervise the production
 * web + worker artifacts. Setting E2E_BASE_URL targets an already-running
 * external environment instead.
 */
const externalBaseURL =
  process.env.E2E_BASE_URL?.trim().replace(/\/+$/, "") || undefined;
const localBaseURL = `http://127.0.0.1:${process.env.E2E_PORT ?? "3002"}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 1,
  use: {
    baseURL: externalBaseURL ?? localBaseURL,
    trace: "retain-on-failure",
  },
  webServer: externalBaseURL
    ? undefined
    : {
        command: "pnpm e2e:server",
        url: `${localBaseURL}/api/health`,
        reuseExistingServer: false,
        timeout: 240_000,
        stdout: "pipe",
        stderr: "pipe",
        gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
      },
});
