import { failureSubmissionSchema } from "@/lib/contracts";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { internalRoute } from "@/lib/internalHandler";
import { recordFailure } from "@/lib/advance";
import type { Stage } from "@/lib/types";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, failureSubmissionSchema, async (body) => {
    await recordFailure(body.jobId, body.stage as Stage, body.error, body.permanent);
    // Always 200: the web service owns retry policy; Pub/Sub redelivery is
    // only used for transient agent-side transport errors.
    return Response.json({ ok: true });
  });
}
