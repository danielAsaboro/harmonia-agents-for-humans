import { describe, expect, it } from "vitest";

import { decideEffectClaim } from "@/lib/effectClaims";
import type { EffectClaim, EffectClaimInput } from "@/lib/types";

const now = new Date("2026-08-25T01:00:00.000Z");
const input: EffectClaimInput = {
  jobId: "job-1", actionId: "action-1", actionType: "export_content_pack",
  idempotencyKey: "a".repeat(64), operationId: "job-1:publish:action-1",
  traceId: "b".repeat(32), claimToken: "claim-token-1",
};

function claim(changes: Partial<EffectClaim> = {}): EffectClaim {
  return {
    id: input.idempotencyKey, ...input, state: "claimed", attempt: 1,
    claimedAt: "2026-08-25T00:59:00.000Z",
    leaseExpiresAt: "2026-08-25T01:04:00.000Z",
    ...changes,
  };
}

describe("effect claim state machine", () => {
  it("grants exactly one new execution owner", () => {
    const first = decideEffectClaim(null, input, now);
    expect(first.outcome).toBe("execute");
    expect(first.claim).toMatchObject({ state: "claimed", attempt: 1, claimToken: "claim-token-1" });

    const contender = decideEffectClaim(first.claim, { ...input, claimToken: "claim-token-2" }, now);
    expect(contender.outcome).toBe("in_progress");
    expect(contender.claim.claimToken).toBe("claim-token-1");
  });

  it("fails closed when a live claim expires without a receipt", () => {
    const expired = claim({ leaseExpiresAt: "2026-08-25T00:59:59.000Z" });
    expect(decideEffectClaim(expired, { ...input, claimToken: "claim-token-2" }, now).outcome).toBe("uncertain");
  });

  it("returns the original receipt after finalization", () => {
    const applied = claim({ state: "applied", receiptId: "receipt-1", finalizedAt: "2026-08-25T01:01:00.000Z" });
    expect(decideEffectClaim(applied, { ...input, claimToken: "claim-token-2" }, now)).toMatchObject({
      outcome: "already_applied", receiptId: "receipt-1",
    });
  });

  it("permits a new claim only after a confirmed failed effect", () => {
    const failed = claim({ state: "failed", finalizedAt: "2026-08-25T01:01:00.000Z" });
    expect(decideEffectClaim(failed, { ...input, claimToken: "claim-token-2" }, now)).toMatchObject({
      outcome: "execute", claim: { attempt: 2, claimToken: "claim-token-2" },
    });
  });

  it("rejects key reuse for a different action or action type", () => {
    expect(() => decideEffectClaim(claim(), { ...input, actionId: "action-2" }, now)).toThrow("identity mismatch");
    expect(() => decideEffectClaim(claim(), { ...input, actionType: "publish_x_post" }, now)).toThrow("identity mismatch");
  });
});
