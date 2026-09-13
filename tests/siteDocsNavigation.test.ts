import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type NavGroup = { group: string; root?: string; directory?: string; pages: string[] };
type NavTab = { tab: string; pages?: string[]; groups?: NavGroup[] };

const root = process.cwd();
const config = JSON.parse(readFileSync(join(root, "docs/docs.json"), "utf8")) as {
  navigation: { tabs: NavTab[] };
};

describe("site-wide documentation navigation", () => {
  it("separates the site into seven reader-goal tabs without missing or duplicate pages", () => {
    expect(config.navigation.tabs.map((tab) => tab.tab)).toEqual([
      "Product",
      "Guides",
      "Agents",
      "Platform",
      "Operations",
      "Optimisation",
      "Reference",
    ]);

    const pages = config.navigation.tabs.flatMap((tab) =>
      tab.pages ?? tab.groups?.flatMap((group) => [group.root, ...group.pages].filter(Boolean) as string[]) ?? [],
    );
    expect(new Set(pages).size).toBe(pages.length);
    expect(pages.some((page) => page.startsWith("superpowers/"))).toBe(false);
    expect(pages).toEqual(expect.arrayContaining([
      "product/overview", "guides/overview", "agents/overview", "platform/overview",
      "operations/overview", "optimization/context-memory-continuity",
      "reference/overview", "evaluation", "glossary",
      "reference/api-routes", "reference/job-state-machine", "reference/agent-contracts",
      "reference/effect-contracts", "reference/error-taxonomy", "reference/dynamodb-data",
      "reference/authority-matrix", "reference/environment", "reference/upload-media",
      "reference/pricing-budget", "reference/receipts-verification",
      "operations/release", "operations/backup-restore", "operations/secret-rotation",
      "operations/incidents", "operations/local-load",
    ]));
    for (const page of pages) {
      expect(existsSync(join(root, "docs", `${page}.mdx`)), `missing page ${page}`).toBe(true);
    }
    const rootedGroups = config.navigation.tabs.flatMap((tab) => tab.groups ?? []).filter((group) => group.root);
    expect(rootedGroups.every((group) => group.directory === "card")).toBe(true);
  });

  it("keeps current operating guidance aligned with the AWS edition", () => {
    const current = [
      "README.md",
      "docs/deployment.mdx",
      "docs/failure-recovery.mdx",
      "docs/observability.mdx",
      "docs/operations/overview.mdx",
      "docs/operations/release.mdx",
      "docs/platform/security/secret-manager.mdx",
      "docs/reference/overview.mdx",
    ].map((path) => readFileSync(join(root, path), "utf8")).join("\n");
    expect(current).not.toContain("pubsubMessageId");
    expect(current).not.toContain("Google client handles");
    expect(current).not.toContain("/reference/firestore-data");
    expect(current).toContain("retentionEpochSeconds");
    expect(current).toContain("scan-release-images.sh");
  });
});
