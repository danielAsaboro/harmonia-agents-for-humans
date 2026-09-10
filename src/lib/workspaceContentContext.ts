import { getGoals, listContentItems, listJobs, type OperatorGoals } from "@/lib/repository";
import type { ContentItem, Job } from "@/lib/types";
import type { ApprovedStrategyRevision } from "./strategy/contracts";
import { loadActiveStrategyContext } from "./strategy/context";

export interface WorkspaceContentContext {
  strategyReady: boolean; planReady: boolean; calendarReady: boolean;
  pendingApprovalCount: number; goals: string[]; channels: string[];
  strategySummary?: string; planSummary?: string; upcomingItemCount: number;
  recentJobs: Array<{ id: string; stage: string; status: string; title?: string }>;
}

const bounded = (value: string, limit: number) => value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

export function projectWorkspaceContentContext(input: { goals: OperatorGoals; jobs: Job[]; items: ContentItem[]; activeStrategy: ApprovedStrategyRevision | null; strategyPlan?: Job["editorialPlan"] | null; now?: Date }): WorkspaceContentContext {
  const now = (input.now ?? new Date()).getTime();
  const strategy = input.activeStrategy?.strategy;
  const plan = input.strategyPlan?.approvedStrategyDigest === input.activeStrategy?.ref.digest ? input.strategyPlan : null;
  const upcoming = input.items.filter((item) => item.status !== "cancelled" && item.status !== "published" && (!item.scheduledFor || Date.parse(item.scheduledFor) >= now));
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
  return {
    strategyReady: Boolean(strategy), planReady: Boolean(plan), calendarReady: upcoming.length > 0,
    pendingApprovalCount: input.jobs.reduce((count, job) => {
      const actions = "actions" in job && Array.isArray(job.actions) ? job.actions as Array<{ approvalState?: string; state?: string }> : [];
      return count + (job.strategyApprovalState === "pending" ? 1 : 0) + actions.filter((action) => action.approvalState === "pending" && action.state === "planned").length;
    }, 0),
    goals, channels, strategySummary: strategy?.thesis,
    planSummary: plan?.summary, upcomingItemCount: upcoming.length,
    recentJobs: input.jobs.slice(0, 5).map((job) => ({ id: job.id, stage: job.stage, status: job.status, ...(job.sourceAnalysis?.summary ? { title: bounded(job.sourceAnalysis.summary, 2_000) } : {}) })),
  };
}

export async function loadWorkspaceContentContext(): Promise<WorkspaceContentContext> {
  const [goals, jobs, items, strategyContext] = await Promise.all([getGoals(), listJobs(25), listContentItems(), loadActiveStrategyContext()]);
  return projectWorkspaceContentContext({ goals, jobs, items, ...strategyContext });
}
