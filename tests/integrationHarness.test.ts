import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("required DynamoDB integration harness", () => {
  it("exposes a checked-in required integration command", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(pkg.scripts["test:integration"]).toBe("bash scripts/test-dynamo-integration.sh");
  });

  it("starts and owns a DynamoDB emulator before running integration tests", () => {
    const script = readFileSync(new URL("../scripts/test-dynamo-integration.sh", import.meta.url), "utf8");
    expect(script).toContain("DYNAMODB_LOCAL_JAR");
    expect(script).toContain("AWS_LOCAL_ENDPOINT");
    expect(script).toContain("vitest run tests/*Dynamo.integration.test.ts");
    expect(script).toContain("durableRuntimeObservability.integration.test.ts");
  });
});
