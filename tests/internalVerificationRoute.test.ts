import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  records: new Map<string, Record<string, unknown>>(),
  getJob: vi.fn(), appendEvent: vi.fn(), listReceipts: vi.fn(), savePacket: vi.fn(),
  transitionStageWithOutbox: vi.fn(), patches: [] as Array<{ path: string; value: Record<string, unknown> }>,
}));

vi.mock("@/lib/dynamo", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/dynamo")>();
  return {
    ...original,
    awsRepository: () => ({
      atomic: async (work: (tx: { read: (key: { id: string; path: string }) => Promise<unknown>; patch: (key: { path: string }, value: Record<string, unknown>) => void }) => Promise<unknown>) => work({
        read: async (key) => ({
          id: key.id, key, present: state.records.has(key.path),
          value: state.records.get(key.path), revision: 1,
        }),
        patch: (key, value) => { state.patches.push({ path: key.path, value }); },
      }),
    }),
  };
});

vi.mock("@/lib/repository", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/repository")>();
  return {
    ...original,
    getJob: state.getJob,
    appendEvent: state.appendEvent,
    listReceipts: state.listReceipts,
    savePacket: state.savePacket,
    transitionStageWithOutbox: state.transitionStageWithOutbox,
  };
});
vi.mock("@/lib/stageOutboxDispatcher", () => ({ dispatchStageOutboxRecord: vi.fn() }));
vi.mock("@/lib/idempotency", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/idempotency")>()), newId: () => "verification-1",
}));

import { POST } from "@/app/api/internal/verification/route";

const jobId = "job-1";
const actionId = "action-1";
const receiptId = "receipt-1";
const checkedAt = "2026-09-09T10:15:00.000Z";
const digest = "a".repeat(64);

function request(target: string, method: "official_api_readback" | "artifact_digest_reread" = "official_api_readback") {
  return new Request("http://localhost/api/internal/verification", {
    method: "POST",
    headers: {
      authorization: "Bearer test-internal-token", "content-type": "application/json",
      "x-workspace-id": "workspace-1", "x-brand-id": "brand-1",
    },
    body: JSON.stringify({
      jobId,
      results: [{
        target, actionId, receiptId, operationId: "job-1:verify:action-1", traceId: "b".repeat(32),
        verified: true, method,
        evidence: { kind: "x_api", url: "https://api.x.com/2/tweets/post-real", fetchedAt: checkedAt, digest },
      }],
    }),
  });
}

describe("internal verification route", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_TOKEN = "test-internal-token";
    process.env.AGENT_SERVICE_URL = "http://127.0.0.1:8080";
    state.records.clear();
    state.patches.length = 0;
    vi.clearAllMocks();
    state.getJob.mockResolvedValue({ stage: "verify", config: { platforms: [] }, contentArtifacts: [], actions: [] });
    state.listReceipts.mockResolvedValue([]);
    state.transitionStageWithOutbox.mockResolvedValue("outbox-1");
    state.records.set("workspaces/workspace-1/jobs/job-1", {
      workspaceId: "workspace-1", brandId: "brand-1", createdByUserId: "user-1",
      createdAt: checkedAt, updatedAt: checkedAt, status: "running", stage: "verify", config: { platforms: [] },
      actions: [{ id: actionId, jobId, type: "publish_x_post", state: "executed" }],
    });
    state.records.set("workspaces/workspace-1/jobs/job-1/receipts/receipt-1", {
      id: receiptId, jobId, actionId, actionType: "publish_x_post", idempotencyKey: "c".repeat(64),
      performedAt: "2026-09-09T10:14:00.000Z", outcome: "applied", artifact: { kind: "x_api", url: "https://api.x.com/2/tweets/post-real", fetchedAt: checkedAt, digest },
      detail: { id: "post-real" }, operationId: "job-1:publish:action-1", traceId: "d".repeat(32),
    });
  });

  it("rejects a forged X target before it can persist a verification", async () => {
    const response = await POST(request("x:invented-post"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "X verification target does not match applied receipt post id" });
    expect(state.patches).toEqual([]);
  });

  it("keeps the existing artifact verification target handling for non-X actions", async () => {
    state.records.set("workspaces/workspace-1/jobs/job-1", {
      workspaceId: "workspace-1", brandId: "brand-1", createdByUserId: "user-1",
      createdAt: checkedAt, updatedAt: checkedAt, status: "running", stage: "verify", config: { platforms: [] },
      actions: [{ id: actionId, jobId, type: "export_content_artifact", state: "executed" }],
    });
    state.records.set("workspaces/workspace-1/jobs/job-1/receipts/receipt-1", {
      id: receiptId, jobId, actionId, actionType: "export_content_artifact", idempotencyKey: "c".repeat(64),
      performedAt: "2026-09-09T10:14:00.000Z", outcome: "applied", artifact: { kind: "asset_store", url: "s3://pack", fetchedAt: checkedAt, digest },
      detail: {}, operationId: "job-1:export:action-1", traceId: "d".repeat(32),
    });

    const response = await POST(request("asset:content-pack-1", "artifact_digest_reread"));

    expect(response.status).toBe(200);
    expect(state.patches).toHaveLength(1);
    expect(state.patches[0].value.verifications).toEqual([
      expect.objectContaining({ target: "asset:content-pack-1", method: "artifact_digest_reread" }),
    ]);
  });
});
