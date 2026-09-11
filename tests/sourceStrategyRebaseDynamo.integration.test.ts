import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { awsRepository, recordKey, partition } from "@/lib/dynamo";
import { runWithTenant, currentTenant, type TenantContext } from "@/lib/tenancy";
import { insertStrategyProposal, decideStrategyProposal, readActiveStrategyRef } from "@/lib/strategy/repository";
import { strategyFixture } from "./fixtures/strategy";
import { strategyDigest } from "@/lib/strategyApproval";
import { configurePlanningPolicy, currentPlan, readPlannedItem, readItemState } from "@/lib/campaigns/repository";
import { listPlanningProposals } from "@/lib/planning/commands";
import { buildStrategySourceBinding } from "@/lib/strategy/sourceBinding";
import { editorialPlanningSnapshotDigest } from "@/lib/editorialPlan";
import { createJob, getJob, acceptEditorialPlan } from "@/lib/repository";
import { sealManifest } from "@/lib/sourceRegistry";
import { putArtifact } from "@/lib/storage";
import { proposeOutputPlan } from "@/lib/outputPlanning";
import { claimNextPlannedItem } from "@/lib/planning/selection";
import { campaignWorkerBridge } from "./fixtures/campaignWorkerBridge";
import { resolveDecision } from "@/lib/decisions";
import { actionPayloadDigest } from "@/lib/idempotency";
import { withTraceContext } from "@/lib/telemetry";
import { buildStageMessage } from "@/lib/queue";
import type { StageOutboxRecord } from "@/lib/stageOutbox";
import type { ContentStrategy, EditorialPlan, SourceAnalysis } from "@/lib/types";

vi.mock("@/lib/auth", () => ({ tenantHandler: (handler: unknown) => handler }));
const tenant = (): TenantContext => ({ workspaceId: `source-rebase-${randomUUID()}`, brandId: "a", principal: { kind: "cognito_user", subjectId: "operator", workspaceRole: "owner", authenticationId: "local-auth" } });
async function approve(strategy: ContentStrategy) {
  const base = await readActiveStrategyRef();
  const proposal = await awsRepository().atomic(tx => insertStrategyProposal(tx, { jobId: randomUUID(), attempt: 1, strategy, digest: strategyDigest(strategy), evidenceLineage: ["m1"], invocationContext: { revision: 1, sourceIds: ["m1"], operatorContextIds: ["context:campaign"], performance: [], memoryFacts: [], audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4, researchRequest: null, searchEvidence: [] }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }));
  return awsRepository().atomic(tx => decideStrategyProposal(tx, proposal.id, { decision: "approved", payloadDigest: proposal.digest, expectedActiveRevision: base?.revision ?? 0 }));
}
async function setup(ambiguous = false) {
  await approve(strategyFixture("old-strategy"));
  await configurePlanningPolicy({ timezone: "UTC", productionCapacity: { maxItems: 24, maxItemsPerWeek: 6 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1 }, 0);
  const origin = await createJob({ operatorBrief: "Share the source proof with founders.", sourceManifestId: "source-manifest", desiredOutputs: ["x_post", "content_pack"], allowedOutputs: ["x_post", "content_pack"], platforms: ["x"] }, "plan");
  const analysis: SourceAnalysis = { sourceDigest: "a".repeat(64), summary: "The team documented its workflow.", moments: [{ id: "m1", title: "Workflow", startSec: 0, endSec: 1, hook: "Proof", quote: "The team documented its workflow.", sourceSegmentRefs: ["source-1:seg-1"], visualEvidenceIds: [], assumptions: [], confidence: "high" }], angles: [], assumptions: [], confidence: "high" };
  const start = "2098-01-01T00:00:00Z", end = "2098-01-29T00:00:00Z";
  const snapshot = { sourceBinding: buildStrategySourceBinding({ id: origin.id, strategyRef: origin.strategyRef!, sourceAnalysis: analysis }), snapshotId: `planning-${origin.id}`, asOf: new Date().toISOString(), horizonStartAt: start, horizonEndAt: end, timezone: "UTC", channelCapabilities: [{ channel: "x", formats: ["text_post"] }], existingCommitments: [], productionCapacity: { maxItems: 24, maxItemsPerWeek: 6 }, cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 }, postingWindowObservations: [], assetReadiness: [], blockedDependencies: [], calendarProjection: [], provenanceIds: ["policy:policy:v1"] };
  const plan: EditorialPlan = { planId: "source-plan", version: 1, approvedStrategyDigest: origin.strategyRef!.digest, planningSnapshotId: snapshot.snapshotId, planningSnapshotDigest: editorialPlanningSnapshotDigest(snapshot), horizonStartAt: start, horizonEndAt: end, timezone: "UTC", summary: "Source campaign", sequencingRationale: "One evidence-led item", cadenceRationale: "One item", assumptions: [], confidence: "high", selectedNextItemId: "source-item", items: [{ id: "source-item", briefId: "brief-1", campaignTheme: "Old proof theme", contentPillar: "proof", objective: "Old objective", audienceId: "founders", funnelStage: "consideration", intendedConversion: "Old conversion", ctaIntent: "Old CTA", kpi: "Old KPI", channel: "x", format: "text_post", evidenceRefs: ["m1"], publicationWindowStartAt: start, publicationWindowEndAt: "2098-01-01T01:00:00Z", productionDeadlineAt: start, priority: 1, selectionScore: 1, dependencies: [], productionStatus: "planned", constraints: [], requiredAssets: [], planningRationale: "Source evidence", selectionRationale: "Only item", confidence: "high" }] };
  await awsRepository().patch(recordKey(`workspaces/${origin.workspaceId}/jobs/${origin.id}`), { sourceAnalysis: analysis, editorialPlanningSnapshot: snapshot, editorialPlanningSnapshotDigest: editorialPlanningSnapshotDigest(snapshot), campaignOutputPlan: proposeOutputPlan(origin.id, ["x_post"], ["x_post"], analysis) });
  await putArtifact("source-normalized.json", Buffer.from(JSON.stringify({ sourceId: "source-1", sourceKind: "document", segments: [{ id: "1", text: "The team documented its workflow.", locator: { kind: "page", page: 1 } }] })), "application/json");
  await awsRepository().put(recordKey(`workspaces/${origin.workspaceId}/brands/a/sources/source-1`), { id: "source-1", workspaceId: origin.workspaceId, brandId: "a", state: "ready", normalizedArtifactId: "source-normalized.json", rightsAuthorizationId: "local-source-rights" });
  await awsRepository().put(recordKey(`workspaces/${origin.workspaceId}/jobs/${origin.id}/source_manifests/source-manifest`), sealManifest({ id: "source-manifest", jobId: origin.id, revision: 1, directSourceIds: ["source-1"], excludedSourceIds: [], exclusionRecords: [], sealedAt: new Date().toISOString(), sealedBySubjectId: "operator" }));
  const accepted = await acceptEditorialPlan(origin.id, plan, 1); expect(accepted.executionJobId).toBeUndefined();
  const next = strategyFixture("new-strategy"); next.briefs = [{ ...next.briefs[0], id: "replacement-brief", title: "Documented workflows", objective: "Invite a workflow review", ctaIntent: "Request a workflow review.", intendedConversion: "Workflow review", kpi: "Qualified review requests", constraints: ["Stay within documented source evidence"] }];
  if (ambiguous) next.briefs.push({ ...next.briefs[0], id: "alternative-brief", objective: "Invite a workshop", ctaIntent: "Join the workshop." });
  await approve(next);
  const proposal = (await listPlanningProposals()).find(p => p.type === "strategy_rebase")!;
  const route = await import("@/app/api/planning/proposals/[id]/route");
  const review = await (await route.GET(new Request("http://localhost"), { params: Promise.resolve({ id: String(proposal.id) }) })).json();
  const decide = async (extra: Record<string, unknown> = {}) => {
    const response = await route.POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ requestId: randomUUID(), decision: "rebase_to_current_strategy", expectedAuthorityDigest: review.dispositionAuthorityDigest, ...extra }) }), { params: Promise.resolve({ id: String(proposal.id) }) });
    return { response, body: await response.json() };
  };
  return { accepted, review, decide, next };
}

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("source-backed exact strategy remapping", () => {
  it("reviews current brief metadata, revises it immutably, then drafts and verifies a real local export", async () => runWithTenant(tenant(), async () => {
    const { accepted, review, decide } = await setup();
    expect(review.proposal.editorialRebases).toHaveLength(1);
    expect(review.proposal.editorialRebases[0].candidates[0].item).toMatchObject({ briefId: "replacement-brief", objective: "Invite a workflow review", ctaIntent: "Request a workflow review.", kpi: "Qualified review requests", evidenceRefs: ["m1"] });
    expect((await decide()).response.status).toBe(200);
    const plan = await currentPlan(accepted.planRef.id); const item = await readPlannedItem(plan.itemRefs[0]);
    expect(item.objective).toBe("Invite a workflow review"); expect(item.productionContext.mode).toBe("source_backed");
    const claim = (await claimNextPlannedItem(plan.ref.id, "2099-01-01T00:00:00Z"))!;
    expect((await getJob(claim.jobId)).editorialPlan!.items[0]).toMatchObject({ briefId: "replacement-brief", ctaIntent: "Request a workflow review.", kpi: "Qualified review requests" });
    vi.stubEnv("INTERNAL_API_TOKEN", "source-rebase-local"); vi.stubEnv("AGENT_SERVICE_URL", "http://127.0.0.1:1"); vi.stubEnv("SQS_STAGE_QUEUE_URL", undefined);
    const bridge = await campaignWorkerBridge();
    try {
      for (const stage of ["draft", "publish", "verify", "learn", "complete"]) {
        const rows = await awsRepository().query(partition(`workspaces/${currentTenant().workspaceId}/stage_outbox`)); const record = rows.rows.find(r => r.value?.jobId === claim.jobId && r.value.stage === stage)?.value as unknown as StageOutboxRecord | undefined;
        if (!record && stage === "complete") break; expect(record).toBeDefined(); const message = buildStageMessage(plan.ref, record!);
        const outcome = await bridge.run({ event: JSON.parse(message.data.toString()), carrier: message.attributes, transportId: randomUUID() }); expect(outcome.result.failed, JSON.stringify(bridge.requests)).not.toBe(true);
        if (stage === "draft") {
          const awaiting = await getJob(claim.jobId);
          expect(awaiting.actions.some(action => action.payload.outputType === "content_pack" && action.approvalState === "pending")).toBe(true);
          for (const action of awaiting.actions.filter(action => action.approvalState === "pending")) await withTraceContext(new Headers(), () => resolveDecision(claim.jobId, action.id, "approved", actionPayloadDigest(action)));
        }
      }
      const job = await getJob(claim.jobId); expect(job.terminalOutcome).toBe("succeeded"); expect(job.contentArtifacts![0].payload).toMatchObject({ kind: "x_post", text: "The team documented its workflow. Request a workflow review." });
      expect(job.verifications?.some(v => v.verified)).toBe(true); expect((await readItemState(claim.itemRef)).status).toBe("completed");
    } finally { await bridge.close(); }
  }), 30000);
  it("requires an exact reviewed mapping when multiple current briefs fit and rejects invented mappings", async () => runWithTenant(tenant(), async () => {
    const { review, decide, accepted } = await setup(true);
    expect((await decide()).response.status).toBe(409);
    const itemRef = review.proposal.editorialRebases[0].itemRef;
    expect((await decide({ editorialMappings: [{ itemRef, briefId: "old-or-invented" }] })).response.status).toBe(409);
    expect((await decide({ editorialMappings: [{ itemRef, briefId: "alternative-brief" }] })).response.status).toBe(200);
    const plan = await currentPlan(accepted.planRef.id); const revised = await readPlannedItem(plan.itemRefs[0]);
    expect(revised.productionContext.mode === "source_backed" && revised.productionContext.item.ctaIntent).toBe("Join the workshop.");
  }));
  it("rejects a mapping decision after another strategy promotion", async () => runWithTenant(tenant(), async () => {
    const { decide } = await setup(); await approve(strategyFixture("newer-strategy"));
    expect((await decide()).response.status).toBe(409);
  }));
});
