import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("state ownership documentation", () => {
  const document = readFileSync(join(process.cwd(), "docs/state-ownership.mdx"), "utf8");
  it.each([
    "Invocation state", "Managed ADK session", "Firestore job", "Approval decisions",
    "Receipts and verification", "Chat history", "Memory Bank", "Secrets", "Private evidence",
    "Source of truth", "Retention",
  ])("documents %s", (required) => expect(document).toContain(required));

  it("assigns editorial-plan persistence and lifecycle authority to Firestore and deterministic code", () => {
    expect(document).toMatch(/complete Temi editorial plan/i);
    expect(document).toMatch(/canonical digest/i);
    expect(document).toMatch(/selected item lifecycle/i);
    expect(document).toMatch(/Memory Bank[\s\S]*never.*authoriz/i);
  });
});
