import { once } from "node:events";
import { stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webRoot = path.join(repoRoot, "apps/web");
const workerRoot = path.join(repoRoot, "apps/worker");
const nextCli = createRequire(path.join(webRoot, "package.json")).resolve(
  "next/dist/bin/next",
);
const workerReadyMarker = '"kind":"worker.started"';

export function assertRuntimeEnvironment(environment = process.env) {
  const issues = [];
  try {
    new URL(environment.DATABASE_URL);
  } catch {
    issues.push("DATABASE_URL must be a URL");
  }
  if (!environment.SESSION_SECRET || environment.SESSION_SECRET.length < 32) {
    issues.push("SESSION_SECRET must contain at least 32 characters");
  }
  const port = Number(environment.E2E_PORT ?? 3002);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    issues.push("E2E_PORT must be an integer from 1 through 65535");
  }
  if (issues.length > 0) {
    throw new Error(`invalid E2E environment: ${issues.join("; ")}`);
  }
}

function isExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

function signalChild(child, signal, processGroup) {
  if (processGroup && process.platform !== "win32" && child.pid) {
    process.kill(-child.pid, signal);
    return;
  }
  if (isExited(child)) return;
  child.kill(signal);
}

export async function assertBuildArtifacts({
  webBuildId = path.join(repoRoot, "apps/web/.next/BUILD_ID"),
  workerEntry = path.join(repoRoot, "apps/worker/dist/index.js"),
} = {}) {
  const missing = [];
  for (const artifact of [webBuildId, workerEntry]) {
    try {
      const details = await stat(artifact);
      if (!details.isFile() || details.size === 0) {
        missing.push(artifact);
      }
    } catch {
      missing.push(artifact);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `production build artifacts missing: ${missing.join(", ")}; run pnpm build`,
    );
  }
}

export function waitForOutput(
  child,
  needle,
  { label = "process", timeoutMs = 60_000 } = {},
) {
  if (!child.stdout) {
    return Promise.reject(new Error(`${label} stdout is not available`));
  }

  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      finish(
        reject,
        new Error(`${label} did not report readiness within ${timeoutMs}ms`),
      );
    }, timeoutMs);

    const onData = (chunk) => {
      buffer = (buffer + String(chunk)).slice(-16_384);
      if (buffer.includes(needle)) finish(resolve);
    };
    const onError = (error) => {
      finish(reject, new Error(`${label} failed to start: ${String(error)}`));
    };
    const onExit = (code, signal) => {
      finish(
        reject,
        new Error(
          `${label} exited before readiness (code ${String(code)}, signal ${String(signal)})`,
        ),
      );
    };
    const finish = (settle, value) => {
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      child.off("error", onError);
      child.off("exit", onExit);
      settle(value);
    };

    child.stdout.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

export async function waitForHealth(
  url,
  {
    timeoutMs = 60_000,
    intervalMs = 250,
    fetchImpl = fetch,
  } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastFailure = "no response";

  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(
          Math.min(5_000, Math.max(1, deadline - Date.now())),
        ),
      });
      const body = await response.json().catch(() => undefined);
      if (response.ok && body?.status === "ok") return;
      lastFailure = `HTTP ${response.status} with status ${String(body?.status)}`;
    } catch (error) {
      lastFailure = String(error);
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(intervalMs, remaining)),
    );
  }

  throw new Error(`web health check timed out: ${lastFailure}`);
}

function targetIsAlive(child, processGroup) {
  if (!processGroup || process.platform === "win32") return !isExited(child);
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function stopChild(
  child,
  { graceMs = 10_000, processGroup = false } = {},
) {
  if (!targetIsAlive(child, processGroup)) return;
  try {
    signalChild(child, "SIGTERM", processGroup);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }

  const deadline = Date.now() + graceMs;
  while (targetIsAlive(child, processGroup) && Date.now() < deadline) {
    await delay(25);
  }
  if (!targetIsAlive(child, processGroup)) return;

  try {
    signalChild(child, "SIGKILL", processGroup);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }

  const killDeadline = Date.now() + 1_000;
  while (targetIsAlive(child, processGroup) && Date.now() < killDeadline) {
    await delay(25);
  }
  if (targetIsAlive(child, processGroup)) {
    throw new Error(`process ${String(child.pid)} did not stop`);
  }
}

function pnpmInvocation(args) {
  const execPath = process.env.npm_execpath;
  return execPath
    ? { command: process.execPath, args: [execPath, ...args] }
    : { command: "pnpm", args };
}

function spawnPnpm(args, options = {}) {
  const invocation = pnpmInvocation(args);
  return spawn(invocation.command, invocation.args, {
    cwd: repoRoot,
    ...options,
  });
}

function forwardOutput(child, label) {
  child.stdout?.on("data", (chunk) => {
    process.stdout.write(`[${label}] ${String(chunk)}`);
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(`[${label}] ${String(chunk)}`);
  });
}

async function waitForSuccessfulExit(child, label) {
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    throw new Error(
      `${label} failed (code ${String(code)}, signal ${String(signal)})`,
    );
  }
}

function waitForUnexpectedExit(processes, isStopping) {
  return new Promise((_, reject) => {
    const rejectFor = (label, code, signal, error) => {
      if (isStopping()) return;
      const detail = error
        ? `error ${String(error)}`
        : `code ${String(code)}, signal ${String(signal)}`;
      reject(new Error(`${label} exited unexpectedly (${detail})`));
    };

    for (const { child, label } of processes) {
      child.once("error", (error) =>
        rejectFor(label, child.exitCode, child.signalCode, error),
      );
      child.once("exit", (code, signal) =>
        rejectFor(label, code, signal),
      );
      if (isExited(child)) {
        rejectFor(label, child.exitCode, child.signalCode);
      }
    }
  });
}

async function main() {
  const managed = [];
  let stopping = false;
  let shutdownPromise;

  const shutdown = (exitCode) => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    shutdownPromise = (async () => {
      const results = await Promise.allSettled(
        [...managed].reverse().map(({ child, processGroup }) =>
          stopChild(child, { processGroup }),
        ),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length > 0) {
        process.stderr.write(`[e2e-server] ${failures.length} cleanup failure(s)\n`);
      }
      const finalExitCode = failures.length > 0 ? 1 : exitCode;
      process.stdout.write(`${JSON.stringify({ kind: "e2e.stack.stopped", exitCode: finalExitCode })}\n`);
      process.exitCode = finalExitCode;
    })();
    return shutdownPromise;
  };

  process.once("SIGINT", () => void shutdown(0));
  process.once("SIGTERM", () => void shutdown(0));

  try {
    assertRuntimeEnvironment();
    const detached = process.platform !== "win32";
    const port = process.env.E2E_PORT ?? "3002";
    const baseURL = `http://127.0.0.1:${port}`;

    const build = spawnPnpm(["build"], {
      detached,
      env: { ...process.env, NODE_ENV: "production" },
      stdio: "inherit",
    });
    managed.push({ child: build, processGroup: detached });
    await waitForSuccessfulExit(build, "production build");
    managed.splice(0, managed.length);
    await assertBuildArtifacts();

    const runtimeEnv = {
      ...process.env,
      NODE_ENV: "test",
      PORT: port,
      APP_URL: baseURL,
      STORAGE_DRIVER: "local",
      PAYMENTS_ENABLED: "false",
      SENTRY_DSN: "",
      TWILIO_ACCOUNT_SID: "",
      TWILIO_AUTH_TOKEN: "",
      TWILIO_FROM: "",
      EMAIL_FROM: "",
    };

    const worker = spawn(
      process.execPath,
      [path.join(workerRoot, "dist/index.js")],
      {
        cwd: workerRoot,
        detached,
        env: runtimeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    managed.push({ child: worker, label: "worker", processGroup: detached });
    const workerExited = waitForUnexpectedExit(
      [{ child: worker, label: "worker" }],
      () => stopping,
    );
    const workerReady = waitForOutput(worker, workerReadyMarker, {
      label: "worker",
    });
    forwardOutput(worker, "worker");
    await Promise.race([workerReady, workerExited]);
    process.stdout.write("[e2e-server] worker ready\n");

    const web = spawn(
      process.execPath,
      [nextCli, "start", "-H", "127.0.0.1", "-p", port],
      {
        cwd: webRoot,
        detached,
        env: runtimeEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    managed.push({ child: web, label: "web", processGroup: detached });
    const webExited = waitForUnexpectedExit(
      [{ child: web, label: "web" }],
      () => stopping,
    );
    const stackExited = Promise.race([workerExited, webExited]);
    forwardOutput(web, "web");
    process.stdout.write(
      `[e2e-server] production web starting on ${baseURL}\n`,
    );

    await Promise.race([
      waitForHealth(`${baseURL}/api/health`),
      stackExited,
    ]);
    process.stdout.write(
      `${JSON.stringify({ kind: "e2e.stack.ready", baseURL })}\n`,
    );
    await stackExited;
  } catch (error) {
    if (stopping) {
      await shutdown(0);
    } else {
      process.stderr.write(
        `${JSON.stringify({ kind: "e2e.stack.failed", error: String(error) })}\n`,
      );
      await shutdown(1);
    }
  }
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) await main();
