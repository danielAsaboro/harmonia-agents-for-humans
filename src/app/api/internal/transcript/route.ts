import { transcriptSubmissionSchema } from "@/lib/contracts";
import { appendEvent, saveTranscript } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { advance } from "@/lib/advance";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, transcriptSubmissionSchema, async (body) => {
    await saveTranscript(body.jobId, body.segments, body.language);
    await appendEvent(body.jobId, "transcribe", `transcribed ${body.segments.length} segment(s) with ${body.modelUsed}`, "agent");
    return advance(body.jobId, "transcribe", "transcript ready; analyzing content");
  });
}
