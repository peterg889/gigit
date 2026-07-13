import { env } from "@gigit/db";
import { describe, expect, it, vi } from "vitest";

const destroySession = vi.fn<() => Promise<void>>();
vi.mock("@/lib/session", () => ({
  destroySession: () => destroySession(),
}));

import { POST } from "./route";

describe("POST /api/auth/logout", () => {
  it("clears the session and redirects to the configured public origin", async () => {
    const response = await POST();

    expect(destroySession).toHaveBeenCalledOnce();
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      new URL("/", env().APP_URL).toString(),
    );
  });
});
