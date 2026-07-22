import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertBuildArtifacts,
  assertRuntimeEnvironment,
  stopChild,
  waitForHealth,
  waitForOutput,
} from "./e2e-server.mjs";

test("assertRuntimeEnvironment validates all required local inputs", () => {
  const valid = {
    DATABASE_URL: "postgres://gigit:gigit@127.0.0.1:5433/gigit",
    SESSION_SECRET: "a".repeat(32),
    E2E_PORT: "3002",
  };

  assert.doesNotThrow(() => assertRuntimeEnvironment(valid));
  assert.throws(
    () =>
      assertRuntimeEnvironment({
        DATABASE_URL: "not a URL",
        SESSION_SECRET: "short",
        E2E_PORT: "70000",
      }),
    /DATABASE_URL.*SESSION_SECRET.*E2E_PORT/,
  );
});

test("waitForHealth retries until the database-aware health response is ready", async () => {
  let calls = 0;
  await waitForHealth("http://example.test/api/health", {
    timeoutMs: 250,
    intervalMs: 1,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: calls > 1,
        status: calls > 1 ? 200 : 503,
        json: async () => ({ status: calls > 1 ? "ok" : "unavailable" }),
      };
    },
  });

  assert.equal(calls, 2);
});

test("waitForOutput reports a child that exits before readiness", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "setTimeout(() => process.exit(17), 10)"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  await assert.rejects(
    waitForOutput(child, "READY", { label: "fixture", timeoutMs: 1_000 }),
    /fixture exited before readiness \(code 17/,
  );
});

test("waitForOutput observes readiness and stopChild tears down the process", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "console.log('READY'); setInterval(() => {}, 1_000)"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForOutput(child, "READY", { label: "fixture", timeoutMs: 1_000 });
    await stopChild(child, { graceMs: 1_000 });

    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    await stopChild(child, { graceMs: 100 });
  }
});

test("stopChild escalates when a process ignores graceful shutdown", { timeout: 3_000 }, async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => {}); console.log('READY'); setInterval(() => {}, 1000)",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  try {
    await waitForOutput(child, "READY", { label: "fixture", timeoutMs: 1_000 });
    await stopChild(child, { graceMs: 50 });
    assert.equal(child.signalCode, "SIGKILL");
  } finally {
    await stopChild(child, { graceMs: 50 });
  }
});

test("assertBuildArtifacts fails clearly until both production outputs exist", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gigit-e2e-server-"));
  const webBuildId = path.join(root, "web/BUILD_ID");
  const workerEntry = path.join(root, "worker/index.js");

  try {
    await assert.rejects(
      assertBuildArtifacts({ webBuildId, workerEntry }),
      /production build artifacts missing/,
    );

    await mkdir(path.dirname(webBuildId), { recursive: true });
    await mkdir(path.dirname(workerEntry), { recursive: true });
    await writeFile(webBuildId, "");
    await writeFile(workerEntry, "");
    await assert.rejects(
      assertBuildArtifacts({ webBuildId, workerEntry }),
      /production build artifacts missing/,
    );

    await writeFile(webBuildId, "build-id");
    await writeFile(workerEntry, "export {};");

    await assert.doesNotReject(
      assertBuildArtifacts({ webBuildId, workerEntry }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the server reports a deliberate startup failure before building", { timeout: 5_000 }, async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./e2e-server.mjs", import.meta.url))],
    {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: {
        ...process.env,
        DATABASE_URL: "postgres://gigit:gigit@127.0.0.1:5433/gigit",
        SESSION_SECRET: "short",
        E2E_PORT: "3002",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += String(chunk)));
  child.stderr.on("data", (chunk) => (stderr += String(chunk)));

  const [code] = await once(child, "close");
  assert.equal(code, 1);
  assert.match(stderr, /"kind":"e2e\.stack\.failed"/);
  assert.match(stderr, /SESSION_SECRET/);
  assert.match(stdout, /"kind":"e2e\.stack\.stopped","exitCode":1/);
  assert.doesNotMatch(stdout, /e2e\.stack\.ready/);
});
