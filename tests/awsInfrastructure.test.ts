import { describe, it, expect } from "vitest";
import { App } from "aws-cdk-lib";
import { Template, Match } from "aws-cdk-lib/assertions";
import { HarmoniaAwsStack } from "../infra/aws/stack";

describe("AWS deployment security and durable services", () => {
  it("synthesizes isolated durable AWS services with paid inference disabled", () => {
    const stack = new HarmoniaAwsStack(new App(), "HarmoniaTest");
    const template = Template.fromStack(stack);
    template.resourceCountIs("AWS::DynamoDB::Table", 1);
    template.hasResourceProperties("AWS::DynamoDB::Table", { BillingMode:"PAY_PER_REQUEST", PointInTimeRecoverySpecification:{PointInTimeRecoveryEnabled:true} });
    template.hasResourceProperties("AWS::S3::Bucket", { PublicAccessBlockConfiguration:{BlockPublicAcls:true,BlockPublicPolicy:true,IgnorePublicAcls:true,RestrictPublicBuckets:true}, VersioningConfiguration:{Status:"Enabled"} });
    template.hasResourceProperties("AWS::ElasticLoadBalancingV2::ListenerRule", { Conditions:Match.arrayWith([Match.objectLike({Field:"path-pattern", PathPatternConfig:{Values:["/api/internal", "/api/internal/*"]}})]), Actions:Match.arrayWith([Match.objectLike({Type:"fixed-response",FixedResponseConfig:{StatusCode:"403",ContentType:"text/plain",MessageBody:"Forbidden"}})]) });
    template.hasResourceProperties("AWS::BedrockAgentCore::Runtime", { EnvironmentVariables:Match.objectLike({HARMONIA_ALLOW_PAID_AWS:"false"}) });
    template.hasResourceProperties("AWS::Scheduler::Schedule", {State:"DISABLED"});
    template.resourcePropertiesCountIs("AWS::ECS::Service", {
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
        MinimumHealthyPercent: 100,
      }),
    }, 3);
    expect(Object.values(template.toJSON().Resources).filter((r) => (r as {Type:string}).Type.startsWith("AWS::"))).not.toHaveLength(0);
  }, 30_000);
});
