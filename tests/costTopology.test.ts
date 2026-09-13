import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HarmoniaAwsStack } from "../infra/aws/stack";
import { summarizeCostTopology } from "../scripts/cost-topology";

describe("production cost topology", () => {
  it("surfaces fixed and elastic AWS billing drivers without inventing a dollar estimate", () => {
    const app = new App({ context: { stage: "production", allowPaidCalls: "false" } });
    const template = Template.fromStack(new HarmoniaAwsStack(app, "CostTopology")).toJSON();
    const topology = summarizeCostTopology(template);

    expect(topology).toMatchObject({
      noUsdEstimate: true,
      resources: {
        alarms: 24,
        backupPlans: 1,
        customerManagedKeys: 6,
        natGateways: 1,
        queues: 8,
        scalableServices: 3,
        webAcls: 1,
      },
      scaling: { minimumTasks: 6, maximumTasks: 26 },
    });
    expect(topology.variableDrivers).toEqual(expect.arrayContaining([
      "Fargate vCPU and memory hours",
      "NAT gateway hours and processed bytes",
      "DynamoDB read/write request units and storage",
      "S3 current/noncurrent bytes, requests, and backup bytes",
      "Bedrock and external provider usage after operator authorization",
    ]));
  }, 30_000);

  it("runs through the checked-in package command runtime", () => {
    const output = execFileSync(join(process.cwd(), "node_modules/.bin/tsx"), ["scripts/cost-topology.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, COST_STAGE: "production" },
    });
    expect(JSON.parse(output)).toMatchObject({ stage: "production", noUsdEstimate: true });
  }, 30_000);
});
