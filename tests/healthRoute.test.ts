import { afterEach, describe, expect, it } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("GET /api/health", () => {
  it("reports web health without requiring an agent runtime", async () => {
    delete process.env.AGENT_SERVICE_URL;
    delete process.env.COGNITO_USER_POOL_ID;
    process.env.AWS_ACCOUNT_ID = "harmonia-preview";
    process.env.AWS_REGION = "us-east-1";

    const { GET } = await import("@/app/api/health/route");
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "harmonia-web",
      project: "harmonia-preview",
      region: "us-east-1",
      durableRuntime: {
        protocolVersion: 1,
        stateStore: "dynamodb",
        wakeTransport: "sqs",
        contextCompiler: "harmonia-context/v1",
      },
    });
  });
});
