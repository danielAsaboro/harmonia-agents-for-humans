import { z } from "zod";

export const HARMONIA_CATALOG_ID = "https://harmonia.app/a2ui/catalogs/chat/v1";

const id = z.string().min(1).max(200);
const status = z.enum(["pending", "active", "complete", "failed"]);
const httpUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "https:" || protocol === "http:";
}, "only HTTP(S) URLs are allowed");
const authorizedPreviewUrl = z.string().refine(
  (value) => value.startsWith("/api/chat/attachments/") || /^\/api\/jobs\/[^/]+\/assets\/[^/]+$/.test(value),
  "only authorized same-origin preview routes are allowed",
);

export const activitySchema = z.object({
  id,
  label: z.string().min(1).max(500),
  description: z.string().max(2_000).optional(),
  status,
  sourceIds: z.array(id).max(50).optional(),
}).strict();

const baseComponent = z.object({ id, component: z.string() });

const activityTraceSchema = baseComponent.extend({
  component: z.literal("ActivityTrace"),
  title: z.string().min(1).max(200),
  steps: z.array(activitySchema).max(100),
}).strict();

const reasoningSummarySchema = baseComponent.extend({
  component: z.literal("ReasoningSummary"),
  summary: z.string().min(1).max(4_000),
  sourceIds: z.array(id).max(50).optional(),
}).strict();

const attachmentCardSchema = baseComponent.extend({
  component: z.literal("AttachmentCard"),
  attachmentId: id,
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(120),
  sizeBytes: z.number().int().nonnegative(),
  state: z.enum(["uploading", "ready", "failed"]),
  previewUrl: authorizedPreviewUrl.optional(),
}).strict();

const inlineCitationSchema = baseComponent.extend({
  component: z.literal("InlineCitation"),
  title: z.string().min(1).max(500),
  url: httpUrl,
  sourceId: id.optional(),
  excerpt: z.string().max(1_000).optional(),
}).strict();

const planStepSchema = z.object({
  id,
  label: z.string().min(1).max(500),
  status,
}).strict();

const planViewSchema = baseComponent.extend({
  component: z.literal("PlanView"),
  title: z.string().min(1).max(200),
  steps: z.array(planStepSchema).max(100),
}).strict();

const queueItemSchema = z.object({
  id,
  label: z.string().min(1).max(500),
  status,
  jobId: id.optional(),
}).strict();

const queueViewSchema = baseComponent.extend({
  component: z.literal("QueueView"),
  title: z.string().min(1).max(200),
  items: z.array(queueItemSchema).max(100),
}).strict();

const toolActivitySchema = baseComponent.extend({
  component: z.literal("ToolActivity"),
  name: z.string().min(1).max(200),
  status,
  inputSummary: z.string().max(2_000).optional(),
  outputSummary: z.string().max(2_000).optional(),
  durationMs: z.number().int().nonnegative().optional(),
  traceId: id.optional(),
}).strict();

const taskViewSchema = baseComponent.extend({
  component: z.literal("TaskView"),
  title: z.string().min(1).max(500),
  owner: z.string().min(1).max(200).optional(),
  status,
  jobId: id.optional(),
  stage: z.string().min(1).max(100).optional(),
}).strict();

const contextUsageSchema = baseComponent.extend({
  component: z.literal("ContextUsage"),
  model: z.string().min(1).max(200),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  contextLimit: z.number().int().positive().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  estimatedCostUsd: z.number().nonnegative().optional(),
}).strict();

const messageContentSchema = baseComponent.extend({
  component: z.literal("MessageContent"),
  text: z.string().max(20_000),
  citationIds: z.array(id).max(100).optional(),
  attachmentIds: z.array(id).max(100).optional(),
}).strict();

const confirmationFields = {
  id,
  operationId: id.optional(),
  jobId: id.optional(),
  actionId: id.optional(),
  title: z.string().min(1).max(500),
  description: z.string().max(2_000).optional(),
  risk: z.enum(["low", "material", "high"]),
  state: z.enum(["pending", "approved", "rejected", "expired"]),
} as const;
const hasOneConfirmationTarget = (value: { operationId?: string; jobId?: string; actionId?: string }) =>
  Boolean(value.operationId) !== Boolean(value.jobId && value.actionId);

const confirmationSchema = z.object({
  ...confirmationFields,
  component: z.literal("Confirmation"),
}).strict().refine(
  hasOneConfirmationTarget,
  "confirmation must reference either one operation or one job action",
);

export const catalogComponentSchema = z.discriminatedUnion("component", [
  activityTraceSchema,
  reasoningSummarySchema,
  attachmentCardSchema,
  inlineCitationSchema,
  planViewSchema,
  queueViewSchema,
  toolActivitySchema,
  taskViewSchema,
  contextUsageSchema,
  messageContentSchema,
  confirmationSchema,
]);

export type HarmoniaCatalogComponent = z.infer<typeof catalogComponentSchema>;

export function parseCatalogComponent(value: unknown): HarmoniaCatalogComponent {
  return catalogComponentSchema.parse(value);
}

const eventBase = z.object({
  runId: id,
  sequence: z.number().int().nonnegative(),
});

const streamEventSchema = z.discriminatedUnion("type", [
  eventBase.extend({ type: z.literal("run_started"), startedAt: z.string().datetime() }).strict(),
  eventBase.extend({ type: z.literal("text_delta"), delta: z.string().max(20_000) }).strict(),
  eventBase.extend({ type: z.literal("activity"), activity: activitySchema }).strict(),
  eventBase.extend({
    type: z.literal("tool_activity"),
    tool: toolActivitySchema.omit({ component: true, id: true }),
  }).strict(),
  eventBase.extend({
    type: z.literal("a2ui_operation"),
    operation: z.record(z.string(), z.unknown()),
  }).strict(),
  eventBase.extend({
    type: z.literal("confirmation_requested"),
    confirmation: z.object(confirmationFields).strict().refine(hasOneConfirmationTarget),
  }).strict(),
  eventBase.extend({
    type: z.literal("job_updated"),
    jobId: id,
    stage: z.string().min(1).max(100),
    status: z.string().min(1).max(100),
  }).strict(),
  eventBase.extend({
    type: z.literal("run_completed"),
    completedAt: z.string().datetime(),
    reply: z.string().max(20_000),
  }).strict(),
  eventBase.extend({
    type: z.literal("run_failed"),
    failedAt: z.string().datetime(),
    error: z.string().min(1).max(4_000),
    permanent: z.boolean(),
  }).strict(),
]);

export type ChatStreamEvent = z.infer<typeof streamEventSchema>;

export function parseChatStreamEvent(value: unknown): ChatStreamEvent {
  return streamEventSchema.parse(value);
}
