import { effectClaimSubmissionSchema } from "@/lib/contracts";
import { claimEffect } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, effectClaimSubmissionSchema, async (body) => {
    const result = await claimEffect(body);
    return Response.json({
      outcome: result.outcome,
      attempt: result.claim.attempt,
      ...(result.outcome === "already_applied" ? { receiptId: result.receiptId } : {}),
    });
  });
}
