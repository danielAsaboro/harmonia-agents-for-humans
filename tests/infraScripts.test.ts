import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(new URL("../infra/deploy.sh", import.meta.url), "utf8");
const setup = readFileSync(new URL("../infra/setup.sh", import.meta.url), "utf8");

describe("cloud infrastructure scripts", () => {
  it("updates an existing push subscription instead of silently keeping stale settings", () => {
    expect(deploy).toContain("subscriptions describe harmonia-stages-agent-push");
    expect(deploy).toContain("subscriptions update harmonia-stages-agent-push");
    expect(deploy).not.toContain('2>/dev/null || echo "subscription exists"');
  });

  it("uses a dedicated push identity instead of the web runtime identity", () => {
    expect(setup).toContain("harmonia-pubsub-push");
    expect(deploy).toContain("harmonia-pubsub-push@${PROJECT_ID}.iam.gserviceaccount.com");
  });

  it("grants the Pub/Sub service agent DLQ publisher and source subscriber roles", () => {
    const serviceAgent = 'service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com';
    expect(deploy).toContain(serviceAgent);
    expect(deploy).toMatch(/topics add-iam-policy-binding harmonia-stages-dlq[\s\S]*roles\/pubsub\.publisher/);
    expect(deploy).toMatch(/subscriptions add-iam-policy-binding harmonia-stages-agent-push[\s\S]*service-\$\{PROJECT_NUMBER\}[\s\S]*roles\/pubsub\.subscriber/);
  });

  it("does not grant the worker direct object-admin access it does not use", () => {
    expect(setup).not.toMatch(/for sa in harmonia-web harmonia-agent; do[\s\S]{0,180}roles\/storage\.objectAdmin/);
    expect(setup).toMatch(/harmonia-web@\$\{PROJECT_ID\}[\s\S]{0,180}roles\/storage\.objectAdmin/);
  });
});
