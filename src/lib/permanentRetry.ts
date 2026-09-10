import { z } from "zod";
import { failureSubmissionSchema } from "./contracts";
import type { AuthorityRef } from "./campaigns/contracts";
import type { Principal } from "./authority";
import type { Stage } from "./types";

export const permanentRetryRequestSchema = z.object({
  afterFix: z.literal(true),
  requestId: z.string().min(1).max(200),
  reason: z.string().trim().min(1).max(500),
  expectedGeneration: z.number().int().nonnegative(),
  expectedFailure: failureSubmissionSchema.omit({ jobId: true }).extend({
    at: z.string().datetime(), error: z.string().optional(), permanent: z.boolean().optional(),
  }).strict(),
}).strict();
export type PermanentRetryRequest = z.infer<typeof permanentRetryRequestSchema>;
export class PermanentRetryConflict extends Error {}

/** Retry admission only. This record grants no publishing or other effect authority. */
export interface PermanentRetryAuthorization {
  id: string; workspaceId: string; brandId: string; jobId: string; itemRef: AuthorityRef | null;
  actor: Extract<Principal, { kind: "cognito_user" }>; decision: "retry_after_fix";
  reason: string; approvedAt: string; idempotencyKey: string; requestDigest: string;
  expectedGeneration: number; failureDigest: string; stage: Stage;
  state: "pending" | "consumed" | "stale";
  outboxId?: string; admittedGeneration?: number; consumedAt?: string; staleAt?: string;
}
