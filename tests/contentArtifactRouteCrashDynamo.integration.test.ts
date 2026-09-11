import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { cognitoPrincipal } from "@/lib/authority";
import { configurePlanningPolicy } from "@/lib/campaigns/repository";
import type { ContentArtifact } from "@/lib/contentArtifacts/contracts";
import { awsRepository, partition, recordKey } from "@/lib/dynamo";
import { submitIntakeTurn } from "@/lib/intake/repository";
import { planRequestedMediaProduction } from "@/lib/outputMediaProduction";
import { materializeIntake } from "@/lib/planning/commands";
import { claimNextPlannedItem } from "@/lib/planning/selection";
import {
  claimSelectedEditorialItem,
  db,
  getJob,
} from "@/lib/repository";
import {
  approveProductionPlan,
  getProductionPlanRevision,
  getProductionPlanWorkspaceForJob,
  proposeProductionPlan,
  sealProductionPlan,
} from "@/lib/productionPlanStore";
import { productionPlanDigest } from "@/lib/mediaProduction";
import { insertStrategyProposal, decideStrategyProposal } from "@/lib/strategy/repository";
import { strategyDigest } from "@/lib/strategyApproval";
import { runWithTenant } from "@/lib/tenancy";
import { POST } from "@/app/api/internal/content-artifacts/route";
import { withContentArtifactsPostTestDependencies } from "@/app/api/internal/content-artifacts/handler";
import { strategyFixture } from "./fixtures/strategy";

const emulator = process.env.AWS_LOCAL_ENDPOINT;
const workspaceId = `artifact-route-crash-${Date.now()}`;
const brandId = "brand-test";
const operatorScope = {
  workspaceId,
  brandId,
  principal: cognitoPrincipal({
    subjectId: "operator-test",
    workspaceRole: "owner",
    authenticationId: "artifact-route-crash-auth",
  }),
};

const checks = ["grounding", "brief", "brand", "format", "cta", "safety", "clarity"]
  .map((kind) => ({ kind, passed: true, note: "Pass" }));

function request(body: unknown, traceId: string) {
  return new Request("http://localhost/api/internal/content-artifacts", {
    method: "POST",
    headers: {
      authorization: "Bearer artifact-route-crash-token",
      "content-type": "application/json",
      "x-workspace-id": workspaceId,
      "x-brand-id": brandId,
      traceparent: `00-${traceId}-1111111111111111-01`,
    },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!emulator)("content artifact callback HTTP recovery", () => {
  it("reuses the durable callback identity after a post-bind crash without revising approved production again", async () => {
    process.env.INTERNAL_API_TOKEN = "artifact-route-crash-token";
    process.env.AGENT_SERVICE_URL = "http://127.0.0.1:1";

    const prepared = await runWithTenant(operatorScope, async () => {
      const strategy = strategyFixture("artifact-route-crash-strategy");
      const digest = strategyDigest(strategy);
      const proposal = await awsRepository().atomic((tx) => insertStrategyProposal(tx, {
        jobId: "artifact-route-crash-strategy-origin",
        attempt: 1,
        strategy,
        digest,
        evidenceLineage: ["m1"],
        invocationContext: {
          revision: 1,
          sourceIds: ["m1"],
          operatorContextIds: ["context:campaign"],
          performance: [],
          memoryFacts: [],
          audienceIds: ["founders"],
          requestedChannels: ["x"],
          supportedChannels: ["x"],
          horizonWeeks: 4,
          researchRequest: null,
          searchEvidence: [],
        },
        proposedAt: "2026-09-11T08:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      }));
      await awsRepository().atomic((tx) => decideStrategyProposal(tx, proposal.id, {
        decision: "approved",
        payloadDigest: digest,
        expectedActiveRevision: 0,
      }));
      await configurePlanningPolicy({
        timezone: "UTC",
        productionCapacity: { maxItems: 8, maxItemsPerWeek: 4 },
        cadenceConstraints: { minimumHoursBetweenItems: 0, maxItemsPerChannelPerWeek: 4 },
        maxConcurrentItems: 1,
      }, 0);
      const intake = await submitIntakeTurn({
        requestId: randomUUID(),
        conversationId: randomUUID(),
        surface: "dashboard",
        message: "Create a concise original launch post and matching image pack; make no factual claims.",
        advice: {
          action: "create_job",
          disposition: "independent",
          expectedOutcome: "Launch invitation",
          requestedOutputs: ["x_post", "social_image", "content_pack"],
          sourceHandles: [],
        },
      });
      const materialized = await materializeIntake({
        draftId: intake.id,
        expectedDraftRevision: intake.revision,
        requestId: intake.answers.at(-1)!.requestId,
      });
      const claim = await claimNextPlannedItem(materialized.planRef.id);
      if (!claim) throw new Error("planned callback test job was not claimed");
      const job = await getJob(claim.jobId);
      const item = job.editorialPlan?.items[0];
      if (!job.campaignOutputPlan || !job.editorialPlan || !job.editorialPlanDigest || !item) {
        throw new Error("planned callback test authority is incomplete");
      }
      const lineage = {
        editorialPlanId: job.editorialPlan.planId,
        editorialPlanDigest: job.editorialPlanDigest,
        editorialItemId: item.id,
        briefId: item.briefId,
      };
      await claimSelectedEditorialItem(job.id, lineage);
      const claimedJob = await getJob(job.id);
      const plan = planRequestedMediaProduction({
        job: claimedJob,
        outputPlan: job.campaignOutputPlan,
        pricing: {
          version: "callback-route-test-v1",
          canvasPerImage: "0.010000",
          reelPerSecond: "0.010000",
          musicPerSecond: "0.010000",
        },
      });
      if (!plan) throw new Error("callback test media plan was not created");
      await proposeProductionPlan(plan, "2026-09-11T08:01:00.000Z");
      await sealProductionPlan(plan.id, {
        planDigest: productionPlanDigest(plan),
        sealedAt: "2026-09-11T08:02:00.000Z",
      });
      await approveProductionPlan(plan.id, {
        planDigest: productionPlanDigest(plan),
        approvedAt: "2026-09-11T08:03:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      return { job: claimedJob, lineage, plan };
    });

    const postDraft = {
      id: "copy-artifact",
      outputPlanItemId: prepared.job.campaignOutputPlan!.outputs.find((output) => output.outputType === "x_post")!.id,
      outputType: "x_post" as const,
      title: "Launch invitation",
      sourceSegmentRefs: [],
      payload: { kind: "x_post" as const, text: "Imagine launching with one governed content workflow." },
    };
    const result = {
      original: { artifacts: [postDraft] },
      firstReview: {
        reviews: [{ artifactId: postDraft.id, decision: "accept" as const, checks, issues: [] }],
      },
      revision: null,
      finalReview: null,
      accepted: { artifacts: [postDraft] },
    };
    const body = {
      jobId: prepared.job.id,
      stage: "draft" as const,
      operation: "complete" as const,
      producerModel: "local-contract-test-model",
      ...prepared.lineage,
      result,
    };

    const firstNow = "2026-09-11T09:00:00.000Z";
    const secondNow = "2026-09-11T10:00:00.000Z";
    const firstTrace = "1".repeat(32);
    const secondTrace = "2".repeat(32);
    let ambientNow = firstNow;
    let callbackAttempt = 0;
    const callbackArtifacts: ContentArtifact[][] = [];
    const attemptIdentities: Array<{ createdAt: string; traceId: string }> = [];
    const crashWindow: {
      approved: Awaited<ReturnType<typeof getProductionPlanWorkspaceForJob>>;
    } = { approved: null };

    const post = (req: Request) => withContentArtifactsPostTestDependencies({
      now: () => ambientNow,
      beforeArtifactFinalization: async ({ artifacts, attemptIdentity }) => {
        callbackAttempt += 1;
        callbackArtifacts.push(artifacts);
        attemptIdentities.push(attemptIdentity);
        if (callbackAttempt !== 1) return;
        await runWithTenant(operatorScope, async () => {
          const workspace = await getProductionPlanWorkspaceForJob(prepared.job.id);
          if (!workspace) throw new Error("bound callback plan is missing");
          await approveProductionPlan(workspace.aggregate.id, {
            planDigest: workspace.revision.planDigest,
            approvedAt: "2026-09-11T09:01:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
          crashWindow.approved = await getProductionPlanWorkspaceForJob(prepared.job.id);
        });
        throw new Error("injected crash before artifact callback finalization");
      },
    }, () => POST(req));

    const firstResponse = await post(request(body, firstTrace));
    expect(firstResponse.status).toBe(500);
    await expect(firstResponse.json()).resolves.toEqual({
      error: "injected crash before artifact callback finalization",
    });
    if (!crashWindow.approved) throw new Error("bound callback plan was not approved before the injected crash");
    const approvedAfterCrashWindow = crashWindow.approved;
    expect(approvedAfterCrashWindow.aggregate).toMatchObject({
      currentRevision: 2,
      state: "approved",
    });
    expect(approvedAfterCrashWindow.aggregate.activeMandateId).toBeTruthy();

    const claimedAfterCrash = await runWithTenant(operatorScope, () => getJob(prepared.job.id));
    expect(claimedAfterCrash).toMatchObject({
      stage: "draft",
      artifactProductionCallbackCreatedAt: firstNow,
      artifactProductionCallbackTraceId: firstTrace,
    });
    expect(claimedAfterCrash.artifactProductionResult).toBeUndefined();
    await awsRepository().patch(
      recordKey(`workspaces/${workspaceId}/jobs/${prepared.job.id}`),
      { artifactProductionCallbackClaimedAt: "2000-01-01T00:00:00.000Z" },
    );

    ambientNow = secondNow;
    const secondResponse = await post(request(body, secondTrace));
    expect(secondResponse.status).toBe(200);
    expect(attemptIdentities).toEqual([
      { createdAt: firstNow, traceId: firstTrace },
      { createdAt: secondNow, traceId: secondTrace },
    ]);
    expect(callbackArtifacts).toHaveLength(2);
    expect(callbackArtifacts[1][0]).toMatchObject({
      contentDigest: callbackArtifacts[0][0].contentDigest,
      createdAt: firstNow,
      producer: { traceId: firstTrace },
      review: { traceId: firstTrace },
    });

    const afterRecovery = await runWithTenant(operatorScope, async () => ({
      job: await getJob(prepared.job.id),
      workspace: await getProductionPlanWorkspaceForJob(prepared.job.id),
      revisionThree: await getProductionPlanRevision(prepared.plan.id, 3),
    }));
    expect(afterRecovery.workspace?.aggregate).toMatchObject({
      currentRevision: approvedAfterCrashWindow.aggregate.currentRevision,
      currentPlanDigest: approvedAfterCrashWindow.aggregate.currentPlanDigest,
      activeMandateId: approvedAfterCrashWindow.aggregate.activeMandateId,
      state: "approved",
    });
    expect(afterRecovery.revisionThree).toBeNull();
    expect(afterRecovery.job.contentArtifacts).toEqual(callbackArtifacts[1]);
    expect(afterRecovery.job.artifactProductionResult).toEqual(result);
    expect(afterRecovery.job.artifactProductionCallbackDigest).toBeUndefined();

    const revisions = await awsRepository().query(partition(
      `workspaces/${workspaceId}/jobs/${prepared.job.id}/content_artifacts/${postDraft.id}/revisions`,
    ));
    expect(revisions.rows).toHaveLength(1);
    expect(revisions.rows[0].value?.contentDigest).toBe(callbackArtifacts[0][0].contentDigest);
  }, 60_000);

  afterAll(async () => {
    if (emulator) await db().removeTree(recordKey(`workspaces/${workspaceId}`));
  });
});
