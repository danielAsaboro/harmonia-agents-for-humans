import { z } from "zod";
import type { ContentStrategy, StrategyApproval, StrategyInvocationContext } from "../types";

export const strategyRefSchema = z.object({
  workspaceId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  brandId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  strategyId: z.string().min(1).max(100),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

/** Lifetime approved revision; unrelated to the bounded proposal attempt. */
export type StrategyRef = z.infer<typeof strategyRefSchema>;
export const strategySourceBindingSchema = z.object({
  jobId: z.string().min(1).max(100),
  strategyRef: strategyRefSchema,
  analysisDigest: z.string().regex(/^[0-9a-f]{64}$/),
  evidenceIds: z.array(z.string().min(1).max(100)).min(1).max(12168),
}).strict();
export type StrategySourceBinding = z.infer<typeof strategySourceBindingSchema>;
export const operatorSourceBindingSchema = z.object({
  mode: z.literal("operator_context"), jobId: z.string().min(1).max(100), strategyRef: strategyRefSchema,
  operatorBrief: z.string().trim().min(1).max(20000), contextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceIds: z.array(z.never()).length(0), factualClaimsAllowed: z.literal(false),
}).strict();
export const planningSourceBindingSchema = z.union([strategySourceBindingSchema, operatorSourceBindingSchema]);
export type PlanningSourceBinding = z.infer<typeof planningSourceBindingSchema>;
export interface ApprovedStrategyRevision {
  workspaceId: string;
  brandId: string;
  ref: StrategyRef;
  proposalId: string;
  jobId: string;
  strategy: ContentStrategy;
  approval: StrategyApproval & { decision: "approved" };
  evidenceLineage: string[];
  invocationContext: StrategyInvocationContext;
}
export interface StrategyProposal {
  id: string; workspaceId: string; brandId: string; jobId: string;
  attempt: number; expectedActiveRevision: number;
  baseStrategyRef: StrategyRef | null;
  strategy: ContentStrategy; digest: string;
  evidenceLineage: string[]; invocationContext: StrategyInvocationContext;
  proposedAt: string; expiresAt: string;
  approval?: StrategyApproval;
  strategyRef?: StrategyRef;
}
