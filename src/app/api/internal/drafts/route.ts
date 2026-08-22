import { draftsSubmissionSchema } from "@/lib/contracts";
import {
  appendEvent,
  createContentItem,
  createNotification,
  getJob,
  saveActions,
  saveDrafts,
  setStage,
} from "@/lib/firestore";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { applyPolicy, validateDraftText } from "@/lib/policy";
import { publishStage } from "@/lib/pubsub";

export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, draftsSubmissionSchema, async (body) => {
    const job = await getJob(body.jobId);
    if (job.stage !== "draft") {
      return Response.json({ error: `job stage is '${job.stage}'` }, { status: 409 });
    }

    const drafts = body.drafts.map((d) => ({
      ...d,
      ...validateDraftText(d.platform, d.text),
    }));
    await saveDrafts(body.jobId, drafts);

    const withPolicy = applyPolicy(
      body.proposedActions.map((a) => ({ ...a, jobId: body.jobId })),
    );
    const actionable = withPolicy.filter((a) => {
      if (a.type !== "publish_x_post") return true;
      const text = String((a.payload as { text?: unknown }).text ?? "");
      return validateDraftText("x", text).valid;
    });
    await saveActions(body.jobId, actionable);

    const needsApproval = actionable.filter((a) => a.requiresApproval);
    const autoRun = actionable.filter((a) => !a.requiresApproval);
    const invalid = drafts.filter((d) => !d.valid);

    // Every X-post action becomes a calendar content item (idempotent by id).
    for (const a of actionable) {
      if (a.type !== "publish_x_post") continue;
      const text = String((a.payload as { text?: unknown }).text ?? "");
      if (!text) continue;
      await createContentItem({
        id: `item-${a.id}`,
        jobId: body.jobId,
        draftId: drafts.find((d) => d.text === text)?.id,
        text,
        platforms: ["x"],
        status: "draft",
        publishMode: "approval",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    if (needsApproval.length > 0) {
      await setStage(body.jobId, "awaiting_approval", "waiting_for_approval");
      await appendEvent(body.jobId, "draft", `${drafts.length} draft(s); ${autoRun.length} auto action(s), ${needsApproval.length} awaiting approval${invalid.length ? `, ${invalid.length} rejected by limits` : ""}`, "agent");
      await createNotification({
        kind: "approval_needed",
        title: "Approval needed",
        body: `Job ${job.ingestedTitle ?? body.jobId.slice(0, 8)} has ${needsApproval.length} action(s) waiting for your decision.`,
        severity: "warning",
        refType: "job",
        refId: body.jobId,
        href: "/dashboard",
        createdAt: new Date().toISOString(),
      });
      return Response.json({ ok: true, awaitingApproval: true });
    }
    if (autoRun.length > 0) {
      await setStage(job.id, "publish");
      await appendEvent(job.id, "draft", `${autoRun.length} safe action(s) dispatched`, "agent");
      await publishStage(job.id, "publish");
      return Response.json({ ok: true, triggered: "publish" });
    }
    await setStage(job.id, "verify");
    await appendEvent(job.id, "draft", "no actions to execute; verifying existing artifacts", "agent");
    await publishStage(job.id, "verify");
    return Response.json({ ok: true, triggered: "verify" });
  });
}
