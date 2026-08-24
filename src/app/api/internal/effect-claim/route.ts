import { effectClaimSubmissionSchema } from "@/lib/contracts";
import { claimEffect, writeReplayObservation } from "@/lib/firestore";
import { newId } from "@/lib/idempotency";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, effectClaimSubmissionSchema, async (body) => {
    const result = await claimEffect(body);
    if (result.outcome === "already_applied") {
      await writeReplayObservation({
        id: newId(), jobId: body.jobId, actionId: body.actionId,
        operationId: body.operationId, traceId: body.traceId,
        receiptId: result.receiptId, outcome: "already_applied",
        attemptedAt: new Date().toISOString(),
      });
    }
    return Response.json({
      outcome: result.outcome,
      attempt: result.claim.attempt,
      ...(result.outcome === "already_applied" ? { receiptId: result.receiptId } : {}),
    });
  });
}
