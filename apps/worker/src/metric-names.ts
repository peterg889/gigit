/**
 * The names of the CloudWatch custom metrics this worker publishes.
 *
 * These strings are a CONTRACT with `infra/cdk/lib/gigit-stack.ts`, which builds
 * one alarm per name. They used to be two independent copies of the same
 * literal — the worker's `putMetrics` calls and the stack's `metricName:` — with
 * nothing spanning them. Renaming either side left BOTH suites green while the
 * alarm quietly watched a metric nobody publishes: an alarm with no data sits in
 * INSUFFICIENT_DATA, which reads as "fine" at a glance, so the failure is
 * invisible until the outage the alarm existed to pre-empt.
 *
 * `infra/cdk/test/infrastructure-guarantees.test.ts` imports this file (by
 * relative path — the CDK package deliberately depends on nothing in the app
 * workspace) so the join is structural: rename a name here and the stack goes
 * red; rename it in the stack and the same test goes red.
 *
 * No imports on purpose: the CDK tests pull this module in on its own.
 */
export const WORKER_METRICS = {
  /** Age of the oldest undispatched outbox row; the fan-out being wedged. */
  outboxLagMs: "OutboxLagMs",
  /** Events parked past the attempt cap; work that will never happen by itself. */
  deadLetteredEvents: "DeadLetteredEvents",
  /** Nightly reconcile's count of terminal bookings whose money doesn't balance. */
  moneyMismatches: "MoneyMismatches",
} as const;

/** Every metric name the worker emits — what the stack must have an alarm for. */
export const WORKER_METRIC_NAMES: readonly string[] = Object.values(WORKER_METRICS);
