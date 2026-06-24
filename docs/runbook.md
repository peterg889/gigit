# Gigit on-call runbook (v1)

**Audience:** whoever is holding the pager. Two deployables (web on App Runner, worker on one EC2), one Postgres. Most incidents are one of the five patterns below.

> **Discovery-first launch — money-path procedures below are DEFERRED.** At launch Gigit processes no gig money (the venue pays the act directly), so the payments apparatus is switched off — `NullGateway` when `STRIPE_SECRET_KEY` is unset, also gated by `PAYMENTS_ENABLED` (default false). Anything tagged *deferred* below (nightly money reconciliation, Stripe PaymentIntent/webhook flows, the ledger) does not apply at the discovery-first launch and only becomes operational when payments turn on in Phase 2. **Seam, not deletion** — the procedures stay documented and ready, they just can't fire yet. See [`pricing.md`](pricing.md) §4.

## The system in one breath

Web (Next.js, App Runner) takes requests and webhooks, writes transactionally, and appends outbox events. Worker (EC2 docker) polls the outbox every second, runs timers (pg-boss), notifications (Twilio/SES), payments (Stripe gateway — *deferred at launch; NullGateway, no money moves*), media screening, series materialization, night-facts snapshots, and nightly money reconciliation (*deferred at launch — nothing to reconcile until payments turn on*). Postgres is the single source of truth — if web and worker disagree, the database is right.

## Health checks

| What | How | Healthy |
|---|---|---|
| Web | `GET /` returns 200 | < 1s |
| Worker alive | EC2 instance status + `docker ps` shows `worker` | running |
| Outbox | `select count(*) from events where dispatched_at is null` | < 100 and draining |
| Outbox lag | worker logs `outbox.LAGGING` when oldest undispatched > 5 min | absent |
| Timers | `timers.reconcile` re-arms anything missed every 10 min | self-healing |
| Money *(deferred at launch)* | nightly `reconcile.clean` log line (04:30 UTC) | n/a at launch — no gig money to reconcile; when `PAYMENTS_ENABLED`: present, `reconcile.MISMATCH` pages |

## The five incident patterns

1. **Outbox backed up** (notifications/payments not happening): worker is down or wedged. `docker logs worker --tail 100` on the EC2 box (SSM session). Restart: `docker restart worker`. Events are at-least-once — a restart loses nothing; the backlog drains in order.
2. **Booking stuck in `confirming`** *(deferred — can't occur at launch)*: with payments off, `confirming` is a `NullGateway` pass-through and a booking can't stall there, so this pattern is moot at the discovery-first launch. **When payments are on:** payment outcome never arrived — check Stripe dashboard for the PaymentIntent (`bookings.payment_ref`). If Stripe shows succeeded but we didn't transition: the webhook failed — replay it from the Stripe dashboard (webhook deliveries → resend). Idempotency makes replays safe.
3. **Reconciliation mismatch page** *(deferred — can't occur at launch; no money is reconciled until `PAYMENTS_ENABLED`)*: read the `reconciliation.mismatch` events for booking ids and kinds. `unbalanced_terminal` = ledger math wrong (engineering bug — escalate); `stripe_charge_missing/not_succeeded` = execution drift (fix in Stripe dashboard, then record an admin adjustment with reason via /admin/search).
4. **Media stuck in processing**: the screen held it (check `/admin/moderation` for the flag) or the worker missed the event (restart worker; the event re-dispatches). High-risk holds are intentional — a person clears or upholds.
5. **SMS not sending**: check Twilio console error logs first (A2P registration status, number capabilities), then `users.sms_opted_out_at` for the recipient, then worker logs for `notify` errors. Email (SES) is the automatic fallback channel.

## Backup-restore drill (run monthly — calendar it)

1. RDS has PITR enabled (7d staging / 14d prod). Restore latest snapshot to a new instance: `aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier <prod-id> --target-db-instance-identifier gigit-drill --use-latest-restorable-time`.
2. Point a local env at the restored endpoint; run `pnpm db:migrate` (should be a no-op) and the smoke test: `select count(*) from bookings; select count(*) from applications;` — compare to production counts. (At the discovery-first launch the ledger is dormant, so `select count(*) from ledger_entries` is expected to be 0 and isn't a useful liveness signal; use it as the money-path smoke query only once `PAYMENTS_ENABLED`.)
3. Run `pnpm --filter @gigit/db test` against the restored copy (read-mostly; uses its own rows).
4. Record the date + restore duration below; delete the drill instance.

| Date | Restore time | Notes |
|---|---|---|
| _(first drill pending — schedule it the week staging exists)_ | | |

## Load test (target: 100× launch volume)

Launch math: hundreds of bookings/month ≈ single-digit requests/second peak. 100× ≈ ~200 rps on the read paths. `node scripts/loadtest.mjs https://<staging-host> 200 30` runs 200 concurrent loops for 30s over the feed, a slot detail, and a profile, and prints p50/p95/p99 + error rate. Pass = p95 < 500ms, errors < 0.1%, and no RDS CPU alarm. Writes are deliberately excluded (they'd create junk bookings); the state machine's concurrency is covered by the version-conflict integration tests.

## First deploy (one-time, from a keyboard with AWS admin creds)

The infra is two stacks per stage: a **foundation** (`GigitBootstrap-{stage}` — ECR repos + GitHub OIDC + deploy role) that must exist before images, and the **service** stack (`GigitStaging`/`GigitProd` — RDS, S3/CloudFront, App Runner web, EC2 worker, alarms) that imports those repos. `scripts/deploy.sh` orders the whole sequence so you don't have to:

```bash
export AWS_PROFILE=…           # creds for the target account
export CDK_REGION=us-east-1
./scripts/deploy.sh staging    # cdk bootstrap → foundation → build+push images → service → worker redeploy
```

Then, the four things the script reminds you of (it can't do them for you):
1. **Fill `AppSecrets`** in Secrets Manager — `DATABASE_URL`, `SESSION_SECRET` (≥32 chars), `APP_URL` (the public web origin, e.g. `https://gigit.app` — it goes into every emailed/SMS link and Stripe redirect, so a missing value silently sends `localhost` links), at least one notification channel (`EMAIL_FROM` for SES, and/or all three `TWILIO_*` together — half a Twilio config fails fast), plus `GEMINI_API_KEY`, `SENTRY_DSN` if you have them. Without `DATABASE_URL`/`SESSION_SECRET` the app won't boot (fail-fast by design). The stack wires `NODE_ENV`, `STORAGE_DRIVER=s3`, `S3_BUCKET`, `AWS_REGION`, and `MEDIA_CDN_URL` for you (App Runner `runtimeEnvironmentVariables` + the worker's `run-worker.sh`), so they're not on this list. **`STRIPE_*` is deferred at the discovery-first launch** — leave it unset so the gateway resolves to `NullGateway` (`PAYMENTS_ENABLED` defaults false); it returns in Phase 2 as Stripe *Billing* for the venue subscription, not Connect.
2. **Run migrations**: `DATABASE_URL=<rds-url> pnpm db:migrate` (the RDS endpoint is in the stack outputs / `/tmp/gigit-staging-outputs.json`).
3. **Wire CI**: put the foundation's `DeployRoleArn` output into the GitHub repo secret `AWS_DEPLOY_ROLE_ARN` (and `…_PROD` for prod), set the `AWS_REGION` repo variable, and add `STAGING_DATABASE_URL`. After this, merges to `main` deploy app code automatically.
4. **Subscribe to alarms**: `aws sns subscribe --topic-arn <OpsAlertsTopic output> --protocol email --notification-endpoint you@…`.

Gotchas the synth can't catch but the deploy will:
- **OIDC provider already exists** in the account → the foundation stack errors on create. Re-run with `-c oidcProviderArn=arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com` to import it instead.
- App Runner takes a few minutes to go healthy after the first image lands; the service-stack deploy waits on it.

## Ongoing deploys & secrets

- Merge to `main` → CI `deploy-staging` (build/push images → ECR, migrations, worker redeploy via SSM). App Runner auto-deploys web on the `:latest` push. **Infra changes** (anything in `infra/cdk`) are NOT deployed by CI — re-run `./scripts/deploy.sh <stage>` or `cdk deploy` by hand. Prod app promotion is the `promote-production` job behind the GitHub `production` environment (required reviewer = the manual promote).
- **Cross-account note:** if prod ECR can't pull staging images, grant cross-account pull on the staging repos (or rebuild in the promote job) — current workflow assumes the grant.
- Secrets live in AWS Secrets Manager (`DATABASE_URL`, `SESSION_SECRET`, `STRIPE_*`, `TWILIO_*`, `GEMINI_API_KEY`, `SENTRY_DSN`); the worker materializes env from there at redeploy. Rotate quarterly (spec §11).
- Subscribe a human to the `OpsAlerts` SNS topic after each `cdk deploy` (output `OpsAlertsTopic`).

## External-dependency checklist (before launch)

Still needed for the discovery-first launch (all independent of payments):

- [ ] **Twilio A2P 10DLC registration** — weeks of carrier vetting; SMS posting and OTP-by-SMS are gated on it. Start NOW if not started.
- [ ] SES production access (out of sandbox) + domain verification.
- [ ] Sentry project; set `SENTRY_DSN` for the worker (web instrumentation is the follow-up).
- [ ] S3 malware scanning (GuardDuty S3 protection) — the media pipeline sniffs content types but does not virus-scan; this is the deployment-level control.
- [ ] PRO-licensing guidance reviewed by counsel (it ships as guidance-not-legal-advice).
- [ ] Web push (PWA): manifest ships now; service-worker push lands when SMS volume costs justify it (F5.2 note).

Deferred — NOT required to launch (seam, not deletion; returns with venue monetization in Phase 2):

- [ ] ~~Stripe live keys + webhook secret; switch venues to live SetupIntent flow.~~ **Deferred.** No gig money moves at launch (`NullGateway`, `PAYMENTS_ENABLED` false). When it returns it's Stripe **Billing** for the venue subscription (a saved card charged $5/month), *not* Connect/SetupIntent — see [`pricing.md`](pricing.md) §5.
