import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same as every other component test here: the JSX transform emits classic
// React.createElement calls that expect React on the global.
vi.stubGlobal("React", React);

/**
 * The open-redirect guard on `?next=` lives inside the verify form's onSubmit,
 * and the web suite has no DOM and no reconciler — `renderToStaticMarkup` never
 * fires a submit, so nothing in the repo could reach that branch. This drives
 * the real component function instead: the page's own request→verify stage
 * change, its own fetches and its own `router.push`. The only thing standing in
 * for React is the store behind `useState`, so a guard rewritten in the page is
 * a guard this test sees.
 */
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0 }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState<S>(initial: S) {
      const index = hooks.cursor++;
      if (hooks.slots.length <= index) hooks.slots[index] = initial;
      const set = (next: S | ((prev: S) => S)) => {
        hooks.slots[index] =
          typeof next === "function"
            ? (next as (prev: S) => S)(hooks.slots[index] as S)
            : next;
      };
      return [hooks.slots[index] as S, set] as const;
    },
  };
});

const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import LoginPage from "./page";

type Element = { type: unknown; props: Record<string, unknown> };

const isElement = (value: unknown): value is Element =>
  typeof value === "object" &&
  value !== null &&
  "type" in value &&
  "props" in value &&
  typeof (value as { props: unknown }).props === "object";

/** Depth-first search of the rendered tree — the page renders exactly one form
 *  per stage, so matching on tag plus id is enough to find the real controls. */
function find(node: unknown, match: (el: Element) => boolean): Element | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (!isElement(node)) return null;
  if (match(node)) return node;
  return find(node.props.children, match);
}

function render(): unknown {
  hooks.cursor = 0;
  return LoginPage();
}

function typeInto(tree: unknown, id: string, value: string): void {
  const input = find(tree, (el) => el.type === "input" && el.props.id === id);
  if (!input) throw new Error(`no input#${id} on this stage`);
  (input.props.onChange as (e: { target: { value: string } }) => void)({
    target: { value },
  });
}

async function submit(tree: unknown): Promise<void> {
  const form = find(tree, (el) => el.type === "form");
  if (!form) throw new Error("no form on this stage");
  await (form.props.onSubmit as (e: { preventDefault: () => void }) => Promise<void>)(
    { preventDefault: () => {} },
  );
}

/** Sign in for real, from an address bar carrying `search`.
 *  Each handler closes over the render it came from, so — exactly as React
 *  does — every state change is followed by a fresh render before the next
 *  interaction, or the submit would send the value from before the keystroke. */
async function signIn(search: string): Promise<void> {
  vi.stubGlobal("window", { location: { search } });
  typeInto(render(), "email", "gig@test.example");
  await submit(render());
  typeInto(render(), "code", "123456");
  await submit(render());
}

describe("login redirect target", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    hooks.slots.length = 0;
    hooks.cursor = 0;
    router.push.mockClear();
    router.refresh.mockClear();
    fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal("React", React);
  });

  /**
   * The phishing case: a link to our own sign-in page that hands the freshly
   * signed-in user to someone else's host the moment the code is accepted.
   */
  it("refuses a cross-origin next and lands on onboarding", async () => {
    await signIn(`?next=${encodeURIComponent("https://evil.example/x")}`);

    // The sign-in itself has to have happened, or a page that redirected
    // nowhere would pass this test.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/auth/verify");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      email: "gig@test.example",
      code: "123456",
      termsAccepted: true,
    });

    expect(router.push).toHaveBeenCalledExactlyOnceWith("/onboarding");
    for (const [target] of router.push.mock.calls)
      expect(String(target)).not.toContain("evil.example");
  });

  /** Protocol-relative: `//evil.example` starts with "/" and is still a hop to
   *  another host, which is why the guard needs its second clause. */
  it("refuses a protocol-relative next", async () => {
    await signIn("?next=//evil.example");

    expect(router.push).toHaveBeenCalledExactlyOnceWith("/onboarding");
    for (const [target] of router.push.mock.calls)
      expect(String(target)).not.toContain("evil.example");
  });

  /** The guard has to stay narrow: deep links into the app are the whole reason
   *  `next` exists, and dropping everyone on /onboarding would break them. */
  it("honours a same-origin next", async () => {
    await signIn("?next=/slots/abc");

    expect(router.push).toHaveBeenCalledExactlyOnceWith("/slots/abc");
    expect(router.refresh).toHaveBeenCalledOnce();
  });
});
