import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { aws_ec2 as ec2, aws_ecs as ecs, aws_ecs_patterns as patterns, aws_s3 as s3, aws_dynamodb as dynamo, aws_sqs as sqs, aws_cognito as cognito, aws_iam as iam, aws_logs as logs, aws_secretsmanager as secrets, aws_elasticloadbalancingv2 as elb, aws_certificatemanager as acm, aws_bedrockagentcore as agentcore, aws_bedrock as bedrock, aws_s3vectors as vectors, aws_scheduler as scheduler, aws_scheduler_targets as targets } from "aws-cdk-lib";
import * as path from "node:path";
import { configureObservability, createRuntimeLogGroups } from "./observability";
import { configureBackups, configureServiceScaling } from "./resilience";
import { createEncryptionKeys, protectPublicService } from "./security";
import { deploymentStage } from "./stage";

/** Isolated AWS edition; synthesis never resolves account credentials or deploys. */
export class HarmoniaAwsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const stage = deploymentStage(this.node.tryGetContext("stage"));
    const production = stage === "production";
    cdk.Tags.of(this).add("Application", "Harmonia");
    cdk.Tags.of(this).add("Stage", stage);
    cdk.Tags.of(this).add("ManagedBy", "aws-cdk");
    const paid = this.node.tryGetContext("allowPaidCalls") === "true";
    const keys = createEncryptionKeys(this, stage);
    const textPrices = new cdk.CfnParameter(this,"TextPricingJson",{type:"String",default:"{}",description:"Verified model rates in USD/million, keyed by exact model ID"});
    const deploymentSettings = new cdk.CfnParameter(this,"ProviderSettingsJson",{type:"String",default:"{}",description:"Operator configured prices, enabled capabilities, and integration secrets are loaded from Secrets Manager"});
    const publicUrl = new cdk.CfnParameter(this, "PublicBaseUrl", {type:"String",allowedPattern:"https://[^/]+",description:"HTTPS origin for this AWS edition only"});
    const certificateArn = new cdk.CfnParameter(this,"CertificateArn",{type:"String",description:"ACM certificate in the stack region matching PublicBaseUrl"});
    const googleClient = new cdk.CfnParameter(this,"GoogleClientId",{type:"String"});
    const googleSecret = new cdk.CfnParameter(this,"GoogleClientSecret",{type:"String",noEcho:true});
    const runtimeImage = new cdk.CfnParameter(this,"AgentCoreImageUri",{type:"String",description:"Published ARM64 cognition image URI pinned to sha256 digest",allowedPattern:"^[0-9]{12}\\.dkr\\.ecr\\.[a-z0-9-]+\\.amazonaws\\.com/[a-z0-9/_-]+@sha256:[a-f0-9]{64}$"});
    const vpc = new ec2.Vpc(this,"Vpc",{maxAzs:2,natGateways:1});
    vpc.addGatewayEndpoint("S3Endpoint",{service:ec2.GatewayVpcEndpointAwsService.S3});
    vpc.addGatewayEndpoint("DynamoEndpoint",{service:ec2.GatewayVpcEndpointAwsService.DYNAMODB});
    const cluster = new ecs.Cluster(this,"Cluster",{vpc,defaultCloudMapNamespace:{name:"harmonia.internal"}});
    const table = new dynamo.Table(this,"State",{partitionKey:{name:"pk",type:dynamo.AttributeType.STRING},sortKey:{name:"sk",type:dynamo.AttributeType.STRING},billingMode:dynamo.BillingMode.PAY_PER_REQUEST,pointInTimeRecoverySpecification:{pointInTimeRecoveryEnabled:true},timeToLiveAttribute:"ttlEpochSeconds",encryption:dynamo.TableEncryption.CUSTOMER_MANAGED,encryptionKey:keys.state,deletionProtection:production,removalPolicy:cdk.RemovalPolicy.RETAIN});
    const bucket = new s3.Bucket(this,"Assets",{blockPublicAccess:s3.BlockPublicAccess.BLOCK_ALL,enforceSSL:true,versioned:true,encryption:s3.BucketEncryption.KMS,encryptionKey:keys.assets,bucketKeyEnabled:true,removalPolicy:cdk.RemovalPolicy.RETAIN,lifecycleRules:[{prefix:"quarantine/",expiration:cdk.Duration.days(7),abortIncompleteMultipartUploadAfter:cdk.Duration.days(1)},{noncurrentVersionExpiration:cdk.Duration.days(production ? 90 : 30),abortIncompleteMultipartUploadAfter:cdk.Duration.days(1)}],cors:[{allowedOrigins:[publicUrl.valueAsString],allowedMethods:[s3.HttpMethods.PUT,s3.HttpMethods.GET,s3.HttpMethods.HEAD],allowedHeaders:["*"],exposedHeaders:["ETag","x-amz-version-id"]}]});
    const queues: Record<string,sqs.Queue> = {};
    const deadLetters: Record<string,sqs.Queue> = {};
    for (const kind of ["stage","production","data","control"]) {
      const dlq = new sqs.Queue(this,`${kind}DeadLetters`,{retentionPeriod:cdk.Duration.days(14),enforceSSL:true,encryption:sqs.QueueEncryption.KMS,encryptionMasterKey:keys.queues,dataKeyReuse:cdk.Duration.minutes(5),removalPolicy:cdk.RemovalPolicy.RETAIN});
      deadLetters[kind] = dlq;
      queues[kind] = new sqs.Queue(this,`${kind}Queue`,{visibilityTimeout:cdk.Duration.minutes(2),retentionPeriod:cdk.Duration.days(14),deadLetterQueue:{queue:dlq,maxReceiveCount:5},enforceSSL:true,encryption:sqs.QueueEncryption.KMS,encryptionMasterKey:keys.queues,dataKeyReuse:cdk.Duration.minutes(5),removalPolicy:cdk.RemovalPolicy.RETAIN});
    }
    const token = new secrets.Secret(this,"InternalToken",{generateSecretString:{passwordLength:48,excludePunctuation:true},encryptionKey:keys.secrets});
    const scannerToken = new secrets.Secret(this,"ScannerToken",{generateSecretString:{passwordLength:48,excludePunctuation:true},encryptionKey:keys.secrets});
    const connectionKey = new secrets.Secret(this,"ConnectionKey",{generateSecretString:{passwordLength:32,excludePunctuation:true},description:"32-byte ASCII key; application accepts base64-encoded key through CONNECTION_KEY_SECRET_ARN",encryptionKey:keys.secrets});
    const integrationSecrets = new secrets.Secret(this,"Integrations",{description:"Operator-configured integration credentials JSON; empty until explicitly connected",secretStringValue:cdk.SecretValue.unsafePlainText("{}"),encryptionKey:keys.secrets});
    for (const secret of [token, scannerToken, connectionKey, integrationSecrets]) secret.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    const pool = new cognito.UserPool(this,"Users",{selfSignUpEnabled:false,signInAliases:{email:true},removalPolicy:cdk.RemovalPolicy.RETAIN});
    const google = new cognito.UserPoolIdentityProviderGoogle(this,"Google",{userPool:pool,clientId:googleClient.valueAsString,clientSecretValue:cdk.SecretValue.cfnParameter(googleSecret),scopes:["openid","email","profile"],attributeMapping:{email:cognito.ProviderAttribute.GOOGLE_EMAIL}});
    const client = pool.addClient("Web",{generateSecret:false,supportedIdentityProviders:[cognito.UserPoolClientIdentityProvider.GOOGLE],oAuth:{flows:{authorizationCodeGrant:true},scopes:[cognito.OAuthScope.OPENID,cognito.OAuthScope.EMAIL,cognito.OAuthScope.PROFILE],callbackUrls:[`${publicUrl.valueAsString}/api/auth/callback`],logoutUrls:[publicUrl.valueAsString]},preventUserExistenceErrors:true});
    client.node.addDependency(google);
    const domain = pool.addDomain("Domain",{cognitoDomain:{domainPrefix:cdk.Fn.join("-",["harmonia",this.account,cdk.Fn.select(2,cdk.Fn.split("/",this.stackId))])}});
    const memory = new agentcore.CfnMemory(this,"Memory",{name:"harmonia_aws_memory",eventExpiryDuration:30,});
    const gatewayRole = new iam.Role(this,"GatewayRole",{assumedBy:new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com")});
    gatewayRole.addToPolicy(new iam.PolicyStatement({actions:["bedrock-agentcore:InvokeWebSearch"],resources:["*"]}));
    const gateway = new agentcore.CfnGateway(this,"ResearchGateway",{name:"harmonia-research",authorizerType:"AWS_IAM",roleArn:gatewayRole.roleArn,protocolType:"MCP"});
    new agentcore.CfnGatewayTarget(this,"WebSearch",{gatewayIdentifier:gateway.attrGatewayIdentifier,name:"web-search",targetConfiguration:{mcp:{connector:{source:{connectorId:"web-search"}}}}});
    const vectorBucket = new vectors.CfnVectorBucket(this,"SourceVectors",{});
    const index = new vectors.CfnIndex(this,"SourceIndex",{vectorBucketArn:vectorBucket.attrVectorBucketArn,indexName:"sources",dimension:1024,dataType:"float32",distanceMetric:"cosine",metadataConfiguration:{nonFilterableMetadataKeys:["AMAZON_BEDROCK_TEXT","AMAZON_BEDROCK_METADATA"]}});
    const kbRole = new iam.Role(this,"KnowledgeRole",{assumedBy:new iam.ServicePrincipal("bedrock.amazonaws.com")});
    bucket.grantRead(kbRole,"knowledge/*");
    kbRole.addToPolicy(new iam.PolicyStatement({actions:["s3vectors:GetIndex","s3vectors:QueryVectors","s3vectors:PutVectors","s3vectors:DeleteVectors","s3vectors:ListVectors"],resources:[index.attrIndexArn]}));
    kbRole.addToPolicy(new iam.PolicyStatement({actions:["bedrock:InvokeModel"],resources:[`arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`]}));
    const kb = new bedrock.CfnKnowledgeBase(this,"KnowledgeBase",{name:"harmonia-authorized-sources",roleArn:kbRole.roleArn,knowledgeBaseConfiguration:{type:"VECTOR",vectorKnowledgeBaseConfiguration:{embeddingModelArn:`arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`}},storageConfiguration:{type:"S3_VECTORS",s3VectorsConfiguration:{indexArn:index.attrIndexArn}}});
    const knowledgeSource = new bedrock.CfnDataSource(this,"KnowledgeSources",{knowledgeBaseId:kb.attrKnowledgeBaseId,name:"authorized-s3-sources",dataSourceConfiguration:{type:"S3",s3Configuration:{bucketArn:bucket.bucketArn,inclusionPrefixes:["knowledge/"]}},vectorIngestionConfiguration:{chunkingConfiguration:{chunkingStrategy:"NONE"}}});
    const runtimeRole = new iam.Role(this,"RuntimeRole",{assumedBy:new iam.ServicePrincipal("bedrock-agentcore.amazonaws.com")});
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["ecr:GetAuthorizationToken"],resources:["*"]}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer"],resources:[`arn:${this.partition}:ecr:${this.region}:${this.account}:repository/*`]}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["logs:CreateLogGroup","logs:DescribeLogStreams","logs:CreateLogStream","logs:PutLogEvents"],resources:[`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:/aws/bedrock-agentcore/runtimes/harmonia_strands-*`]}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["logs:PutResourcePolicy"],resources:["*"]}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["logs:DescribeLogGroups"],resources:[`arn:${this.partition}:logs:${this.region}:${this.account}:log-group:*`]}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["xray:PutTraceSegments","xray:PutTelemetryRecords","xray:GetSamplingRules","xray:GetSamplingTargets"],resources:["*"]}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["cloudwatch:PutMetricData"],resources:["*"],conditions:{StringEquals:{"cloudwatch:namespace":"bedrock-agentcore"}}}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],resources:[`arn:${this.partition}:bedrock:*::foundation-model/anthropic.claude-*`,`arn:${this.partition}:bedrock:*::foundation-model/amazon.nova-*`,`arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*`]}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["bedrock-agentcore:CreateEvent","bedrock-agentcore:RetrieveMemoryRecords","bedrock-agentcore:ListMemoryRecords","bedrock-agentcore:BatchCreateMemoryRecords"],resources:[memory.attrMemoryArn,`${memory.attrMemoryArn}/*`]}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["bedrock-agentcore:InvokeGateway"],resources:[gateway.attrGatewayArn]}));
    runtimeRole.addToPolicy(new iam.PolicyStatement({actions:["bedrock:Retrieve"],resources:[kb.attrKnowledgeBaseArn]}));
    bucket.grantRead(runtimeRole);
    token.grantRead(runtimeRole);
    const runtimeSg = new ec2.SecurityGroup(this,"RuntimeNetwork",{vpc});
    const runtime = new agentcore.CfnRuntime(this,"Cognition",{agentRuntimeName:"harmonia_strands",agentRuntimeArtifact:{containerConfiguration:{containerUri:runtimeImage.valueAsString}},networkConfiguration:{networkMode:"VPC",networkModeConfig:{subnets:vpc.privateSubnets.map(s=>s.subnetId),securityGroups:[runtimeSg.securityGroupId]}},roleArn:runtimeRole.roleArn,protocolConfiguration:"HTTP",environmentVariables:{WEB_INTERNAL_URL:"http://web.harmonia.internal:8080",INTERNAL_API_TOKEN_SECRET_ARN:token.secretArn,BEDROCK_TEXT_PRICING_JSON:textPrices.valueAsString,AWS_REGION:this.region,HARMONIA_ALLOW_PAID_AWS:String(paid),AGENTCORE_MEMORY_ID:memory.attrMemoryId,AGENTCORE_GATEWAY_URL:gateway.attrGatewayUrl,AGENTCORE_GATEWAY_SEARCH_TOOL:"web-search___WebSearch",BEDROCK_KNOWLEDGE_BASE_ID:kb.attrKnowledgeBaseId,BEDROCK_DATA_SOURCE_ID:knowledgeSource.attrDataSourceId}});
    const common = {BEDROCK_TEXT_PRICING_JSON:textPrices.valueAsString,HARMONIA_PROVIDER_SETTINGS_JSON:deploymentSettings.valueAsString,AWS_REGION:this.region,DYNAMODB_TABLE:table.tableName,S3_BUCKET:bucket.bucketName,SQS_STAGE_QUEUE_URL:queues.stage.queueUrl,SQS_PRODUCTION_QUEUE_URL:queues.production.queueUrl,SQS_DATA_QUEUE_URL:queues.data.queueUrl,SQS_CONTROL_QUEUE_URL:queues.control.queueUrl,HARMONIA_ALLOW_PAID_AWS:String(paid),AGENTCORE_RUNTIME_ARN:runtime.attrAgentRuntimeArn,AGENTCORE_MEMORY_ID:memory.attrMemoryId,MEMORY_BANK_ENABLED:"true",AGENTCORE_GATEWAY_URL:gateway.attrGatewayUrl,AGENTCORE_GATEWAY_SEARCH_TOOL:"web-search___WebSearch",BEDROCK_KNOWLEDGE_BASE_ID:kb.attrKnowledgeBaseId,BEDROCK_DATA_SOURCE_ID:knowledgeSource.attrDataSourceId,COGNITO_USER_POOL_ID:pool.userPoolId,COGNITO_CLIENT_ID:client.userPoolClientId,COGNITO_DOMAIN:domain.baseUrl(),AUTH_REDIRECT_URI:`${publicUrl.valueAsString}/api/auth/callback`,PUBLIC_BASE_URL:publicUrl.valueAsString,ATTACHMENT_ALLOWED_ORIGINS:publicUrl.valueAsString,AGENT_SERVICE_URL:"http://worker.harmonia.internal:8080",WEB_INTERNAL_URL:"http://web.harmonia.internal:8080",MALWARE_SCANNER_URL:"http://scanner.harmonia.internal:8080/scan",INTEGRATION_SECRETS_ARN:integrationSecrets.secretArn,HARMONIA_ENABLE_RESIDENT_AUTONOMY:"false",HARMONIA_TELEMETRY_ENABLED:"true",OTEL_EXPORTER_OTLP_ENDPOINT:"http://127.0.0.1:4317",OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT:"NO_CONTENT"};
    const runtimeSecrets = {INTERNAL_API_TOKEN:ecs.Secret.fromSecretsManager(token),MALWARE_SCANNER_TOKEN:ecs.Secret.fromSecretsManager(scannerToken),HARMONIA_CONNECTION_ENVELOPE_KEY_RAW:ecs.Secret.fromSecretsManager(connectionKey),HARMONIA_INTEGRATION_SECRETS_JSON:ecs.Secret.fromSecretsManager(integrationSecrets)};
    const runtimeLogs = createRuntimeLogGroups(this, keys.observability, stage, production);
    const webTask = new ecs.FargateTaskDefinition(this,"WebTask",{cpu:512,memoryLimitMiB:1024});
    webTask.addContainer("web",{image:ecs.ContainerImage.fromAsset(path.resolve(__dirname,"../.."),{exclude:["node_modules","agent/.venv","agent/node_modules",".next",".git",".artifacts",".data",".env*"],ignoreMode:cdk.IgnoreMode.GLOB}),environment:common,secrets:runtimeSecrets,logging:ecs.LogDrivers.awsLogs({streamPrefix:"web",logGroup:runtimeLogs.web}),portMappings:[{containerPort:8080}]});
    const web = new patterns.ApplicationLoadBalancedFargateService(this,"Web",{cluster,taskDefinition:webTask,desiredCount:production ? 2 : 1,minHealthyPercent:100,circuitBreaker:{rollback:true},publicLoadBalancer:true,certificate:acm.Certificate.fromCertificateArn(this,"Certificate",certificateArn.valueAsString),redirectHTTP:true,cloudMapOptions:{name:"web"},healthCheckGracePeriod:cdk.Duration.seconds(60)});
    web.targetGroup.configureHealthCheck({path:"/api/health",healthyHttpCodes:"200"});
    web.listener.addAction("BlockInternal",{priority:1,conditions:[elb.ListenerCondition.pathPatterns(["/api/internal","/api/internal/*"])],action:elb.ListenerAction.fixedResponse(403,{contentType:"text/plain",messageBody:"Forbidden"})});
    const workerTask = new ecs.FargateTaskDefinition(this,"WorkerTask",{cpu:1024,memoryLimitMiB:4096,ephemeralStorageGiB:40});
    workerTask.addContainer("worker",{image:ecs.ContainerImage.fromAsset(path.resolve(__dirname,"../../agent"),{exclude:[".venv","node_modules","__pycache__",".pytest_cache",".env*"],ignoreMode:cdk.IgnoreMode.GLOB}),environment:{...common,HARMONIA_ENABLE_QUEUE_CONSUMERS:"true"},secrets:runtimeSecrets,logging:ecs.LogDrivers.awsLogs({streamPrefix:"worker",logGroup:runtimeLogs.worker}),portMappings:[{containerPort:8080}]});
    const worker = new ecs.FargateService(this,"Worker",{cluster,taskDefinition:workerTask,desiredCount:production ? 2 : 1,minHealthyPercent:100,circuitBreaker:{rollback:true},cloudMapOptions:{name:"worker"}});
    const scannerTask = new ecs.FargateTaskDefinition(this,"ScannerTask",{cpu:512,memoryLimitMiB:2048});
    const collectorConfig = JSON.stringify({receivers:{otlp:{protocols:{grpc:{endpoint:"127.0.0.1:4317"}}}},processors:{batch:{}},exporters:{awsxray:{region:this.region}},service:{pipelines:{traces:{receivers:["otlp"],processors:["batch"],exporters:["awsxray"]}}}});
    const otelTargets: Array<[ecs.FargateTaskDefinition, logs.LogGroup]> = [[webTask, runtimeLogs.webOtel], [workerTask, runtimeLogs.workerOtel]];
    for(const [task, logGroup] of otelTargets) {
      task.addToTaskRolePolicy(new iam.PolicyStatement({actions:["xray:PutTraceSegments","xray:PutTelemetryRecords","xray:GetSamplingRules","xray:GetSamplingTargets"],resources:["*"]}));
      task.addContainer("otel",{image:ecs.ContainerImage.fromRegistry("amazon/aws-otel-collector:v0.46.0@sha256:371d3c8b9b97d0ebd0c56eb6b1e4f3d2ba4980c255f67d02695158e5851c2b31"),command:["--config=env:OTEL_CONFIG"],environment:{AWS_REGION:this.region,OTEL_CONFIG:collectorConfig},memoryReservationMiB:128,essential:true,logging:ecs.LogDrivers.awsLogs({streamPrefix:"otel",logGroup})});
    }
    scannerTask.addContainer("scanner",{image:ecs.ContainerImage.fromAsset(path.resolve(__dirname,"../malware-scanner")),secrets:{MALWARE_SCANNER_TOKEN:ecs.Secret.fromSecretsManager(scannerToken)},logging:ecs.LogDrivers.awsLogs({streamPrefix:"scanner",logGroup:runtimeLogs.scanner}),portMappings:[{containerPort:8080}]});
    const scanner = new ecs.FargateService(this,"Scanner",{cluster,taskDefinition:scannerTask,desiredCount:production ? 2 : 1,minHealthyPercent:100,circuitBreaker:{rollback:true},cloudMapOptions:{name:"scanner"}});
    web.service.connections.allowFrom(runtimeSg,ec2.Port.tcp(8080));
    web.service.connections.allowFrom(worker,ec2.Port.tcp(8080));
    worker.connections.allowFrom(web.service,ec2.Port.tcp(8080));
    scanner.connections.allowFrom(web.service,ec2.Port.tcp(8080));
    for (const task of [webTask,workerTask]) {
      table.grantReadWriteData(task.taskRole); bucket.grantReadWrite(task.taskRole); connectionKey.grantRead(task.taskRole); integrationSecrets.grantRead(task.taskRole);
      for (const queue of Object.values(queues)) queue.grantSendMessages(task.taskRole);
      task.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:["bedrock-agentcore:InvokeAgentRuntime"],resources:[runtime.attrAgentRuntimeArn,`${runtime.attrAgentRuntimeArn}/*`]}));
    }
    for (const queue of Object.values(queues)) queue.grantConsumeMessages(workerTask.taskRole);
    workerTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:["bedrock-agentcore:BatchCreateMemoryRecords","bedrock-agentcore:RetrieveMemoryRecords"],resources:[memory.attrMemoryArn,`${memory.attrMemoryArn}/*`]}));
    webTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:["bedrock:InvokeModel"],resources:[`arn:${this.partition}:bedrock:*::foundation-model/anthropic.claude-*`,`arn:${this.partition}:bedrock:${this.region}:${this.account}:inference-profile/*`]}));
    workerTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:["bedrock:InvokeModel","bedrock:StartAsyncInvoke","bedrock:GetAsyncInvoke"],resources:[`arn:${this.partition}:bedrock:${this.region}::foundation-model/amazon.nova-*`,`arn:${this.partition}:bedrock:${this.region}:${this.account}:async-invoke/*`]}));
    workerTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:["bedrock:StartIngestionJob","bedrock:GetIngestionJob"],resources:[kb.attrKnowledgeBaseArn]}));
    workerTask.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({actions:["transcribe:StartTranscriptionJob","transcribe:GetTranscriptionJob"],resources:[`arn:${this.partition}:transcribe:${this.region}:${this.account}:transcription-job/harmonia-*`]}));
    for (const [kind,expression] of [["tick","rate(1 minute)"],["recover","rate(5 minutes)"],["heartbeat","rate(1 hour)"],["dream","cron(0 2 * * ? *)"],["wakeup","cron(0 8 * * ? *)"]]) {
      new scheduler.Schedule(this,`${kind}Schedule`,{schedule:scheduler.ScheduleExpression.expression(expression,cdk.TimeZone.AFRICA_LAGOS),enabled:kind==="tick" || kind==="recover",target:new targets.SqsSendMessage(queues.control,{input:scheduler.ScheduleTargetInput.fromObject({data:{kind},attributes:{}}),retryAttempts:3})});
    }
    configureServiceScaling({ web, worker, scanner }, queues, production);
    const observability = configureObservability(this, stage, keys.observability, table, queues, deadLetters, { web, worker, scanner });
    const backups = configureBackups(this, table, bucket, keys, observability.topic);
    const webAcl = protectPublicService(this, web.loadBalancer, stage);
    new cdk.CfnOutput(this,"LoadBalancerDns",{value:web.loadBalancer.loadBalancerDnsName});
    new cdk.CfnOutput(this,"CognitoCallback",{value:`${domain.baseUrl()}/oauth2/idpresponse`});
    new cdk.CfnOutput(this,"RuntimeArn",{value:runtime.attrAgentRuntimeArn});
    new cdk.CfnOutput(this,"RuntimeId",{value:runtime.attrAgentRuntimeId});
    new cdk.CfnOutput(this,"AssetsBucket",{value:bucket.bucketName});
    new cdk.CfnOutput(this,"StateTable",{value:table.tableName});
    new cdk.CfnOutput(this,"StateTableArn",{value:table.tableArn});
    new cdk.CfnOutput(this,"ClusterName",{value:cluster.clusterName});
    new cdk.CfnOutput(this,"WebServiceName",{value:web.service.serviceName});
    new cdk.CfnOutput(this,"WorkerServiceName",{value:worker.serviceName});
    new cdk.CfnOutput(this,"ScannerServiceName",{value:scanner.serviceName});
    new cdk.CfnOutput(this,"InternalTokenSecretArn",{value:token.secretArn});
    new cdk.CfnOutput(this,"ScannerTokenSecretArn",{value:scannerToken.secretArn});
    new cdk.CfnOutput(this,"OperationsAlertTopic",{value:observability.topic.topicArn});
    new cdk.CfnOutput(this,"OperationsDashboardName",{value:observability.dashboard.dashboardName});
    new cdk.CfnOutput(this,"BackupVaultName",{value:backups.vault.backupVaultName});
    new cdk.CfnOutput(this,"BackupPlanId",{value:backups.plan.backupPlanId});
    new cdk.CfnOutput(this,"PublicWebAclArn",{value:webAcl.attrArn});
  }
}
