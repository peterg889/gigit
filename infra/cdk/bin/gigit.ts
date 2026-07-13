import * as cdk from "aws-cdk-lib";
import { BootstrapStack } from "../lib/bootstrap-stack.js";
import { GigitStack } from "../lib/gigit-stack.js";

const app = new cdk.App();
const region = process.env.CDK_REGION ?? "us-east-1";
const account = process.env.CDK_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT;
const env = { account, region };
// Images are published explicitly by the deploy workflow and the stacks have
// no CDK file/image assets. The legacy synthesizer uses the caller/OIDC
// credentials directly and avoids the standard bootstrap's SSM parameter and
// roles, which are unavailable in restricted accounts.
const directSynthesizer = () => new cdk.LegacyStackSynthesizer();
// "owner/repo" allowed to assume the deploy roles; override via context or env.
const githubRepo =
  app.node.tryGetContext("githubRepo") ?? process.env.GITHUB_REPO ?? "peterg889/gigit";
// If your account already has the GitHub OIDC provider, pass its ARN so the
// bootstrap imports rather than re-creating it (one per account):
//   cdk deploy -c oidcProviderArn=arn:aws:iam::<acct>:oidc-provider/token.actions.githubusercontent.com
const existingOidcProviderArn = app.node.tryGetContext("oidcProviderArn");

// Foundation (ECR repos + OIDC + deploy role) — deploy FIRST, before images
// exist and before the service stack that references them.
new BootstrapStack(app, "GigitBootstrap-staging", {
  env,
  synthesizer: directSynthesizer(),
  stage: "staging",
  githubRepo,
  existingOidcProviderArn,
});
new BootstrapStack(app, "GigitBootstrap-prod", {
  env,
  synthesizer: directSynthesizer(),
  stage: "prod",
  githubRepo,
  existingOidcProviderArn,
});

// Service stacks — import the ECR repos by name (images must be pushed first).
new GigitStack(app, "GigitStaging", {
  env,
  synthesizer: directSynthesizer(),
  stage: "staging",
});
// Production lives in a separate AWS account (engineering-spec K11):
// CDK_ACCOUNT/CDK_REGION select it via the deploy role.
new GigitStack(app, "GigitProd", {
  env,
  synthesizer: directSynthesizer(),
  stage: "prod",
});
