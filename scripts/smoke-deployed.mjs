#!/usr/bin/env node
/**
 * Unauthenticated smoke test against a DEPLOYED EightGig environment.
 *
 *   node scripts/smoke-deployed.mjs https://eightgig.com
 *
 * WHY THIS EXISTS AND WHY IT IS NOT PLAYWRIGHT
 * --------------------------------------------
 * The e2e suite cannot be pointed at eightgig.com or staging.eightgig.com. It
 * signs in with the fixed dev OTP "000000", which apps/web/src/lib/otp.ts only
 * honours when NODE_ENV !== "production"; both deployments run
 * NODE_ENV=production and mint CSPRNG codes, so every e2e sign-in there would
 * hang on a code nobody can read. Wiring `playwright test` at a deployed URL
 * would produce a suite that fails for reasons unrelated to the deployment —
 * or, worse, one someone "fixes" by weakening the production OTP path. So the
 * deployed check is deliberately unauthenticated, and this file is what runs.
 *
 * WHAT IT GUARDS
 *  - /api/health is ok      → the app can reach its database at all
 *  - public pages render    → a 200 that is an empty shell is still an outage;
 *                             each page must contain its own real copy
 *  - the /admin gate holds  → a real security regression test, see below
 *  - nothing returns 5xx    → across every probe, no exceptions
 *
 * THE ADMIN GATE CHECK IS THE SECURITY ONE. Each ops page does its own
 * `adminUserId()` check and renders <AdminOnly/> when it fails. Two distinct
 * regressions are in scope and this catches both:
 *   1. a page that forgets the check and serves the moderation queue, the
 *      support queue or ops search to an anonymous visitor;
 *   2. a page that swaps adminUserId() for requireUser(), which THROWS for an
 *      anonymous visitor — a throwing server component renders the error
 *      boundary, so the ops links people paste to each other would greet a
 *      signed-out teammate with a crash page instead of a way in. See the
 *      comment in apps/web/src/app/admin/AdminOnly.tsx.
 * Hence: must contain "Admin only.", must NOT contain that page's
 * authenticated content, must NOT be an error boundary.
 *
 * Exit 0 = every probe passed. Exit 1 = at least one failed (and the run log
 * says which probe, which URL, and what was expected). Exit 2 = bad usage.
 */

const USER_AGENT = "eightgig-nightly-smoke";
// Worst case must fit the job's timeout-minutes, or a HUNG production — an
// exhausted DB pool, a wedged ALB target — is killed by GitHub mid-run and
// reported as a CI timeout with no annotations and no step summary, instead of
// as the outage it is. The arithmetic: PROBES x (ATTEMPTS x TIMEOUT_MS +
// backoffs). At 10 probes that is 10 x (2 x 10s + 2s) = 220s, inside the job's
// 10 minutes with room to spare. The old 20s x 3 was 640s — over budget, and
// measured at 10m40s against a genuinely hanging origin. Raise the job timeout
// before raising either of these.
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 10_000);
const TRANSPORT_ATTEMPTS = Number(process.env.SMOKE_ATTEMPTS ?? 2);

/**
 * Signs a page rendered its error boundary instead of its content. Next's
 * default boundary is the only one this app has — there is no app/error.tsx —
 * so these are the strings it produces in production.
 */
const ERROR_BOUNDARY_MARKERS = [
  "Application error:",
  "server-side exception",
  "Internal Server Error",
  "Unhandled Runtime Error",
];

const NOT_FOUND_MARKER = "This page could not be found";

/**
 * Public pages: the marker list is the page's own copy, not boilerplate from
 * the shared layout — a blank page inside a working shell must fail. Markers
 * are headings and eyebrows, i.e. static copy, never seeded data: /slots on an
 * empty database is a legitimate state and must not page anyone at 3am.
 */
const PUBLIC_PAGES = [
  {
    path: "/",
    markers: [
      "Find the room. Fill the night. Get the gig.",
      "Live gigs for independent venues",
    ],
  },
  // NOT the bare "Open gigs" / "Sound techs" these pages are titled with —
  // layout.tsx renders both as <NavLink>s on EVERY page, so those markers passed
  // against a page whose body was completely empty, which is the exact outage
  // this check exists to catch. Match copy only the page body prints.
  {
    path: "/slots",
    markers: ["Open gigs", "Every gig shows its listed budget up front"],
  },
  { path: "/venues", markers: ["Rooms that book live music", "The rooms"] },
  { path: "/techs", markers: ["Sound techs", "Gigs that need sound"] },
];

/**
 * Admin pages: `forbidden` is the content only a signed-in admin may ever see
 * — the heading each page renders AFTER its adminUserId() check passes. If one
 * of these comes back to an anonymous request, the gate is gone.
 */
const ADMIN_PAGES = [
  { path: "/admin", forbidden: ["Liquidity", "performer_profiles"] },
  { path: "/admin/disputes", forbidden: ["Reliability reports"] },
  {
    path: "/admin/moderation",
    forbidden: ["Moderation queue", "Uphold — reject it"],
  },
  { path: "/admin/search", forbidden: ["Ops search"] },
  { path: "/admin/support", forbidden: ["Support queue"] },
];

/**
 * Everything a browser would actually show: the HTML with <script>/<style>
 * bodies removed.
 *
 * This is not cosmetic. Next serialises its RSC flight payload into inline
 * <script> tags, and that payload embeds the *unused* notFound template on
 * every single page — so a naive substring search for "This page could not be
 * found" matches a perfectly healthy /admin and the check reports a fake
 * outage. Positive assertions ("Admin only.", page copy) and the
 * boundary/404 detectors therefore run against rendered markup only.
 * The admin-leak check deliberately does NOT use this — see below.
 */
function visible(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
}

const results = [];

function record(check, path, ok, detail, meta = {}) {
  results.push({ check, path, ok, detail, ...meta });
  const status = ok ? "PASS" : "FAIL";
  const ms = meta.ms === undefined ? "" : ` ${meta.ms}ms`;
  console.log(`  ${status}  ${check.padEnd(12)} ${path.padEnd(20)}${ms}  ${detail}`);
}

/**
 * Retries ONLY transport errors (DNS, connect reset, timeout) — a nightly
 * shouldn't wake anyone for one dropped TCP connection. HTTP responses,
 * including 5xx, are returned on the first attempt and never retried: an
 * intermittent 500 from a deployed environment is exactly the thing this is
 * supposed to report, and retrying it would average the signal away.
 */
async function get(url) {
  let lastError;
  for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { "user-agent": USER_AGENT, "cache-control": "no-cache" },
        redirect: "follow",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const body = await res.text();
      return { res, body, ms: Date.now() - started, attempts: attempt };
    } catch (err) {
      lastError = err;
      if (attempt < TRANSPORT_ATTEMPTS) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return { error: lastError, attempts: TRANSPORT_ATTEMPTS };
}

function errorBoundaryHit(body) {
  const shown = visible(body);
  return ERROR_BOUNDARY_MARKERS.find((m) => shown.includes(m));
}

async function checkHealth(base) {
  const { res, body, ms, error } = await get(`${base}/api/health`);
  if (error) return record("health", "/api/health", false, `no response: ${error.message}`);
  if (res.status !== 200)
    return record("health", "/api/health", false, `expected 200, got ${res.status}`, { ms, status: res.status });
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return record("health", "/api/health", false, `body is not JSON: ${body.slice(0, 120)}`, { ms, status: res.status });
  }
  // status "unavailable" is a 503 the load balancer already acts on; anything
  // other than "ok" here means the app is up but its database is not.
  if (parsed.status !== "ok")
    return record("health", "/api/health", false, `expected status "ok", got ${JSON.stringify(parsed)}`, { ms, status: res.status });
  record("health", "/api/health", true, "200 status=ok", { ms, status: res.status });
}

async function checkPublicPage(base, { path, markers }) {
  const { res, body, ms, error } = await get(`${base}${path}`);
  if (error) return record("public", path, false, `no response: ${error.message}`);
  if (res.status !== 200)
    return record("public", path, false, `expected 200, got ${res.status}`, { ms, status: res.status });
  const boundary = errorBoundaryHit(body);
  if (boundary)
    return record("public", path, false, `rendered the error boundary (matched ${JSON.stringify(boundary)})`, { ms, status: res.status });
  const missing = markers.filter((m) => !visible(body).includes(m));
  if (missing.length)
    return record("public", path, false, `200 but missing page content: ${missing.map((m) => JSON.stringify(m)).join(", ")}`, { ms, status: res.status });
  record("public", path, true, `200, ${markers.length} content marker(s) present`, { ms, status: res.status });
}

async function checkAdminGate(base, { path, forbidden }) {
  const { res, body, ms, error } = await get(`${base}${path}`);
  if (error) return record("admin-gate", path, false, `no response: ${error.message}`);
  if (res.status >= 500)
    return record("admin-gate", path, false, `server error ${res.status} — the gate should render a card, not blow up`, { ms, status: res.status });
  const boundary = errorBoundaryHit(body);
  if (boundary)
    return record("admin-gate", path, false, `ERROR BOUNDARY for an anonymous visitor (matched ${JSON.stringify(boundary)}) — the page most likely throws (requireUser) instead of returning <AdminOnly/>`, { ms, status: res.status });
  if (visible(body).includes(NOT_FOUND_MARKER))
    return record("admin-gate", path, false, "rendered 404 — the ops route is gone, not gated", { ms, status: res.status });
  // Matched against the RAW response, scripts included: admin data that reaches
  // the client only inside the RSC flight payload has still been served to an
  // anonymous visitor, and `curl | grep` is all it takes to read it.
  const leaked = forbidden.filter((m) => body.includes(m));
  if (leaked.length)
    return record("admin-gate", path, false, `LEAK: admin-only content served to an anonymous request: ${leaked.map((m) => JSON.stringify(m)).join(", ")}`, { ms, status: res.status });
  if (!visible(body).includes("Admin only."))
    return record("admin-gate", path, false, `${res.status} but no "Admin only." card — the gate did not render its refusal`, { ms, status: res.status });
  record("admin-gate", path, true, `${res.status}, "Admin only." card, no admin content`, { ms, status: res.status });
}

/** "(all probes)" is not a URL — only real paths get the base prefixed. */
const where = (base, path) => (path.startsWith("/") ? base + path : path);

function annotate(base, failures) {
  if (!process.env.GITHUB_ACTIONS) return;
  for (const f of failures) {
    console.log(
      `::error title=smoke ${f.check} ${where(base, f.path)}::${f.detail.replace(/\n/g, " ")}`,
    );
  }
}

async function main() {
  const base = (process.argv[2] ?? "").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) {
    console.error("usage: node scripts/smoke-deployed.mjs <base-url>");
    console.error("  e.g. node scripts/smoke-deployed.mjs https://eightgig.com");
    process.exit(2);
  }

  console.log(`eightgig unauthenticated smoke → ${base}`);
  console.log(`  (${new Date().toISOString()})`);

  await checkHealth(base);
  for (const page of PUBLIC_PAGES) await checkPublicPage(base, page);
  for (const page of ADMIN_PAGES) await checkAdminGate(base, page);

  // Belt-and-braces over every probe: individual checks already reject their
  // own 5xx, this re-states it as one line so "no 5xx anywhere" is asserted
  // rather than implied.
  const serverErrors = results.filter((r) => r.status >= 500);
  record(
    "no-5xx",
    "(all probes)",
    serverErrors.length === 0,
    serverErrors.length === 0
      ? `${results.length} probes, no 5xx`
      : `5xx from: ${serverErrors.map((r) => `${r.path} (${r.status})`).join(", ")}`,
  );

  const failures = results.filter((r) => !r.ok);
  console.log("");
  if (failures.length === 0) {
    console.log(`SMOKE PASSED — ${results.length} checks against ${base}`);
    process.exit(0);
  }
  console.log(`SMOKE FAILED — ${failures.length}/${results.length} checks failed against ${base}:`);
  for (const f of failures) console.log(`  ✗ ${f.check} ${where(base, f.path)}: ${f.detail}`);
  annotate(base, failures);
  process.exit(1);
}

await main();
