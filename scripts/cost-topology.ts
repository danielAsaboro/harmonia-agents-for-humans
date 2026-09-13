import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HarmoniaAwsStack } from "../infra/aws/stack";

type Resource = {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
};

type CloudFormationTemplate = {
  readonly Resources?: Record<string, Resource>;
};

export interface CostTopology {
  readonly noUsdEstimate: true;
  readonly resources: {
    readonly alarms: number;
    readonly backupPlans: number;
    readonly customerManagedKeys: number;
    readonly natGateways: number;
    readonly queues: number;
    readonly scalableServices: number;
    readonly webAcls: number;
  };
  readonly scaling: {
    readonly maximumTasks: number;
    readonly minimumTasks: number;
  };
  readonly variableDrivers: readonly string[];
  readonly warning: string;
}

export function summarizeCostTopology(template: CloudFormationTemplate): CostTopology {
  const resources = Object.values(template.Resources ?? {});
  const ofType = (type: string) => resources.filter((resource) => resource.Type === type);
  const scalableTargets = ofType("AWS::ApplicationAutoScaling::ScalableTarget");
  const sumCapacity = (property: "MinCapacity" | "MaxCapacity") => scalableTargets.reduce(
    (sum, target) => sum + Number(target.Properties?.[property] ?? 0),
    0,
  );
  return {
    noUsdEstimate: true,
    resources: {
      alarms: ofType("AWS::CloudWatch::Alarm").length,
      backupPlans: ofType("AWS::Backup::BackupPlan").length,
      customerManagedKeys: ofType("AWS::KMS::Key").length,
      natGateways: ofType("AWS::EC2::NatGateway").length,
      queues: ofType("AWS::SQS::Queue").length,
      scalableServices: scalableTargets.length,
      webAcls: ofType("AWS::WAFv2::WebACL").length,
    },
    scaling: {
      maximumTasks: sumCapacity("MaxCapacity"),
      minimumTasks: sumCapacity("MinCapacity"),
    },
    variableDrivers: [
      "Fargate vCPU and memory hours",
      "NAT gateway hours and processed bytes",
      "Application Load Balancer hours and capacity units",
      "WAF requests and managed rule evaluations",
      "DynamoDB read/write request units and storage",
      "S3 current/noncurrent bytes, requests, and backup bytes",
      "SQS requests, CloudWatch logs, metrics, alarms, and traces",
      "KMS API requests and customer-managed keys",
      "Bedrock and external provider usage after operator authorization",
    ],
    warning: "This is a resource and scaling inventory, not a USD estimate. Apply a dated region-specific AWS price export before approving spend.",
  };
}

async function main(): Promise<void> {
  const stage = process.env.COST_STAGE ?? "production";
  const app = new App({ context: { stage, allowPaidCalls: "false" } });
  const template = Template.fromStack(new HarmoniaAwsStack(app, "HarmoniaCostTopology")).toJSON();
  process.stdout.write(`${JSON.stringify({ stage, ...summarizeCostTopology(template) }, null, 2)}\n`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
