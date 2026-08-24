import { effectClaimSubmissionSchema } from "@/lib/contracts";
import { effectClaimResponse } from "@/lib/effectClaims";
import { claimEffect } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, effectClaimSubmissionSchema, async (body) => {
    const result = await claimEffect(body);
    return Response.json(effectClaimResponse(result, body));
  });
}
