# AWS account migration runbook — pxnllc → EightGig account

_Last updated: 2026-07-23 (evening). Status: **MIGRATION COMPLETE.**
eightgig.com (prod) and staging.eightgig.com serve from 200790771428; NS
delegation flipped; pxnllc teardown done (all five scoped items); keys
rotated. Remaining: CloudFront re-enable when AWS's verification email
arrives (drop `-c enableCdn=false`, one stack update per env); domain
REGISTRATION transfer retry ~2026-09-14 (blocked while the registration is
<60 days old — DNS control has already moved); Peter's two OpsAlerts email
confirmations._

## Accounts

| | Account | Notes |
|---|---|---|
| OLD | 794451358339 (`pxnllc`) | Shared with other businesses — wrong home for EightGig. Currently still serving staging.eightgig.com. Nothing torn down yet. |
| NEW | 200790771428 | Local AWS profile `eightgig` (IAM user `claude-keys`). Fresh account → CloudFront + SES gated on AWS verification. |

## Already done

- [x] New account: foundation stack `GigitBootstrap-staging` (ECR, OIDC deploy roles); web+worker images pushed
- [x] New account: hosted zone `eightgig.com` = `Z0798311MFZI0RLC4E77`
- [x] New account: SES identity eightgig.com **verified, DKIM SUCCESS**; operator email verified for sandbox testing
- [x] ACM validation CNAME for staging.eightgig.com pre-mirrored into the live (old) zone → next deploy's cert validates instantly
- [x] CI auto-deploys **paused** (`DEPLOY_ENABLED=false`) so nothing else lands in pxnllc
- [x] Support cases filed: CloudFront account verification + SES production access (prior case `178337801700887`)
- [x] A session monitor polls SES production access and reports when it flips

## Waiting on AWS (Peter gets the emails)

- [x] EC2/account verification cleared 2026-07-23 — both stacks deployed CDN-less
- [ ] CloudFront: still unverified at deploy time; when its email arrives, one stack update per environment re-enables the CDN (drop `-c enableCdn=false`)
- [x] SES production access GRANTED (2026-07-22)

## Domain layout (decided 2026-07-22)

- **eightgig.com (apex) = production** — the beta launch URL. `GigitProd` now
  carries `domainName: eightgig.com`.
- **staging.eightgig.com = internal testing only.**

## On "go" — Claude runs

1. `AWS_PROFILE=eightgig ./scripts/deploy.sh staging` (~10 min: images already pushed, cert validates instantly)
1b. `AWS_PROFILE=eightgig ./scripts/deploy.sh prod` — production at the apex
    (needs `GigitBootstrap-prod` first, which the script deploys; prod
    AppSecrets get `APP_URL=https://eightgig.com`)
2. Mirror `staging.eightgig.com` → new ALB CNAME into the old zone (site works before the DNS flip)
3. Rewire CI: `AWS_DEPLOY_ROLE_ARN` → `arn:aws:iam::200790771428:role/gigit-deploy-staging`, re-enable `DEPLOY_ENABLED`
4. Verify health + alarms in the new account

## Then Peter runs (registrar ops are permission-blocked for Claude)

```bash
# 1. Point the live delegation at the new zone
aws route53domains update-domain-nameservers --region us-east-1 --domain-name eightgig.com \
  --nameservers Name=ns-462.awsdns-57.com Name=ns-871.awsdns-44.net \
               Name=ns-1983.awsdns-55.co.uk Name=ns-1203.awsdns-22.org

# 2. Transfer the registration (run with OLD/default pxnllc credentials)
aws route53domains transfer-domain-to-another-aws-account --region us-east-1 \
  --domain-name eightgig.com --account-id 200790771428
# 3. Accept from the new account with the password step 2 returns
aws route53domains accept-domain-transfer-from-another-aws-account --region us-east-1 \
  --domain-name eightgig.com --password '<password>' --profile eightgig
```

## After the new account is serving — Claude tears down pxnllc

Scope is fixed: ONLY these five, each verified as gigit's before deletion —
`GigitStaging` stack, `GigitBootstrap-staging` stack (ECR repos emptied
first), the SES eightgig.com identity, the DNS records Claude added, and the
old `eightgig.com` zone (only after the NS flip). Explicitly NOT touched:
`CDKToolkit` (unproven ownership) and everything else in pxnllc.

## Final configuration (new account)

- [x] Staging AppSecrets injected pre-boot (2026-07-23)
- [x] Prod AppSecrets injected pre-boot with APP_URL=https://eightgig.com (2026-07-23)
- [ ] OpsAlerts subscriptions created for BOTH new stacks — Peter clicks the two confirmation emails
- [x] `claude-keys` rotated 2026-07-23; chat-exposed key deleted

## Known gotchas (learned the hard way)

- `/tmp/claude-1000` shares the root filesystem — docker builds during deploys
  can fill the disk and wedge the tooling; `docker builder prune -af` frees it.
- Never add keys to the CDK `AppSecrets` `secretObjectValue`: a template change
  rewrites the deployed secret and clobbers operator-set values.
- SES reputation is account-scoped — the move exists precisely so EightGig's
  sending doesn't share a pool with the other pxnllc projects.


## Sister deployment — Open Reachout (reachout.eightgig.com)

Outbound seeding runs on its own stack in the same account (`GigitReachout`,
infra/cdk/lib/reachout-stack.ts): a t3.small running the private
open-reachout compose stack behind Caddy TLS. Source + tenant config ship via
the private S3 bucket `eightgig-reachout-config-<account>`; secrets via SSM
`/eightgig/reachout/env`. Refresh after code changes: rebuild the tarball,
`aws s3 cp` to the bucket's `src/` key, then SSM `docker compose up -d --build`
on the host. Sending stays halted until eightgig.com has a warmed mailbox.
See the `reachout-instance` memory for full operating notes.
