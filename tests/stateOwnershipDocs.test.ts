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
});
