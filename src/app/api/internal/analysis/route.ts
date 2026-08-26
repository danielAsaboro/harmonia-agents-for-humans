import { analysisSubmissionSchema } from "@/lib/contracts";
import { appendEvent, saveAnalysis } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { advance } from "@/lib/advance";
import { sourceAnalysisDigest } from "@/lib/sourceAnalysis";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, analysisSubmissionSchema, async (body) => {
    if (sourceAnalysisDigest(body.analysis) !== body.analysisDigest) {
      throw new Error("source analysis digest mismatch");
    }
    await saveAnalysis(body.jobId, body.analysis, body.analysisDigest);
    await appendEvent(body.jobId, "understand", `analysis: ${body.analysis.moments.length} grounded moment(s), ${body.analysis.angles.length} grounded angle(s), with ${body.modelUsed}`, "agent");
    return advance(body.jobId, "understand", "analysis complete; Ryan strategy dispatched");
  });
}
