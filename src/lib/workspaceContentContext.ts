import { getGoals, listContentItems, listAllJobs, listAllProposals, type OperatorGoals } from "@/lib/repository";
import type { ContentItem, Job } from "@/lib/types";
import type { ApprovedStrategyRevision } from "./strategy/contracts";
import { loadActiveStrategyContext } from "./strategy/context";
import type { PlanRevision } from "./campaigns/contracts";
import { listPlanningProposals, plannedCalendar } from "./planning/commands";
import { strategyDigest } from "./strategyApproval";
import { listCurrentCampaigns } from "./campaigns/repository";
import { listAllLearningOperation } from "./learning/repository";
import { listStrategyProposals } from "./strategy/repository";
import type { DeliverableLearningRecord, Evaluation, LearningEvidence, PerformanceObservation, StrategyChangeDecision, StrategyChangeProposal } from "./learning/contracts";

export interface WorkspaceOperationContext {
  activeStrategy: { thesis: string; strategyId: string; revision: number; digest: string } | null;
  proposedChanges: Array<{ id: string; kind: "content" | "strategy" | "learning_strategy" | "incomplete_command" | "source_replacement" | "strategy_rebase" | "calendar_change" | "measurement_change"; status: string; changes: string[]; evidenceRefs: string[]; revision?: number; decision?: string }>;
  campaigns: Array<{ id: string; name: string; objective: string }>;
  plans: Array<{ id: string; revision: number; reason: string }>;
  plannedItems: Array<{
    id: string; planId: string; campaignId: string | null; campaignLabel: string;
    name: string; objective: string; channel: string; scheduledFor: string; strategyRef: { strategyId: string; revision: number; digest: string }; metricIds: string[]; sourceEvidenceRefs: string[]; declaredDependencies: string[]; requiredAssets: string[];
    evidenceState: "source_backed" | "operator_context" | "unavailable";
    approvalState: "pending" | "not_pending"; lifecycleState: "planned" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled" | "blocked" | "requires_disposition";
    unresolvedDependencies: string[];
  }>;
  results: Array<{ id: string; metric: string; availability: "available" | "pending" | "pending_window" | "stale" | "revoked" | "unavailable" | "failed" | "reconciliation_required"; checkedAt?: string }>;
  deliverables: Array<{
    id: string; itemId: string; campaignId: string | null; channel: string; itemType: string; outputKind: string; exactOutput: Record<string, unknown>;
    strategyRevision: number; sourceEvidence: string[]; approvalState: "approved"; providerReceiptId: string | null; verificationReceiptId: string | null;
    metricWindows: Array<{ metric: string; startAt: string; endAt: string; availability: string; value: number | null; reason: string | null }>;
    feedbackIds: string[]; feedback: Array<{ id: string; text: string; actor: string; createdAt: string; evidenceLinks: string[] }>;
    evaluationIds: string[]; proposalIds: string[]; decisionIds: string[]; decisions: Array<{ id: string; decision: "approved" | "rejected"; rationale: string; feedback: string | null; actor: string; decidedAt: string }>;
  }>;
  currentJobs: Array<{ id: string; stage: string; status: string; title?: string }>;
}

export interface WorkspaceContentContext {
  strategyReady: boolean; planReady: boolean; calendarReady: boolean;
  pendingApprovalCount: number; goals: string[]; channels: string[];
  strategySummary?: string; planSummary?: string; upcomingItemCount: number;
  recentJobs: Array<{ id: string; stage: string; status: string; title?: string }>;
  /** Present on current server projections; optional for historical callers. */
  operation?: WorkspaceOperationContext;
}

type PlanningProposalKind = Extract<WorkspaceOperationContext["proposedChanges"][number]["kind"], "incomplete_command" | "source_replacement" | "strategy_rebase" | "calendar_change" | "measurement_change">;

/** Preserve the durable record's actual shape; generic commands are never called source replacements. */
export function projectPlanningProposal(proposal: Record<string, unknown>): WorkspaceOperationContext["proposedChanges"][number] {
  const sourceHandles = Array.isArray(proposal.sourceHandles) ? proposal.sourceHandles : [];
  const sourceRights = proposal.sourceRights && typeof proposal.sourceRights === "object" && !Array.isArray(proposal.sourceRights) ? Object.entries(proposal.sourceRights as Record<string, unknown>) : [];
  const guarded = Array.isArray(proposal.guarded) ? proposal.guarded : [];
  const input = proposal.input ?? null;
  const declared = proposal.type;
  const kind: PlanningProposalKind = declared === "calendar_change" || declared === "measurement_change" || declared === "strategy_rebase" ? declared : proposal.intakeDraftId !== undefined || proposal.itemRef !== undefined || sourceHandles.length ? "source_replacement" : "incomplete_command";
  const evidenceRefs = [
    ...sourceHandles.map(handle => typeof handle === "object" && handle !== null && "url" in handle ? String(handle.url) : typeof handle === "object" && handle !== null && "attachmentId" in handle ? `attachment:${String(handle.attachmentId)}` : JSON.stringify(handle)),
    ...sourceRights.map(([sourceKey, authorizationId]) => `rights:${sourceKey}:${String(authorizationId)}`),
    ...guarded.map(guard => typeof guard === "object" && guard !== null && "authorityDigest" in guard ? `authority:${String(guard.authorityDigest)}` : JSON.stringify(guard)),
  ];
  return {
    id: String(proposal.id), kind, status: String(proposal.state ?? "unavailable"),
    changes: [
      `type=${String(declared ?? kind)}`, `intakeDraftId=${String(proposal.intakeDraftId ?? "")}`,
      `expectedPlanRef=${JSON.stringify(proposal.expectedPlanRef ?? null)}`, `targetStrategyRef=${JSON.stringify(proposal.targetStrategyRef ?? null)}`,
      `itemRef=${JSON.stringify(proposal.itemRef ?? (typeof input === "object" && input !== null && "itemRef" in input ? input.itemRef : null))}`,
      `sourceHandles=${JSON.stringify(sourceHandles)}`, `sourceRights=${JSON.stringify(Object.fromEntries(sourceRights))}`,
      `operatorBrief=${String(proposal.operatorBrief ?? "")}`, `input=${JSON.stringify(input)}`,
      `digest=${String(proposal.digest ?? "")}`, `state=${String(proposal.state ?? "")}`, `reason=${String(proposal.reason ?? "")}`,
      `reasons=${JSON.stringify(proposal.reasons ?? [])}`, `guarded=${JSON.stringify(guarded)}`,
      `actor=${String(proposal.actor ?? "")}`, `decision=${String(proposal.decision ?? "")}`,
      `decidedBy=${String(proposal.decidedBy ?? "")}`, `decidedAt=${String(proposal.decidedAt ?? "")}`,
    ], evidenceRefs,
    ...(typeof proposal.decision === "string" ? { decision: proposal.decision } : typeof proposal.decidedAt === "string" ? { decision: proposal.decidedAt } : {}),
  };
}

const bounded = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

export function projectWorkspaceContentContext(input: { goals: OperatorGoals; jobs: Job[]; items: ContentItem[]; activeStrategy: ApprovedStrategyRevision | null; plans?: PlanRevision[]; campaigns?: Array<{ ref: { id: string }; name: string; objective: string }>; proposedChanges?: Array<{ id: string; kind?: WorkspaceOperationContext["proposedChanges"][number]["kind"]; status: string; changes?: string[]; evidenceRefs?: string[]; revision?: number; decision?: string }>; results?: Array<{ id: string; availability?: string; metric?: string; checkedAt?: string }>; plannedItems?: Awaited<ReturnType<typeof plannedCalendar>>; deliverables?: DeliverableLearningRecord[]; learningObservations?: PerformanceObservation[]; learningFeedback?: LearningEvidence[]; learningEvaluations?: Evaluation[]; learningProposals?: StrategyChangeProposal[]; learningDecisions?: StrategyChangeDecision[]; now?: Date }): WorkspaceContentContext {
  const now = (input.now ?? new Date()).getTime();
  const strategy = input.activeStrategy?.strategy;
  const plan = input.plans?.find(plan => input.activeStrategy && strategyDigest(plan.strategyRef) === strategyDigest(input.activeStrategy.ref));
  const upcoming = input.items.filter((item) => item.status !== "cancelled" && item.status !== "published" && (!item.scheduledFor || Date.parse(item.scheduledFor) >= now));
  const planned = (input.plannedItems ?? []).filter(item => !["completed", "cancelled"].includes(item.lifecycle.status) && !upcoming.some(content => content.jobId === item.lifecycle.jobId));
  const channels = [...new Set([
    ...(strategy?.channelRoles ?? []).map((role) => role.channel),
    ...input.items.flatMap((item) => item.platforms),
  ])].slice(0, 12);
  const goals = [
    ...(input.goals.audience ? [`Audience: ${input.goals.audience}`] : []),
    ...(input.goals.voice ? [`Voice: ${input.goals.voice}`] : []),
    ...(input.goals.weeklyPostTarget ? [`Weekly target: ${input.goals.weeklyPostTarget}`] : []),
    ...input.goals.topics.map((topic) => `Topic: ${topic}`),
  ].slice(0, 12);
  const operation: WorkspaceOperationContext = {
    activeStrategy: strategy ? { thesis: strategy.thesis, strategyId: input.activeStrategy!.ref.strategyId, revision: input.activeStrategy!.ref.revision, digest: strategyDigest(input.activeStrategy!.ref) } : null,
    proposedChanges: (input.proposedChanges ?? []).map(change => ({ id: change.id, kind: change.kind ?? "content", status: change.status, changes: change.changes ?? [], evidenceRefs: change.evidenceRefs ?? [], ...(change.revision ? { revision: change.revision } : {}), ...(change.decision ? { decision: change.decision } : {}) })),
    campaigns: (input.campaigns ?? []).map(campaign => ({ id: campaign.ref.id, name: bounded(campaign.name, 300), objective: bounded(campaign.objective, 1_000) })),
    plans: (input.plans ?? []).flatMap(plan => plan.ref ? [{ id: plan.ref.id, revision: plan.ref.revision, reason: bounded(plan.reason, 1_000) }] : []),
    plannedItems: (input.plannedItems ?? []).map((item) => {
      const execution = item.lifecycle.jobId ? input.jobs.find(job => job.id === item.lifecycle.jobId) : undefined;
      const approvalState = execution && (execution.strategyApprovalState === "pending" || ("actions" in execution && Array.isArray(execution.actions) && execution.actions.some((action: { approvalState?: string; state?: string }) => action.approvalState === "pending" && action.state === "planned"))) ? "pending" as const : "not_pending" as const;
      const lifecycleState = item.lifecycle.status;
      const evidenceState = item.evidence.mode === "source_backed" || item.evidence.mode === "operator_context" ? item.evidence.mode : "unavailable";
      return {
        id: item.ref.id, planId: item.planRef.id, campaignId: item.campaignRef?.id ?? null, campaignLabel: item.campaignRef ? item.campaignRef.id : "Independent work",
        name: bounded(item.name, 500), objective: bounded(item.objective, 1_000), channel: item.channel, scheduledFor: item.scheduledFor,
        strategyRef: { strategyId: item.strategyRef.strategyId, revision: item.strategyRef.revision, digest: item.strategyRef.digest },
        metricIds: item.measurements.map(measurement => measurement.definition.id).slice(0, 8), evidenceState,
        sourceEvidenceRefs: item.evidence.mode === "source_backed" ? [...item.evidence.sourceBinding.evidenceIds] : [],
        declaredDependencies: (item.dependencies ?? []).map(dependency => `${dependency.id}:v${dependency.revision}`), requiredAssets: [...(item.requiredAssetIds ?? [])],
        approvalState, lifecycleState,
        unresolvedDependencies: ["blocked", "requires_disposition", "failed"].includes(lifecycleState) && item.lifecycle.reason ? [bounded(item.lifecycle.reason, 500)] : [],
      };
    }),
    results: (input.results ?? []).map(result => ({
      id: result.id, metric: result.metric ?? "unavailable metric",
      availability: result.availability === "available" || result.availability === "pending" || result.availability === "pending_window" || result.availability === "stale" || result.availability === "revoked" || result.availability === "unavailable" || result.availability === "failed" || result.availability === "reconciliation_required" ? result.availability : "unavailable",
      ...(result.checkedAt ? { checkedAt: result.checkedAt } : {}),
    })),
    deliverables: (input.deliverables ?? []).map(deliverable => {
      const sameRef = (left: unknown, right: unknown) => strategyDigest(left) === strategyDigest(right);
      const observations = (input.learningObservations ?? []).filter(observation => sameRef(observation.itemRef, deliverable.itemRef) && observation.actionId === deliverable.actionId && observation.contentRevisionDigest === deliverable.contentRevisionDigest);
      const feedback = (input.learningFeedback ?? []).filter(evidence => {
        if (!evidence.target) return false;
        if (evidence.target.kind === "plan_item") return sameRef(evidence.target.ref, deliverable.itemRef);
        if (evidence.target.kind === "campaign") return deliverable.campaignRef !== null && sameRef(evidence.target.ref, deliverable.campaignRef);
        if (evidence.target.kind === "post") return evidence.target.id === observations.find(observation => observation.postId)?.postId && evidence.target.revisionDigest === deliverable.contentRevisionDigest;
        if (evidence.target.kind === "artifact" || evidence.target.kind === "asset") return evidence.target.id === deliverable.artifactId && evidence.target.revisionDigest === (deliverable.artifactRevisionDigest ?? deliverable.contentRevisionDigest);
        return false;
      });
      const evaluations = (input.learningEvaluations ?? []).filter(evaluation => evaluation.itemRefs.some(ref => sameRef(ref, deliverable.itemRef)) && evaluation.observationIds.some(id => observations.some(observation => observation.id === id)));
      const proposals = (input.learningProposals ?? []).filter(proposal => proposal.impactedItemRefs.some(ref => sameRef(ref, deliverable.itemRef)) || proposal.evidenceRefs.some(ref => evaluations.some(evaluation => evaluation.id === ref.id)));
      const decisions = (input.learningDecisions ?? []).filter(decision => proposals.some(proposal => proposal.id === decision.proposalId));
      return { id: deliverable.id, itemId: deliverable.itemRef.id, campaignId: deliverable.campaignRef?.id ?? null, channel: deliverable.channel, itemType: deliverable.itemType, outputKind: deliverable.outputKind, exactOutput: deliverable.exactOutput, strategyRevision: deliverable.strategyRef.revision, sourceEvidence: deliverable.sourceIds, approvalState: deliverable.approvalState, providerReceiptId: deliverable.providerReceipt?.id ?? null, verificationReceiptId: deliverable.verificationReceipt?.id ?? null,
        metricWindows: observations.map(observation => ({ metric: observation.measurement.definition.metricId, startAt: observation.window.startAt, endAt: observation.window.endAt, availability: observation.availability, value: observation.value, reason: observation.reason })), feedbackIds: feedback.map(evidence => evidence.id), feedback: feedback.map(evidence => ({ id: evidence.id, text: evidence.text, actor: evidence.actor, createdAt: evidence.createdAt, evidenceLinks: evidence.evidenceLinks ?? [] })), evaluationIds: evaluations.map(evaluation => evaluation.id), proposalIds: proposals.map(proposal => proposal.id), decisionIds: decisions.map(decision => decision.id), decisions: decisions.map(decision => ({ id: decision.id, decision: decision.decision, rationale: decision.rationale, feedback: decision.feedback, actor: decision.actor, decidedAt: decision.decidedAt })) };
    }),
    currentJobs: input.jobs.map((job) => ({ id: job.id, stage: job.stage, status: job.status, ...(job.sourceAnalysis?.summary ? { title: bounded(job.sourceAnalysis.summary, 2_000) } : {}) })),
  };
  return {
    strategyReady: Boolean(strategy), planReady: Boolean(plan), calendarReady: upcoming.length + planned.length > 0,
    pendingApprovalCount: input.jobs.reduce((count, job) => {
      const actions = "actions" in job && Array.isArray(job.actions) ? job.actions as Array<{ approvalState?: string; state?: string }> : [];
      return count + (job.strategyApprovalState === "pending" ? 1 : 0) + actions.filter((action) => action.approvalState === "pending" && action.state === "planned").length;
    }, 0),
    goals, channels, strategySummary: strategy?.thesis,
    planSummary: plan?.reason, upcomingItemCount: upcoming.length + planned.length,
    recentJobs: input.jobs.map((job) => ({ id: job.id, stage: job.stage, status: job.status, ...(job.sourceAnalysis?.summary ? { title: bounded(job.sourceAnalysis.summary, 2_000) } : {}) })),
    operation,
  };
}

export async function loadWorkspaceContentContext(): Promise<WorkspaceContentContext> {
  const [goals, allJobs, items, strategyContext, plannedItems, contentProposals, learning, campaigns, strategyProposals, planningProposals] = await Promise.all([getGoals(), listAllJobs(), listContentItems(), loadActiveStrategyContext(), plannedCalendar(undefined, true), listAllProposals(), listAllLearningOperation(), listCurrentCampaigns(), listStrategyProposals(), listPlanningProposals()]);
  const jobs = allJobs;
  const changes = [
    ...contentProposals.map(proposal => ({ id: proposal.id, kind: "content" as const, status: proposal.status, changes: [`topic=${proposal.topic}`, `angle=${proposal.angle}`, `suggestedPost=${proposal.suggestedPost}`], evidenceRefs: proposal.sources, decision: proposal.decidedAt })),
    ...strategyProposals.map(proposal => ({ id: proposal.id, kind: "strategy" as const, status: proposal.approval?.decision ?? "pending", changes: [JSON.stringify(proposal.strategy)], evidenceRefs: proposal.evidenceLineage, revision: proposal.attempt, decision: proposal.approval?.decidedAt })),
    ...learning.proposals.map(proposal => ({ id: proposal.id, kind: "learning_strategy" as const, status: proposal.status, changes: proposal.changes.map(change => JSON.stringify(change)), evidenceRefs: proposal.evidenceRefs.map(ref => ref.id), revision: proposal.revision, decision: proposal.feedback ?? proposal.decidedAt })),
    ...planningProposals.map(projectPlanningProposal),
  ];
  return projectWorkspaceContentContext({ goals, jobs, items, plannedItems, campaigns, proposedChanges: [...new Map(changes.map(change => [change.id, change])).values()], results: learning.observations.map(observation => ({ id: observation.id, metric: observation.measurement.definition.id, availability: observation.availability, checkedAt: observation.observedAt })), deliverables: learning.deliverables, learningObservations: learning.observations, learningFeedback: learning.feedback, learningEvaluations: learning.evaluations, learningProposals: learning.proposals, learningDecisions: learning.decisions, ...strategyContext });
}
