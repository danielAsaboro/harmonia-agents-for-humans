import { beforeEach, describe, expect, it, vi } from "vitest";

const { getOrCreateEditorialPlanningSnapshot } = vi.hoisted(() => ({
  getOrCreateEditorialPlanningSnapshot: vi.fn(),
}));
vi.mock("@/lib/firestore", () => ({ getOrCreateEditorialPlanningSnapshot }));

import { GET } from "@/app/api/internal/editorial-planning-snapshot/route";
import { currentTenant } from "@/lib/tenancy";

describe("editorial planning snapshot internal route", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_TOKEN = "test-internal-token";
    process.env.AGENT_SERVICE_URL = "http://127.0.0.1:8080";
    getOrCreateEditorialPlanningSnapshot.mockReset();
    getOrCreateEditorialPlanningSnapshot.mockImplementation(async () => ({
      tenant: currentTenant(),
      snapshot: { snapshotId: "planning-job-1-v1" },
      digest: "a".repeat(64),
    }));
  });

  it("establishes the authenticated workspace and brand tenant context", async () => {
    const response = await GET(new Request(
      "http://localhost/api/internal/editorial-planning-snapshot?jobId=job-1",
      { headers: {
        authorization: "Bearer test-internal-token",
        "x-workspace-id": "workspace-1",
        "x-brand-id": "brand-1",
      } },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      tenant: { workspaceId: "workspace-1", brandId: "brand-1" },
    });
  });
});
