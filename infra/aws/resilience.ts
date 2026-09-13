import * as cdk from "aws-cdk-lib";
import {
  aws_applicationautoscaling as appscaling,
  aws_backup as backup,
  aws_cloudwatch as cloudwatch,
  aws_dynamodb as dynamo,
  aws_ecs as ecs,
  aws_ecs_patterns as patterns,
  aws_events as events,
  aws_s3 as s3,
  aws_sns as sns,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import { Construct } from "constructs";
import type { EncryptionKeys } from "./security";

export interface RuntimeServices {
  readonly scanner: ecs.FargateService;
  readonly web: patterns.ApplicationLoadBalancedFargateService;
  readonly worker: ecs.FargateService;
}

export function configureServiceScaling(
  services: RuntimeServices,
  queues: Record<string, sqs.Queue>,
  production: boolean,
): void {
  const webScaling = services.web.service.autoScaleTaskCount({
    minCapacity: production ? 2 : 1,
    maxCapacity: production ? 8 : 4,
  });
  webScaling.scaleOnCpuUtilization("WebCpuScaling", { targetUtilizationPercent: 55 });
  webScaling.scaleOnMemoryUtilization("WebMemoryScaling", { targetUtilizationPercent: 65 });

  const workerScaling = services.worker.autoScaleTaskCount({
    minCapacity: production ? 2 : 1,
    maxCapacity: production ? 12 : 6,
  });
  workerScaling.scaleOnCpuUtilization("WorkerCpuScaling", { targetUtilizationPercent: 60 });
  const queueMetrics = Object.fromEntries(
    Object.entries(queues).map(([name, queue]) => [
      name,
      queue.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: "Maximum",
      }),
    ]),
  );
  workerScaling.scaleOnMetric("WorkerBacklogScaling", {
    metric: new cloudwatch.MathExpression({
      expression: Object.keys(queueMetrics).join(" + "),
      usingMetrics: queueMetrics,
      period: cdk.Duration.minutes(1),
    }),
    adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
    scalingSteps: [
      { upper: 5, change: -1 },
      { lower: 5, upper: 50, change: 1 },
      { lower: 50, change: 3 },
    ],
    cooldown: cdk.Duration.minutes(2),
    evaluationPeriods: 2,
    datapointsToAlarm: 2,
  });

  const scannerScaling = services.scanner.autoScaleTaskCount({
    minCapacity: production ? 2 : 1,
    maxCapacity: production ? 6 : 3,
  });
  scannerScaling.scaleOnCpuUtilization("ScannerCpuScaling", { targetUtilizationPercent: 60 });
}

export interface BackupResources {
  readonly plan: backup.BackupPlan;
  readonly vault: backup.BackupVault;
}

export function configureBackups(
  scope: Construct,
  table: dynamo.Table,
  bucket: s3.Bucket,
  keys: EncryptionKeys,
  alerts: sns.Topic,
): BackupResources {
  const vault = new backup.BackupVault(scope, "DurableBackupVault", {
    encryptionKey: keys.backups,
    notificationTopic: alerts,
    notificationEvents: [
      backup.BackupVaultEvents.BACKUP_JOB_FAILED,
      backup.BackupVaultEvents.RESTORE_JOB_FAILED,
    ],
    blockRecoveryPointDeletion: true,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  const plan = new backup.BackupPlan(scope, "DurableBackupPlan", {
    backupVault: vault,
    backupPlanRules: [
      new backup.BackupPlanRule({
        ruleName: "Daily35DayRetention",
        scheduleExpression: events.Schedule.cron({ minute: "0", hour: "2" }),
        deleteAfter: cdk.Duration.days(35),
        startWindow: cdk.Duration.hours(1),
        completionWindow: cdk.Duration.hours(8),
      }),
      new backup.BackupPlanRule({
        ruleName: "Weekly90DayRetention",
        scheduleExpression: events.Schedule.cron({ minute: "0", hour: "3", weekDay: "SUN" }),
        deleteAfter: cdk.Duration.days(90),
        startWindow: cdk.Duration.hours(1),
        completionWindow: cdk.Duration.hours(8),
      }),
    ],
  });
  plan.addSelection("DurableStateSelection", {
    resources: [
      backup.BackupResource.fromDynamoDbTable(table),
      backup.BackupResource.fromArn(bucket.bucketArn),
    ],
  });
  return { plan, vault };
}
