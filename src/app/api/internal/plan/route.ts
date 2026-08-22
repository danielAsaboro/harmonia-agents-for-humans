import { planSubmissionSchema } from "@/lib/contracts";
import {
  appendEvent,
  getJob,
  saveActions,
  setStage,
} from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { applyPolicy } from "@/lib/policy";
import { publishStage } from "@/lib/pubsub";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, planSubmissionSchema, async (body) => {
    const job = await getJob(body.jobId);
    const withPolicy = applyPolicy(
      body.actions.map((a) => ({ ...a, jobId: body.jobId })),
    );
    await saveActions(body.jobId, withPolicy);

    const needsApproval = withPolicy.filter((a) => a.requiresApproval);
    const autoRun = withPolicy.filter((a) => !a.requiresApproval);

    if (needsApproval.length > 0) {
      await setStage(body.jobId, "awaiting_approval", "waiting_for_approval");
      await appendEvent(
        body.jobId,
        "plan",
        `${withPolicy.length} action(s) planned; ${needsApproval.length} require operator approval: ${needsApproval.map((a) => a.title).join("; ")}`,
        "agent",
      );
      return Response.json({
        ok: true,
        awaitingApproval: true,
        actions: withPolicy.map((a) => ({ id: a.id, title: a.title, risk: a.risk, requiresApproval: a.requiresApproval })),
      });
    }

    if (autoRun.length > 0) {
      await setStage(job.id, "act");
      await appendEvent(
        job.id,
        "plan",
        `${autoRun.length} low-risk action(s) planned and dispatched without approval`,
        "agent",
      );
      await publishStage(job.id, "act");
      return Response.json({ ok: true, triggered: "act" });
    }

    await setStage(job.id, "verify");
    await appendEvent(job.id, "plan", "no corrective actions proposed; verifying existing evidence", "agent");
    await publishStage(job.id, "verify");
    return Response.json({ ok: true, triggered: "verify" });
  });
}
