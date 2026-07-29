# Production promotion — 53d2e02

Everything up to the CDK rollout is done. Staging is verified and both
production images are already pushed, so promotion is one command.

## State as of this writing

| Thing | State |
| --- | --- |
| `main` | `53d2e02`, pushed, CI green (e2e + unit + staging deploy) |
| staging | running `53d2e02`, `/api/health` ok, migrations 0023–0025 applied |
| `gigit-web-prod:53d2e02…` | pushed (retagged from the staging image CI validated) |
| `gigit-worker-prod:53d2e02…` | pushed |
| prod | still on `0f7fca188cca` — **not yet rolled out** |

Images were retagged, never rebuilt, so production runs the exact bits the
staging health gate passed.

## The remaining command

```sh
export AWS_PROFILE=eightgig
SHA=53d2e0200763a087f1510c57c5450e6c05936d1f
CFN_EXEC_ROLE=$(aws cloudformation describe-stacks --stack-name GigitBootstrap-prod \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFormationExecutionRoleArn'].OutputValue" \
  --output text)

pnpm --filter @gigit/infra exec cdk deploy GigitProd \
  --require-approval never \
  --role-arn "$CFN_EXEC_ROLE" \
  --context imageTag=$SHA \
  --context deploymentNonce=$SHA-manual-1
```

Then confirm:

```sh
curl -fsS https://eightgig.com/api/health
curl -fsS -o /dev/null https://eightgig.com/slots
curl -fsS -o /dev/null https://eightgig.com/dmca   # new page in this release
```

## What the migrations do to production data

Three migrations run as part of the rollout. Two are additive-only; one
backfills.

- **0023** adds `bookings.performer_marked_played_at` (nullable). No backfill —
  existing bookings read as "not marked", which is the truth.
- **0024** adds `events.next_attempt_at` (NOT NULL DEFAULT now()) and rebuilds
  `events_outbox_idx` to cover it. The default means every existing undispatched
  row is immediately due, so nothing stalls. The index rebuild is brief at
  current row counts.
- **0025** adds `applications.decline_reason` and `threads.created_by_user_id`,
  then **backfills every existing `declined` application to
  `'venue_declined'`**. This is the one irreversible-in-spirit step: existing
  declines are genuinely indistinguishable, and treating them as venue decisions
  leaves them inactive rather than resurrecting applications a venue may have
  deliberately turned down. Going forward the auto-decline on confirm tags
  `'slot_filled'` and those get revived when a slot reopens.

If you'd rather the backfill went the other way (revive everything already
declined), say so before rolling out — it's a one-line change to
`packages/db/migrations/0025_applicant_restore.sql` and a re-run through CI.

## One thing worth fixing separately

`.github/workflows/ci.yml` gates `promote-production` on
`environment: production`, and the comment beside it says
"required-reviewer gate = the manual promote". **That environment does not
exist** — `gh api repos/:owner/:repo/environments` returns zero. So if
`PROD_DEPLOY_ENABLED` were ever set to `true`, every push to `main` would deploy
straight to production with no approval, contrary to what the workflow claims.

Either create the environment with yourself as a required reviewer and then set
`PROD_DEPLOY_ENABLED=true` (which makes promotion a one-click approval instead of
the manual command above), or leave the variable unset and keep promoting by
hand. I did not set it, because doing so with no reviewer configured would
silently turn every merge into a production deploy.
