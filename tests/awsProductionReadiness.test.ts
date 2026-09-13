import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, it } from "vitest";
import { HarmoniaAwsStack } from "../infra/aws/stack";
import { deploymentStackId, deploymentStage } from "../infra/aws/stage";

type Resource = {
  Type: string;
  Properties?: Record<string, unknown>;
  DeletionPolicy?: string;
  UpdateReplacePolicy?: string;
};

function resourcesOf(template: Template, type: string): Resource[] {
  return Object.values(template.toJSON().Resources).filter(
    (resource): resource is Resource => (resource as Resource).Type === type,
  );
}

describe("AWS production readiness contract", () => {
  it("uses distinct validated stack identities for staging and production", () => {
    expect(deploymentStackId(deploymentStage("staging"))).toBe("HarmoniaStrandsStaging");
    expect(deploymentStackId(deploymentStage("production"))).toBe("HarmoniaStrandsProduction");
    expect(() => deploymentStage("preview")).toThrow("staging or production");
  });
  it("synthesizes separated rotating keys and retained encrypted state", () => {
    const app = new App({ context: { stage: "production" } });
    const template = Template.fromStack(new HarmoniaAwsStack(app, "ProductionSecurity"));

    const keys = resourcesOf(template, "AWS::KMS::Key");
    expect(keys.length).toBeGreaterThanOrEqual(5);
    expect(keys.every((key) => key.Properties?.EnableKeyRotation === true)).toBe(true);
    expect(keys.every((key) => key.DeletionPolicy === "Retain")).toBe(true);

    const table = resourcesOf(template, "AWS::DynamoDB::Table")[0];
    expect(table.Properties).toMatchObject({
      DeletionProtectionEnabled: true,
      SSESpecification: { SSEEnabled: true, SSEType: "KMS" },
      TimeToLiveSpecification: { AttributeName: "ttlEpochSeconds", Enabled: true },
    });
    expect(table.DeletionPolicy).toBe("Retain");

    const bucket = resourcesOf(template, "AWS::S3::Bucket")[0];
    expect(bucket.Properties).toMatchObject({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            BucketKeyEnabled: true,
            ServerSideEncryptionByDefault: { SSEAlgorithm: "aws:kms" },
          },
        ],
      },
    });
    expect(bucket.DeletionPolicy).toBe("Retain");

    const queues = resourcesOf(template, "AWS::SQS::Queue");
    expect(queues).toHaveLength(8);
    expect(queues.every((queue) => queue.Properties?.KmsMasterKeyId)).toBe(true);
    expect(queues.every((queue) => queue.DeletionPolicy === "Retain")).toBe(true);

    const storedSecrets = resourcesOf(template, "AWS::SecretsManager::Secret");
    expect(storedSecrets).toHaveLength(4);
    expect(storedSecrets.every((secret) => secret.Properties?.KmsKeyId)).toBe(true);
    expect(storedSecrets.every((secret) => secret.DeletionPolicy === "Retain")).toBe(true);
  }, 30_000);

  it("puts the public service behind rate controls and actionable alerts", () => {
    const app = new App({ context: { stage: "production" } });
    const template = Template.fromStack(new HarmoniaAwsStack(app, "ProductionEdge"));

    const webAcls = resourcesOf(template, "AWS::WAFv2::WebACL");
    expect(webAcls).toHaveLength(1);
    expect(webAcls[0].Properties?.Rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ Name: "RequestRateLimit" }),
        expect.objectContaining({ Name: "AwsCommonRules" }),
        expect.objectContaining({ Name: "AwsKnownBadInputs" }),
        expect.objectContaining({ Name: "AwsIpReputation" }),
      ]),
    );
    expect(resourcesOf(template, "AWS::WAFv2::WebACLAssociation")).toHaveLength(1);

    expect(resourcesOf(template, "AWS::SNS::Topic")).toHaveLength(1);
    expect(resourcesOf(template, "AWS::SNS::Subscription")).toHaveLength(1);
    expect(resourcesOf(template, "AWS::CloudWatch::Alarm").length).toBeGreaterThanOrEqual(16);
    expect(resourcesOf(template, "AWS::CloudWatch::Dashboard")).toHaveLength(1);
  }, 30_000);

  it("provides service autoscaling and encrypted backup retention", () => {
    const app = new App({ context: { stage: "production" } });
    const template = Template.fromStack(new HarmoniaAwsStack(app, "ProductionResilience"));

    const scalableTargets = resourcesOf(template, "AWS::ApplicationAutoScaling::ScalableTarget");
    expect(scalableTargets).toHaveLength(3);
    expect(scalableTargets.every((target) => Number(target.Properties?.MinCapacity) >= 2)).toBe(true);
    expect(scalableTargets.every((target) => Number(target.Properties?.MaxCapacity) > Number(target.Properties?.MinCapacity))).toBe(true);
    expect(resourcesOf(template, "AWS::ApplicationAutoScaling::ScalingPolicy").length).toBeGreaterThanOrEqual(4);

    expect(resourcesOf(template, "AWS::Backup::BackupVault")).toHaveLength(1);
    expect(resourcesOf(template, "AWS::Backup::BackupPlan")).toHaveLength(1);
    expect(resourcesOf(template, "AWS::Backup::BackupSelection")).toHaveLength(1);

    const logGroups = resourcesOf(template, "AWS::Logs::LogGroup");
    expect(logGroups.length).toBeGreaterThanOrEqual(5);
    expect(logGroups.every((group) => group.Properties?.KmsKeyId)).toBe(true);
    expect(logGroups.every((group) => group.DeletionPolicy === "Retain")).toBe(true);
  }, 30_000);
});
