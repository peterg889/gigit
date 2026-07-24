import { describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";

const store = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (store.has(name) ? { value: store.get(name) } : undefined),
    set: (name: string, value: string) => void store.set(name, value),
    delete: (name: string) => void store.delete(name),
  }),
}));

import { createSession, destroySession, sessionUserId } from "./session";
import { env } from "@gigit/db";

const key = () => new TextEncoder().encode(env().SESSION_SECRET);

/**
 * The session cookie and the 365-day iCal feed token are signed with the SAME
 * secret and both carry `sub`. The feed URL is meant to be shared (pasted into
 * Google Calendar, sent to a bandmate), so a session check that ignores the
 * token's purpose turns every shared calendar link into an account takeover.
 */
describe("session tokens are purpose-scoped", () => {
  it("accepts a real session cookie", async () => {
    store.clear();
    await createSession("usr_session_ok");
    expect(await sessionUserId()).toBe("usr_session_ok");
    await destroySession();
    expect(await sessionUserId()).toBeNull();
  });

  it("REFUSES an iCal feed token as a session (account-takeover regression)", async () => {
    store.clear();
    const icalToken = await new SignJWT({ sub: "usr_victim", scope: "ical" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("365d")
      .sign(key());
    store.set("gigit_session", icalToken);
    expect(await sessionUserId()).toBeNull();
  });

  it("refuses any other purpose-scoped token signed with the same secret", async () => {
    store.clear();
    const other = await new SignJWT({ sub: "usr_victim", scope: "media-upload" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1d")
      .sign(key());
    store.set("gigit_session", other);
    expect(await sessionUserId()).toBeNull();
  });

  it("still accepts sessions issued before the scope claim existed", async () => {
    store.clear();
    const legacy = await new SignJWT({ sub: "usr_legacy" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(key());
    store.set("gigit_session", legacy);
    expect(await sessionUserId()).toBe("usr_legacy");
  });

  it("rejects a token signed with the wrong secret", async () => {
    store.clear();
    const forged = await new SignJWT({ sub: "usr_forged", scope: "session" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode("not-the-real-secret-not-the-real-secret"));
    store.set("gigit_session", forged);
    expect(await sessionUserId()).toBeNull();
  });
});
