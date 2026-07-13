/**
 * Gigit bootstrap stack — the "deploy once, rarely touch" foundation that has
 * to exist BEFORE the service stack:
 *
 *  - ECR repos: immutable release images must be pushable before the shared
 *    EC2 app host is created (the first-deploy chicken-and-egg). Repos live
 *    here; the service stack imports them by name.
 *  - GitHub Actions OIDC + a scoped deploy role: lets CI assume short-lived
 *    AWS creds (no long-lived keys, K11). Its ARN goes in the repo's
 *    AWS_DEPLOY_ROLE_ARN secret.
 *  - A CloudFormation-only execution role: lets restricted deploy callers
 *    create the service resources without granting those callers direct
 *    Secrets Manager, SSM, or database-administration access.
 *
 * One stage per AWS account (the K11 model: staging and prod are separate
 * accounts), so each account's bootstrap owns its own OIDC provider.
 */
import * as cdk from "aws-cdk-lib";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

export interface BootstrapStackProps extends cdk.StackProps {
  stage: "staging" | "prod";
  /** "owner/repo" allowed to assume the deploy role. */
  githubRepo: string;
  /**
   * If your AWS account already has the GitHub OIDC provider, pass its ARN to
   * import it (you can only have one per account). Leave undefined to create.
   */
  existingOidcProviderArn?: string;
}

export class BootstrapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id, props);

    // ECR repos — stable names the service stack imports and CI pushes to.
    new ecr.Repository(this, "WebRepo", {
      repositoryName: `gigit-web-${props.stage}`,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10 }], // keep the last 10, prune the rest
    });
    new ecr.Repository(this, "WorkerRepo", {
      repositoryName: `gigit-worker-${props.stage}`,
      imageScanOnPush: true,
      lifecycleRules: [{ maxImageCount: 10 }],
    });

    const administrator = iam.ManagedPolicy.fromAwsManagedPolicyName(
      "AdministratorAccess",
    );
    const cloudFormationExecutionRole = new iam.Role(
      this,
      "CloudFormationExecutionRole",
      {
        roleName: `gigit-cfn-exec-${props.stage}`,
        assumedBy: new iam.ServicePrincipal("cloudformation.amazonaws.com"),
        managedPolicies: [administrator],
      },
    );

    // GitHub Actions OIDC: trust GitHub's token issuer, scoped to this repo.
    const provider = props.existingOidcProviderArn
      ? iam.OidcProviderNative.fromOidcProviderArn(
          this,
          "GithubOidc",
          props.existingOidcProviderArn,
        )
      : new iam.OidcProviderNative(this, "GithubOidc", {
          url: "https://token.actions.githubusercontent.com",
          clientIds: ["sts.amazonaws.com"],
        });

    // The deploy role: assumable only from this repo, and (for prod) only from
    // the protected `production` environment. CDK deploys need to manage IAM,
    // CloudFormation, ECR, ALB, CloudFront, EC2, RDS, etc. — AdministratorAccess
    // within the account, gated by the tight OIDC trust below, is the pragmatic
    // choice for a small team. Narrow it later if the account gets shared.
    const subClaims = props.stage === "prod"
      ? [`repo:${props.githubRepo}:environment:production`]
      : [
          `repo:${props.githubRepo}:ref:refs/heads/main`,
          `repo:${props.githubRepo}:pull_request`,
        ];

    const deployRole = new iam.Role(this, "DeployRole", {
      roleName: `gigit-deploy-${props.stage}`,
      assumedBy: new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
        StringLike: { "token.actions.githubusercontent.com:sub": subClaims },
      }),
      managedPolicies: [administrator],
      maxSessionDuration: cdk.Duration.hours(1),
    });

    new cdk.CfnOutput(this, "DeployRoleArn", {
      value: deployRole.roleArn,
      description: "Put this in the GitHub repo secret AWS_DEPLOY_ROLE_ARN" +
        (props.stage === "prod" ? "_PROD" : ""),
    });
    new cdk.CfnOutput(this, "CloudFormationExecutionRoleArn", {
      value: cloudFormationExecutionRole.roleArn,
      description: "Pass this role to CloudFormation for service-stack deployments",
    });
  }
}
