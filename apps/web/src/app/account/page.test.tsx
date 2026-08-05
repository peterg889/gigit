import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, db, schema } from "@gigit/db";
import { newId } from "@gigit/domain";

vi.stubGlobal("React", React);
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const sessionUserId = vi.fn<() => Promise<string | null>>();
vi.mock("@/lib/session", () => ({ sessionUserId: () => sessionUserId() }));

import AccountPage from "./page";

describe("account page suspension state", () => {
  const userId = newId("user");
  const email = `${userId}@suspended-account-page.test`;

  beforeAll(async () => {
    await db().insert(schema.users).values({
      id: userId,
      email,
      status: "suspended",
    });
  });

  afterAll(async () => {
    await closeDb();
  });

  it("explains the read-only state while keeping self-deactivation available", async () => {
    sessionUserId.mockResolvedValue(userId);
    const html = renderToStaticMarkup(await AccountPage());

    expect(html).toContain("Account suspended.");
    expect(html).toContain("profiles are not public");
    expect(html).toContain("marketplace actions are unavailable");
    expect(html).toContain(email);
    expect(html).toContain("Type DEACTIVATE to confirm");
    expect(html).toContain("Deactivate my account");
    expect(html).toContain('href="/help"');
  });
});
