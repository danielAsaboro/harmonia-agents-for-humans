import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(root, relative), "utf8");

describe("AI SDK 7 presentation boundary", () => {
  it("pins the exact AI SDK 7 packages and removes the former renderer packages", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(pkg.dependencies.ai).toBe("7.0.97");
    expect(pkg.dependencies["@ai-sdk/react"]).toBe("4.0.100");
    expect(Object.keys(pkg.dependencies).some((name) => name.startsWith("@a2ui/"))).toBe(false);
  });

  it("has no former protocol or renderer references in current product surfaces", () => {
    const paths = ["README.md", "package.json", "src", "agent/harmonia_agent", "agent/tests", "tests", "docs"];
    const violations: string[] = [];
    const visit = (relative: string) => {
      const absolute = path.join(root, relative);
      const stat = fs.statSync(absolute);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(absolute)) {
          if (relative === "docs" && entry === "superpowers") continue;
          if (entry === "architecture-flow.js" || entry === "architecture-flow.css" || entry === "__pycache__") continue;
          visit(path.join(relative, entry));
        }
        return;
      }
      if (relative === "tests/aiSdkUiMigration.test.ts") return;
      if (!/\.(?:md|mdx|json|py|ts|tsx)$/.test(relative)) return;
      if (/a2ui/i.test(relative) || /\bA2UI\b|@a2ui\//i.test(read(relative))) violations.push(relative);
    };
    for (const candidate of paths) visit(candidate);
    expect(violations).toEqual([]);
  });
});
