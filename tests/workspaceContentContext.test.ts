import { describe, expect, it } from "vitest";

import { projectPlanningProposal, projectWorkspaceContentContext } from "@/lib/workspaceContentContext";
import type { Job, ContentItem } from "@/lib/types";
import type { ApprovedStrategyRevision } from "@/lib/strategy/contracts";
import type { PlanRevision } from "@/lib/campaigns/contracts";

describe("workspace content context", () => {
  it("projects durable planning proposal shapes without inventing source replacement", () => {
    expect(projectPlanningProposal({ id: "command-1", state: "needs_details", input: { action: "advance_plan" }, digest: "d", reason: "Need target", actor: "operator", at: "2026-09-11T10:00:00Z" })).toMatchObject({ kind: "incomplete_command", status: "needs_details", changes: expect.arrayContaining(["input={\"action\":\"advance_plan\"}", "digest=d", "state=needs_details", "reason=Need target", "actor=operator"]) });
    expect(projectPlanningProposal({ id: "sources-1", state: "pending_approval", intakeDraftId: "draft-1", itemRef: { id: "item-1" }, sourceHandles: [{ url: "https://example.com/source" }], sourceRights: { "web:https://example.com/source": "rights-1" }, operatorBrief: "Replace source", reason: "Explicit revision needed" })).toMatchObject({ kind: "source_replacement", evidenceRefs: ["https://example.com/source", "rights:web:https://example.com/source:rights-1"], changes: expect.arrayContaining(["intakeDraftId=draft-1"]) });
    expect(projectPlanningProposal({ id: "calendar-1", type: "calendar_change", state: "declined", input: { itemRef: { id: "item-1" } }, reasons: ["claimed"], guarded: [{ itemRef: { id: "item-1" }, authorityDigest: "a".repeat(64) }], decision: "keep_existing_execution", decidedBy: "operator", decidedAt: "2026-09-11T11:00:00Z" })).toMatchObject({ kind: "calendar_change", decision: "keep_existing_execution", evidenceRefs: [`authority:${"a".repeat(64)}`], changes: expect.arrayContaining(["decidedBy=operator", "decidedAt=2026-09-11T11:00:00Z"]) });
  });
  it("never treats approved job fields or operator goals as active authority", () => {
    const result = projectWorkspaceContentContext({ goals: { topics: ["draft goals"] }, items: [], jobs: [{ id: "old", strategyApprovalState: "approved", contentStrategy: { thesis: "Old" }, editorialPlan: { summary: "Old plan" } }] as unknown as Job[], activeStrategy: null } as never);
    expect(result.strategyReady).toBe(false);
    expect(result.planReady).toBe(false);
  });

  it("keeps strategy visible beyond 25 jobs and refuses a plan from a different strategy", () => {
    const result = projectWorkspaceContentContext({ goals: { topics: [] }, items: [], jobs: Array.from({ length: 30 }, (_, i) => ({ id: `new-${i}`, strategyApprovalState: "approved", editorialPlan: { summary: "Unrelated plan", approvedStrategyDigest: "b".repeat(64) } })) as unknown as Job[], activeStrategy: { ref: { digest: "a".repeat(64) }, strategy: { thesis: "Durable approved strategy", channelRoles: [] } }, plans: [{ strategyRef: { digest: "b".repeat(64) }, reason: "Unrelated plan" }] } as never);
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
    const result = projectWorkspaceContentContext({ goals: { topics: ["agent reliability"], audience: "startup founders" }, jobs, items, activeStrategy, plans: [{ strategyRef: activeStrategy.ref, reason: "Four weeks of founder proof" }] as PlanRevision[], now: new Date("2026-09-01T00:00:00Z") });
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

  it("projects current durable work with its strategy, evidence, approval, dependency and result states", () => {
    const result = projectWorkspaceContentContext({
      goals: { topics: [] }, items: [], jobs: [{
        id: "job-approval", stage: "awaiting_approval", status: "waiting_for_approval",
        strategyApprovalState: "pending", actions: [{ id: "publish-1", state: "planned", approvalState: "pending" }],
      }] as unknown as Job[],
      activeStrategy: { ref: { digest: "a".repeat(64) }, strategy: { thesis: "Grow with operator proof", channelRoles: [] } } as unknown as ApprovedStrategyRevision,
      plans: [{ ref: { id: "plan-1", revision: 2 }, strategyRef: { digest: "a".repeat(64) }, reason: "Founder evidence campaign" }] as unknown as PlanRevision[],
      campaigns: [{ ref: { id: "campaign-1", revision: 1 }, name: "Founder proof", objective: "Build trust" }],
      plannedItems: [{
        ref: { id: "item-1", revision: 1 }, planRef: { id: "plan-1", revision: 2 }, strategyRef: { digest: "a".repeat(64) },
        campaignRef: null, name: "Independent founder note", objective: "Teach founder operations", channel: "x", scheduledFor: "2026-09-20T09:00:00Z",
        evidence: { mode: "operator_context", contextDigest: "b".repeat(64) }, measurements: [{ definition: { id: "engagement" } }],
        dependencies: [], requiredAssetIds: [],
        lifecycle: { status: "blocked", jobId: "job-approval", reason: "asset:demo-video" },
      }] as never,
      results: [{ id: "observation-1", availability: "unavailable", metric: "engagement", checkedAt: "2026-09-11T10:00:00Z" }],
    } as never);

    expect(result.operation?.activeStrategy?.thesis).toBe("Grow with operator proof");
    expect(result.operation?.campaigns).toEqual([{ id: "campaign-1", name: "Founder proof", objective: "Build trust" }]);
    expect(result.operation?.plannedItems[0]).toMatchObject({ campaignId: null, campaignLabel: "Independent work", metricIds: ["engagement"], evidenceState: "operator_context", approvalState: "pending", lifecycleState: "blocked" });
    expect(result.operation?.plannedItems[0].unresolvedDependencies).toEqual(["asset:demo-video"]);
    expect(result.operation?.results).toEqual([{ id: "observation-1", metric: "engagement", availability: "unavailable", checkedAt: "2026-09-11T10:00:00Z" }]);
  });

  it("does not truncate authoritative operating records and preserves proposal and availability states", () => {
    const jobs = Array.from({ length: 26 }, (_, index) => ({ id: `job-${index}`, stage: "draft", status: "running", actions: [] })) as unknown as Job[];
    const campaigns = Array.from({ length: 26 }, (_, index) => ({ ref: { id: `campaign-${index}`, revision: 1 }, name: `Campaign ${index}`, objective: "Durable campaign even without current work" }));
    const result = projectWorkspaceContentContext({
      goals: { topics: [] }, jobs, items: [], activeStrategy: null, campaigns,
      proposedChanges: [{ id: "proposal-pending", status: "pending", changes: ["Move cadence to weekly"], decision: "operator review pending" }, { id: "proposal-revoked", status: "revoked", changes: ["Do not use revoked evidence"] }],
      results: ["available", "pending_window", "stale", "revoked", "unavailable"].map((availability, index) => ({ id: `result-${availability}`, metric: `metric-${index}`, availability })),
    } as never);
    expect(result.recentJobs).toHaveLength(26);
    expect(result.operation?.campaigns).toHaveLength(26);
    expect(result.operation?.proposedChanges).toContainEqual({ id: "proposal-pending", kind: "content", status: "pending", changes: ["Move cadence to weekly"], evidenceRefs: [], decision: "operator review pending" });
    expect(result.operation?.results.map(item => item.availability)).toEqual(["available", "pending_window", "stale", "revoked", "unavailable"]);
  });

  it.each(["planned", "running", "awaiting_approval", "completed", "failed", "cancelled", "blocked", "requires_disposition"] as const)("preserves durable planned-item state %s exactly", (status) => {
    const result = projectWorkspaceContentContext({ goals: { topics: [] }, jobs: [], items: [], activeStrategy: null, plannedItems: [{
      ref: { id: `item-${status}`, revision: 1 }, planRef: { id: "plan", revision: 1 }, strategyRef: { strategyId: "strategy", revision: 1, digest: "a".repeat(64) }, campaignRef: null,
      name: status, objective: status, channel: "x", scheduledFor: "2026-09-20T09:00:00Z", evidence: { mode: "operator_context", contextDigest: "b".repeat(64) }, measurements: [{ definition: { id: "m" } }], dependencies: [], requiredAssetIds: [], lifecycle: { status },
    }] } as never);
    expect(result.operation?.plannedItems[0].lifecycleState).toBe(status);
  });

  it("retains every valid source evidence reference beyond the old 500-card cap", () => {
    const evidenceIds = Array.from({ length: 501 }, (_, index) => `evidence-${index}`);
    const result = projectWorkspaceContentContext({ goals: { topics: [] }, jobs: [], items: [], activeStrategy: null, plannedItems: [{
      ref: { id: "item-evidence", revision: 1 }, planRef: { id: "plan", revision: 1 }, strategyRef: { strategyId: "strategy", revision: 1, digest: "a".repeat(64) }, campaignRef: null, name: "Evidence", objective: "Keep evidence", channel: "x", scheduledFor: "2026-09-20T09:00:00Z", measurements: [{ definition: { id: "m" } }], dependencies: [], requiredAssetIds: [], evidence: { mode: "source_backed", sourceBinding: { evidenceIds } }, lifecycle: { status: "planned" },
    }] } as never);
    expect(result.operation?.plannedItems[0].sourceEvidenceRefs).toEqual(evidenceIds);
  });
});
