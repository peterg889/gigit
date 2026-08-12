/**
 * Shared synth helper for the infrastructure tests.
 *
 * Not named *.test.ts on purpose: `node --test test/*.test.ts` would otherwise
 * run it as an empty test file. Everything here is offline — synthesis with a
 * fixed account/region and the legacy synthesizer needs no AWS credentials, so
 * these tests run in CI and on a laptop with no profile configured.
 */
import * as cdk from "aws-cdk-lib";
import { GigitStack } from "../lib/gigit-stack.js";

export type Stage = "staging" | "prod";

export type Template = {
  Resources: Record<string, { Type: string; Properties: Record<string, any> }>;
  Outputs?: Record<string, { Value: unknown }>;
};

// bin/gigit.ts wires these; the tests must assert the stacks as they are
// actually deployed, not a convenient simplification of them.
const domains: Record<Stage, { domainName: string; hostedZoneName: string }> = {
  staging: { domainName: "staging.eightgig.com", hostedZoneName: "eightgig.com" },
  prod: { domainName: "eightgig.com", hostedZoneName: "eightgig.com" },
};

const cache = new Map<Stage, Template>();

export const synthesize = (stage: Stage = "staging"): Template => {
  const cached = cache.get(stage);
  if (cached) return cached;
  const app = new cdk.App({ context: { imageTag: "aaa", deploymentNonce: "bbb" } });
  const stack = new GigitStack(app, stage === "prod" ? "GigitProd" : "GigitStaging", {
    env: { account: "111111111111", region: "us-east-1" },
    synthesizer: new cdk.LegacyStackSynthesizer(),
    stage,
    ...domains[stage],
  });
  const template = app.synth().getStackByName(stack.stackName).template as Template;
  cache.set(stage, template);
  return template;
};

export const pick = (template: Template, type: string) =>
  Object.entries(template.Resources).filter(([, r]) => r.Type === type);

export const stages: Stage[] = ["staging", "prod"];

/**
 * Renders an `Fn::Join` back into a single string, substituting a readable
 * placeholder for each intrinsic. Lets a test reason about a value that
 * CloudFormation assembles at deploy time — e.g. the AppSecrets JSON, which is
 * half literal text and half `Ref`s to other resources.
 */
export const renderJoin = (value: any): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && Array.isArray(value["Fn::Join"])) {
    const [sep, parts] = value["Fn::Join"] as [string, any[]];
    return parts.map(renderJoin).join(sep);
  }
  if (value && typeof value === "object" && "Ref" in value) return `<Ref:${value.Ref}>`;
  if (value && typeof value === "object" && "Fn::GetAtt" in value)
    return `<GetAtt:${(value["Fn::GetAtt"] as string[]).join(".")}>`;
  return JSON.stringify(value);
};
