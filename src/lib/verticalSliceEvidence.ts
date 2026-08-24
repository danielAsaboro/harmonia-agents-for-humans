import { z } from "zod";

const REQUIRED_STAGES = [
  "ingest",
  "transcribe",
  "understand",
  "draft",
  "awaiting_approval",
  "publish",
  "verify",
] as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const traceId = z.string().regex(/^[a-f0-9]{32}$/);
const timestamp = z.string().datetime({ offset: true });
const usd = z.string().regex(/^\d+\.\d{6}$/);

const sourceSchema = z.object({
  kind: z.literal("youtube"),
  sourceId: z.string().min(1),
  authorizationRef: z.string().min(1),
  metadataDigest: sha256,
}).strict();

const environmentSchema = z.object({
  projectId: z.string().min(1),
  location: z.string().min(1),
  webService: z.string().min(1),
  webRevision: z.string().min(1),
  agentService: z.string().min(1),
  agentRevision: z.string().min(1),
  agentEngineResource: z.string().min(1),
  firestoreDatabase: z.string().min(1),
  pubsubTopic: z.string().min(1),
  mockAi: z.boolean(),
  mockEffects: z.boolean(),
  emulator: z.boolean(),
}).strict();

const jobSchema = z.object({
  workspaceId: z.string().min(1),
  brandId: z.string().min(1),
  jobId: z.string().min(1),
  createdAt: timestamp,
  completedAt: timestamp,
}).strict();

const eventSchema = z.object({
  eventId: z.string().min(1),
  stage: z.enum(REQUIRED_STAGES),
  status: z.enum(["waiting", "completed"]),
  at: timestamp,
  operationId: z.string().min(1),
  pubsubMessageId: z.string().min(1),
  traceId,
}).strict();

const cognitionSchema = z.object({
  role: z.string().min(1),
  model: z.string().min(1),
  provider: z.literal("gemini"),
  policyVersion: z.string().min(1),
  usageRecordId: z.string().min(1),
  operationId: z.string().min(1),
  traceId,
}).strict();

const approvalSchema = z.object({
  approvalId: z.string().min(1),
  actionId: z.string().min(1),
  decision: z.literal("approved"),
  actorType: z.literal("human_operator"),
  decidedAt: timestamp,
  traceId,
}).strict();

const effectSchema = z.object({
  actionId: z.string().min(1),
  operationId: z.string().min(1),
  idempotencyKey: sha256,
  receiptId: z.string().min(1),
  kind: z.enum(["export_content_pack", "publish_post"]),
  outcome: z.literal("applied"),
  executedAt: timestamp,
  artifactDigest: sha256,
  traceId,
}).strict();

const verificationSchema = z.object({
  verificationId: z.string().min(1),
  receiptId: z.string().min(1),
  method: z.enum(["artifact_digest_reread", "official_api_readback"]),
  status: z.enum(["verified", "failed"]),
  checkedAt: timestamp,
  observedDigest: sha256,
  traceId,
}).strict();

const costRecordSchema = z.object({
  usageRecordId: z.string().min(1),
  operationId: z.string().min(1),
  estimatedUsd: usd,
  observedUsd: usd,
}).strict();

const costsSchema = z.object({
  pricingVersion: z.string().min(1),
  currency: z.literal("USD"),
  records: z.array(costRecordSchema),
  totalEstimatedUsd: usd,
  totalObservedUsd: usd,
}).strict();

const evidenceFileSchema = z.object({
  kind: z.enum(["job_export", "trace_export", "approval_export", "effect_export"]),
  relativePath: z.string().min(1),
  sha256,
}).strict();

export const verticalSliceEvidenceSchema = z.object({
  schemaVersion: z.literal("harmonia.vertical-slice-evidence.v1"),
  runId: z.string().min(1),
  capturedAt: timestamp,
  source: sourceSchema,
  environment: environmentSchema,
  job: jobSchema,
  events: z.array(eventSchema),
  cognition: z.array(cognitionSchema).min(1),
  approval: approvalSchema,
  effect: effectSchema,
  verification: verificationSchema,
  costs: costsSchema,
  evidenceFiles: z.array(evidenceFileSchema).min(1),
}).strict();

export type VerticalSliceEvidence = z.infer<typeof verticalSliceEvidenceSchema>;

export type EvidenceFailure = {
  code: string;
  path: string;
  message: string;
};

export type EvidenceVerification = {
  ok: boolean;
  failures: EvidenceFailure[];
};

function failure(code: string, path: string, message: string): EvidenceFailure {
  return { code, path, message };
}

function decimalToMicros(value: string): bigint {
  const [whole, fractional] = value.split(".");
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fractional);
}

export function verifyVerticalSliceEvidence(input: unknown): EvidenceVerification {
  const parsed = verticalSliceEvidenceSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      failures: parsed.error.issues.map((issue) => failure(
        "schema_invalid",
        issue.path.join("."),
        issue.message,
      )),
    };
  }

  const bundle = parsed.data;
  const failures: EvidenceFailure[] = [];

  if (bundle.environment.mockAi || bundle.environment.mockEffects || bundle.environment.emulator) {
    failures.push(failure(
      "non_production_provenance",
      "environment",
      "Authenticated evidence cannot originate from mocks or emulators.",
    ));
  }

  if (!/^projects\/[^/]+\/locations\/[^/]+\/reasoningEngines\/[^/]+$/.test(
    bundle.environment.agentEngineResource,
  )) {
    failures.push(failure(
      "missing_agent_engine",
      "environment.agentEngineResource",
      "A concrete Vertex AI Agent Engine resource is required.",
    ));
  }

  if (!bundle.cognition.every((entry) => /^gemini-3\.(?:[5-9]|\d{2,})(?:-|$)/.test(entry.model))) {
    failures.push(failure(
      "missing_required_gemini",
      "cognition",
      "Every cognition record must use Gemini 3.5 or newer.",
    ));
  }

  const presentStages = new Set(bundle.events.map((event) => event.stage));
  for (const stage of REQUIRED_STAGES) {
    if (!presentStages.has(stage)) {
      failures.push(failure("missing_stage", "events", `Missing required stage: ${stage}.`));
    }
  }

  const stageSequence = bundle.events.map((event) => event.stage);
  if (
    stageSequence.length !== REQUIRED_STAGES.length
    || stageSequence.some((stage, index) => stage !== REQUIRED_STAGES[index])
  ) {
    failures.push(failure(
      "stage_order_invalid",
      "events",
      "Evidence stages must appear exactly once in the required lifecycle order.",
    ));
  }

  for (let index = 1; index < bundle.events.length; index += 1) {
    if (Date.parse(bundle.events[index].at) < Date.parse(bundle.events[index - 1].at)) {
      failures.push(failure("stage_order_invalid", `events.${index}.at`, "Stage timestamps are not monotonic."));
      break;
    }
  }

  const expectedTrace = bundle.events[0]?.traceId;
  const traceRecords = [
    ...bundle.events.map((entry) => ({ path: "events", value: entry.traceId })),
    ...bundle.cognition.map((entry) => ({ path: "cognition", value: entry.traceId })),
    { path: "approval", value: bundle.approval.traceId },
    { path: "effect", value: bundle.effect.traceId },
    { path: "verification", value: bundle.verification.traceId },
  ];
  if (!expectedTrace || traceRecords.some((entry) => entry.value !== expectedTrace)) {
    failures.push(failure("trace_mismatch", "traceId", "All lifecycle records must share one trace ID."));
  }

  const operationIds = bundle.events.map((event) => event.operationId);
  if (new Set(operationIds).size !== operationIds.length) {
    failures.push(failure("duplicate_operation_id", "events", "Event operation IDs must be unique."));
  }

  if (bundle.approval.actionId !== bundle.effect.actionId) {
    failures.push(failure("action_mismatch", "effect.actionId", "Effect does not match the approved action."));
  }
  if (Date.parse(bundle.effect.executedAt) < Date.parse(bundle.approval.decidedAt)) {
    failures.push(failure("effect_before_approval", "effect.executedAt", "Effect occurred before human approval."));
  }
  if (bundle.verification.receiptId !== bundle.effect.receiptId) {
    failures.push(failure("receipt_mismatch", "verification.receiptId", "Verification does not reference the effect receipt."));
  }
  if (bundle.verification.observedDigest !== bundle.effect.artifactDigest) {
    failures.push(failure("artifact_digest_mismatch", "verification.observedDigest", "Verified artifact differs from the applied artifact."));
  }
  if (bundle.verification.status !== "verified") {
    failures.push(failure("effect_not_verified", "verification.status", "The external effect was not independently verified."));
  }
  if (Date.parse(bundle.verification.checkedAt) < Date.parse(bundle.effect.executedAt)) {
    failures.push(failure("verification_before_effect", "verification.checkedAt", "Verification occurred before effect execution."));
  }

  const costsByUsage = new Map(bundle.costs.records.map((record) => [record.usageRecordId, record]));
  for (const cognition of bundle.cognition) {
    const cost = costsByUsage.get(cognition.usageRecordId);
    if (!cost || cost.operationId !== cognition.operationId) {
      failures.push(failure(
        "missing_usage_record",
        "costs.records",
        `No matching cost record exists for usage ${cognition.usageRecordId}.`,
      ));
    }
  }

  const estimated = bundle.costs.records.reduce(
    (sum, record) => sum + decimalToMicros(record.estimatedUsd),
    BigInt(0),
  );
  const observed = bundle.costs.records.reduce(
    (sum, record) => sum + decimalToMicros(record.observedUsd),
    BigInt(0),
  );
  if (
    estimated !== decimalToMicros(bundle.costs.totalEstimatedUsd)
    || observed !== decimalToMicros(bundle.costs.totalObservedUsd)
  ) {
    failures.push(failure(
      "cost_total_mismatch",
      "costs",
      "Declared cost totals do not exactly reconcile with usage records.",
    ));
  }

  return { ok: failures.length === 0, failures };
}
