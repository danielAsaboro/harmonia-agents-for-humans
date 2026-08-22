import { findingsSubmissionSchema } from "@/lib/contracts";
import { appendEvent, getJob, saveFindings, setStage } from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { publishStage } from "@/lib/pubsub";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, findingsSubmissionSchema, async (body) => {
    const job = await getJob(body.jobId);
    if (job.stage !== "evaluate") {
      return Response.json(
        { error: `job stage is '${job.stage}', findings accepted at 'evaluate'` },
        { status: 409 },
      );
    }
    await saveFindings(body.jobId, body.findings);
    const missing = body.findings.filter((f) => f.status !== "satisfied").length;
    await appendEvent(
      body.jobId,
      "evaluate",
      `evaluation complete: ${body.findings.length - missing} satisfied, ${missing} gap(s)`,
      "agent",
    );
    await setStage(body.jobId, "plan");
    await publishStage(body.jobId, "plan");
    return Response.json({ ok: true, next: "plan" });
  });
}
