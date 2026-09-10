import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { awsRepository, partition, recordKey } from "@/lib/dynamo";
import * as jobs from "@/lib/repository";
import * as pending from "@/lib/pendingOperations";
import { insertStrategyProposal } from "@/lib/strategy/repository";
import { strategyDigest } from "@/lib/strategyApproval";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { strategyFixture } from "./fixtures/strategy";

vi.mock("@/lib/auth", () => ({ operatorTenantHandler: (handler: unknown) => handler }));
vi.mock("@/lib/stageOutboxDispatcher", () => ({ dispatchStageOutboxRecord: async () => undefined }));
import { POST as dashboard } from "@/app/api/jobs/[id]/strategy/decision/route";
import { POST as chat } from "@/app/api/chat/operations/[id]/decision/route";

const workspaceId = `strategy-routes-${randomUUID()}`;
const root = `workspaces/${workspaceId}`;
const tenant: TenantContext = { workspaceId, brandId: "brand", principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" } };
const run = <T>(work: () => T) => runWithTenant(tenant, work);
const store = awsRepository();
async function propose(jobId: string, attempt = 1) {
  const strategy = strategyFixture(jobId, attempt);
  const proposal = await store.atomic((tx) => insertStrategyProposal(tx, { jobId, strategy, digest: strategyDigest(strategy), attempt, evidenceLineage: ["m1"], invocationContext: { revision: attempt, sourceIds: ["m1"], operatorContextIds: ["context:campaign"], performance: [], memoryFacts: [], audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4, researchRequest: null, searchEvidence: [] }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }));
  await store.put(recordKey(`${root}/jobs/${jobId}`), { workspaceId, brandId: tenant.brandId, createdByUserId: "operator", stage: "awaiting_strategy_approval", status: "waiting_for_approval", strategyProposalId: proposal.id, strategyRevision: attempt, config: { sourceManifestId: "source", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  return { decision: "approved" as const, payloadDigest: proposal.digest, expectedActiveRevision: proposal.expectedActiveRevision, proposalId: proposal.id };
}
const request = (value: unknown) => new Request("http://localhost/decision", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
async function operation(jobId: string, value: Awaited<ReturnType<typeof propose>>) {
  return pending.createPendingOperation({ handler: "decide_strategy", title: "Strategy approval", risk: "material", arguments: { jobId, actionId: "strategy", proposalId: value.proposalId, payloadDigest: value.payloadDigest, expectedActiveRevision: value.expectedActiveRevision } });
}
async function counts() {
  const [events, outboxes, proposals] = await Promise.all([store.query(partition(`${root}/event_log`)), store.query(partition(`${root}/stage_outbox`)), store.query(partition(`${root}/brands/brand/strategy_proposals`))]);
  return { events: events.size, outboxes: outboxes.size, decisions: proposals.rows.filter((row) => row.value?.approval).length };
}
const call = (id: string, decision = "approved") => chat(request({ decision }), { params: Promise.resolve({ id }) });

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("strategy HTTP decision recovery", () => {
  afterEach(() => vi.restoreAllMocks());
  it("does not append another decision event or outbox on an identical dashboard retry", () => run(async () => {
    const { proposalId: _proposalId, ...input } = await propose("dashboard");
    const params = { params: Promise.resolve({ id: "dashboard" }) };
    expect((await dashboard(request(input), params)).status).toBe(200);
    const before = await counts();
    expect((await dashboard(request(input), params)).status).toBe(200);
    expect(await counts()).toEqual(before);
  }));
  it("keeps a stale strategy CAS from marking its chat operation approved", () => run(async () => {
    const input = await propose("stale"); const op = await operation("stale", input);
    const winner = await propose("winner"); await jobs.decideStrategy("winner", winner);
    expect((await call(op.id)).status).toBeGreaterThanOrEqual(400);
    expect((await pending.getPendingOperation(op.id))?.state).not.toBe("approved");
    expect((await jobs.getJob("stale")).strategyApprovalState).toBe("pending");
    const before = await counts();
    expect((await call(op.id)).status).toBeGreaterThanOrEqual(400);
    expect(await counts()).toEqual(before);
  }));
  it("recovers interruption before strategy commit using only the original claimed intent", () => run(async () => {
    const input = await propose("before-commit"); const op = await operation("before-commit", input);
    vi.spyOn(jobs, "decideStrategy").mockRejectedValueOnce(new Error("transport interrupted before commit"));
    expect((await call(op.id)).status).toBeGreaterThanOrEqual(400);
    expect((await pending.getPendingOperation(op.id))?.state).toBe("processing");
    expect((await jobs.getJob("before-commit")).strategyApprovalState).toBe("pending");
    await store.patch(recordKey(`${root}/pending_operations/${op.id}`), { decisionLeaseExpiresAt: "2000-01-01T00:00:00Z", expiresAt: "2000-01-01T00:00:00Z" });
    expect((await call(op.id)).status).toBe(200);
    const before = await counts();
    expect((await call(op.id)).status).toBe(200);
    expect(await counts()).toEqual(before);
  }));
  it("reconciles exact rejection feedback after the job advances to another proposal", () => run(async () => {
    const input = await propose("rejection-recovery"); const op = await operation("rejection-recovery", input);
    const reject = (feedback: string) => chat(request({ decision: "rejected", feedback }), { params: Promise.resolve({ id: op.id }) });
    vi.spyOn(pending, "finalizePendingOperationDecision").mockRejectedValueOnce(new Error("interrupted rejection finalize"));
    expect((await reject("Change audience")).status).toBeGreaterThanOrEqual(400);
    expect((await jobs.getJob("rejection-recovery")).strategyApprovalState).toBe("rejected");
    // The old decision stays recoverable by its exact proposal, independent of
    // the job's subsequent proposal workflow.
    await propose("rejection-recovery", 2);
    await store.patch(recordKey(`${root}/pending_operations/${op.id}`), { decisionLeaseExpiresAt: "2000-01-01T00:00:00Z" });
    const before = await counts();
    expect((await reject("Different feedback")).status).toBeGreaterThanOrEqual(400);
    expect((await reject("Change audience")).status).toBe(200);
    expect((await reject("Change audience")).status).toBe(200);
    expect((await pending.getPendingOperation(op.id))?.state).toBe("rejected");
    expect(await counts()).toEqual(before);
  }));
  it("recovers interruption after strategy commit before operation finalization and replays exactly", () => run(async () => {
    const input = await propose("interrupted"); const op = await operation("interrupted", input);
    vi.spyOn(pending, "finalizePendingOperationDecision").mockRejectedValueOnce(new Error("interrupted before operation finalize"));
    expect((await call(op.id)).status).toBeGreaterThanOrEqual(400);
    expect((await pending.getPendingOperation(op.id))?.state).toBe("processing");
    expect((await jobs.getJob("interrupted")).strategyApprovalState).toBe("approved");
    const before = await counts();
    // Expire the persisted lease to model a crashed request without sleeping.
    await store.patch(recordKey(`${root}/pending_operations/${op.id}`), { decisionLeaseExpiresAt: "2000-01-01T00:00:00Z" });
    expect((await call(op.id, "rejected")).status).toBeGreaterThanOrEqual(400);
    expect((await call(op.id)).status).toBe(200);
    expect((await pending.getPendingOperation(op.id))?.state).toBe("approved");
    expect((await call(op.id)).status).toBe(200);
    expect(await counts()).toEqual(before);
  }));
  it("reconciles an unknown strategy commit without granting a concurrent second decision", () => run(async () => {
    const input = await propose("unknown"); const op = await operation("unknown", input);
    const real = jobs.decideStrategy;
    vi.spyOn(jobs, "decideStrategy").mockImplementationOnce(async (...args) => { await real(...args); throw new Error("transport interrupted after commit"); });
    expect((await call(op.id)).status).toBeGreaterThanOrEqual(400);
    expect((await pending.getPendingOperation(op.id))?.state).toBe("processing");
    expect((await call(op.id)).status).toBeGreaterThanOrEqual(400);
    const before = await counts();
    await store.patch(recordKey(`${root}/pending_operations/${op.id}`), { decisionLeaseExpiresAt: "2000-01-01T00:00:00Z" });
    expect((await call(op.id)).status).toBe(200);
    expect(await counts()).toEqual(before);
  }));
  afterAll(async () => store.removeTree(recordKey(root)));
});
