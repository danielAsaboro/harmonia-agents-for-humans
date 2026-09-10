import type { IntakeDraft } from "./contracts";
import { bindIntakeJob, readIntakeDraft, readIntakeSourceRights, submitIntakeTurn } from "./repository";
import { createJob } from "../repository";
import { createSourceJob } from "../sourceManifest";
import { requireReadyAttachments } from "../chatAttachments";
import type { SourceInput } from "../types";
import { materializeIntake } from "../planning/commands";
import { readActiveStrategyRef } from "../strategy/repository";
import { claimNextPlannedItem } from "../planning/selection";

export { evaluateIntake } from "./contracts";
export { submitIntakeTurn };
export async function executeIntakeDraft(input: IntakeDraft): Promise<IntakeDraft> {
  const draft = await readIntakeDraft(input.id);
  if (!draft) throw new Error("intake draft missing");
  if (draft.state === "ready_for_planning") {
    if (!await readActiveStrategyRef()) return draft;
    await materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId: draft.answers.at(-1)!.requestId });
    return (await readIntakeDraft(draft.id))!;
  }
  if (draft.planning && !draft.jobId) {
    await claimNextPlannedItem(draft.planning.planRef.id);
    return (await readIntakeDraft(draft.id))!;
  }
  if (draft.state !== "ready" || draft.disposition === "knowledge_only") return draft;
  const intake = { draftId: draft.id, action: draft.action, disposition: draft.disposition, expectedOutcome: draft.expectedOutcome, target: draft.target, strategyBaseRef: draft.strategyBaseRef };
  const setup = (tx: Parameters<typeof bindIntakeJob>[0], jobId: string) => bindIntakeJob(tx, draft, jobId);
  const idempotentJobId = `intake-${draft.id}`;
  const directSources: SourceInput[] = [];
  await requireReadyAttachments(draft.sourceHandles.flatMap(source => source.kind === "upload" ? [source.attachmentId] : []));
  for (const source of draft.sourceHandles) {
    const rightsAuthorizationId = await readIntakeSourceRights(draft, source);
    directSources.push({ ...source, rightsAuthorizationId });
  }
  const config = { operatorBrief: draft.originalOperatorBrief, desiredOutputs: draft.requestedOutputs, allowedOutputs: draft.requestedOutputs,
    platforms: draft.strategyContext?.supportedChannels ?? [], strategyContext: draft.strategyContext, intake };
  try {
    if (directSources.length) await createSourceJob({ ...config, directSources, idempotentJobId, setup });
    else {
      if (!["establish_strategy", "revise_strategy"].includes(draft.action)) throw new Error("source-free work requires the planning handoff");
      if (!draft.strategyContext) throw new Error("typed operator context required for a text-only request");
      await createJob(config, "strategize", setup, idempotentJobId);
    }
  } catch (error) {
    const reconciled = await readIntakeDraft(draft.id);
    if (reconciled?.state === "dispatched" && reconciled.jobId === idempotentJobId) return reconciled;
    throw error;
  }
  // The durable outbox inserted with the job owns dispatch, including restart recovery.
  return (await readIntakeDraft(draft.id))!;
}
export function intakeReply(draft: IntakeDraft): string {
  if (draft.question) return draft.question;
  if (draft.state === "retained") return "Saved the source references for knowledge-only use. No production job was started.";
  if (draft.planning?.proposalId) return `Saved source replacement proposal ${draft.planning.proposalId}. The planned item is paused for an explicit new revision and evidence binding.`;
  if (draft.planning) return `Saved planned item ${draft.planning.itemRefs.map(ref => ref.id).join(", ")} in plan ${draft.planning.planRef.id}${draft.planning.campaignRef ? ` for campaign ${draft.planning.campaignRef.id}` : " as independent work"}. Production follows its schedule and configured capacity; effects keep their approval gates.`;
  if (draft.state === "ready_for_planning") return "Saved your request for planning with the original brief and selected outputs. No production job was started.";
  if (draft.jobId) return `Started job ${draft.jobId} for “${draft.expectedOutcome}”. The original brief and selected outputs are preserved; effects require their normal approval.`;
  return "Your request is saved and ready for execution.";
}
