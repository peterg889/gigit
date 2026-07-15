/**
 * Gigit infrastructure (engineering-spec K11): deliberately minimal —
 * one EC2 host (web + worker) + ALB/CloudFront + RDS + S3/CloudFront + SES.
 * No Fargate, no NAT gateway, no cluster.
 */
import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwactions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as targets from "aws-cdk-lib/aws-elasticloadbalancingv2-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as rds from "aws-cdk-lib/aws-rds";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import * as ssm from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { createHash } from "node:crypto";

export interface GigitStackProps extends cdk.StackProps {
  stage: "staging" | "prod";
  domainName?: string;
  hostedZoneName?: string;
}

export class GigitStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: GigitStackProps) {
    super(scope, id, props);
    const prod = props.stage === "prod";
    if (Boolean(props.domainName) !== Boolean(props.hostedZoneName)) {
      throw new Error("domainName and hostedZoneName must be configured together");
    }
    const publicAppUrl = props.domainName
      ? `https://${props.domainName}`
      : undefined;

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Data",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });
    const albSg = new ec2.SecurityGroup(this, "AlbSg", { vpc });
    const hostSg = new ec2.SecurityGroup(this, "HostSg", { vpc });

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
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T4G,
        prod ? ec2.InstanceSize.SMALL : ec2.InstanceSize.MICRO,
      ),
      credentials: rds.Credentials.fromSecret(dbSecret),
      databaseName: "gigit",
      multiAz: false, // single-AZ at launch; flip when revenue justifies (K11)
      allocatedStorage: 20,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(prod ? 14 : 7),
      deletionProtection: prod,
    });
    database.connections.allowFrom(hostSg, ec2.Port.tcp(5432));

    // ── media (S3 + CloudFront) ─────────────────────────────────────────────
    const media = new s3.Bucket(this, "Media", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT],
          allowedOrigins: publicAppUrl ? [publicAppUrl] : ["*"],
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
    // Imported by name so immutable release images can be pushed before the
    // service stack creates the host that pulls them.
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
    // Keep generated credentials out of the CloudFormation template. AppSecrets
    // is initialized from Secrets Manager dynamic references so both containers
    // can start successfully on the first deployment, before operator edits.
    const sessionSecret = new secretsmanager.Secret(this, "SessionSecret", {
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
      },
    });
    const databaseUrl = cdk.SecretValue.unsafePlainText(
      cdk.Fn.join("", [
        "postgresql://",
        dbSecret.secretValueFromJson("username").unsafeUnwrap(),
        ":",
        dbSecret.secretValueFromJson("password").unsafeUnwrap(),
        "@",
        database.instanceEndpoint.hostname,
        ":",
        database.instanceEndpoint.port.toString(),
        "/gigit?sslmode=verify-full&sslrootcert=/etc/ssl/certs/aws-rds-global-bundle.pem",
      ]),
    );
    const emptySecretValue = () => cdk.SecretValue.unsafePlainText("");
    const appSecrets = new secretsmanager.Secret(this, "AppSecrets", {
      description: "Gigit application environment",
      secretObjectValue: {
        DATABASE_URL: databaseUrl,
        SESSION_SECRET: sessionSecret.secretValue,
        EMAIL_FROM: emptySecretValue(),
        PAYMENTS_ENABLED: cdk.SecretValue.unsafePlainText("false"),
        STRIPE_SECRET_KEY: emptySecretValue(),
        STRIPE_WEBHOOK_SECRET: emptySecretValue(),
        GEMINI_API_KEY: emptySecretValue(),
        TWILIO_ACCOUNT_SID: emptySecretValue(),
        TWILIO_AUTH_TOKEN: emptySecretValue(),
        TWILIO_FROM: emptySecretValue(),
        SENTRY_DSN: emptySecretValue(),
      },
    });
    const originVerifySecret = new secretsmanager.Secret(
      this,
      "OriginVerifySecret",
      {
        description: "Shared only by CloudFront and the ALB listener",
        generateSecretString: {
          passwordLength: 48,
          excludePunctuation: true,
        },
      },
    );
    const originVerifyHeader = originVerifySecret.secretValue.unsafeUnwrap();

    // Infrastructure-derived values are appended by the host deployment script
    // so operator-managed provider secrets cannot make them drift.
    const computedEnv: Record<string, string> = {
      NODE_ENV: "production",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: media.bucketName,
      AWS_REGION: this.region,
      MEDIA_CDN_URL: `https://${cdn.distributionDomainName}`,
    };

    // ── one EC2 host: web + worker containers (K11) ────────────────────────
    const hostRole = new iam.Role(this, "HostRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    webRepo.grantPull(hostRole);
    workerRepo.grantPull(hostRole);
    media.grantReadWrite(hostRole);
    appSecrets.grantRead(hostRole);
    hostRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["ses:SendEmail"], resources: ["*"] }),
    );

    // ECR registry host is token-safe; deployment selects immutable image tags.
    const registry = `${this.account}.dkr.ecr.${this.region}.amazonaws.com`;
    const computedEnvLines = Object.entries(computedEnv)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");

    const alb = new elbv2.ApplicationLoadBalancer(this, "WebAlb", {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSg,
    });
    const cloudFrontOrigins = ec2.PrefixList.fromLookup(
      this,
      "CloudFrontOrigins",
      {
        prefixListName: "com.amazonaws.global.cloudfront.origin-facing",
      },
    );
    alb.connections.allowFrom(
      ec2.Peer.prefixList(cloudFrontOrigins.prefixListId),
      ec2.Port.tcp(80),
    );

    // This script stays stable across releases: the SSM association passes both
    // the immutable tag and final CloudFront origin on every rollout.
    const deployHostScript = [
      "#!/bin/bash",
      "set -euo pipefail",
      "umask 077",
      'IMAGE_TAG="${1:?image tag required}"',
      'APP_URL="${2:?application URL required}"',
      'case "$IMAGE_TAG" in',
      '  ""|*[!A-Za-z0-9._:-]*) echo "invalid image tag" >&2; exit 2 ;;',
      "esac",
      'ENV_FILE="$(mktemp)"',
      `aws secretsmanager get-secret-value --region ${this.region} --secret-id ${appSecrets.secretArn} --query SecretString --output text | jq -r 'to_entries[] | "\\(.key)=\\(.value|tostring)"' > "$ENV_FILE"`,
      'cat >> "$ENV_FILE" <<ENVEOF',
      computedEnvLines,
      "APP_URL=${APP_URL}",
      "ENVEOF",
      'install -m 600 "$ENV_FILE" /etc/gigit.env',
      'rm -f "$ENV_FILE"',
      `aws ecr get-login-password --region ${this.region} | docker login --username AWS --password-stdin ${registry}`,
      `WEB_REPO="${webRepo.repositoryUri}"`,
      `WORKER_REPO="${workerRepo.repositoryUri}"`,
      'WEB_IMAGE="${WEB_REPO}:${IMAGE_TAG}"',
      'WORKER_IMAGE="${WORKER_REPO}:${IMAGE_TAG}"',
      'docker pull "$WEB_IMAGE"',
      'docker pull "$WORKER_IMAGE"',
      "docker rm -f worker || true",
      'docker run --rm --env-file /etc/gigit.env "$WORKER_IMAGE" pnpm --filter @gigit/db migrate',
      "docker rm -f web || true",
      'docker run -d --restart=always --log-opt max-size=10m --log-opt max-file=3 --name web --env-file /etc/gigit.env -p 3000:3000 "$WEB_IMAGE"',
      "for attempt in $(seq 1 60); do",
      '  if curl -fsS http://127.0.0.1:3000/api/health >/dev/null && curl -fsS http://127.0.0.1:3000/slots >/dev/null; then',
      "    break",
      "  fi",
      '  if [ "$attempt" -eq 60 ]; then',
      "    docker logs web >&2 || true",
      "    exit 1",
      "  fi",
      "  sleep 5",
      "done",
      'docker run -d --restart=always --log-opt max-size=10m --log-opt max-file=3 --name worker --env-file /etc/gigit.env "$WORKER_IMAGE"',
      "sleep 5",
      "test \"$(docker inspect -f '{{.State.Running}}' worker)\" = \"true\"",
      "docker image prune -a -f >/dev/null",
      'printf "%s\\n" "$IMAGE_TAG" > /var/lib/gigit-release',
    ].join("\n");

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "dnf install -y docker jq && systemctl enable --now docker",
      `cat > /usr/local/bin/deploy-release.sh <<'EOS'\n${deployHostScript}\nEOS`,
      "chmod +x /usr/local/bin/deploy-release.sh",
    );

    const host = new ec2.Instance(this, "Host", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      associatePublicIpAddress: true,
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.X86_64,
      }),
      securityGroup: hostSg,
      role: hostRole,
      userData,
      userDataCausesReplacement: true,
      httpTokens: ec2.HttpTokens.REQUIRED,
      httpPutResponseHopLimit: 2,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(30, { volumeType: ec2.EbsDeviceVolumeType.GP3, encrypted: true }),
        },
      ],
    });
    hostSg.addIngressRule(albSg, ec2.Port.tcp(3000));

    const webTargets = new elbv2.ApplicationTargetGroup(this, "WebTargets", {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [new targets.InstanceTarget(host, 3000)],
      healthCheck: {
        path: "/api/health",
        healthyHttpCodes: "200",
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });
    const listener = alb.addListener("Http", {
      port: 80,
      open: false,
      defaultAction: elbv2.ListenerAction.fixedResponse(403, {
        contentType: "text/plain",
        messageBody: "Forbidden",
      }),
    });
    listener.addTargetGroups("CloudFrontOnly", {
      priority: 1,
      conditions: [
        elbv2.ListenerCondition.httpHeader("X-Gigit-Origin-Verify", [
          originVerifyHeader,
        ]),
      ],
      targetGroups: [webTargets],
    });

    const webHostedZone = props.hostedZoneName
      ? route53.HostedZone.fromLookup(this, "WebHostedZone", {
          domainName: props.hostedZoneName,
        })
      : undefined;
    const webCertificate = props.domainName && webHostedZone
      ? new acm.Certificate(this, "WebCertificate", {
          domainName: props.domainName,
          validation: acm.CertificateValidation.fromDns(webHostedZone),
        })
      : undefined;

    const webCdn = new cloudfront.Distribution(this, "WebCdn", {
      certificate: webCertificate,
      domainNames: props.domainName ? [props.domainName] : undefined,
      minimumProtocolVersion: webCertificate
        ? cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021
        : undefined,
      defaultBehavior: {
        origin: new origins.LoadBalancerV2Origin(alb, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          customHeaders: {
            "X-Gigit-Origin-Verify": originVerifyHeader,
          },
        }),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy:
          cloudfront.OriginRequestPolicy.ALL_VIEWER_AND_CLOUDFRONT_2022,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
      },
    });
    if (props.domainName && webHostedZone) {
      new route53.ARecord(this, "WebAliasIpv4", {
        zone: webHostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(webCdn),
        ),
      });
      new route53.AaaaRecord(this, "WebAliasIpv6", {
        zone: webHostedZone,
        recordName: props.domainName,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(webCdn),
        ),
      });
    }
    const webUrl = publicAppUrl ?? `https://${webCdn.distributionDomainName}`;

    const imageTag = String(
      this.node.tryGetContext("imageTag") ?? "initial",
    );
    const deploymentNonce = String(
      this.node.tryGetContext("deploymentNonce") ?? "initial",
    );
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(imageTag)) {
      throw new Error(
        "imageTag must be a Docker tag: 1-128 characters, starting with a letter, number, or underscore",
      );
    }
    if (!/^[A-Za-z0-9._:-]+$/.test(deploymentNonce)) {
      throw new Error(
        "deploymentNonce may contain only letters, numbers, dot, underscore, colon, and hyphen",
      );
    }

    // State Manager can create an association before a new instance has joined
    // SSM, which makes CloudFormation report CREATE_COMPLETE before the command
    // eventually runs. A fresh wait-condition handle for every release turns
    // the host's actual health-gated result into the deployment result.
    const deploymentKey = createHash("sha256")
      .update(`${imageTag}:${deploymentNonce}`)
      .digest("hex")
      .slice(0, 12);
    const deploySignalHandle = new cdk.CfnWaitConditionHandle(
      this,
      `DeploySignalHandle${deploymentKey}`,
    );

    const deployAssociation = new ssm.CfnAssociation(this, "DeployRelease", {
      name: "AWS-RunShellScript",
      associationName: `gigit-deploy-release-${props.stage}`,
      targets: [{ key: "InstanceIds", values: [host.instanceId] }],
      parameters: {
        commands: [
          `printf '%s\\n' '${deploymentNonce}' > /var/lib/gigit-deployment-nonce`,
          "until [ -x /usr/local/bin/deploy-release.sh ]; do sleep 5; done",
          "set +e",
          `/usr/local/bin/deploy-release.sh '${imageTag}' '${webUrl}' > /var/log/gigit-deploy.log 2>&1`,
          "DEPLOY_STATUS=$?",
          "tail -n 200 /var/log/gigit-deploy.log > /dev/console || true",
          `if [ "$DEPLOY_STATUS" -eq 0 ]; then SIGNAL_STATUS=SUCCESS; SIGNAL_REASON='release ${imageTag} healthy'; else SIGNAL_STATUS=FAILURE; SIGNAL_REASON='release ${imageTag} failed; inspect EC2 console'; fi`,
          `SIGNAL_URL='${deploySignalHandle.ref}'`,
          `curl -fsS -X PUT -H 'Content-Type:' --data-binary "{\\"Status\\":\\"$SIGNAL_STATUS\\",\\"Reason\\":\\"$SIGNAL_REASON\\",\\"UniqueId\\":\\"${deploymentKey}\\",\\"Data\\":\\"${imageTag}\\"}" "$SIGNAL_URL"`,
          'exit "$DEPLOY_STATUS"',
        ],
      },
      waitForSuccessTimeoutSeconds: 900,
    });
    deployAssociation.node.addDependency(host);
    const deployWaitCondition = new cdk.CfnWaitCondition(
      this,
      `DeployWaitCondition${deploymentKey}`,
      {
        count: 1,
        handle: deploySignalHandle.ref,
        timeout: "900",
      },
    );
    deployWaitCondition.addDependency(deployAssociation);

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
      "HostStatusAlarm",
      new cloudwatch.Metric({
        namespace: "AWS/EC2",
        metricName: "StatusCheckFailed",
        dimensionsMap: { InstanceId: host.instanceId },
        statistic: "Maximum",
        period: cdk.Duration.minutes(5),
      }),
      1,
      { comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD },
    );


    alarm(
      "AlbUnhealthyAlarm",
      webTargets.metrics.unhealthyHostCount({
        statistic: "Maximum",
        period: cdk.Duration.minutes(1),
      }),
      1,
      {
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 2,
      },
    );
    new cdk.CfnOutput(this, "OpsAlertsTopic", { value: alerts.topicArn });
    new cdk.CfnOutput(this, "MediaCdnDomain", { value: cdn.distributionDomainName });
    new cdk.CfnOutput(this, "DbEndpoint", { value: database.instanceEndpoint.hostname });
    new cdk.CfnOutput(this, "WebUrl", { value: webUrl });
    new cdk.CfnOutput(this, "HostInstanceId", { value: host.instanceId });
    new cdk.CfnOutput(this, "WebAlbDnsName", { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, "AppSecretsArn", { value: appSecrets.secretArn });
    new cdk.CfnOutput(this, "DbSecretArn", { value: dbSecret.secretArn });
  }
}
