import { observationsSubmissionSchema } from "@/lib/contracts";
import { appendEvent, saveObservations } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { advance } from "@/lib/advance";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, observationsSubmissionSchema, async (body) => {
    const okCount = body.observations.filter((o) => o.ok).length;
    await saveObservations(body.jobId, body.observations);
    await appendEvent(
      body.jobId,
      "collect",
      `collected ${body.observations.length} observation(s) (${okCount} ok) from live sources`,
      "agent",
    );
    await advance(body.jobId, "collect", "observations stored; evaluating against rubric");
  });
}
