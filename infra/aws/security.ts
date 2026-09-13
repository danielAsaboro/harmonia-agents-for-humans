import * as cdk from "aws-cdk-lib";
import {
  aws_elasticloadbalancingv2 as elb,
  aws_kms as kms,
  aws_wafv2 as wafv2,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface EncryptionKeys {
  readonly assets: kms.Key;
  readonly backups: kms.Key;
  readonly observability: kms.Key;
  readonly queues: kms.Key;
  readonly secrets: kms.Key;
  readonly state: kms.Key;
}

function retainedKey(scope: Construct, id: string, stage: string): kms.Key {
  return new kms.Key(scope, id, {
    alias: `alias/harmonia/${stage}/${id.toLowerCase()}`,
    description: `Harmonia ${stage} ${id.toLowerCase()} encryption boundary`,
    enableKeyRotation: true,
    pendingWindow: cdk.Duration.days(30),
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
}

export function createEncryptionKeys(scope: Construct, stage: string): EncryptionKeys {
  return {
    assets: retainedKey(scope, "AssetKey", stage),
    backups: retainedKey(scope, "BackupKey", stage),
    observability: retainedKey(scope, "ObservabilityKey", stage),
    queues: retainedKey(scope, "QueueKey", stage),
    secrets: retainedKey(scope, "SecretKey", stage),
    state: retainedKey(scope, "StateKey", stage),
  };
}

export function protectPublicService(
  scope: Construct,
  loadBalancer: elb.ApplicationLoadBalancer,
  stage: string,
): wafv2.CfnWebACL {
  const visibility = (name: string) => ({
    cloudWatchMetricsEnabled: true,
    metricName: `harmonia-${stage}-${name}`,
    sampledRequestsEnabled: true,
  });
  const webAcl = new wafv2.CfnWebACL(scope, "PublicWebAcl", {
    defaultAction: { allow: {} },
    scope: "REGIONAL",
    visibilityConfig: visibility("web-acl"),
    rules: [
      {
        name: "RequestRateLimit",
        priority: 0,
        action: { block: {} },
        statement: {
          rateBasedStatement: {
            aggregateKeyType: "IP",
            evaluationWindowSec: 300,
            limit: stage === "production" ? 2_000 : 5_000,
          },
        },
        visibilityConfig: visibility("request-rate-limit"),
      },
      {
        name: "AwsCommonRules",
        priority: 10,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            name: "AWSManagedRulesCommonRuleSet",
            vendorName: "AWS",
          },
        },
        visibilityConfig: visibility("aws-common-rules"),
      },
      {
        name: "AwsKnownBadInputs",
        priority: 20,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            name: "AWSManagedRulesKnownBadInputsRuleSet",
            vendorName: "AWS",
          },
        },
        visibilityConfig: visibility("aws-known-bad-inputs"),
      },
      {
        name: "AwsIpReputation",
        priority: 30,
        overrideAction: { none: {} },
        statement: {
          managedRuleGroupStatement: {
            name: "AWSManagedRulesAmazonIpReputationList",
            vendorName: "AWS",
          },
        },
        visibilityConfig: visibility("aws-ip-reputation"),
      },
    ],
  });
  new wafv2.CfnWebACLAssociation(scope, "PublicWebAclAssociation", {
    resourceArn: loadBalancer.loadBalancerArn,
    webAclArn: webAcl.attrArn,
  });
  return webAcl;
}
