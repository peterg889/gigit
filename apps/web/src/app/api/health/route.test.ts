import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only the failure is simulated; the happy path runs a real query against real
// Postgres. `failWith` is the switch, so the 503 branch stops being unreachable.
const state = vi.hoisted(() => ({ failWith: null as Error | null, calls: 0 }));

vi.mock("@gigit/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gigit/db")>();
  const genuineDb = actual.db; // captured here; referencing the module recurses
  return {
    ...actual,
    db: () => {
      const real = genuineDb();
      return new Proxy(real, {
        get(target, prop, receiver) {
          if (prop !== "execute") return Reflect.get(target, prop, receiver);
          return (...args: unknown[]) => {
            state.calls++;
            if (state.failWith) return Promise.reject(state.failWith);
            return (target.execute as (...a: unknown[]) => unknown)(...args);
          };
        },
      });
    },
  };
});

const { closeDb } = await import("@gigit/db");
const { GET } = await import("./route");

afterAll(async () => closeDb());
beforeEach(() => {
  state.failWith = null;
  state.calls = 0;
});

/**
 * The 503 branch had no test — and this endpoint is the ALB target check AND the
 * gate the staging deploy waits on. The old single case asserted 200 against a
 * live database, which cannot distinguish "checks the database" from "returns ok
 * blindly": deleting the query entirely would have passed it.
 */
describe("GET /api/health", () => {
  it("proves the database is reachable without exposing connection details", async () => {
    const response = await GET();

    expect(state.calls).toBeGreaterThan(0); // it actually asked the database
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports 503 when the database is unreachable, and leaks nothing", async () => {
    state.failWith = new Error(
      'connect ECONNREFUSED 10.0.1.42:5432 for user "gigit" password "hunter2"',
    );
    const response = await GET();

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: "unavailable" });
    // The ALB and the deploy gate read the status; nobody should read a DSN.
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|5432|password/i);
    // An unhealthy response must not be cached either: a stale 503 outlives the
    // outage, and a stale 200 outlives the recovery.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
