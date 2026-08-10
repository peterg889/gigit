#!/usr/bin/env node
/**
 * Asserts that the live AI golden-set evals ACTUALLY EXECUTED.
 *
 *   node scripts/assert-evals-ran.mjs packages/db/vitest-evals.json
 *
 * WHY THIS EXISTS
 * ---------------
 * packages/db/src/ai.eval.test.ts gates its whole live suite on
 * `const evalDescribe = hasKey ? describe : describe.skip`. A skipped describe
 * is a GREEN vitest run. So "the nightly passed" and "the golden set and the
 * prompt-injection corpus were exercised against the live model" are two
 * different facts, and every way of getting this wrong — the secret not being
 * plumbed into the job, an env name typo, someone inverting the gate — lands on
 * the first one while looking like the second. That is the exact failure the
 * file's own comment describes ("this file used to report one green
 * expect(true).toBe(true)"), reproduced at the CI level.
 *
 * This reads vitest's JSON report and fails unless the live tests are present,
 * are not pending/skipped, and passed. Exit 0 = they really ran.
 */

import { readFileSync } from "node:fs";

/** The describe block that only runs with a real GEMINI_API_KEY. */
const LIVE_SUITE = "golden-set evals (live model)";

/**
 * The golden set is 6 tests today (4 task evals + 2 injection-corpus evals).
 * Adding more is fine; silently ending up with fewer means evals were deleted
 * or filtered out of the run, which is precisely what this guards.
 */
const EXPECTED_MIN = 6;

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: node scripts/assert-evals-ran.mjs <vitest-json-report>");
  process.exit(2);
}

let report;
try {
  report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (err) {
  console.error(`could not read vitest JSON report at ${reportPath}: ${err.message}`);
  console.error("the eval step did not produce a report — treat this as a failed run, not a pass.");
  process.exit(1);
}

const live = (report.testResults ?? [])
  .flatMap((file) => file.assertionResults ?? [])
  .filter((t) => (t.ancestorTitles ?? []).includes(LIVE_SUITE));

const passed = live.filter((t) => t.status === "passed");
const failed = live.filter((t) => t.status === "failed");
// vitest reports a skipped test as "pending"; describe.skip produces these.
const skipped = live.filter((t) => t.status !== "passed" && t.status !== "failed");

console.log(`live golden-set evals in ${reportPath}:`);
for (const t of live) console.log(`  ${t.status.padEnd(7)} ${t.title}`);
if (live.length === 0) console.log("  (none found)");

const problems = [];
if (live.length < EXPECTED_MIN)
  problems.push(
    `expected at least ${EXPECTED_MIN} tests under "${LIVE_SUITE}", found ${live.length} — ` +
      `the suite was skipped (no GEMINI_API_KEY reached vitest), filtered out, or deleted`,
  );
if (skipped.length)
  problems.push(`${skipped.length} live eval(s) were SKIPPED, not run: ${skipped.map((t) => t.title).join("; ")}`);
if (failed.length)
  problems.push(`${failed.length} live eval(s) FAILED: ${failed.map((t) => t.title).join("; ")}`);

if (problems.length) {
  console.error("");
  for (const p of problems) {
    console.error(`✗ ${p}`);
    if (process.env.GITHUB_ACTIONS)
      console.log(`::error title=AI golden-set evals::${p.replace(/\n/g, " ")}`);
  }
  process.exit(1);
}

console.log(`\nOK — ${passed.length} live golden-set evals ran and passed against the real model.`);
