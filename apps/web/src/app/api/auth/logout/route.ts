import { env } from "@gigit/db";
import { NextResponse } from "next/server";
import { destroySession } from "@/lib/session";

export async function POST() {
  await destroySession();
  return NextResponse.redirect(new URL("/", env().APP_URL), 303);
}
