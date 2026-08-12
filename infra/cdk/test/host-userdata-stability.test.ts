/**
 * Regression guard for the 128.8s production outage of 2026-07.
 *
 * A deploy that only removed two variables from `computedEnv` replaced the EC2
 * host — logical id HostB4E45AD7eda76556df701033 -> HostB4E45AD7eed94486936fd059
 * — because the release script (with computedEnv interpolated into it) lived in
 * UserData and `userDataCausesReplacement: true` hashes UserData into the
 * instance's logical id. 415 requests failed.
 *
 * The fix keeps the flag (a host must match its boot configuration) and instead
 * makes UserData contain nothing that varies per release or per config. These
 * assertions fail the moment someone puts release-time content back in UserData.
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as cdk from "aws-cdk-lib";
import { GigitStack } from "../lib/gigit-stack.js";

const synth = () => {
  const app = new cdk.App({ context: { imageTag: "aaa", deploymentNonce: "bbb" } });
  const stack = new GigitStack(app, "GigitStaging", {
    env: { account: "111111111111", region: "us-east-1" },
    synthesizer: new cdk.LegacyStackSynthesizer(),
    stage: "staging",
    domainName: "staging.eightgig.com",
    hostedZoneName: "eightgig.com",
  });
  return app.synth().getStackByName(stack.stackName).template as {
    Resources: Record<string, { Type: string; Properties: Record<string, any> }>;
  };
};

const pick = (template: ReturnType<typeof synth>, type: string) =>
  Object.entries(template.Resources).filter(([, r]) => r.Type === type);

test("UserData carries no per-release or per-config content", () => {
  const template = synth();
  const [[hostLogicalId, host]] = pick(template, "AWS::EC2::Instance");
  const userData = JSON.stringify(host.Properties.UserData);

  // Instance identity only: the packages a booted host must have.
  assert.match(userData, /dnf install -y docker jq/);
  // The release script — any part of it — must NOT be here.
  assert.doesNotMatch(userData, /deploy-release\.sh/);
  assert.doesNotMatch(userData, /docker run/);
  // Nor any computedEnv value: these are exactly the edits that took prod down.
  assert.doesNotMatch(userData, /GIGIT_STAGE/);
  assert.doesNotMatch(userData, /NODE_ENV/);
  assert.doesNotMatch(userData, /APP_URL/);

  // The flag stays on: without it a UserData change would apply to future
  // instances only, leaving this host silently on a stale boot configuration.
  // `userDataCausesReplacement` shows up in the template as the UserData hash
  // suffix appended to the logical id, so its absence is detectable here.
  assert.match(hostLogicalId, /^Host[0-9A-F]{8}[0-9a-f]{16}$/);
});

test("release script lives in a stage-scoped standard-tier SSM parameter", () => {
  const template = synth();
  const params = pick(template, "AWS::SSM::Parameter");
  assert.equal(params.length, 1);
  const [, param] = params[0];
  assert.equal(param.Properties.Name, "/gigit/staging/deploy-release-script");
  assert.equal(param.Properties.Tier, "Standard"); // advanced tier is billed per parameter
  // The value is the script VERBATIM, rendered as a CloudFormation intrinsic so
  // the CDK tokens inside it (the AppSecrets ARN, the ECR URIs) resolve at
  // deploy time. Serialize the whole intrinsic and assert against that.
  const rendered = JSON.stringify(param.Properties.Value);
  assert.match(rendered, /GIGIT_STAGE=staging/);
  assert.match(rendered, /docker run -d .*--name web/);

  // TWO deploy-time failures that synth alone will not catch, both of which we
  // have now hit for real:
  //
  // 1. SSM rejects ANY value containing "{{}}" — its own dynamic-reference
  //    syntax, refused on the literal braces (even 'hello {{foo}} world'
  //    fails). The script used to run `docker inspect -f '{{.State.Running}}'`,
  //    which made the stack undeployable while synthesizing perfectly.
  assert.doesNotMatch(rendered, /\{\{/, "SSM refuses any value containing {{ }} at PutParameter");
  //
  // 2. An unresolved token means CDK could not substitute a real value, and the
  //    host would execute the literal placeholder. That is what
  //    `TOKEN.1361: syntax error` was: the script had been base64-encoded in
  //    TypeScript, freezing the tokens inside a blob CDK could no longer see.
  assert.doesNotMatch(rendered, /Token\[/, "unresolved CDK token would be executed literally on the host");

  // 4KB standard-tier ceiling. The stored value is LONGER than the source
  // string, because tokens resolve to full ARNs, so leave headroom.
  assert.ok(
    rendered.length < 3500,
    `rendered script is ${rendered.length} bytes; too close to the 4KB standard-tier limit`,
  );
});

test("the host may read exactly that parameter, and nothing else in SSM", () => {
  const template = synth();
  const statements = pick(template, "AWS::IAM::Policy")
    .flatMap(([, p]) => p.Properties.PolicyDocument.Statement as any[])
    .filter((s) => JSON.stringify(s.Action).includes("ssm:"));
  assert.equal(statements.length, 1);
  assert.equal(statements[0].Action, "ssm:GetParameter");
  const resource = JSON.stringify(statements[0].Resource);
  assert.doesNotMatch(resource, /"\*"/);
  assert.match(resource, /DeployReleaseScript/); // the parameter's own ARN
});

test("the association fetches the script and fails loudly rather than reusing a stale one", () => {
  const template = synth();
  const [[, assoc]] = pick(template, "AWS::SSM::Association");
  const commands = (assoc.Properties.Parameters.commands as unknown[])
    .map((c) => (typeof c === "string" ? c : JSON.stringify(c)))
    .join("\n");

  // Fetched fresh, from the parameter, every run.
  assert.match(commands, /aws ssm get-parameter .*\/gigit\/staging\/deploy-release-script/);
  // The on-disk copy is destroyed before the fetch, so "run last week's release
  // logic" is impossible rather than merely unlikely.
  assert.match(commands, /rm -f \/usr\/local\/bin\/deploy-release\.sh/);
  // No waiting on the on-disk script: a stale file satisfies `-x` instantly.
  assert.doesNotMatch(commands, /until \[ -x \/usr\/local\/bin\/deploy-release\.sh \]/);
  // A failed or malformed fetch aborts with its own status and reason.
  assert.match(commands, /FATAL: cannot read SSM parameter/);
  assert.match(commands, /exit 90/);
  assert.match(commands, /no stale script was run/);
});
