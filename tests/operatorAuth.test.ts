import { describe, expect, it, vi } from "vitest";

type OperatorAuth = typeof import("@/lib/operatorAuth");

async function loadWithEnv(
  env: Record<string, string | undefined>,
): Promise<OperatorAuth> {
  vi.resetModules();
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await import("@/lib/operatorAuth");
  } finally {
    // restore after assertions run against freshly imported closures
    setTimeout(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }, 0);
  }
}

function req(headers: Record<string, string>): Request {
  return new Request("https://closefold.test/api/jobs", { headers });
}

describe("operator gate", () => {
  it("allows all mutations when no operator token is configured (local dev)", async () => {
    const mod = await loadWithEnv({
      INTERNAL_API_TOKEN: "internal-test-token",
      OPERATOR_TOKEN: undefined,
    });
    expect(mod.isOperatorAuthorized(req({}))).toBe(true);
  });

  it("requires the exact x-operator-token header when configured", async () => {
    const mod = await loadWithEnv({
      INTERNAL_API_TOKEN: "internal-test-token",
      OPERATOR_TOKEN: "s3cret-operator-value",
    });
    expect(mod.isOperatorAuthorized(req({}))).toBe(false);
    expect(mod.isOperatorAuthorized(req({ "x-operator-token": "wrong" }))).toBe(false);
    expect(
      mod.isOperatorAuthorized(req({ "x-operator-token": "s3cret-operator-value" })),
    ).toBe(true);
  });
});
