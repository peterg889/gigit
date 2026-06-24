/**
 * Gigit infrastructure (engineering-spec K11): deliberately minimal —
 * App Runner (web) + one small EC2 (worker) + RDS + S3/CloudFront + SES.
 * No Fargate, no ALB, no cluster.
 */
import * as cdk from "aws-cdk-lib";
import * as apprunner from "aws-cdk-lib/aws-apprunner";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwactions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export interface GigitStackProps extends cdk.StackProps {
  stage: "staging" | "prod";
}

export class GigitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GigitStackProps) {
    super(scope, id, props);
    const prod = props.stage === "prod";

    const vpc = new ec2.Vpc(this, "Vpc", { maxAzs: 2, natGateways: 0 });

    // ── data ────────────────────────────────────────────────────────────────
    const dbSecret = new secretsmanager.Secret(this, "DbSecret", {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: "gigit" }),
        generateStringKey: "password",
        excludePunctuation: true,
      },
    });
    const database = new rds.DatabaseInstance(this, "Db", {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, // SG-restricted; private subnets need NAT
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        prod ? ec2.InstanceSize.SMALL : ec2.InstanceSize.MICRO,
      ),
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: "gigit",
      multiAz: false, // single-AZ at launch; flip when revenue justifies (K11)
      allocatedStorage: 20,
      backupRetention: cdk.Duration.days(prod ? 14 : 3),
      deletionProtection: prod,
    });

    // ── media (S3 + CloudFront) ─────────────────────────────────────────────
    const media = new s3.Bucket(this, "Media", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: ["*"], // tightened to APP_URL post-DNS
          allowedHeaders: ["*"],
        },
      ],
      lifecycleRules: [{ abortIncompleteMultipartUploadAfter: cdk.Duration.days(2) }],
    });
    const cdn = new cloudfront.Distribution(this, "MediaCdn", {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(media),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
    });

    // ── container registries (created by the bootstrap stack, imported here) ─
    // Imported by name so images can be pushed BEFORE this stack creates the
    // App Runner service / worker that reference `:latest`.
    const webRepo = ecr.Repository.fromRepositoryName(
      this,
      "WebRepo",
      `gigit-web-${props.stage}`,
    );
    const workerRepo = ecr.Repository.fromRepositoryName(
      this,
      "WorkerRepo",
      `gigit-worker-${props.stage}`,
    );

    // ── app secrets (DATABASE_URL, SESSION_SECRET, STRIPE_*, TWILIO_*) ──────
    const appSecrets = new secretsmanager.Secret(this, "AppSecrets", {
      description: "Gigit application env (filled manually per stage)",
    });

    // Env wiring (both containers boot with an empty env otherwise → env() throws
    // on DATABASE_URL/SESSION_SECRET → crash-loop). Secret-backed keys are filled
    // by the operator in AppSecrets; the rest are computed from this stack so they
    // can't drift or be forgotten on the checklist.
    const SECRET_ENV_KEYS = [
      "DATABASE_URL",
      "SESSION_SECRET",
      "APP_URL", // the public web origin — used in every emailed/SMS link + Stripe redirect
      "EMAIL_FROM",
      "PAYMENTS_ENABLED",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "GEMINI_API_KEY",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_FROM",
      "SENTRY_DSN",
    ];
    const computedEnv: Record<string, string> = {
      NODE_ENV: "production",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: media.bucketName,
      AWS_REGION: this.region,
      MEDIA_CDN_URL: `https://${cdn.distributionDomainName}`,
    };

    // ── web: App Runner from ECR ────────────────────────────────────────────
    const accessRole = new iam.Role(this, "AppRunnerAccessRole", {
      assumedBy: new iam.ServicePrincipal("build.apprunner.amazonaws.com"),
    });
    webRepo.grantPull(accessRole);
    const instanceRole = new iam.Role(this, "AppRunnerInstanceRole", {
      assumedBy: new iam.ServicePrincipal("tasks.apprunner.amazonaws.com"),
    });
    media.grantReadWrite(instanceRole);
    appSecrets.grantRead(instanceRole);

    new apprunner.CfnService(this, "Web", {
      serviceName: `gigit-web-${props.stage}`,
      sourceConfiguration: {
        authenticationConfiguration: { accessRoleArn: accessRole.roleArn },
        autoDeploymentsEnabled: true,
        imageRepository: {
          imageIdentifier: `${webRepo.repositoryUri}:latest`,
          imageRepositoryType: "ECR",
          imageConfiguration: {
            port: "3000",
            // App Runner resolves each secret-manager JSON key by ref; without
            // this the container has no DATABASE_URL/SESSION_SECRET and crash-loops.
            runtimeEnvironmentSecrets: SECRET_ENV_KEYS.map((name) => ({
              name,
              value: `${appSecrets.secretArn}:${name}::`,
            })),
            runtimeEnvironmentVariables: Object.entries(computedEnv).map(
              ([name, value]) => ({ name, value }),
            ),
          },
        },
      },
      instanceConfiguration: {
        cpu: prod ? "1 vCPU" : "0.5 vCPU",
        memory: prod ? "2 GB" : "1 GB",
        instanceRoleArn: instanceRole.roleArn,
      },
    });

    // ── worker: one small EC2 running the container (K11) ──────────────────
    const workerSg = new ec2.SecurityGroup(this, "WorkerSg", { vpc });
    database.connections.allowFrom(workerSg, ec2.Port.tcp(5432));
    const workerRole = new iam.Role(this, "WorkerRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    workerRepo.grantPull(workerRole);
    appSecrets.grantRead(workerRole);
    workerRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["ses:SendEmail"], resources: ["*"] }),
    );

    // ECR registry host (token-safe — do NOT .split() a repositoryUri token).
    const registry = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`;
    const workerImage = `${workerRepo.repositoryUri}:latest`;
    const computedEnvLines = Object.entries(computedEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
    // One materialize-and-run script lives on the instance, so the first boot and
    // every later redeploy (deploy.sh / CI via SSM) share the same env wiring:
    // pull AppSecrets → /etc/gigit.env, append the computed vars, run the image
    // with --env-file. Without this the worker boots with no DATABASE_URL.
    const runWorkerScript = [
      "#!/bin/bash",
      "set -euo pipefail",
      `aws secretsmanager get-secret-value --region ${this.region} --secret-id ${appSecrets.secretArn} --query SecretString --output text | jq -r 'to_entries[]|"\\(.key)=\\(.value)"' > /etc/gigit.env`,
      "cat >> /etc/gigit.env <<'ENVEOF'",
      computedEnvLines,
      "ENVEOF",
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${registry}`,
      `docker pull ${workerImage}`,
      "docker rm -f worker || true",
      `docker run -d --restart=always --name worker --env-file /etc/gigit.env ${workerImage}`,
    ].join("\n");
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "dnf install -y docker jq && systemctl enable --now docker",
      `cat > /usr/local/bin/run-worker.sh <<'EOS'\n${runWorkerScript}\nEOS`,
      "chmod +x /usr/local/bin/run-worker.sh",
      "/usr/local/bin/run-worker.sh",
    );
    const worker = new ec2.Instance(this, "Worker", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: workerSg,
      role: workerRole,
      userData,
    });

    // ── Alarms (technical-design §7.7): page a human, not a dashboard ──
    const alerts = new sns.Topic(this, "OpsAlerts"); // subscribe email/SMS post-deploy
    const page = new cwactions.SnsAction(alerts);
    const alarm = (id: string, metric: cloudwatch.IMetric, threshold: number, opts?: Partial<cloudwatch.AlarmProps>) => {
      const a = new cloudwatch.Alarm(this, id, {
        metric: metric as cloudwatch.Metric,
        threshold,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        ...opts,
      });
      a.addAlarmAction(page);
      return a;
    };
    alarm("DbCpuAlarm", database.metricCPUUtilization(), 90);
    alarm("DbStorageAlarm", database.metricFreeStorageSpace(), 2 * 1024 ** 3, {
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    });
    alarm(
      "WorkerStatusAlarm",
      new cloudwatch.Metric({
        namespace: "AWS/EC2",
        metricName: "StatusCheckFailed",
        dimensionsMap: { InstanceId: worker.instanceId },
        statistic: "Maximum",
        period: cdk.Duration.minutes(5),
      }),
      1,
      { comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD },
    );

    new cdk.CfnOutput(this, "OpsAlertsTopic", { value: alerts.topicArn });
    new cdk.CfnOutput(this, "MediaCdnDomain", { value: cdn.distributionDomainName });
    new cdk.CfnOutput(this, "DbEndpoint", { value: database.instanceEndpoint.hostname });
  }
}
