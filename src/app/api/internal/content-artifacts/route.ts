import { artifactProductionSubmissionSchema } from "@/lib/contentArtifacts/submission";
import { resolveContentPackPayload, sealContentArtifact } from "@/lib/contentArtifacts/digest";
import { deriveArtifactActions } from "@/lib/contentArtifacts/actions";
import { applyPolicy } from "@/lib/policy";
import { appendEvent, claimArtifactProductionCallback, createNotification, finalizeArtifactProduction, getConnection, getJob, transitionStageWithOutbox } from "@/lib/repository";
import { internalRoute } from "@/lib/internalHandler";
import { isInternalAuthorized, unauthorized } from "@/lib/internalAuth";
import { currentTraceId } from "@/lib/telemetry";
import { dispatchStageOutboxRecord } from "@/lib/stageOutboxDispatcher";
import { materializeExecutableJobCommands } from "@/lib/jobEffectCommands";
import { bindTextArtifactsToMediaPack } from "@/lib/outputMediaProduction";
import { getProductionPlanWorkspaceForJob, proposeProductionPlan, sealProductionPlan } from "@/lib/productionPlanStore";
import { productionPlanDigest } from "@/lib/mediaProduction";


export async function POST(req: Request) {
  if (!isInternalAuthorized(req)) return unauthorized();
  return internalRoute(req, artifactProductionSubmissionSchema, async (body) => {
    const job = await getJob(body.jobId);
    const callback = await claimArtifactProductionCallback(body.jobId, body.result, { createdAt: new Date().toISOString(), traceId: currentTraceId() });
    if (callback.outcome === "already_applied") return Response.json({ ok: true, alreadyApplied: true });
    if (callback.outcome === "in_progress") return Response.json({ ok: true, inProgress: true }, { status: 202 });
    if (job.stage !== "draft" && job.stage !== "awaiting_approval") return Response.json({ error: `job stage is '${job.stage}'` }, { status: 409 });
    const plan = job.campaignOutputPlan; if (!plan) return Response.json({ error: "campaign output plan is missing" }, { status: 409 });
    const acceptedReviews = body.result.finalReview?.reviews ?? body.result.firstReview.reviews; const traceId = callback.traceId; const now = callback.createdAt;
    const sealDraft = (draft: (typeof body.result.accepted.artifacts)[number], payload = draft.payload) => {
      const planned = plan.outputs.find((item) => item.id === draft.outputPlanItemId); if (!planned || planned.outputType !== draft.outputType) throw new Error(`artifact ${draft.id} is outside the output plan`);
      if (draft.sourceSegmentRefs.some((ref) => !planned.evidenceRefs.includes(ref))) throw new Error(`artifact ${draft.id} references evidence outside its output-plan item`);
      if (!draft.sourceSegmentRefs.length && job.operatorPlanningContext?.mode !== "operator_context") throw new Error("source-backed artifact requires factual evidence");
      if (job.operatorPlanningContext?.mode === "operator_context" && (draft.sourceSegmentRefs.length || !["x_post", "linkedin_post", "caption", "social_image", "generated_video", "generated_music", "content_pack"].includes(draft.outputType))) throw new Error("operator-context artifact cannot claim source evidence");
      const review = acceptedReviews.find((item) => item.artifactId === draft.id); if (!review || review.decision !== "accept") throw new Error(`artifact ${draft.id} has no accepted exact review`);
      return sealContentArtifact({ id: draft.id, jobId: body.jobId, outputPlanId: plan.id, outputPlanDigest: plan.digest, outputType: draft.outputType, revision: body.result.revision ? 2 : 1, title: draft.title, sourceSegmentRefs: draft.sourceSegmentRefs, producer: { role: draft.payload.kind === "content_pack" ? "harmonia_content_pack_assembler" : "noni_artifact_producer", model: draft.payload.kind === "content_pack" ? "deterministic" : body.producerModel, traceId }, review: { role: "dara_artifact_editor", traceId, decision: "accept" }, mimeType: "text/markdown", createdAt: now, payload });
    };
    const drafts = body.result.accepted.artifacts;
    const unifiedMediaPack = plan.outputs.some((item) => item.outputType === "content_pack")
      && plan.outputs.some((item) => ["social_image", "generated_video", "generated_music"].includes(item.outputType));
    const retainedDrafts = unifiedMediaPack ? drafts.filter((draft) => draft.payload.kind !== "content_pack") : drafts;
    const sealedChildren = retainedDrafts.filter((draft) => draft.payload.kind !== "content_pack").map((draft) => sealDraft(draft));
    const sealedById = new Map(sealedChildren.map((artifact) => [artifact.id, artifact] as const));
    const artifacts = retainedDrafts.map((draft) => {
      if (draft.payload.kind !== "content_pack") return sealedById.get(draft.id)!;
      return sealDraft(draft, resolveContentPackPayload(draft.payload, sealedChildren));
    });
    if (unifiedMediaPack) {
      const workspace = await getProductionPlanWorkspaceForJob(job.id);
      if (!workspace || workspace.revision.plan.outputRequest?.outputPlanDigest !== plan.digest) throw new Error("sealed media plan is required before binding a unified content pack");
      const alreadyBound = workspace.revision.plan.packTextChildren.length === artifacts.length
        && workspace.revision.plan.packTextChildren.every((child) => artifacts.some((artifact) => artifact.id === child.artifactId && artifact.contentDigest === child.digest));
      if (!alreadyBound) {
        const revised = bindTextArtifactsToMediaPack(workspace.revision.plan, artifacts);
        await proposeProductionPlan(revised);
        await sealProductionPlan(revised.id, { planDigest: productionPlanDigest(revised) });
      }
    }
    const [x, linkedin] = await Promise.all([getConnection("x"), getConnection("linkedin")]);
    const destination = linkedin?.health !== "reconnect_required" && linkedin?.defaultDestinationId ? linkedin.destinations?.find((item) => item.id === linkedin.defaultDestinationId && (item.kind === "linkedin_member" || item.kind === "linkedin_organization")) ?? null : null;
    const actions = applyPolicy(deriveArtifactActions(artifacts, { x: Boolean(x && x.health !== "reconnect_required"), linkedinDestination: destination && (destination.kind === "linkedin_member" || destination.kind === "linkedin_organization") ? destination : null }));
    const lineage = { editorialPlanId: body.editorialPlanId, editorialPlanDigest: body.editorialPlanDigest, editorialItemId: body.editorialItemId, briefId: body.briefId }; const needsApproval = actions.filter((item) => item.requiresApproval); const autoRun = actions.filter((item) => !item.requiresApproval);
    const result = await finalizeArtifactProduction(body.jobId, lineage, body.result, artifacts, actions, needsApproval.length > 0); if (result.outcome === "already_applied") return Response.json({ ok: true, alreadyApplied: true });
    if (needsApproval.length) { await appendEvent(body.jobId, "draft", `${artifacts.length} accepted artifact(s); ${autoRun.length} export(s), ${needsApproval.length} awaiting approval`, "agent"); await createNotification({ kind: "approval_needed", title: "Approval needed", body: `Job ${body.jobId.slice(0, 8)} has ${needsApproval.length} publication action(s) waiting.`, severity: "warning", refType: "job", refId: body.jobId, href: "/dashboard", createdAt: now }); return Response.json({ ok: true, awaitingApproval: true, artifactCount: artifacts.length }); }
    await materializeExecutableJobCommands(job.id); const outboxId = await transitionStageWithOutbox(job.id, "draft", "publish", `${autoRun.length} verified export action(s) dispatched`); await dispatchStageOutboxRecord(outboxId).catch(() => undefined); return Response.json({ ok: true, triggered: "publish", artifactCount: artifacts.length });
  });
}
