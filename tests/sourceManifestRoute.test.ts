import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  advance: vi.fn(),
  setStage: vi.fn(),
}));

vi.mock("@/lib/advance", () => ({ advance: mocks.advance }));
vi.mock("@/lib/firestore", () => ({
  db: vi.fn(),
  getJob: vi.fn(),
  setStage: mocks.setStage,
}));
vi.mock("@/lib/storage", () => ({ getArtifact: vi.fn() }));

import { POST } from "@/app/api/internal/source-manifest/route";

function request(stage: "collect_sources" | "extract_sources") {
  return new Request("http://localhost/api/internal/source-manifest", {
    method: "POST",
    headers: {
      authorization: "Bearer test-internal-token",
      "content-type": "application/json",
      "x-workspace-id": "workspace-1",
      "x-brand-id": "brand-1",
    },
    body: JSON.stringify({ jobId: "job-1", stage, outcome: "all_ready" }),
  });
}

describe("source manifest completion route", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_TOKEN = "test-internal-token";
    process.env.AGENT_SERVICE_URL = "http://127.0.0.1:8080";
    vi.clearAllMocks();
    mocks.advance.mockResolvedValue(undefined);
  });

  it.each(["collect_sources", "extract_sources"] as const)(
    "returns a success response after advancing %s",
    async (stage) => {
      const response = await POST(request(stage));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      expect(mocks.advance).toHaveBeenCalledWith(
        "job-1",
        stage,
        stage === "collect_sources"
          ? "sources validated and queued"
          : "all selected sources extracted",
      );
    },
  );
});
