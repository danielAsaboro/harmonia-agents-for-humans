import { App } from "aws-cdk-lib";
import { Template,Match } from "aws-cdk-lib/assertions";
import { describe,it } from "vitest";
import { HarmoniaAwsStack } from "../infra/aws/stack";
describe("AWS runtime deployment",()=>{
 it("isolates cognition, scanner, identity, queue redrive, and secrets",()=>{
  const t=Template.fromStack(new HarmoniaAwsStack(new App(),"DeploymentContract"));
  t.resourceCountIs("AWS::ECS::Service",3);
  t.resourceCountIs("AWS::SQS::Queue",8);
  t.hasResourceProperties("AWS::SQS::Queue",{RedrivePolicy:Match.objectLike({maxReceiveCount:5}),VisibilityTimeout:120});
  t.hasResourceProperties("AWS::Cognito::UserPoolClient",{AllowedOAuthFlows:["code"],GenerateSecret:false,SupportedIdentityProviders:["Google"]});
  t.hasResourceProperties("AWS::BedrockAgentCore::Runtime",{NetworkConfiguration:Match.objectLike({NetworkMode:"VPC"})});
  t.hasResourceProperties("AWS::ECS::TaskDefinition",{ContainerDefinitions:Match.arrayWith([Match.objectLike({Secrets:Match.arrayWith([Match.objectLike({Name:"INTERNAL_API_TOKEN"})])})])});
 }, 30_000);
});
