import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  appendEvent: vi.fn(), getJob: vi.fn(), saveLearnings: vi.fn(), listCommandsForJob: vi.fn(),
}));

vi.mock("@/lib/repository", () => ({
  appendEvent: store.appendEvent,
  getJob: store.getJob,
  saveLearnings: store.saveLearnings,
}));
vi.mock("@/lib/effectCommandStore", () => ({ listCommandsForJob: store.listCommandsForJob }));

import { POST } from "@/app/api/internal/engagement/route";

const checkedAt = "2026-09-09T10:15:00.000Z";
const base = {
  jobId: "job-1", stage: "learn", learnings: { summary: "Measured verified engagement.", notes: [] },
  engagement: [{ actionId: "action-1", postId: "post-1", checkedAt, likes: 12, replies: 4, reposts: 3, quotes: 1 }],
};

function request(body: unknown) {
  return new Request("http://localhost/api/internal/engagement", {
    method: "POST",
    headers: {
      authorization: "Bearer test-internal-token", "content-type": "application/json",
      "x-workspace-id": "workspace-1", "x-brand-id": "brand-1",
    },
    body: JSON.stringify(body),
  });
}

function job(target = "x:post-1") {
  return {
    stage: "learn",
    actions: [{ id: "action-1", type: "publish_x_post", state: "executed" }],
    verifications: [{ actionId: "action-1", target, verified: true, method: "official_api_readback", checkedAt: "2026-09-09T10:14:00.000Z" }],
  };
}

describe("internal engagement route", () => {
  beforeEach(() => {
    process.env.INTERNAL_API_TOKEN = "test-internal-token";
    process.env.AGENT_SERVICE_URL = "http://127.0.0.1:8080";
    vi.clearAllMocks();
    store.getJob.mockResolvedValue(job());
    store.listCommandsForJob.mockResolvedValue([]);
  });

  it("persists the producer's measurement timestamp unchanged", async () => {
    const response = await POST(request(base));

    expect(response.status).toBe(200);
    expect(store.saveLearnings).toHaveBeenCalledWith(
      "job-1", [expect.objectContaining({ checkedAt })], expect.any(Object), expect.any(String),
    );
  });

  it("rejects a measurement whose post id is not the verified action target", async () => {
    store.getJob.mockResolvedValue(job("x:post-1"));
    const body = structuredClone(base);
    body.engagement[0].postId = "post-other";

    const response = await POST(request(body));

    expect(response.status).toBe(409);
    expect(store.saveLearnings).not.toHaveBeenCalled();
  });
});
