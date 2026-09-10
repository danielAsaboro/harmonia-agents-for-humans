import { describe, expect, it } from "vitest";

import { projectWorkspaceContentContext } from "@/lib/workspaceContentContext";
import type { Job, ContentItem } from "@/lib/types";
import type { ApprovedStrategyRevision } from "@/lib/strategy/contracts";

describe("workspace content context", () => {
  it("never treats approved job fields or operator goals as active authority", () => {
    const result = projectWorkspaceContentContext({ goals: { topics: ["draft goals"] }, items: [], jobs: [{ id: "old", strategyApprovalState: "approved", contentStrategy: { thesis: "Old" }, editorialPlan: { summary: "Old plan" } }] as unknown as Job[], activeStrategy: null } as never);
    expect(result.strategyReady).toBe(false);
    expect(result.planReady).toBe(false);
  });

  it("keeps strategy visible beyond 25 jobs and refuses a plan from a different strategy", () => {
    const result = projectWorkspaceContentContext({ goals: { topics: [] }, items: [], jobs: Array.from({ length: 30 }, (_, i) => ({ id: `new-${i}`, strategyApprovalState: "approved", editorialPlan: { summary: "Unrelated plan", approvedStrategyDigest: "b".repeat(64) } })) as unknown as Job[], activeStrategy: { ref: { digest: "a".repeat(64) }, strategy: { thesis: "Durable approved strategy", channelRoles: [] } }, strategyPlan: null } as never);
    expect(result.strategySummary).toBe("Durable approved strategy");
    expect(result.strategyReady).toBe(true);
    expect(result.planReady).toBe(false);
  });
  it("projects the latest approved strategy, plan, calendar and approval load", () => {
    const jobs = [{
      id: "job-1", stage: "awaiting_approval", status: "waiting_for_approval",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
      strategyApprovalState: "approved", contentStrategy: { thesis: "Own the reliable-agent category", channelRoles: [{ channel: "linkedin" }] },
      editorialPlan: { summary: "Four weeks of founder proof" }, actions: [{ approvalState: "pending", state: "planned" }],
      sourceAnalysis: { summary: "Launch interview" },
    }] as unknown as Job[];
    const items = [{ id: "item-1", status: "scheduled", scheduledFor: "2026-09-08T09:00:00Z", platforms: ["linkedin"] }] as ContentItem[];
    const activeStrategy = { ref: { digest: "a".repeat(64) }, strategy: jobs[0].contentStrategy } as ApprovedStrategyRevision;
    const result = projectWorkspaceContentContext({ goals: { topics: ["agent reliability"], audience: "startup founders" }, jobs, items, activeStrategy, strategyPlan: { ...jobs[0].editorialPlan!, approvedStrategyDigest: activeStrategy.ref.digest }, now: new Date("2026-09-01T00:00:00Z") });
    expect(result).toMatchObject({ strategyReady: true, planReady: true, calendarReady: true, pendingApprovalCount: 1, upcomingItemCount: 1, channels: ["linkedin"] });
    expect(result.strategySummary).toContain("reliable-agent");
    expect(result.goals).toContain("Audience: startup founders");
  });

  it("bounds generated job titles before sending them to the intent router", () => {
    const jobs = [{
      id: "job-long-summary", stage: "strategize", status: "failed",
      createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
      sourceAnalysis: { summary: "Evidence-backed startup content operations. ".repeat(80) },
    }] as unknown as Job[];
    const result = projectWorkspaceContentContext({ goals: { topics: [] }, jobs, items: [], activeStrategy: null });
    expect(result.recentJobs[0].title).toHaveLength(2_000);
    expect(result.recentJobs[0].title?.endsWith("…")).toBe(true);
  });
});
