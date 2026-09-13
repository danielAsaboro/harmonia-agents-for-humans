import * as cdk from "aws-cdk-lib";
import {
  aws_cloudwatch as cloudwatch,
  aws_cloudwatch_actions as actions,
  aws_dynamodb as dynamo,
  aws_ecs as ecs,
  aws_ecs_patterns as patterns,
  aws_elasticloadbalancingv2 as elb,
  aws_kms as kms,
  aws_logs as logs,
  aws_sns as sns,
  aws_sns_subscriptions as subscriptions,
  aws_sqs as sqs,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface RuntimeLogGroups {
  readonly scanner: logs.LogGroup;
  readonly web: logs.LogGroup;
  readonly webOtel: logs.LogGroup;
  readonly worker: logs.LogGroup;
  readonly workerOtel: logs.LogGroup;
}

export function createRuntimeLogGroups(
  scope: Construct,
  key: kms.Key,
  stage: string,
  production: boolean,
): RuntimeLogGroups {
  const create = (id: string, suffix: string) => new logs.LogGroup(scope, id, {
    logGroupName: `/harmonia/${stage}/${suffix}`,
    encryptionKey: key,
    deletionProtectionEnabled: production,
    retention: production ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
    removalPolicy: cdk.RemovalPolicy.RETAIN,
  });
  return {
    scanner: create("ScannerLogs", "scanner"),
    web: create("WebLogs", "web"),
    webOtel: create("WebOtelLogs", "web-otel"),
    worker: create("WorkerLogs", "worker"),
    workerOtel: create("WorkerOtelLogs", "worker-otel"),
  };
}

export interface ObservabilityResources {
  readonly dashboard: cloudwatch.Dashboard;
  readonly topic: sns.Topic;
}

export function configureObservability(
  scope: Construct,
  stage: string,
  key: kms.Key,
  table: dynamo.Table,
  queues: Record<string, sqs.Queue>,
  deadLetters: Record<string, sqs.Queue>,
  services: {
    readonly scanner: ecs.FargateService;
    readonly web: patterns.ApplicationLoadBalancedFargateService;
    readonly worker: ecs.FargateService;
  },
): ObservabilityResources {
  const alertEmail = new cdk.CfnParameter(scope, "AlertEmail", {
    type: "String",
    allowedPattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
    description: "Confirmed operations mailbox for production and staging alarms",
  });
  const topic = new sns.Topic(scope, "OperationsAlerts", {
    displayName: `Harmonia ${stage} operations alerts`,
    masterKey: key,
  });
  topic.addSubscription(new subscriptions.EmailSubscription(alertEmail.valueAsString));

  const action = new actions.SnsAction(topic);
  const alarms: cloudwatch.Alarm[] = [];
  const addAlarm = (
    id: string,
    metric: cloudwatch.IMetric,
    threshold: number,
    evaluationPeriods = 1,
  ) => {
    const alarm = new cloudwatch.Alarm(scope, id, {
      metric,
      threshold,
      evaluationPeriods,
      datapointsToAlarm: evaluationPeriods,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarm.addAlarmAction(action);
    alarms.push(alarm);
    return alarm;
  };

  for (const [kind, queue] of Object.entries(queues)) {
    addAlarm(`${kind}QueueAgeAlarm`, queue.metricApproximateAgeOfOldestMessage({ period: cdk.Duration.minutes(1), statistic: "Maximum" }), 300, 2);
    addAlarm(`${kind}QueueBacklogAlarm`, queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: "Maximum" }), 100, 3);
  }
  for (const [kind, queue] of Object.entries(deadLetters)) {
    addAlarm(`${kind}DeadLetterAlarm`, queue.metricApproximateNumberOfMessagesVisible({ period: cdk.Duration.minutes(1), statistic: "Maximum" }), 1);
  }

  for (const [name, service] of Object.entries({
    web: services.web.service,
    worker: services.worker,
    scanner: services.scanner,
  })) {
    addAlarm(`${name}CpuAlarm`, service.metricCpuUtilization({ period: cdk.Duration.minutes(1), statistic: "Average" }), 85, 5);
    addAlarm(`${name}MemoryAlarm`, service.metricMemoryUtilization({ period: cdk.Duration.minutes(1), statistic: "Average" }), 85, 5);
  }
  addAlarm("LoadBalancer5xxAlarm", services.web.loadBalancer.metrics.httpCodeElb(elb.HttpCodeElb.ELB_5XX_COUNT, { period: cdk.Duration.minutes(1), statistic: "Sum" }), 5, 2);
  addAlarm("TargetLatencyAlarm", services.web.targetGroup.metrics.targetResponseTime({ period: cdk.Duration.minutes(1), statistic: "p95" }), 2, 3);
  addAlarm("DynamoThrottlingAlarm", new cloudwatch.Metric({ namespace: "AWS/DynamoDB", metricName: "ThrottledRequests", dimensionsMap: { TableName: table.tableName }, period: cdk.Duration.minutes(1), statistic: "Sum" }), 1, 2);
  addAlarm("DynamoSystemErrorsAlarm", new cloudwatch.Metric({ namespace: "AWS/DynamoDB", metricName: "SystemErrors", dimensionsMap: { TableName: table.tableName }, period: cdk.Duration.minutes(1), statistic: "Sum" }), 1, 2);

  const dashboard = new cloudwatch.Dashboard(scope, "OperationsDashboard", {
    dashboardName: `harmonia-${stage}-operations`,
  });
  dashboard.addWidgets(
    new cloudwatch.AlarmStatusWidget({ title: "Actionable alarms", alarms, width: 24 }),
    new cloudwatch.GraphWidget({
      title: "Queue backlog",
      left: Object.values(queues).map((queue) => queue.metricApproximateNumberOfMessagesVisible()),
      width: 12,
    }),
    new cloudwatch.GraphWidget({
      title: "Service utilization",
      left: [services.web.service.metricCpuUtilization(), services.worker.metricCpuUtilization(), services.scanner.metricCpuUtilization()],
      right: [services.web.service.metricMemoryUtilization(), services.worker.metricMemoryUtilization(), services.scanner.metricMemoryUtilization()],
      width: 12,
    }),
  );
  return { dashboard, topic };
}
