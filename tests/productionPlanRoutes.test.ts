import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  approveProductionPlan: vi.fn(),
  claimPaidProductionOperation: vi.fn(),
  getProductionPlan: vi.fn(),
  getProductionPlanRevision: vi.fn(),
  proposeProductionPlan: vi.fn(),
  rejectProductionPlan: vi.fn(),
  sealProductionPlan: vi.fn(),
}));
vi.mock("@/lib/productionPlanStore", () => store);
vi.mock("@/lib/auth", () => ({
  administratorTenantHandler: (handler: unknown) => handler,
  operatorTenantHandler: (handler: unknown) => handler,
}));

import { POST as propose } from "@/app/api/production-plans/route";
import { POST as revise } from "@/app/api/production-plans/[id]/revisions/route";
import { POST as seal } from "@/app/api/production-plans/[id]/seal/route";
import { POST as decide } from "@/app/api/production-plans/[id]/decision/route";
import { POST as claimInternal } from "@/app/api/internal/production-plans/[id]/operations/[operationId]/claim/route";

const plan = {
  id: "plan-1", jobId: "job-1", workspaceId: "workspace-1", brandId: "brand-1", revision: 1,
  goal: "Launch reel", audience: "founders", tone: ["clear"],
  target: { platform: "linkedin", durationSec: 30, aspectRatio: "9:16", resolution: "1080p", frameRate: 30, format: "mp4" },
  scenes: [{ id: "scene-1", order: 1, startSec: 0, durationSec: 4, purpose: "Open", sourceArtifactIds: [], overlays: [], captions: [], transitions: [] }],
  constraints: { allowLikeness: false, allowGeneratedVocals: false, requireLicensedSources: true },
  pricingVersion: "2026-08-31", operationCostsUsd: {}, estimatedCostUsd: "0.000000", maximumCostUsd: "0.000000",
};

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("production plan routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.INTERNAL_API_TOKEN = "test-internal-token";
    process.env.AGENT_SERVICE_URL = "http://127.0.0.1:8080";
    store.proposeProductionPlan.mockResolvedValue({ id: "plan-1", state: "proposed" });
    store.sealProductionPlan.mockResolvedValue({ id: "plan-1", state: "sealed" });
    store.approveProductionPlan.mockResolvedValue({ id: "plan-1:mandate:v1" });
    store.rejectProductionPlan.mockResolvedValue({ id: "plan-1", state: "rejected" });
    store.claimPaidProductionOperation.mockResolvedValue({ outcome: "execute", claim: { id: "claim-1" } });
  });

  it("exposes distinct propose and revise mutations bound to the path plan id", async () => {
    expect((await propose(jsonRequest("http://localhost/api/production-plans", { plan }))).status).toBe(201);
    expect(store.proposeProductionPlan).toHaveBeenNthCalledWith(1, plan);

    const revision = { ...plan, revision: 2 };
    const response = await revise(jsonRequest("http://localhost/api/production-plans/plan-1/revisions", { plan: revision }), {
      params: Promise.resolve({ id: "plan-1" }),
    });
    expect(response.status).toBe(201);
    expect(store.proposeProductionPlan).toHaveBeenNthCalledWith(2, revision);

    const substituted = await revise(jsonRequest("http://localhost/api/production-plans/plan-1/revisions", { plan: { ...revision, id: "plan-2" } }), {
      params: Promise.resolve({ id: "plan-1" }),
    });
    expect(substituted.status).toBe(409);
  });

  it("seals and decides only the submitted plan digest", async () => {
    const digest = "a".repeat(64);
    const sealed = await seal(jsonRequest("http://localhost/api/production-plans/plan-1/seal", { planDigest: digest }), {
      params: Promise.resolve({ id: "plan-1" }),
    });
    expect(sealed.status).toBe(200);
    expect(store.sealProductionPlan).toHaveBeenCalledWith("plan-1", { planDigest: digest });

    const approved = await decide(jsonRequest("http://localhost/api/production-plans/plan-1/decision", {
      decision: "approved", planDigest: digest, expiresAt: "2026-08-31T12:00:00.000Z",
    }), { params: Promise.resolve({ id: "plan-1" }) });
    expect(approved.status).toBe(200);
    expect(store.approveProductionPlan).toHaveBeenCalledWith("plan-1", {
      planDigest: digest, expiresAt: "2026-08-31T12:00:00.000Z",
    });

    const rejected = await decide(jsonRequest("http://localhost/api/production-plans/plan-1/decision", {
      decision: "rejected", planDigest: digest, feedback: "Use the source footage instead",
    }), { params: Promise.resolve({ id: "plan-1" }) });
    expect(rejected.status).toBe(200);
    expect(store.rejectProductionPlan).toHaveBeenCalledWith("plan-1", {
      planDigest: digest, feedback: "Use the source footage instead",
    });
  });

  it("requires service authentication before resolving a paid-operation mandate", async () => {
    const url = "http://localhost/api/internal/production-plans/plan-1/operations/operation-1/claim";
    const claim = { claimToken: "worker-claim-1" };
    const unauthorized = await claimInternal(jsonRequest(url, claim), {
      params: Promise.resolve({ id: "plan-1", operationId: "operation-1" }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await claimInternal(jsonRequest(url, claim, {
      authorization: "Bearer test-internal-token",
      "x-workspace-id": "workspace-1",
      "x-brand-id": "brand-1",
    }), { params: Promise.resolve({ id: "plan-1", operationId: "operation-1" }) });
    expect(authorized.status).toBe(200);
    expect(store.claimPaidProductionOperation).toHaveBeenCalledWith("plan-1", "operation-1", claim);
  });
});
