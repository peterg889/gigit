/**
 * Assertions about the resources that protect this product.
 *
 * Companion to host-userdata-stability.test.ts: that file pins the deploy
 * mechanism, this one pins the guard rails. Everything here is a property that
 * can be removed WITHOUT anything looking broken — an alarm with no action
 * still shows up green in the console, a database that lost deletion protection
 * still serves queries, a bucket that comes back still passes every unit test.
 * Those are the failures worth a test; the ones that announce themselves are
 * not.
 *
 * Concretely, this week: production raised a HostStatusAlarm that notified
 * nobody, the media bucket and its CDN were deleted for DMCA reasons, and the
 * health-check interval went 30s -> 10s. None of that was pinned.
 *
 * No AWS credentials required — see synth-template.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { pick, renderJoin, stages, synthesize, type Template } from "./synth-template.js";
// Reached for by relative path on purpose: @gigit/infra depends on nothing in
// the app workspace, and this is the ONE thing the stack and the worker have to
// agree on letter-for-letter. See apps/worker/src/metric-names.ts.
import { WORKER_METRICS, WORKER_METRIC_NAMES } from "../../../apps/worker/src/metric-names.js";

/**
 * Every ingress rule attached to a security group, from BOTH places CDK puts
 * them. This is not pedantry: CDK inlines a rule into the group's own
 * `SecurityGroupIngress` property whenever it can, and only emits a standalone
 * `AWS::EC2::SecurityGroupIngress` resource when the peer is another security
 * group in the same template. So `hostSg.addIngressRule(Peer.anyIpv4(), ...)`
 * — the single most dangerous edit anyone can make here — produces an INLINE
 * rule and is invisible to a test that only reads the standalone resources.
 * (Verified: a first draft of these tests scanned only the standalone
 * resources and passed happily with port 3000 open to 0.0.0.0/0.)
 */
const ingressFor = (template: Template, sgLogicalId: string) => [
  ...((template.Resources[sgLogicalId].Properties.SecurityGroupIngress ?? []) as any[]),
  ...pick(template, "AWS::EC2::SecurityGroupIngress")
    .filter(([, r]) => r.Properties.GroupId?.["Fn::GetAtt"]?.[0] === sgLogicalId)
    .map(([, r]) => r.Properties),
];

const allIngress = (template: Template) =>
  pick(template, "AWS::EC2::SecurityGroup").flatMap(([id]) => ingressFor(template, id));

// Logical ids are stable across both stages (CDK hashes the construct path
// suffix only), so the tests can name them and fail loudly if one moves.
const HOST_SG = "HostSgFEF2A25E";
const ALB_SG = "AlbSg1155C1BE";
const DB_SG = "DbSecurityGroupC34ABFAB";

// ── alarms ────────────────────────────────────────────────────────────────

/**
 * The seven alarms, by the thing each one watches. Keyed by logical-id prefix
 * because CDK appends a hash; the value is what the alarm is FOR, which is the
 * part a refactor can silently drop.
 */
const expectedAlarms: Record<string, { namespace: string; metricName: string }> = {
  DbCpuAlarm: { namespace: "AWS/RDS", metricName: "CPUUtilization" },
  DbStorageAlarm: { namespace: "AWS/RDS", metricName: "FreeStorageSpace" },
  HostStatusAlarm: { namespace: "AWS/EC2", metricName: "StatusCheckFailed" },
  AlbUnhealthyAlarm: { namespace: "AWS/ApplicationELB", metricName: "UnHealthyHostCount" },
  // The three Gigit-namespace names come from the worker's own constant, not
  // from a second copy of the literal — see the import at the top of the file.
  OutboxDeadLetterAlarm: { namespace: "Gigit", metricName: WORKER_METRICS.deadLetteredEvents },
  OutboxLagAlarm: { namespace: "Gigit", metricName: WORKER_METRICS.outboxLagMs },
  MoneyMismatchAlarm: { namespace: "Gigit", metricName: WORKER_METRICS.moneyMismatches },
};

for (const stage of stages) {
  test(`[${stage}] every alarm notifies the OpsAlerts topic`, () => {
    const template = synthesize(stage);
    // OpsAlerts BY NAME, not "the first SNS topic in the template". The moment
    // a second topic exists (deploy notices, a billing feed) the positional
    // version starts comparing the alarms against whichever topic CDK emitted
    // first — so alarms rewired to the wrong topic would pass. Verified: adding
    // a DeployNotices topic and pointing `page` at it failed nothing until this
    // lookup was made explicit.
    const topic = pick(template, "AWS::SNS::Topic").find(([id]) => id.startsWith("OpsAlerts"));
    assert.ok(topic, "the OpsAlerts topic is gone; the alarms have nowhere to page");
    const [topicLogicalId] = topic;
    const alarms = pick(template, "AWS::CloudWatch::Alarm");

    // THE headline assertion. An alarm with no action is the exact silent
    // failure this suite exists for: it evaluates, it goes red in the console,
    // and it pages nobody. Nothing else in the system notices, so the first
    // sign is the outage the alarm was supposed to pre-empt.
    for (const [logicalId, alarm] of alarms) {
      assert.deepEqual(
        alarm.Properties.AlarmActions,
        [{ Ref: topicLogicalId }],
        `${logicalId} does not notify OpsAlerts; it would fire into the void`,
      );
    }

    // Count, not just per-alarm: without this a NEW alarm added without an
    // action passes, because the loop above only checks alarms it can see and
    // every existing one is fine. Bump this deliberately when you add one.
    assert.equal(
      alarms.length,
      Object.keys(expectedAlarms).length,
      "alarm count changed; if you added an alarm, add it to expectedAlarms and confirm it has an SNS action",
    );
  });

  test(`[${stage}] each alarm still watches the metric it was created for`, () => {
    const template = synthesize(stage);
    const alarms = pick(template, "AWS::CloudWatch::Alarm");

    for (const [prefix, expected] of Object.entries(expectedAlarms)) {
      const found = alarms.find(([logicalId]) => logicalId.startsWith(prefix));
      assert.ok(found, `${prefix} is gone; nothing watches ${expected.metricName} any more`);
      const [, alarm] = found;
      assert.equal(alarm.Properties.Namespace, expected.namespace, prefix);
      assert.equal(alarm.Properties.MetricName, expected.metricName, prefix);
    }
  });

  test(`[${stage}] worker alarms watch this stage's metrics, not the other stage's`, () => {
    const template = synthesize(stage);
    // The worker emits into one namespace for both stages and separates them
    // by the Stage dimension. A copy-pasted `dimensionsMap: { Stage: "staging" }`
    // in the prod stack would leave prod's money-reconciliation alarm watching
    // STAGING's metric: permanently quiet, permanently green, and completely
    // blind to a real prod mismatch. Nothing about that looks wrong anywhere.
    for (const [logicalId, alarm] of pick(template, "AWS::CloudWatch::Alarm")) {
      if (alarm.Properties.Namespace !== "Gigit") continue;
      assert.deepEqual(
        alarm.Properties.Dimensions,
        [{ Name: "Stage", Value: stage }],
        `${logicalId} is dimensioned for the wrong stage`,
      );
    }
  });

  test(`[${stage}] every Gigit alarm watches a metric the worker actually publishes`, () => {
    const template = synthesize(stage);
    // Both directions, because each is a different silent failure:
    //
    //  - alarm -> worker: an alarm naming a metric nothing emits never leaves
    //    INSUFFICIENT_DATA. It looks provisioned, it looks green-ish, and it
    //    pages nobody for the rest of its life.
    //  - worker -> alarm: a metric published with no alarm is a number in
    //    CloudWatch that no human will ever look at, which is the same as not
    //    publishing it.
    //
    // The set on the worker side is the constant the worker's putMetrics calls
    // are built from (apps/worker/src/metric-names.ts), so this is a real join
    // across the two repos-in-one, not a restatement of the stack's literals.
    const watched = pick(template, "AWS::CloudWatch::Alarm")
      .filter(([, a]) => a.Properties.Namespace === "Gigit")
      .map(([, a]) => a.Properties.MetricName as string)
      .sort();
    assert.deepEqual(
      watched,
      [...WORKER_METRIC_NAMES].sort(),
      "the Gigit alarms and the worker's published metric names have drifted apart",
    );
  });
}

test("money and outbox alarms fire on the first breach, not the third", () => {
  const template = synthesize("prod");
  // These metrics are emitted by periodic worker jobs (15-minute outbox
  // reconcile, nightly money reconcile), so datapoints are scarce. The default
  // `evaluationPeriods: 3` would mean waiting three nights before an unbalanced
  // ledger paged anyone. One breach is enough; a raise back to 3 is invisible.
  for (const [logicalId, alarm] of pick(template, "AWS::CloudWatch::Alarm")) {
    if (alarm.Properties.Namespace !== "Gigit") continue;
    assert.equal(alarm.Properties.EvaluationPeriods, 1, logicalId);
    // ...and missing data must NOT be breaching for these: the metric simply
    // stops when the worker is down, which HostStatusAlarm already pages for.
    assert.equal(alarm.Properties.TreatMissingData, "notBreaching", logicalId);
  }
  const [, money] = pick(template, "AWS::CloudWatch::Alarm").find(([id]) =>
    id.startsWith("MoneyMismatchAlarm"),
  )!;
  // The reconcile runs nightly. A period shorter than a day leaves the alarm in
  // INSUFFICIENT_DATA for most of its life, which reads as "fine" at a glance.
  assert.ok(
    money.Properties.Period >= 86400,
    `MoneyMismatchAlarm period is ${money.Properties.Period}s; shorter than the nightly reconcile that feeds it`,
  );
});

// ── database ──────────────────────────────────────────────────────────────

for (const stage of stages) {
  test(`[${stage}] the database is unreachable from the internet and encrypted at rest`, () => {
    const template = synthesize(stage);
    const [[, db]] = pick(template, "AWS::RDS::DBInstance");

    // Not set literally in the stack — CDK derives it from the isolated subnet
    // group. That is exactly why it is worth asserting: moving the instance to
    // the public subnets (a one-word edit to `vpcSubnets`) flips this to true
    // and puts the booking database on the public internet, with nothing in the
    // diff that says "public".
    assert.equal(db.Properties.PubliclyAccessible, false);
    assert.equal(db.Properties.StorageEncrypted, true);

    // The only thing allowed to open a Postgres connection is the app host.
    const dbIngress = ingressFor(template, DB_SG);
    assert.equal(dbIngress.length, 1, "the database should accept exactly one source");
    assert.equal(dbIngress[0].ToPort, 5432);
    assert.deepEqual(dbIngress[0].SourceSecurityGroupId, {
      "Fn::GetAtt": [HOST_SG, "GroupId"],
    });
    assert.equal(dbIngress[0].CidrIp, undefined);
  });
}

test("deletion protection and backup retention differ by stage on purpose", () => {
  const [staging] = pick(synthesize("staging"), "AWS::RDS::DBInstance");
  const [prod] = pick(synthesize("prod"), "AWS::RDS::DBInstance");

  // `deletionProtection: prod` in the stack. Both halves matter:
  //  - prod ON: the last line of defence against `cdk destroy` against the
  //    wrong stack taking every booking with it.
  //  - staging OFF deliberately: staging is meant to be destroyable, and a
  //    protected staging DB turns a routine teardown into a support ticket.
  // Asserting only the prod half would let someone "fix" staging to match and
  // never learn the difference was intentional.
  assert.equal(prod[1].Properties.DeletionProtection, true);
  assert.equal(staging[1].Properties.DeletionProtection, false);

  // Retention is silent in the other direction: a shortened window costs
  // nothing until the day you need a restore from eight days ago.
  assert.equal(prod[1].Properties.BackupRetentionPeriod, 14);
  assert.equal(staging[1].Properties.BackupRetentionPeriod, 7);
});

// ── no user-file storage (DMCA) ───────────────────────────────────────────

for (const stage of stages) {
  test(`[${stage}] no bucket and no media CDN: EightGig stores no user files`, () => {
    const template = synthesize(stage);

    // engineering-spec §8: photos, tracks and video are links to allow-listed
    // third-party hosts, never uploads. That is what keeps EightGig out of DMCA
    // §512(c) — no material is stored "at the direction of a user". Re-adding a
    // bucket would restore the liability quietly, in a PR that reads like a
    // feature. Any S3 resource at all fails here, deliberately: the argument is
    // about storing user content, and an "internal only, honest" bucket is one
    // upload handler away from being the thing the spec forbids.
    const s3 = Object.entries(template.Resources).filter(([, r]) =>
      r.Type.startsWith("AWS::S3::"),
    );
    assert.deepEqual(
      s3.map(([id]) => id),
      [],
      "an S3 resource is back; EightGig is supposed to store no user files (DMCA §512(c))",
    );

    // Exactly one distribution, and it fronts the ALB. The count alone is not
    // enough — a media CDN could just as easily arrive as a second origin on
    // this distribution, or as an S3 origin replacing the ALB one.
    const distributions = pick(template, "AWS::CloudFront::Distribution");
    assert.equal(distributions.length, 1, "the only CDN should be the web one");
    const origins = distributions[0][1].Properties.DistributionConfig.Origins as any[];
    assert.equal(origins.length, 1);
    assert.deepEqual(origins[0].DomainName, { "Fn::GetAtt": ["WebAlb916F4A49", "DNSName"] });
    assert.equal(origins[0].S3OriginConfig, undefined);
    assert.equal(origins[0].OriginAccessControlId, undefined);
  });
}

// ── secrets ───────────────────────────────────────────────────────────────

for (const stage of stages) {
  test(`[${stage}] no credential is written into the template in plaintext`, () => {
    const template = synthesize(stage);

    // A CloudFormation template is readable by anyone with ListStacks — and it
    // is on disk in cdk.out, in CI logs, and in the deploy artifact. Every
    // credential here must therefore be a `{{resolve:secretsmanager:}}`
    // reference that CloudFormation dereferences at deploy time, never a value.
    for (const [logicalId, secret] of pick(template, "AWS::SecretsManager::Secret")) {
      assert.notEqual(
        typeof secret.Properties.SecretString,
        "string",
        `${logicalId} has a literal SecretString; anyone who can read the template can read the secret`,
      );
    }

    // The RDS master password reaches the instance the same way.
    const [[, db]] = pick(template, "AWS::RDS::DBInstance");
    assert.match(renderJoin(db.Properties.MasterUserPassword), /^\{\{resolve:secretsmanager:/);

    // AppSecrets is assembled from dynamic references so both containers can
    // start on the very first deploy, before an operator has edited anything.
    // Render the Fn::Join back to a string and check every seeded value.
    const [[, appSecrets]] = pick(template, "AWS::SecretsManager::Secret").filter(
      ([id]) => id.startsWith("AppSecrets"),
    );
    const seeded = JSON.parse(renderJoin(appSecrets.Properties.SecretString)) as Record<
      string,
      string
    >;
    // Each value must be the WHOLE reference, an empty placeholder, or a
    // non-secret flag — never a string that merely CONTAINS a reference. That
    // distinction is the whole assertion: a `value.includes("{{resolve:")`
    // check passes happily on "{{resolve:...username...}}:hunter2@host/db",
    // i.e. with the password hardcoded next to a resolved username. (Verified:
    // replacing `dbSecret.secretValueFromJson("password")` with a literal was
    // the one mutation an earlier draft of this test did not catch.) A new
    // composite value fails here on purpose — it needs a shape assertion of its
    // own, the way DATABASE_URL has one below, rather than a substring match.
    for (const [key, value] of Object.entries(seeded)) {
      if (key === "DATABASE_URL") continue; // composite; pinned precisely below
      assert.ok(
        value === "" ||
          value === "false" ||
          /^\{\{resolve:secretsmanager:[^{}]+\}\}$/.test(value),
        `AppSecrets.${key} is not a bare Secrets Manager reference: ${value}`,
      );
    }
    // Named explicitly, because "" would satisfy the loop above: the session
    // signing key seeded empty would start a web container that signs every
    // cookie with nothing.
    assert.match(seeded.SESSION_SECRET, /^\{\{resolve:secretsmanager:/);
    // BOTH halves of the credential pair are references, asserted positionally.
    // This is the string a plaintext password would hide in.
    assert.match(
      seeded.DATABASE_URL,
      /^postgresql:\/\/\{\{resolve:secretsmanager:[^{}]+:SecretString:username::\}\}:\{\{resolve:secretsmanager:[^{}]+:SecretString:password::\}\}@/,
      `DATABASE_URL does not resolve BOTH credentials from Secrets Manager: ${seeded.DATABASE_URL}`,
    );
    // The connection string is the only thing that makes the DB link verified
    // TLS. Dropping `verify-full` still connects, still passes every test, and
    // silently accepts any certificate.
    assert.match(seeded.DATABASE_URL, /sslmode=verify-full/);

    // Deliberately absent. Any key listed in `secretObjectValue` is rewritten
    // to the template value on every stack update, so seeding SUPPORT_EMAIL_TO
    // would clobber the operator's address on the next unrelated deploy — and
    // support mail would go nowhere, with nothing logged at deploy time.
    assert.ok(
      !("SUPPORT_EMAIL_TO" in seeded),
      "SUPPORT_EMAIL_TO is operator-managed; seeding it here clobbers their value on every stack update",
    );
  });
}

// ── the ALB accepts CloudFront traffic only ───────────────────────────────

for (const stage of stages) {
  test(`[${stage}] the ALB serves only requests carrying CloudFront's shared secret`, () => {
    const template = synthesize(stage);
    const [[, listener]] = pick(template, "AWS::ElasticLoadBalancingV2::Listener");
    const rules = pick(template, "AWS::ElasticLoadBalancingV2::ListenerRule");

    // Default action is a flat 403. The ALB has a public DNS name, so without
    // this anyone hitting it directly bypasses CloudFront entirely — no TLS
    // redirect, no WAF surface, no origin verification. A default action of
    // `forward` would look completely normal in a diff and quietly open that
    // path. Assert the fixed response, not just "not a forward".
    assert.deepEqual(listener.Properties.DefaultActions, [
      {
        FixedResponseConfig: {
          ContentType: "text/plain",
          MessageBody: "Forbidden",
          StatusCode: "403",
        },
        Type: "fixed-response",
      },
    ]);

    // Exactly one way past the 403, and it is the header check. A second rule
    // is how the bypass would actually arrive — nobody edits the default action.
    assert.equal(rules.length, 1);
    const [, rule] = rules[0];
    assert.equal(rule.Properties.Priority, 1);
    assert.deepEqual(rule.Properties.Conditions[0].Field, "http-header");
    assert.equal(
      rule.Properties.Conditions[0].HttpHeaderConfig.HttpHeaderName,
      "X-Gigit-Origin-Verify",
    );
    assert.deepEqual(rule.Properties.Actions, [
      { TargetGroupArn: { Ref: "WebTargets2F627E77" }, Type: "forward" },
    ]);

    // The header value must be a Secrets Manager reference, not a literal — a
    // hardcoded shared secret sits in the template, in git, and in cdk.out, and
    // anyone who reads it can reach the origin directly forever.
    const headerValue = rule.Properties.Conditions[0].HttpHeaderConfig.Values[0];
    assert.match(renderJoin(headerValue), /^\{\{resolve:secretsmanager:/);

    // And it must be the SAME secret CloudFront sends. If these ever drift to
    // two different secrets the site returns 403 for every request — total
    // outage, from a change that synthesizes and deploys perfectly.
    const [[, cdn]] = pick(template, "AWS::CloudFront::Distribution");
    const customHeaders =
      cdn.Properties.DistributionConfig.Origins[0].OriginCustomHeaders as any[];
    const sent = customHeaders.find((h) => h.HeaderName === "X-Gigit-Origin-Verify");
    assert.ok(sent, "CloudFront no longer sends the origin-verify header; the ALB would 403 everything");
    assert.deepEqual(sent.HeaderValue, headerValue);
  });

  test(`[${stage}] the app port is reachable only through the ALB`, () => {
    const template = synthesize(stage);

    // The host sits in a PUBLIC subnet with a public IP (there is no NAT
    // gateway), so its security group is the only thing between port 3000 and
    // the internet. One `0.0.0.0/0` rule — added to debug something, never
    // removed — exposes the app directly and silently routes around both the
    // 403 default action and the origin-verify header above.
    const hostIngress = ingressFor(template, HOST_SG);
    assert.equal(hostIngress.length, 1, "the host should accept traffic from exactly one source");
    assert.equal(hostIngress[0].ToPort, 3000);
    assert.deepEqual(hostIngress[0].SourceSecurityGroupId, {
      "Fn::GetAtt": [ALB_SG, "GroupId"],
    });
    assert.equal(hostIngress[0].CidrIp, undefined);

    // Nothing anywhere opens port 22. SSM Session Manager is the access path
    // (the host role carries AmazonSSMManagedInstanceCore), so an SSH rule is
    // never needed — it is only ever a new front door on a public IP.
    for (const rule of allIngress(template)) {
      assert.notEqual(rule.ToPort, 22, `${rule.Description} opens SSH on a public-subnet host`);
    }

    // The ALB itself takes port 80 only from CloudFront's origin-facing prefix
    // list. Defence in depth behind the header check: without it, the origin is
    // reachable by anyone who learns the header value.
    const albIngress = ingressFor(template, ALB_SG);
    assert.equal(albIngress.length, 1);
    assert.equal(albIngress[0].ToPort, 80);
    assert.match(String(albIngress[0].SourcePrefixListId), /^pl-/);
    assert.equal(albIngress[0].CidrIp, undefined);
  });
}

// ── the host ──────────────────────────────────────────────────────────────

for (const stage of stages) {
  test(`[${stage}] the host requires IMDSv2 and encrypts its root volume`, () => {
    const template = synthesize(stage);
    const [[, host]] = pick(template, "AWS::EC2::Instance");

    // The instance role can read AppSecrets — DATABASE_URL, Stripe keys, the
    // session signing key. On IMDSv1 any SSRF in the web app ("fetch this
    // image URL") reads 169.254.169.254 and walks away with those credentials.
    // IMDSv2 requires a PUT to get a token, which a plain server-side GET
    // cannot do. Removing this line changes nothing observable until it is
    // exploited.
    assert.deepEqual(host.Properties.MetadataOptions, {
      HttpPutResponseHopLimit: 2,
      HttpTokens: "required",
    });

    // /etc/gigit.env lands on this volume in plaintext (mode 600) — it is where
    // the resolved secrets actually live. An unencrypted volume puts them in
    // every snapshot.
    assert.equal(host.Properties.BlockDeviceMappings[0].Ebs.Encrypted, true);
  });

  test(`[${stage}] the host can read AppSecrets and nothing else in Secrets Manager`, () => {
    const template = synthesize(stage);
    const statements = pick(template, "AWS::IAM::Policy")
      .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as any[])
      .filter((s) => JSON.stringify(s.Action).includes("secretsmanager:"));

    // Widening this grant is a one-word change (`dbSecret.grantRead(hostRole)`,
    // or a `resources: ["*"]`) and nothing breaks when you do it. What it buys
    // an attacker on the host is the RDS MASTER credential — which is not in
    // AppSecrets, and which bypasses every application-level control — and the
    // origin-verify secret, which is the ALB's whole access check.
    assert.equal(statements.length, 1);
    assert.deepEqual(statements[0].Resource, { Ref: "AppSecretsA1997F2A" });
    const resource = JSON.stringify(statements[0].Resource);
    assert.doesNotMatch(resource, /"\*"/);
    assert.doesNotMatch(resource, /DbSecret/);
    assert.doesNotMatch(resource, /OriginVerifySecret/);
  });
}

// ── failure detection ─────────────────────────────────────────────────────

test("the load balancer notices a dead target in ~20s, not ~60s", () => {
  const template = synthesize("prod");
  const [[, tg]] = pick(template, "AWS::ElasticLoadBalancingV2::TargetGroup");

  // Changed from 30s to 10s this week, and the reason is failure detection, not
  // deploys: two failed checks at 30s meant up to 60s of routing live traffic
  // into a black hole. Reverting to the CDK default is invisible — every
  // request still succeeds, right up until the host dies and takes a minute of
  // traffic with it.
  assert.equal(tg.Properties.HealthCheckIntervalSeconds, 10);
  assert.equal(tg.Properties.UnhealthyThresholdCount, 2);
  assert.equal(tg.Properties.HealthCheckPath, "/api/health");
  // Deliberately NOT asserted here: that the timeout is shorter than the
  // interval. CDK already refuses to synthesize otherwise ("Healthcheck
  // interval 10 seconds must be greater than the timeout 10 seconds"), so the
  // assertion could never fail — and a test that cannot fail is worse than no
  // test, because it reads like coverage.
});
