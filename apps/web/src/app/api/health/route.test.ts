import { closeDb } from "@gigit/db";
import { afterAll, describe, expect, it } from "vitest";
import { GET } from "./route";

afterAll(async () => closeDb());

describe("GET /api/health", () => {
  it("proves the database is reachable without exposing connection details", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
