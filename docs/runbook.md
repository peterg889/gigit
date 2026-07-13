# Gigit on-call runbook (v1)

**Audience:** whoever is holding the pager. Two containers (web and worker) on one x86 `t3.small` EC2 host, one Postgres. Most incidents are one of the five patterns below.

> **Discovery-first launch — money-path procedures below are DEFERRED.** At launch Gigit processes no gig money (the venue pays the act directly), so the payments apparatus is switched off — `NullGateway` when `STRIPE_SECRET_KEY` is unset, also gated by `PAYMENTS_ENABLED` (default false). Anything tagged *deferred* below (nightly money reconciliation, Stripe PaymentIntent/webhook flows, the ledger) does not apply at the discovery-first launch and only becomes operational when payments turn on in Phase 2. **Seam, not deletion** — the procedures stay documented and ready, they just can't fire yet. See [`pricing.md`](pricing.md) §4.

## The system in one breath

CloudFront provides the public HTTPS endpoint and forwards app traffic through a public ALB to the Next.js web container. The ALB accepts network traffic only from AWS's CloudFront origin prefix list and forwards only requests carrying its generated origin-verification header; direct origin requests receive 403. The web and worker containers share one x86 `t3.small` EC2 host in a public subnet; the host accepts web traffic only from the ALB security group and has no SSH ingress. Its public route provides outbound access to SES/Twilio/Gemini without a NAT gateway. The worker polls the outbox every second and runs timers (pg-boss), notifications, media screening, series materialization, night-facts snapshots, and money operations (*deferred at launch; `NullGateway`, no money moves*). RDS is encrypted, private-isolated, and reachable only from the host. Postgres is the single source of truth — if web and worker disagree, the database is right.

## Health checks

| What | How | Healthy |
|---|---|---|
| Web + DB | `GET /api/health` returns 200 | database reachable; no cache |
| App processes | EC2 instance status + `docker ps` shows `web` and `worker` | both running |
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

The infra is two stacks per stage: a **foundation** (`GigitBootstrap-{stage}` — ECR repos + GitHub OIDC + deploy role) that must exist before images, and the **service** stack (`GigitStaging` or the optional `GigitProd` — public ALB, CloudFront HTTPS, one EC2 app host, private-isolated RDS, S3/media CDN, and alarms) that imports those repos. There is no NAT gateway. `scripts/deploy.sh` orders the whole sequence so you don't have to:

```bash
export AWS_PROFILE=…           # creds for the target account
export CDK_REGION=us-east-1
./scripts/deploy.sh staging    # bootstrap → foundation → immutable images → service/migrate/restart
```

Then, the four operator tasks the script cannot decide for you:
1. **Configure provider delivery** in the output `AppSecretsArn`: set `EMAIL_FROM` and/or all three `TWILIO_*`, plus `GEMINI_API_KEY`/`SENTRY_DSN` when available. CloudFormation generates the database credentials/`DATABASE_URL` and `SESSION_SECRET`, sets `PAYMENTS_ENABLED=false`, and leaves Stripe values empty. The deployment association appends the actual CloudFront `APP_URL` to the materialized container environment. These generated/computed values are not operator copy/paste fields. **After any AppSecrets edit, rerun `./scripts/deploy.sh staging`**; the unique nonce rematerializes the environment and restarts both containers.
2. **Trust the private migration gate**: the CloudFormation-managed SSM association pulls the immutable web and worker `imageTag`, materializes `AppSecrets`, applies Drizzle migrations from the app host, then restarts both containers. A failed migration fails the deployment; there is no caller-side database connection or separate local migration step.
3. **Wire CI**: put `DeployRoleArn` in the GitHub secret `AWS_DEPLOY_ROLE_ARN`, set `AWS_REGION`, and set `DEPLOY_ENABLED=true`. No staging database secret is needed. Every deployment uses an immutable `imageTag` plus a unique `deploymentNonce`; the nonce reruns the association even when the infrastructure shape is unchanged.
4. **Subscribe to alarms**: `aws sns subscribe --topic-arn <OpsAlertsTopic output> --protocol email --notification-endpoint you@…`.

Gotchas the synth can't catch but the deploy will:
- **OIDC provider already exists** in the account → the foundation stack errors on create. Re-run with `-c oidcProviderArn=arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com` to import it instead.
- The ALB target can take a few minutes to pass `/api/health` after the first image lands; CloudFront is the public HTTPS URL used by the live smoke gate.

## Ongoing deploys & secrets

- Merge to `main` → CI `deploy-staging` (build/push linux/amd64 web and worker images under an immutable `imageTag` → CDK update with a unique `deploymentNonce` → SSM migrate/restart both containers → live CloudFront health gate).
- Production is not implied by the staging workflow. If enabled later, its optional job is manually gated by the GitHub `production` environment and builds/pushes production images in the production account before deploying; it does not retag or pull staging images across accounts.
- Secrets live in AWS Secrets Manager. Database/session values are generated by CloudFormation; the SSM association materializes those secrets for both containers and appends the computed CloudFront `APP_URL`. Provider settings (`EMAIL_FROM`, `TWILIO_*`, `GEMINI_API_KEY`, `SENTRY_DSN`) remain operator-managed. `PAYMENTS_ENABLED=false` and empty Stripe settings are the launch configuration. Rerun the stage deploy after every AppSecrets edit so running containers load it. Rotate credentials quarterly (spec §11).
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
