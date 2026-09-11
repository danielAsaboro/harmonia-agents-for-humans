import { getGoals, listContentItems, listAllJobs, listAllProposals, type OperatorGoals } from "@/lib/repository";
import type { ContentItem, Job } from "@/lib/types";
import type { ApprovedStrategyRevision } from "./strategy/contracts";
import { loadActiveStrategyContext } from "./strategy/context";
import type { PlanRevision } from "./campaigns/contracts";
import { plannedCalendar } from "./planning/commands";
import { strategyDigest } from "./strategyApproval";
import { listCurrentCampaigns } from "./campaigns/repository";
import { listLearningContext } from "./learning/repository";

export interface WorkspaceOperationContext {
  activeStrategy: { thesis: string; strategyId: string; revision: number; digest: string } | null;
  proposedChanges: Array<{ id: string; status: string; changes: string[]; decision?: string }>;
  campaigns: Array<{ id: string; name: string; objective: string }>;
  plans: Array<{ id: string; revision: number; reason: string }>;
  plannedItems: Array<{
    id: string; planId: string; campaignId: string | null; campaignLabel: string;
    name: string; objective: string; channel: string; scheduledFor: string; strategyRef: { strategyId: string; revision: number; digest: string }; metricIds: string[]; sourceEvidenceRefs: string[]; declaredDependencies: string[]; requiredAssets: string[];
    evidenceState: "source_backed" | "operator_context" | "unavailable";
    approvalState: "pending" | "not_pending"; dependencyState: "ready" | "blocked" | "pending_window" | "failed" | "revoked" | "unavailable" | "stale";
    unresolvedDependencies: string[];
  }>;
  results: Array<{ id: string; metric: string; availability: "available" | "pending" | "pending_window" | "stale" | "revoked" | "unavailable"; checkedAt?: string }>;
}

export interface WorkspaceContentContext {
  strategyReady: boolean; planReady: boolean; calendarReady: boolean;
  pendingApprovalCount: number; goals: string[]; channels: string[];
  strategySummary?: string; planSummary?: string; upcomingItemCount: number;
  recentJobs: Array<{ id: string; stage: string; status: string; title?: string }>;
  /** Present on current server projections; optional for historical callers. */
  operation?: WorkspaceOperationContext;
}

const bounded = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

export function projectWorkspaceContentContext(input: { goals: OperatorGoals; jobs: Job[]; items: ContentItem[]; activeStrategy: ApprovedStrategyRevision | null; plans?: PlanRevision[]; campaigns?: Array<{ ref: { id: string }; name: string; objective: string }>; proposedChanges?: Array<{ id: string; status: string; changes?: string[]; decision?: string }>; results?: Array<{ id: string; availability?: string; metric?: string; checkedAt?: string }>; plannedItems?: Awaited<ReturnType<typeof plannedCalendar>>; now?: Date }): WorkspaceContentContext {
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
    proposedChanges: (input.proposedChanges ?? []).map(change => ({ id: change.id, status: change.status, changes: change.changes ?? [], ...(change.decision ? { decision: change.decision } : {}) })),
    campaigns: (input.campaigns ?? []).map(campaign => ({ id: campaign.ref.id, name: bounded(campaign.name, 300), objective: bounded(campaign.objective, 1_000) })),
    plans: (input.plans ?? []).flatMap(plan => plan.ref ? [{ id: plan.ref.id, revision: plan.ref.revision, reason: bounded(plan.reason, 1_000) }] : []),
    plannedItems: (input.plannedItems ?? []).map((item) => {
      const execution = item.lifecycle.jobId ? input.jobs.find(job => job.id === item.lifecycle.jobId) : undefined;
      const approvalState = execution && (execution.strategyApprovalState === "pending" || ("actions" in execution && Array.isArray(execution.actions) && execution.actions.some((action: { approvalState?: string; state?: string }) => action.approvalState === "pending" && action.state === "planned"))) ? "pending" as const : "not_pending" as const;
      const state = item.lifecycle.status === "blocked" ? "blocked" : item.lifecycle.status === "failed" ? "failed" : item.lifecycle.status === "cancelled" ? "revoked" : item.lifecycle.status === "planned" ? "pending_window" : ["claimed", "running", "waiting_for_approval"].includes(item.lifecycle.status) ? "ready" : "unavailable";
      const evidenceState = item.evidence.mode === "source_backed" || item.evidence.mode === "operator_context" ? item.evidence.mode : "unavailable";
      return {
        id: item.ref.id, planId: item.planRef.id, campaignId: item.campaignRef?.id ?? null, campaignLabel: item.campaignRef ? item.campaignRef.id : "Independent work",
        name: bounded(item.name, 500), objective: bounded(item.objective, 1_000), channel: item.channel, scheduledFor: item.scheduledFor,
        strategyRef: { strategyId: item.strategyRef.strategyId, revision: item.strategyRef.revision, digest: item.strategyRef.digest },
        metricIds: item.measurements.map(measurement => measurement.definition.id).slice(0, 8), evidenceState,
        sourceEvidenceRefs: item.evidence.mode === "source_backed" ? item.evidence.sourceBinding.evidenceIds.slice(0, 500) : [],
        declaredDependencies: (item.dependencies ?? []).map(dependency => `${dependency.id}:v${dependency.revision}`), requiredAssets: [...(item.requiredAssetIds ?? [])],
        approvalState, dependencyState: state,
        unresolvedDependencies: state === "blocked" && item.lifecycle.reason ? [bounded(item.lifecycle.reason, 500)] : [],
      };
    }),
    results: (input.results ?? []).map(result => ({
      id: result.id, metric: result.metric ?? "unavailable metric",
      availability: result.availability === "available" || result.availability === "pending" || result.availability === "pending_window" || result.availability === "stale" || result.availability === "revoked" || result.availability === "unavailable" ? result.availability : "unavailable",
      ...(result.checkedAt ? { checkedAt: result.checkedAt } : {}),
    })),
  };
  return {
    strategyReady: Boolean(strategy), planReady: Boolean(plan), calendarReady: upcoming.length + planned.length > 0,
    pendingApprovalCount: input.jobs.reduce((count, job) => {
      const actions = "actions" in job && Array.isArray(job.actions) ? job.actions as Array<{ approvalState?: string; state?: string }> : [];
      return count + (job.strategyApprovalState === "pending" ? 1 : 0) + actions.filter((action) => action.approvalState === "pending" && action.state === "planned").length;
    }, 0),
    goals, channels, strategySummary: strategy?.thesis,
    planSummary: plan?.reason, upcomingItemCount: upcoming.length + planned.length,
    recentJobs: input.jobs.slice(0, 5).map((job) => ({ id: job.id, stage: job.stage, status: job.status, ...(job.sourceAnalysis?.summary ? { title: bounded(job.sourceAnalysis.summary, 2_000) } : {}) })),
    operation,
  };
}

export async function loadWorkspaceContentContext(): Promise<WorkspaceContentContext> {
  const [goals, allJobs, items, strategyContext, plannedItems, proposedChanges, learning, campaigns] = await Promise.all([getGoals(), listAllJobs(), listContentItems(), loadActiveStrategyContext(), plannedCalendar(), listAllProposals(), listLearningContext(), listCurrentCampaigns()]);
  const jobs = allJobs;
  const changes = [...proposedChanges.map(proposal => ({ id: proposal.id, status: proposal.status, changes: [proposal.reason], decision: proposal.decidedAt })), ...learning.proposals.map(proposal => ({ id: proposal.id, status: proposal.status, changes: proposal.changes.map(change => JSON.stringify(change)), decision: proposal.feedback ?? proposal.decidedAt }))];
  return projectWorkspaceContentContext({ goals, jobs, items, plannedItems, campaigns, proposedChanges: [...new Map(changes.map(change => [change.id, change])).values()], results: learning.observations.map(observation => ({ id: observation.id, metric: observation.measurement.definition.id, availability: observation.availability, checkedAt: observation.observedAt })), ...strategyContext });
}
