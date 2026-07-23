/**
 * Open Reachout instance for EightGig (reachout.eightgig.com) — the outbound
 * seeding engine, deployed ALONGSIDE prod in the EightGig account but on its
 * own small host: it is a different workload (Python compose stack, its own
 * Postgres) with a different risk profile, and it must never contend with the
 * marketplace for resources.
 *
 * Topology: one t3.small in the default VPC running the upstream
 * docker-compose (db/migrate/api/worker) plus a Caddy front for TLS.
 * Secrets/config arrive via SSM SecureString parameters under
 * /eightgig/reachout/* (written by the operator/session, never baked into
 * user-data). Sending remains halted until `reachout resume` on the host —
 * this stack ships a research/discovery instance, not a mailer.
 */
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export interface ReachoutStackProps extends cdk.StackProps {
  domainName: string; // reachout.eightgig.com
  hostedZoneName: string; // eightgig.com
}

export class ReachoutStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ReachoutStackProps) {
    super(scope, id, props);

    const vpc = ec2.Vpc.fromLookup(this, "DefaultVpc", { isDefault: true });

    const sg = new ec2.SecurityGroup(this, "ReachoutSg", {
      vpc,
      description: "reachout.eightgig.com - Caddy TLS front",
    });
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), "ACME + redirect");
    sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "dashboard/API");

    const role = new iam.Role(this, "ReachoutRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore"),
      ],
    });
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter", "ssm:GetParameters"],
        resources: [
          `arn:aws:ssm:${this.region}:${this.account}:parameter/eightgig/reachout/*`,
        ],
      }),
    );
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ["s3:GetObject"],
        resources: [`arn:aws:s3:::eightgig-reachout-config-${this.account}/*`],
      }),
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "set -euo pipefail",
      "dnf install -y docker git",
      "systemctl enable --now docker",
      // compose v2 plugin
      "mkdir -p /usr/local/lib/docker/cli-plugins",
      "curl -fsSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 -o /usr/local/lib/docker/cli-plugins/docker-compose",
      "chmod +x /usr/local/lib/docker/cli-plugins/docker-compose",
      "mkdir -p /opt/reachout/src && cd /opt/reachout",
      // the framework repo is private: source ships as a tarball via the same
      // S3 bucket as the tenant config (refresh = re-upload + re-run these steps)
      `aws s3 cp s3://eightgig-reachout-config-${this.account}/src/open-reachout.tar.gz /opt/reachout/open-reachout.tar.gz --region ${this.region}`,
      "tar -xzf open-reachout.tar.gz -C /opt/reachout/src",
      "cd /opt/reachout/src",
      // config + env from SSM (SecureString) — operator-writable, never in this template
      `aws ssm get-parameter --with-decryption --name /eightgig/reachout/env --query Parameter.Value --output text --region ${this.region} > .env`,
      "mkdir -p config/eightgig-mke",
      // tenant config from S3 (too large for SSM; contains no secrets)
      `aws s3 cp s3://eightgig-reachout-config-${this.account}/config/eightgig-mke/tenant.yaml config/eightgig-mke/tenant.yaml --region ${this.region}`,
      // Caddy TLS front as a compose override joining the app network
      `cat > docker-compose.override.yml <<'EOF'
services:
  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
volumes:
  caddy_data: {}
EOF`,
      `cat > Caddyfile <<'EOF'
${props.domainName} {
  reverse_proxy api:8714
}
EOF`,
      "docker compose up -d --build",
    );

    const host = new ec2.Instance(this, "ReachoutHost", {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.SMALL),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: sg,
      role,
      userData,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    });

    const eip = new ec2.CfnEIP(this, "ReachoutEip", {
      instanceId: host.instanceId,
    });

    const zone = route53.HostedZone.fromLookup(this, "Zone", {
      domainName: props.hostedZoneName,
    });
    new route53.ARecord(this, "ReachoutARecord", {
      zone,
      recordName: props.domainName,
      target: route53.RecordTarget.fromIpAddresses(eip.attrPublicIp),
    });

    new cdk.CfnOutput(this, "ReachoutUrl", { value: `https://${props.domainName}` });
    new cdk.CfnOutput(this, "ReachoutInstanceId", { value: host.instanceId });
  }
}
