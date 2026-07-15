#!/usr/bin/env bash
# First-deploy + redeploy orchestrator (docs/runbook.md "First deploy").
# Resolves the image chicken-and-egg by ordering: foundation (ECR) -> push
# images -> service stack. Idempotent: safe to re-run for redeploys.
#
#   ./scripts/deploy.sh staging
#   ./scripts/deploy.sh prod
#
# Requires: local AWS creds for the target account, docker, pnpm. Run from repo
# root. The stack generates boot-safe secrets and applies migrations privately.
set -euo pipefail

STAGE="${1:-staging}"
REGION="${CDK_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
CDK="pnpm --filter @gigit/infra exec cdk"
IMAGE_TAG="${GIGIT_IMAGE_TAG:-$(git rev-parse --short=12 HEAD)}"
# Keep the image immutable while changing this nonce on every rollout. This
# makes same-commit secret/config rollouts rerun migrations and restart both
# services without racing an uncontrolled image update.
DEPLOYMENT_NONCE="${GIGIT_DEPLOYMENT_NONCE:-${IMAGE_TAG}-$(date -u +%Y%m%dT%H%M%SZ)}"

if [[ "$STAGE" != "staging" && "$STAGE" != "prod" ]]; then
  echo "usage: $0 [staging|prod]" >&2; exit 1
fi

echo "▶ Deploying gigit ($STAGE) to account $ACCOUNT / $REGION"

# 1. Foundation: ECR repos + OIDC + deploy/execution roles. The app uses CDK's
# direct-credentials synthesizer because images are pushed explicitly and the
# stacks contain no CDK-managed assets.
FOUNDATION_STACK="GigitBootstrap-${STAGE}"
echo "▶ [1/3] Foundation stack (ECR, OIDC, deploy/execution roles)"
$CDK deploy "$FOUNDATION_STACK" --require-approval never
CFN_EXEC_ROLE="$(aws cloudformation describe-stacks --region "$REGION" \
  --stack-name "$FOUNDATION_STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFormationExecutionRoleArn'].OutputValue" \
  --output text)"
if [[ -z "$CFN_EXEC_ROLE" || "$CFN_EXEC_ROLE" == "None" ]]; then
  echo "foundation did not output CloudFormationExecutionRoleArn" >&2
  exit 1
fi

# 2. Build + push images to the now-existing repos.
echo "▶ [2/3] Build & push linux/amd64 images ($IMAGE_TAG)"
aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"
for app in web worker; do
  REPO="${REGISTRY}/gigit-${app}-${STAGE}"
  docker build --platform linux/amd64 -f "Dockerfile.${app}" \
    -t "${REPO}:${IMAGE_TAG}" .
  docker push "${REPO}:${IMAGE_TAG}"
done

# 3. Service stack. The deployment nonce updates the CloudFormation-managed SSM
# association, which applies private RDS migrations and restarts both services.
# The caller therefore needs no direct ssm:SendCommand or database ingress.
echo "▶ [3/3] Service stack + private migrations/service rollout"
STACK="$([[ "$STAGE" == "prod" ]] && echo GigitProd || echo GigitStaging)"
$CDK deploy "$STACK" --require-approval never \
  --role-arn "$CFN_EXEC_ROLE" \
  --context "imageTag=${IMAGE_TAG}" \
  --context "deploymentNonce=${DEPLOYMENT_NONCE}" \
  --outputs-file "/tmp/gigit-${STAGE}-outputs.json"

WEB_URL="$(node -e 'const fs=require("fs"); const [f,s]=process.argv.slice(1); const v=JSON.parse(fs.readFileSync(f,"utf8"))[s]?.WebUrl; if (!v) process.exit(1); process.stdout.write(v);' "/tmp/gigit-${STAGE}-outputs.json" "$STACK")"
echo "▶ Waiting for database-aware web health at ${WEB_URL}"
healthy=false
deadline=$((SECONDS + 600))
while (( SECONDS < deadline )); do
  if curl -fsS --connect-timeout 5 --max-time 15 "${WEB_URL}/api/health" >/dev/null && \
     curl -fsS --connect-timeout 5 --max-time 15 "${WEB_URL}/slots" >/dev/null; then
    healthy=true
    break
  fi
  sleep 10
done
if ! $healthy; then
  echo "${STAGE} health checks did not pass within 10 minutes" >&2
  exit 1
fi

echo ""
echo "✅ Deploy complete. Outputs in /tmp/gigit-${STAGE}-outputs.json"
echo "   Web: ${WEB_URL}"
echo "   Next:"
echo "   • Configure EMAIL_FROM (SES) for sign-in and SUPPORT_EMAIL_TO for human escalations; TWILIO_*, GEMINI_API_KEY, and SENTRY_DSN are optional"
echo "   • After changing AppSecrets, rerun ./scripts/deploy.sh ${STAGE} so both containers load the new values"
echo "   • Leave PAYMENTS_ENABLED=false and Stripe values empty for discovery-first launch"
if [[ "$STAGE" == "prod" ]]; then
  ROLE_SECRET="AWS_DEPLOY_ROLE_ARN_PROD"
else
  ROLE_SECRET="AWS_DEPLOY_ROLE_ARN"
fi
echo "   • Put the deploy-role ARN (from the foundation outputs) in the GitHub secret ${ROLE_SECRET}"
echo "   • Subscribe to the OpsAlertsTopic SNS topic"
