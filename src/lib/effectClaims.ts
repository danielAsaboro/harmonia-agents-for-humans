import type { EffectClaim, EffectClaimInput, EffectClaimOutcome } from "./types";

const CLAIM_LEASE_MS = 5 * 60 * 1000;

function nextClaim(input: EffectClaimInput, attempt: number, now: Date): EffectClaim {
  return {
    id: input.idempotencyKey,
    ...input,
    state: "claimed",
    attempt,
    claimedAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + CLAIM_LEASE_MS).toISOString(),
  };
}

function assertSameIdentity(existing: EffectClaim, input: EffectClaimInput): void {
  if (
    existing.jobId !== input.jobId
    || existing.actionId !== input.actionId
    || existing.actionType !== input.actionType
    || existing.idempotencyKey !== input.idempotencyKey
  ) {
    throw new Error("effect claim identity mismatch");
  }
}

export function decideEffectClaim(
  existing: EffectClaim | null,
  input: EffectClaimInput,
  now = new Date(),
): EffectClaimOutcome {
  if (!existing) return { outcome: "execute", claim: nextClaim(input, 1, now) };
  assertSameIdentity(existing, input);
  if (existing.state === "applied") {
    if (!existing.receiptId) throw new Error("applied effect claim is missing its receipt");
    return { outcome: "already_applied", claim: existing, receiptId: existing.receiptId };
  }
  if (existing.state === "failed") {
    return { outcome: "execute", claim: nextClaim(input, existing.attempt + 1, now) };
  }
  if (Date.parse(existing.leaseExpiresAt) <= now.getTime()) {
    return { outcome: "uncertain", claim: existing };
  }
  return { outcome: "in_progress", claim: existing };
}

export type EffectFinalization =
  | { duplicate: true; claim: EffectClaim; receiptId: string }
  | { duplicate: false; claim: EffectClaim; receiptId: string };

export function decideEffectFinalization(
  claim: EffectClaim,
  claimToken: string,
  receiptId: string,
  outcome: "applied" | "already_applied" | "rejected" | "failed",
  now = new Date(),
): EffectFinalization {
  if (claim.state === "applied") {
    if (!claim.receiptId) throw new Error("applied effect claim is missing its receipt");
    return { duplicate: true, claim, receiptId: claim.receiptId };
  }
  if (claim.state !== "claimed") throw new Error(`effect claim cannot finalize from state '${claim.state}'`);
  if (claim.claimToken !== claimToken) throw new Error("effect claim owner mismatch");
  const finalized: EffectClaim = {
    ...claim,
    state: outcome === "applied" || outcome === "already_applied" ? "applied" : "failed",
    receiptId,
    finalizedAt: now.toISOString(),
  };
  return { duplicate: false, claim: finalized, receiptId };
}
