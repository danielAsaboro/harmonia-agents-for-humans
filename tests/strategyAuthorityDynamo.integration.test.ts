import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { editorialPlanSchema } from "@/lib/contracts";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3Client } from "@/lib/storage";
import { insertStrategyProposal, decideStrategyProposal, readStrategyRevision } from "@/lib/strategy/repository";
import { afterAll, describe, expect, it } from "vitest";
import * as repository from "@/lib/repository";
import { awsRepository, recordKey } from "@/lib/dynamo";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { strategyDigest } from "@/lib/strategyApproval";
import { loadWorkspaceContentContext } from "@/lib/workspaceContentContext";
import { strategyFixture as strategy } from "./fixtures/strategy";

const workspaceId = `strategy-${randomUUID()}`;
const tenant = { workspaceId, brandId: "brand-a", principal: { subjectId: "operator", authenticationId: "auth", workspaceRole: "owner", kind: "cognito_user" } } as TenantContext;
const run = <T>(work: () => T, brandId = "brand-a") => runWithTenant({ ...tenant, brandId }, work);
const root = `workspaces/${workspaceId}`;
const store = awsRepository();


async function propose(id: string, attempt = 1) {
  const body = strategy(id, attempt);
  await store.put(recordKey(`${root}/jobs/${id}`), {
    workspaceId, brandId: "brand-a", createdByUserId: "operator", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
    stage: "strategize", status: "running", strategyRevision: attempt,
    config: { platforms: ["x"], strategyContext: { company: "Harmonia", product: "content", positioning: "proof", differentiators: [], brandVoice: [], exclusions: [], safetyConstraints: [], businessObjectives: ["educate"], campaignObjectives: ["educate"], audiences: [{ id: "founders", name: "Founders", pains: [] }], funnelStage: "consideration", intendedConversion: "demo", requestedChannels: ["x"], supportedChannels: ["x"] } },
    sourceAnalysis: { moments: [{ id: "m1", sourceSegmentRefs: ["segment-1"] }], angles: [] },
    strategyInvocationContext: { revision: attempt, sourceIds: ["m1", "segment-1"], operatorContextIds: ["context:campaign", "context:company"], performance: [], memoryFacts: [], searchEvidence: [], researchRequest: null },
  });
  await repository.acceptStrategyProposal(id, body, strategyDigest(body), attempt, [], null);
  return { decision: "approved" as const, payloadDigest: strategyDigest(body), expectedActiveRevision: (await repository.getJob(id)).strategyExpectedActiveRevision! };
}

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("brand strategy authority", () => {
  it("approves the first strategy then plans and drafts a second pinned job with disjoint evidence", () => run(async () => {
    const input = await propose("disjoint-origin");
    const approval = await repository.decideStrategy("disjoint-origin", input);
    const original = await readStrategyRevision(approval.strategyRef!);
    const second = await repository.createJob({ sourceManifestId: "second-manifest", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, "collect_sources");
    const sourceAnalysis = { sourceDigest: "c".repeat(64), summary: "Second source proof.", moments: [{ id: "second-moment", title: "Proof", startSec: 0, endSec: 1, hook: "Proof", quote: "Second source proof.", sourceSegmentRefs: ["second-source:seg-1"], visualEvidenceIds: [], assumptions: [], confidence: "high" }], angles: [], assumptions: [], confidence: "high" };
    await store.patch(recordKey(`${root}/jobs/${second.id}`), { stage: "plan", sourceAnalysis, campaignOutputPlan: { id: "second-output-plan", digest: "d".repeat(64), outputs: [{ id: "second-output", outputType: "x_post", evidenceRefs: ["second-source:seg-1"] }] } });
    const snapshot = await repository.getOrCreateEditorialPlanningSnapshot(second.id);
    const exercise = (stage: string, job: unknown) => JSON.parse(execFileSync(resolve("agent/.venv/bin/python"), ["-m", "tests.disjoint_strategy_workflow_fixture"], { cwd: resolve("agent"), input: JSON.stringify({ stage, job, snapshot }), encoding: "utf8" }));
    const planning = exercise("plan", await repository.getJob(second.id));
    const plan = editorialPlanSchema.parse(planning.posts[0].payload.plan);
    expect(plan.items[0].evidenceRefs).toEqual(["second-moment"]);
    await repository.acceptEditorialPlan(second.id, plan, 1);
    const drafting = exercise("draft", await repository.getJob(second.id));
    const produced = drafting.posts.at(-1).payload.result.accepted.artifacts[0];
    expect(produced.sourceSegmentRefs).toEqual(["second-source:seg-1"]);
    expect(produced.payload.text).toBe("Second source proof. Request a demo.");
    expect(drafting.observed[0].input.strategyRef).toEqual(approval.strategyRef);
    expect(drafting.observed[0].input.sourceBinding).toEqual(snapshot.snapshot.sourceBinding);
    expect(drafting.observed[0].input.editorialItem.briefId).toBe(original.strategy.briefs[0].id);
    expect((await repository.getJob(second.id)).strategyRef).toEqual(approval.strategyRef);
    expect(await readStrategyRevision(approval.strategyRef!)).toEqual(original);
  }), 15_000);
  it("promotes once, rejects concurrent stale approval, and replays the exact winner", () => run(async () => {
    const a = await propose("concurrent-a"); const b = await propose("concurrent-b");
    const pendingJob = await store.read(recordKey(`${root}/jobs/concurrent-a`));
    expect(pendingJob.value).not.toHaveProperty("contentStrategy");
    expect((await repository.getJob("concurrent-a")).contentStrategy?.strategyId).toBe("concurrent-a");
    const results = await Promise.allSettled([repository.decideStrategy("concurrent-a", a), repository.decideStrategy("concurrent-b", b)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const winner = results[0].status === "fulfilled" ? "concurrent-a" : "concurrent-b";
    const input = winner === "concurrent-a" ? a : b;
    const first = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof repository.decideStrategy>>>).value;
    expect(await repository.decideStrategy(winner, input)).toMatchObject({ strategyRef: first.strategyRef, replayed: true });
    const approved = await store.read(recordKey(`${root}/brands/brand-a/strategy_revisions/${first.strategyRef!.revision}`));
    expect(approved.value).toMatchObject({ workspaceId, brandId: "brand-a" });
    await expect(repository.decideStrategy(winner, { ...input, payloadDigest: "0".repeat(64) })).rejects.toThrow();
    await expect(repository.decideStrategy(winner, { ...input, expectedActiveRevision: 99 })).rejects.toThrow();
  }));

  it("pins admission, survives 30 newer jobs, and keeps old jobs pinned after a third lifetime approval", () => run(async () => {
    const baseline = await propose("pinned-baseline"); await repository.decideStrategy("pinned-baseline", baseline);
    const first = await propose("pinned-first"); await repository.decideStrategy("pinned-first", first);
    const old = await repository.createJob({ sourceManifestId: "source-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, "collect_sources");
    expect(old.strategyRef?.digest).toBe(first.payloadDigest);
    const second = await propose("pinned-second"); const outcome = await repository.decideStrategy("pinned-second", second);
    expect(outcome.strategyRef?.revision).toBeGreaterThan(2);
    expect((await repository.getJob(old.id)).strategyRef).toEqual(old.strategyRef);
    expect((await repository.getJob(old.id)).contentStrategy?.strategyId).toBe("pinned-first");
    await store.patch(recordKey(`${root}/jobs/${old.id}`), { editorialPlan: { summary: "A plan from a different job", approvedStrategyDigest: first.payloadDigest } });
    for (let i = 0; i < 30; i++) await repository.createJob({ sourceManifestId: "source-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, "collect_sources");
    const context = await loadWorkspaceContentContext();
    expect(context.strategySummary).toBe("Approved pinned-second");
    expect(context.strategyReady).toBe(true);
    expect(context.planReady).toBe(false);
  }));

  it("rejection leaves active authority unchanged and keeps attempts separate from lifetime revision", () => run(async () => {
    const baseline = await propose("rejection-baseline"); await repository.decideStrategy("rejection-baseline", baseline);
    const before = (await repository.createJob({ sourceManifestId: "source-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, "collect_sources")).strategyRef;
    const input = await propose("rejected", 2);
    const result = await repository.decideStrategy("rejected", { ...input, decision: "rejected", feedback: "Different audience" });
    expect(result.terminalOutcome).toBe("rejected");
    expect((await repository.createJob({ sourceManifestId: "source-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, "collect_sources")).strategyRef).toEqual(before);
  }));

  it("isolates brands and never promotes operator goals", () => run(async () => {
    await run(async () => { const input = await propose("brand-isolation"); await repository.decideStrategy("brand-isolation", input); });
    const strategyContext = await run(async () => (await repository.getJob("brand-isolation")).config.strategyContext);
    await repository.saveGoals({ topics: ["draft"], audience: "unapproved audience", strategyContext });
    expect((await loadWorkspaceContentContext()).strategyReady).toBe(false);
    const job = await repository.createJob({ sourceManifestId: "source-1", desiredOutputs: ["x_post"], allowedOutputs: ["x_post"], platforms: ["x"] }, "collect_sources");
    expect(job.strategyRef).toBeUndefined();
    expect(job.config.strategyContext).toEqual(strategyContext);
    await expect(repository.getJob("brand-isolation")).rejects.toThrow("brand access denied");
    await expect(repository.decideStrategy("brand-isolation", { decision: "approved", payloadDigest: "a".repeat(64), expectedActiveRevision: 0 })).rejects.toThrow("brand access denied");
  }, "brand-b"));

  it("retains active authority when the originating job is deleted", () => run(async () => {
    const input = await propose("deleted-origin"); await repository.decideStrategy("deleted-origin", input);
    await store.remove(recordKey(`${root}/jobs/deleted-origin`));
    expect((await loadWorkspaceContentContext()).strategySummary).toBe("Approved deleted-origin");
  }));

  it("round-trips an oversized approved strategy through tenant-scoped versioned S3 bytes", () => run(async () => {
    const body = strategy("oversized");
    const sourceIds = ["m1", ...Array.from({ length: 4000 }, (_, index) => `source-${index}-${"x".repeat(80)}`)];
    const proposal = await store.atomic((tx) => insertStrategyProposal(tx, { jobId: "oversized", strategy: body, digest: strategyDigest(body), attempt: 1, evidenceLineage: ["m1"], invocationContext: { revision: 1, sourceIds, operatorContextIds: ["context:campaign"], performance: [], memoryFacts: [], audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4, researchRequest: null, searchEvidence: [] }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" }));
    const result = await store.atomic((tx) => decideStrategyProposal(tx, proposal.id, { decision: "approved", payloadDigest: proposal.digest, expectedActiveRevision: proposal.expectedActiveRevision }));
    const ref = result.strategyRef!;
    const row = await store.read(recordKey(`${root}/brands/brand-a/strategy_revisions/${ref.revision}`));
    expect(row.blob?.key).toMatch(new RegExp(`^${workspaceId}/brand-a/record-blobs/`));
    const blob = row.blob!;
    const response = await s3Client().send(new GetObjectCommand({ Bucket: blob.bucket, Key: blob.key }));
    expect(response.VersionId).toBeTruthy();
    expect(response.VersionId).not.toBe("null");
    const bytes = Buffer.from(await response.Body!.transformToByteArray());
    expect(bytes.length).toBeGreaterThan(240 * 1024);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(blob.sha256);
    const restored = await readStrategyRevision(ref);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(restored);
    expect(restored.invocationContext.sourceIds).toEqual(sourceIds);
    expect(strategyDigest(restored.strategy)).toBe(ref.digest);
    const overwritten = await s3Client().send(new PutObjectCommand({ Bucket: blob.bucket, Key: blob.key, Body: Buffer.from("corrupted approved strategy") }));
    expect(overwritten.VersionId).not.toBe(response.VersionId);
    await expect(readStrategyRevision(ref)).rejects.toThrow("record blob digest mismatch");
    await s3Client().send(new PutObjectCommand({ Bucket: blob.bucket, Key: blob.key, Body: bytes }));
    expect(await readStrategyRevision(ref)).toEqual(restored);
  }));

  afterAll(async () => { await store.removeTree(recordKey(root)); });
});
