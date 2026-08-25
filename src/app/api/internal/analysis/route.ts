import { analysisSubmissionSchema } from "@/lib/contracts";
import { appendEvent, saveAnalysis } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { advance } from "@/lib/advance";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, analysisSubmissionSchema, async (body) => {
    await saveAnalysis(body.jobId, body.moments, body.angles, body.summary);
    await appendEvent(body.jobId, "understand", `analysis: ${body.moments.length} clip moment(s), ${body.angles.length} trend/meme angle(s), with ${body.modelUsed}`, "agent");
    return advance(body.jobId, "understand", "analysis complete; Ryan strategy dispatched");
  });
}
