import { z } from "zod";
import { strategyRefSchema, strategySourceBindingSchema } from "../strategy/contracts";
import type { EditorialPlan, EditorialPlanItem, EditorialPlanningSnapshot, JobConfig, SourceAnalysis } from "../types";

const id = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const authorityRefSchema = z.object({ workspaceId: id, brandId: id, id, revision }).strict();
export type AuthorityRef = z.infer<typeof authorityRefSchema>;
export const planningPolicySchema = z.object({
  timezone: z.string().refine(value => { try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; } }, "configured IANA timezone required"),
  productionCapacity: z.object({ maxItems: z.number().int().min(1).max(48), maxItemsPerWeek: z.number().int().min(1).max(12) }).strict(),
  cadenceConstraints: z.object({ minimumHoursBetweenItems: z.number().int().min(0).max(168), maxItemsPerChannelPerWeek: z.number().int().min(1).max(12) }).strict(),
  maxConcurrentItems: z.number().int().min(1).max(12),
}).strict();
export type PlanningPolicy = z.infer<typeof planningPolicySchema> & { ref: AuthorityRef; configuredBy: string; configuredAt: string };
export const operatorPlanningContextSchema = z.object({
  mode: z.literal("operator_context"), operatorBrief: z.string().trim().min(1).max(20000),
  contextDigest: z.string().regex(/^[a-f0-9]{64}$/), evidenceIds: z.array(z.never()).length(0),
  factualClaimsAllowed: z.literal(false),
}).strict();
export const plannedEvidenceSchema = z.discriminatedUnion("mode", [
  operatorPlanningContextSchema,
  z.object({ mode: z.literal("source_backed"), sourceJobId: id, sourceBinding: strategySourceBindingSchema }).strict(),
]);
export type PlannedEvidence = z.infer<typeof plannedEvidenceSchema>;
export type PlannedProductionContext =
  | { mode: "operator_context"; policyRef: AuthorityRef }
  | { mode: "source_backed"; policyRef: AuthorityRef; plan: Omit<EditorialPlan, "items" | "selectedNextItemId">; item: EditorialPlanItem; snapshot: EditorialPlanningSnapshot; config: JobConfig; sourceAnalysis: SourceAnalysis };
export interface Campaign { ref: AuthorityRef; workspaceId: string; brandId: string; name: string; objective: string; strategyRef: z.infer<typeof strategyRefSchema>; createdAt: string; createdBy: string }
export interface PlanRevision {
  ref: AuthorityRef; workspaceId: string; brandId: string; campaignRef: AuthorityRef | null;
  strategyRef: z.infer<typeof strategyRefSchema>; policyRef: AuthorityRef; itemRefs: AuthorityRef[];
  createdAt: string; createdBy: string; reason: string;
  acceptedEditorialDigest?: string;
}
export interface PlannedItem {
  ref: AuthorityRef; workspaceId: string; brandId: string; planRef: AuthorityRef; campaignRef: AuthorityRef | null;
  strategyRef: z.infer<typeof strategyRefSchema>; name: string; objective: string; operatorBrief: string;
  requestedOutputs: JobConfig["desiredOutputs"]; channel: string; scheduledFor: string; publicationWindowEndAt?: string; productionDeadlineAt?: string; productionReadyAt?: string;
  dependencies: AuthorityRef[]; requiredAssetIds: string[]; evidence: PlannedEvidence;
  productionContext: PlannedProductionContext; productionContextDigest: string;
  editorialItemId?: string; createdAt: string;
}
export type ItemStatus = "planned" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "blocked" | "requires_disposition";
export interface PlannedItemState {
  ref: AuthorityRef; workspaceId: string; brandId: string; status: ItemStatus; updatedAt: string;
  jobId?: string; outboxId?: string; reason?: string; retryable?: boolean; retryPending?: boolean;
  dispositionProposalId?: string;
}
export interface PlanningMaterialization { campaignRef: AuthorityRef | null; planRef: AuthorityRef; itemRefs: AuthorityRef[]; proposalId?: string }
export interface PlanningAsset { id: string; workspaceId: string; brandId: string; briefId: string; assetType: string; status: "ready" | "missing" | "blocked"; evidenceRefs: string[] }
