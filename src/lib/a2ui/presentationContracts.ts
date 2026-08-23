import { z } from "zod";

const id = z.string().min(1).max(200);
const boundedList = <T extends z.ZodTypeAny>(schema: T, max: number) => z.array(schema).max(max);

const jobSummarySchema = z.object({
  id,
  stage: z.string().min(1).max(100),
  status: z.string().min(1).max(100),
  title: z.string().max(300).optional(),
  sourceKind: z.enum(["written", "video", "audio", "mixed"]),
}).strict();

const draftSummarySchema = z.object({
  id,
  platform: z.string().min(1).max(50),
  valid: z.boolean(),
  momentId: id.optional(),
  angleId: id.optional(),
}).strict();

const momentSummarySchema = z.object({
  id,
  title: z.string().min(1).max(300),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
}).strict().refine((value) => value.endSec >= value.startSec, {
  message: "moment endSec must not precede startSec",
});

const sourceSummarySchema = z.object({
  id,
  kind: z.enum(["video", "audio", "transcript", "media", "http"]),
  label: z.string().min(1).max(300),
}).strict();

const assetSummarySchema = z.object({
  actionId: id,
  kind: z.enum(["image", "video", "audio", "document", "other"]),
  mime: z.string().min(1).max(120),
}).strict();

const actionSummarySchema = z.object({
  id,
  type: z.string().min(1).max(100),
  pending: z.boolean(),
}).strict();

const receiptSummarySchema = z.object({
  id,
  actionId: id,
  outcome: z.enum(["applied", "already_applied", "rejected", "failed"]),
  verified: z.boolean(),
}).strict();

export const uiContextSchema = z.object({
  runId: id,
  operatorRequest: z.string().min(1).max(2_000),
  intent: z.string().min(1).max(100),
  job: jobSummarySchema.nullable().optional(),
  drafts: boundedList(draftSummarySchema, 20).default([]),
  moments: boundedList(momentSummarySchema, 20).default([]),
  sources: boundedList(sourceSummarySchema, 50).default([]),
  assets: boundedList(assetSummarySchema, 20).default([]),
  actions: boundedList(actionSummarySchema, 20).default([]),
  receipts: boundedList(receiptSummarySchema, 20).default([]),
}).strict();

export const surfaceSlots = ["canvas", "conversation", "approval"] as const;
export const surfaceComponentNames = [
  "CampaignBrief",
  "JobProgress",
  "MomentExplorer",
  "DraftComparison",
  "PlatformPreview",
  "SourceEvidence",
  "ApprovalReview",
  "VerificationReceipt",
  "SurfaceLoading",
  "SurfaceEmpty",
  "SurfaceUnresolved",
  "SurfaceFailure",
] as const;

const entityRefsSchema = z.object({
  jobId: id.optional(),
  draftIds: boundedList(id, 20).default([]),
  momentIds: boundedList(id, 20).default([]),
  sourceIds: boundedList(id, 50).default([]),
  assetActionIds: boundedList(id, 20).default([]),
  actionIds: boundedList(id, 20).default([]),
  receiptIds: boundedList(id, 20).default([]),
}).strict();

const surfacePlanNodeSchema = z.object({
  id,
  component: z.enum(surfaceComponentNames),
  refs: entityRefsSchema.default(() => ({
    draftIds: [],
    momentIds: [],
    sourceIds: [],
    assetActionIds: [],
    actionIds: [],
    receiptIds: [],
  })),
  title: z.string().max(160).optional(),
  emphasis: z.enum(["primary", "secondary", "compact"]).default("primary"),
  children: boundedList(id, 30).default([]),
}).strict();

const plannedSurfaceSchema = z.object({
  slot: z.enum(surfaceSlots),
  revision: z.number().int().positive(),
  rootId: id,
  nodes: z.array(surfacePlanNodeSchema).min(1).max(40),
}).strict().superRefine((surface, context) => {
  const ids = surface.nodes.map((node) => node.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", message: "surface graph node ids must be unique" });
  }
  if (!ids.includes(surface.rootId)) {
    context.addIssue({ code: "custom", message: "surface graph must include rootId" });
  }
  for (const node of surface.nodes) {
    for (const child of node.children) {
      if (!ids.includes(child)) {
        context.addIssue({ code: "custom", message: `surface graph contains dangling child ${child}` });
      }
    }
  }
});

export const surfacePlanSchema = z.object({
  version: z.literal("harmonia.ui/v1"),
  surfaces: z.array(plannedSurfaceSchema).min(1).max(3),
}).strict().superRefine((plan, context) => {
  const slots = plan.surfaces.map((surface) => surface.slot);
  if (new Set(slots).size !== slots.length) {
    context.addIssue({ code: "custom", message: "surface plan slots must be unique" });
  }
});

export type UiContext = z.infer<typeof uiContextSchema>;
export type SurfacePlan = z.infer<typeof surfacePlanSchema>;
export type SurfaceSlot = (typeof surfaceSlots)[number];
export type SurfaceComponentName = (typeof surfaceComponentNames)[number];
