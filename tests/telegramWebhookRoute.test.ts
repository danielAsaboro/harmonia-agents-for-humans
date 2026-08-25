import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Telegram webhook route contract", () => {
  it("uses the verified webhook protocol and never an internal service wrapper", () => {
    const source = readFileSync(resolve(process.cwd(), "src/app/api/telegram/webhook/[routeToken]/route.ts"), "utf8");
    expect(source).toContain("verifyTelegramWebhook");
    expect(source).toContain("principal: verified.principal");
    expect(source).not.toContain("internalTenantHandler");
    expect(source).not.toContain("tenantHandler(");
  });
});
