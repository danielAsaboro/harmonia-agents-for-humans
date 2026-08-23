import { afterEach, describe, expect, test, vi } from "vitest";
import { GET, POST } from "../src/app/api/auth/session/route";
import { isDevAuthBypassEnabled } from "../src/lib/auth";

afterEach(() => vi.unstubAllEnvs());

describe("development authentication bypass", () => {
  test("reports and creates a local HttpOnly session when explicitly enabled outside production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("HARMONIA_DEV_AUTH_BYPASS", "1");

    const mode = await GET();
    const response = await POST(new Request("http://localhost/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ devBypass: true }),
    }));

    expect(await mode.json()).toEqual({ devBypassEnabled: true });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("harmonia_session=dev-local");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
  });

  test("refuses the bypass in production even when the flag is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HARMONIA_DEV_AUTH_BYPASS", "1");

    expect(isDevAuthBypassEnabled()).toBe(false);
    const response = await POST(new Request("https://harmonia.example/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ devBypass: true }),
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
