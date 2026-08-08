import React from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { newId } from "@gigit/domain";
import { closeDb, db, schema } from "@gigit/db";
vi.stubGlobal("React", React);

const controls = vi.hoisted(() => ({ sessionUserId: null as string | null }));
vi.mock("@/lib/session", () => ({
  sessionUserId: () => Promise.resolve(controls.sessionUserId),
}));

import AdminPage from "./page";
import DisputeBriefPage from "./dispute-brief/page";
import AdminDisputesPage from "./disputes/page";
import ModerationPage from "./moderation/page";
import AdminSearchPage from "./search/page";
import SupportQueuePage from "./support/page";
import SupportRequestPage from "./support/[id]/page";
import { AdminOnly } from "./AdminOnly";

/**
 * The gate's own element, not its rendered text: a server component returns an
 * unrendered <AdminOnly/>, and asserting on the type is the one check that
 * cannot pass by accident when a page falls through to its real content.
 */
const isGated = (node: React.ReactNode) =>
  React.isValidElement(node) && node.type === AdminOnly;

function text(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (!React.isValidElement(node)) return "";
  return text((node.props as { children?: React.ReactNode }).children);
}

/**
 * The /admin/* page gates. These render ops surfaces — every account's email
 * and phone, every dispute, every money lever — so the check that keeps a
 * civilian out is the one thing on the page worth testing, and a fail-open
 * mistake here ships silently: the page still renders, just for everyone.
 *
 * Signed-out is a case of its own. requireUser() throws, and a server component
 * that throws renders the error boundary, so the ops gate has to answer an
 * anonymous visitor with the sign-in card instead.
 */
describe("admin page gates", () => {
  const adminId = newId("user");
  const civilianId = newId("user");
  const supportRequestId = newId("supportRequest");

  beforeAll(async () => {
    const d = db();
    await d.insert(schema.users).values([
      { id: adminId, email: `${adminId}@admin-gates.test` },
      { id: civilianId, email: `${civilianId}@admin-gates.test` },
    ]);
    await d
      .insert(schema.actorRoles)
      .values({ id: newId("role"), userId: adminId, kind: "admin" });
    await d.insert(schema.supportRequests).values({
      id: supportRequestId,
      requesterUserId: civilianId,
      channel: "web",
      category: "other",
      escalationReason: "explicit",
      message: "Gate test request",
    });
  });

  afterAll(async () => {
    await closeDb();
    vi.unstubAllGlobals();
  });

  const pages: [string, () => Promise<React.ReactNode>][] = [
    ["/admin", () => AdminPage()],
    [
      "/admin/dispute-brief",
      () => DisputeBriefPage({ searchParams: Promise.resolve({}) }),
    ],
    ["/admin/disputes", () => AdminDisputesPage()],
    ["/admin/moderation", () => ModerationPage()],
    [
      "/admin/search",
      () => AdminSearchPage({ searchParams: Promise.resolve({}) }),
    ],
    [
      "/admin/support",
      () => SupportQueuePage({ searchParams: Promise.resolve({}) }),
    ],
    [
      "/admin/support/[id]",
      () =>
        SupportRequestPage({ params: Promise.resolve({ id: supportRequestId }) }),
    ],
  ];

  it("offers the signed-out visitor a way in rather than an error", () => {
    expect(text(AdminOnly())).toContain("Admin only.");
    expect(text(AdminOnly())).toContain("Sign in");
  });

  for (const [name, render] of pages) {
    it(`${name} gates a signed-out visitor without throwing`, async () => {
      controls.sessionUserId = null;
      expect(isGated(await render())).toBe(true);
    });

    it(`${name} gates a signed-in non-admin`, async () => {
      controls.sessionUserId = civilianId;
      expect(isGated(await render())).toBe(true);
    });

    it(`${name} renders for an admin`, async () => {
      controls.sessionUserId = adminId;
      expect(isGated(await render())).toBe(false);
    });
  }
});
