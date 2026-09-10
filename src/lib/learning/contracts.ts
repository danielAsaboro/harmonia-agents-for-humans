import { z } from "zod";
import { strategyDigest } from "../strategyApproval";
import { strategyRefSchema, type StrategyRef } from "../strategy/contracts";
import type { AuthorityRef } from "../campaigns/contracts";
import { authorityRefSchema } from "../campaigns/contracts";

const id = z.string().regex(/^[A-Za-z0-9_.:-]{1,180}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
export const measurementDefinitionSchema = z.object({
  id, revision: z.number().int().positive(), metricId: id,
  kind: z.enum(["performance", "delivery_verification"]),
  unit: z.enum(["count", "ratio", "seconds", "boolean"]),
  comparator: z.enum(["observe", "gte", "lte", "eq"]), target: z.number().finite().nullable(),
  baseline: z.object({ value: z.number().finite(), sampleCount: z.number().int().positive(), evidenceIds: z.array(id).min(1) }).strict().nullable(),
  window: z.object({ anchor: z.enum(["publication", "completion"]), startOffsetSeconds: z.number().int().nonnegative(), endOffsetSeconds: z.number().int().nonnegative(), collectionToleranceSeconds: z.number().int().min(0).max(86400) }).strict(),
  collectionMethod: z.enum(["official_x", "operator", "unsupported", "verification_receipt"]),
}).strict().superRefine((m, ctx) => {
  if ((m.comparator === "observe") !== (m.target === null)) ctx.addIssue({ code: "custom", message: "observation-only definitions have no target; comparisons require a target" });
  if (m.window.startOffsetSeconds !== 0 || m.window.endOffsetSeconds < m.window.startOffsetSeconds) ctx.addIssue({ code: "custom", message: "only cumulative windows starting at the anchor are supported" });
  if (m.collectionMethod === "official_x" && (!/^x\.(likes|replies|reposts|quotes|impressions)$/.test(m.metricId) || m.unit !== "count" || m.window.anchor !== "publication" || m.kind !== "performance")) ctx.addIssue({ code: "custom", message: "unsupported X metric definition" });
  if ((m.kind === "delivery_verification") !== (m.collectionMethod === "verification_receipt") || (m.kind === "delivery_verification" && (m.metricId !== "delivery.verified" || m.unit !== "boolean"))) ctx.addIssue({ code: "custom", message: "delivery verification requires its separate receipt definition" });
});
export type MeasurementDefinition = z.infer<typeof measurementDefinitionSchema>;
export const configureMeasurementSchema = z.object({ itemRef: authorityRefSchema, expectedPlanRef: authorityRefSchema, strategyRef: strategyRefSchema, requestId: id, measurement: measurementDefinitionSchema }).strict();
export const pinnedMeasurementSchema = z.object({ definition: measurementDefinitionSchema, digest }).strict().refine(m => strategyDigest(m.definition) === m.digest, "measurement definition digest mismatch");
export type PinnedMeasurement = z.infer<typeof pinnedMeasurementSchema>;
export function pinMeasurement(input: MeasurementDefinition): PinnedMeasurement { const definition = measurementDefinitionSchema.parse(input); return { definition, digest: strategyDigest(definition) }; }
export function defaultMeasurements(channel: string): PinnedMeasurement[] {
  return [pinMeasurement({ id: "delivery", revision: 1, metricId: "delivery.verified", kind: "delivery_verification", unit: "boolean", comparator: "eq", target: 1, baseline: null, window: { anchor: "completion", startOffsetSeconds: 0, endOffsetSeconds: 0, collectionToleranceSeconds: 86400 }, collectionMethod: "verification_receipt" }),
    pinMeasurement({ id: "audience", revision: 1, metricId: channel === "x" ? "x.likes" : `${channel}.audience`, kind: "performance", unit: "count", comparator: "observe", target: null, baseline: null, window: { anchor: "publication", startOffsetSeconds: 0, endOffsetSeconds: 86400, collectionToleranceSeconds: 300 }, collectionMethod: channel === "x" ? "official_x" : "unsupported" })];
}
export const observationValueSchema = z.discriminatedUnion("availability", [
  z.object({ availability: z.literal("available"), value: z.number().finite(), reason: z.null() }).strict(),
  ...(["pending_window", "unavailable", "failed", "revoked"] as const).map(availability => z.object({ availability: z.literal(availability), value: z.null(), reason: z.string().min(1).max(1000) }).strict()),
]);
export type ObservationValue = z.infer<typeof observationValueSchema>;
export interface ObservationBinding {
  workspaceId: string; brandId: string; itemRef: AuthorityRef; planRef: AuthorityRef; campaignRef: AuthorityRef | null;
  strategyRef: StrategyRef; pillar: string | null; jobId: string; actionId: string | null; artifactId: string | null; postId: string | null;
  sourceIds: string[];
}
export type PerformanceObservation = ObservationBinding & ObservationValue & {
  id: string; collectionId: string; measurement: PinnedMeasurement; kind: MeasurementDefinition["kind"];
  window: { startAt: string; endAt: string }; observedAt: string; provider: "x" | "operator" | "host" | "unsupported";
  actor: string | null; evidenceRefs: string[]; digest: string;
};
export type Collection = ObservationBinding & {
  id: string; measurement: PinnedMeasurement; window: PerformanceObservation["window"]; dueAt: string; expiresAt: string;
  state: "scheduled" | "collecting" | "completed" | "reconciliation_required"; observationId: string;
  createdAt: string; attempts: number; token?: string; leaseUntil?: string;
  dispatch?: { issuedAt: string; expiresAt: string; token: string };
  reconciliationDigest?: string;
  costAuthorization?: { maximumUsd: string; reservationId: string; accounting: "reserved_pending_provider_billing" };
};
export function observationKey(itemRef: AuthorityRef, measurement: PinnedMeasurement, window: PerformanceObservation["window"]) { return strategyDigest({ itemRef, measurementDigest: measurement.digest, window }); }
export interface Evaluation {
  id: string; observationIds: string[]; measurement: PinnedMeasurement; strategyRef: StrategyRef;
  cohortMembers: Array<Pick<PerformanceObservation, "id" | "digest" | "collectionId" | "itemRef" | "availability" | "window">>;
  campaignRefs: AuthorityRef[]; planRefs: AuthorityRef[]; itemRefs: AuthorityRef[]; pillars: string[];
  sampleCount: number; value: number | null; baseline: MeasurementDefinition["baseline"];
  cohortCount: number; missingCounts: Record<"pending_window" | "unavailable" | "failed" | "revoked", number>;
  supportingObservationIds: string[]; contradictingObservationIds: string[];
  confidence: "insufficient" | "low" | "moderate"; causalClaim: false;
  outcome: "delivery_only" | "unmeasured" | "observational"; limitations: string[];
}
export const strategyChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cadence_guidance"), value: z.string().min(1).max(600) }).strict(),
  z.object({ type: z.literal("cta_guidance"), value: z.array(z.string().min(1).max(300)).min(1).max(12) }).strict(),
  z.object({ type: z.literal("pillar_purpose"), pillar: z.string().min(1).max(200), value: z.string().min(1).max(600) }).strict(),
  z.object({ type: z.literal("assumption"), value: z.string().min(1).max(300) }).strict(),
]);
export const evidenceRefSchema = z.object({ id, digest }).strict();
export const changeProposalInputSchema = z.object({ requestId: id, baseStrategyRef: strategyRefSchema, changes: z.array(strategyChangeSchema).min(1).max(8), rationale: z.string().min(1).max(2000), evidenceRefs: z.array(evidenceRefSchema).min(1).max(24), contradictionRefs: z.array(evidenceRefSchema).max(24) }).strict();
export type ChangeProposalInput = z.infer<typeof changeProposalInputSchema>;
export interface LearningEvidence {
  id: string; workspaceId: string; brandId: string; kind: "source_discovery" | "operator_feedback" | "evaluation";
  sourceIds: string[]; observationIds: string[]; actor: string; createdAt: string; digest: string;
  text: string; evaluation?: Evaluation; sourceDigest?: string;
}
export interface StrategyChangeProposal extends ChangeProposalInput {
  id: string; workspaceId: string; brandId: string; revision: number; digest: string; actor: string; createdAt: string;
  status: "pending" | "approved" | "rejected" | "superseded"; evidenceStatus: "valid" | "revoked";
  confidence: Evaluation["confidence"]; limitations: string[]; strategyProposalId: string; proposedStrategyDigest: string;
  impactedCampaignRefs: AuthorityRef[]; impactedPlanRefs: AuthorityRef[]; impactedItemRefs: AuthorityRef[];
  decisionActor?: string; decidedAt?: string; feedback?: string; approvedStrategyRef?: StrategyRef;
}
export const providerObservationInputSchema = z.object({ collectionId: digest, token: digest, checkedAt: timestamp, metrics: z.object({ likes: z.number().int().nonnegative(), replies: z.number().int().nonnegative(), reposts: z.number().int().nonnegative(), quotes: z.number().int().nonnegative(), impressions: z.number().int().nonnegative().optional() }).strict().nullable(), outcome: z.enum(["available", "unavailable", "failed", "unknown"]), reason: z.string().max(1000).optional() }).strict();
export const performanceObservationSchema = z.object({
  id, collectionId: digest, workspaceId: id, brandId: id, itemRef: authorityRefSchema, planRef: authorityRefSchema, campaignRef: authorityRefSchema.nullable(), strategyRef: strategyRefSchema,
  pillar: z.string().nullable(), jobId: id, actionId: id.nullable(), artifactId: id.nullable(), postId: id.nullable(), sourceIds: z.array(id), measurement: pinnedMeasurementSchema,
  kind: z.enum(["performance", "delivery_verification"]), availability: z.enum(["available", "pending_window", "unavailable", "failed", "revoked"]), value: z.number().finite().nullable(), reason: z.string().nullable(),
  window: z.object({ startAt: timestamp, endAt: timestamp }).strict(), observedAt: timestamp, provider: z.enum(["x", "operator", "host", "unsupported"]), actor: id.nullable(), evidenceRefs: z.array(id), digest,
}).strict().superRefine((o, ctx) => {
  if (!observationValueSchema.safeParse({ availability: o.availability, value: o.value, reason: o.reason }).success || o.kind !== o.measurement.definition.kind || (o.availability === "available" && (!o.evidenceRefs.length || (o.provider === "operator" && !o.actor)))) ctx.addIssue({ code: "custom", message: "observation authority inconsistent" });
});
export const evaluationSchema = z.object({ id, observationIds: z.array(id), cohortMembers: z.array(z.object({ id, digest, collectionId: digest, itemRef: authorityRefSchema, availability: performanceObservationSchema.shape.availability, window: performanceObservationSchema.shape.window }).strict()), measurement: pinnedMeasurementSchema, strategyRef: strategyRefSchema, campaignRefs: z.array(authorityRefSchema), planRefs: z.array(authorityRefSchema), itemRefs: z.array(authorityRefSchema), pillars: z.array(z.string()), cohortCount: z.number().int().nonnegative(), missingCounts: z.object({ pending_window: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative(), failed: z.number().int().nonnegative(), revoked: z.number().int().nonnegative() }).strict(), sampleCount: z.number().int().nonnegative(), value: z.number().finite().nullable(), baseline: measurementDefinitionSchema.shape.baseline, supportingObservationIds: z.array(id), contradictingObservationIds: z.array(id), confidence: z.enum(["insufficient", "low", "moderate"]), causalClaim: z.literal(false), outcome: z.enum(["delivery_only", "unmeasured", "observational"]), limitations: z.array(z.string()) }).strict();
export const strategyChangeProposalSchema = changeProposalInputSchema.extend({ id, workspaceId: id, brandId: id, revision: z.number().int().positive(), digest, actor: id, createdAt: timestamp, status: z.enum(["pending", "approved", "rejected", "superseded"]), evidenceStatus: z.enum(["valid", "revoked"]), confidence: z.enum(["insufficient", "low", "moderate"]), limitations: z.array(z.string()), strategyProposalId: id, proposedStrategyDigest: digest, impactedCampaignRefs: z.array(authorityRefSchema), impactedPlanRefs: z.array(authorityRefSchema), impactedItemRefs: z.array(authorityRefSchema), decisionActor: id.nullish(), decidedAt: timestamp.nullish(), feedback: z.string().nullish(), approvedStrategyRef: strategyRefSchema.nullish() }).strict();
export const learningContextSchema = z.object({ authority: z.literal("host_persisted"), memoryAuthority: z.literal("derived_recall_only"), observations: z.array(performanceObservationSchema).max(100), evaluations: z.array(evaluationSchema).max(50), proposals: z.array(strategyChangeProposalSchema).max(50) }).strict();
export const revokedProposalSchema = z.object({ id, revision: z.number().int().positive(), status: strategyChangeProposalSchema.shape.status, evidenceStatus: z.literal("revoked") }).strict();
export const learningInferenceContextSchema = learningContextSchema.extend({ proposals: z.array(z.union([strategyChangeProposalSchema, revokedProposalSchema])).max(50), performanceEvidenceRefs: z.array(evidenceRefSchema).max(200), advisoryEvidenceRefs: z.array(evidenceRefSchema).max(200) });
