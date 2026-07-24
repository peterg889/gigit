import { env } from "@gigit/db";
import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";

const COOKIE = "gigit_session";
const TTL_DAYS = 30;
/**
 * Purpose claim. Other features mint long-lived tokens with the SAME secret —
 * notably the 365-day iCal feed token (api/calendar), which users are told to
 * paste into Google Calendar and share with bandmates. Without a purpose check
 * that shareable URL is a login: same key, same `sub`. Session tokens carry
 * this scope and sessionUserId() refuses anything minted for another purpose.
 */
const SESSION_SCOPE = "session";

function key(): Uint8Array {
  return new TextEncoder().encode(env().SESSION_SECRET);
}

export async function createSession(userId: string): Promise<void> {
  const token = await new SignJWT({ sub: userId, scope: SESSION_SCOPE })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${TTL_DAYS}d`)
    .sign(key());
  const jar = await cookies();
  jar.set(COOKIE, token, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    sameSite: "lax",
    maxAge: TTL_DAYS * 86_400,
    path: "/",
  });
}

export async function sessionUserId(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key());
    // A token minted for another purpose must never authenticate a session.
    // (`undefined` accepts sessions issued before the scope claim existed;
    // every non-session token sets a scope, so they are still rejected.)
    if (payload.scope !== undefined && payload.scope !== SESSION_SCOPE) return null;
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE);
}
