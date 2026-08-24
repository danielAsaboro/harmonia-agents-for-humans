import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("GEAR architecture documentation contracts", () => {
  it("describes claim-before-effect rather than receipt lookup as the concurrency boundary", () => {
    const architecture = readFileSync("docs/architecture.mdx", "utf8");
    expect(architecture).toContain("atomically claims");
    expect(architecture).toContain("expired unresolved claim");
    expect(architecture).not.toContain("Before executing, the publish stage checks existing receipts");
  });

  it("reserves durable replay observations for explicit operator proof", () => {
    const design = readFileSync("docs/superpowers/specs/2026-08-25-effect-claim-recovery-design.md", "utf8");
    expect(design).toContain("operator replay-proof route");
    expect(design).not.toContain("An `already_applied` claim response writes a durable replay observation");
  });
});
