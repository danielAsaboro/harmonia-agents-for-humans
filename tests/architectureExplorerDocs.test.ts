import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("architecture explorer documentation", () => {
  it("is present in docs navigation", () => expect(JSON.parse(read("docs/docs.json")).navigation.tabs[0].groups[0].pages).toContain("architecture-explorer"));
  it("documents operation, semantics, maintenance, and accessibility", () => {
    const doc = read("docs/architecture-explorer.mdx").toLowerCase();
    for (const term of ["open the explorer", "edge semantics", "authority", "workflow", "state ownership", "human approval", "skills and tools", "model allocation", "route families", "observability", "status vocabulary", "update the dataset", "validation", "keyboard", "narrow screens"]) expect(doc).toContain(term);
    for (const link of ["architecture", "pipeline", "agent-platform", "state-ownership", "approval-and-audit", "tool-contracts", "observability", "models-cost-evaluation"]) expect(doc).toContain(`./${link}`);
  });
});
