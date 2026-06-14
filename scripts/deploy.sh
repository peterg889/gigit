#!/usr/bin/env bash
# First-deploy + redeploy orchestrator (docs/runbook.md "First deploy").
# Resolves the image chicken-and-egg by ordering: bootstrap (ECR) -> push
# images -> service stack. Idempotent: safe to re-run for redeploys.
#
#   ./scripts/deploy.sh staging
#   ./scripts/deploy.sh prod
#
# Requires: local AWS creds for the target account, docker, pnpm. Run from repo
# root. The service stack's AppSecrets must be filled in Secrets Manager before
# the app is healthy (the script reminds you).
set -euo pipefail

STAGE="${1:-staging}"
REGION="${CDK_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
CDK="pnpm --filter @gigit/infra exec cdk"

if [[ "$STAGE" != "staging" && "$STAGE" != "prod" ]]; then
  echo "usage: $0 [staging|prod]" >&2; exit 1
fi

echo "▶ Deploying gigit ($STAGE) to account $ACCOUNT / $REGION"

# 1. Bootstrap CDK itself (one-time per account/region; no-op after).
$CDK bootstrap "aws://${ACCOUNT}/${REGION}"

# 2. Foundation: ECR repos + OIDC + deploy role.
echo "▶ [1/4] Foundation stack (ECR, OIDC, deploy role)"
$CDK deploy "GigitBootstrap-${STAGE}" --require-approval never

# 3. Build + push images to the now-existing repos.
echo "▶ [2/4] Build & push images"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"
for app in web worker; do
  REPO="${REGISTRY}/gigit-${app}-${STAGE}"
  docker build -f "Dockerfile.${app}" -t "${REPO}:latest" .
  docker push "${REPO}:latest"
done

# 4. Service stack: RDS, S3/CloudFront, App Runner (web), EC2 (worker), alarms.
echo "▶ [3/4] Service stack"
STACK="$([[ "$STAGE" == "prod" ]] && echo GigitProd || echo GigitStaging)"
$CDK deploy "$STACK" --require-approval never --outputs-file "/tmp/gigit-${STAGE}-outputs.json"

# 5. Redeploy the worker to pull the image just pushed (App Runner auto-deploys
#    web on push; the EC2 worker needs a nudge).
echo "▶ [4/4] Redeploy worker"
IDS="$(aws ec2 describe-instances \
  --filters "Name=tag:aws:cloudformation:stack-name,Values=${STACK}" \
            "Name=instance-state-name,Values=running" \
  --query "Reservations[].Instances[].InstanceId" --output text)"
if [[ -n "$IDS" ]]; then
  aws ssm send-command --instance-ids $IDS --document-name AWS-RunShellScript \
    --parameters "commands=[\"aws ecr get-login-password --region ${REGION} | docker login --username AWS --password-stdin ${REGISTRY}\",\"docker pull ${REGISTRY}/gigit-worker-${STAGE}:latest\",\"docker rm -f worker || true\",\"docker run -d --restart=always --name worker ${REGISTRY}/gigit-worker-${STAGE}:latest\"]" \
    --output text --query "Command.CommandId" >/dev/null
  echo "  worker redeploy command sent to: $IDS"
else
  echo "  no running worker instance yet (first deploy: it boots the image itself)"
fi

echo ""
echo "✅ Deploy complete. Outputs in /tmp/gigit-${STAGE}-outputs.json"
echo "   Next:"
echo "   • Fill AppSecrets in Secrets Manager (DATABASE_URL, SESSION_SECRET, STRIPE_*, TWILIO_*, GEMINI_API_KEY, SENTRY_DSN)"
echo "   • Run migrations:  DATABASE_URL=… pnpm db:migrate"
echo "   • Put the deploy-role ARN (from the foundation outputs) in the GitHub secret AWS_DEPLOY_ROLE_ARN${STAGE/staging/}"
echo "   • Subscribe to the OpsAlertsTopic SNS topic"
