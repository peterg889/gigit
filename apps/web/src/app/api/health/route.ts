import { db } from "@gigit/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

/** Database-aware liveness check used by the load balancer and deploy smoke tests. */
export async function GET() {
  try {
    await db().execute(sql`select 1`);
    return Response.json(
      { status: "ok" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
