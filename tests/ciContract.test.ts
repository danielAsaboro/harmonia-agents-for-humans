import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("checked-in verification gate", () => {
  const workflow = readFileSync(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");

  it("runs application, agent, emulator, type, lint, and build checks", () => {
    for (const command of [
      "npm test",
      "npm run test:integration",
      "npm run test:agent",
      "npm run lint",
      "npx tsc --noEmit",
      "npm run build",
    ]) expect(workflow).toContain(`run: ${command}`);
  });

  it("verifies the documented Node 22 release baseline", () => {
    expect(workflow).toContain('node-version: "22"');
  });

  it("installs Java and checksum-verified local AWS data services for integration tests", () => {
    expect(workflow).toContain("actions/setup-java@");
    expect(workflow).toContain("python -m venv agent/.venv");
    expect(workflow).toContain("agent/.venv/bin/python -m pip install");
    expect(workflow).toContain("agent/.venv/bin/python -m pip_audit");
    expect(workflow).toContain("scripts/install-local-emulators.sh");
  });
});
