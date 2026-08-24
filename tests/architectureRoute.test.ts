import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("architecture route integration", () => {
  it("exposes the explorer through the authenticated dashboard navigation", () => {
    expect(read("src/app/dashboard/architecture/page.tsx")).toContain("ArchitectureExplorer");
    const nav = read("src/components/NavRail.tsx");
    expect(nav).toContain('href: "/dashboard/architecture"');
    expect(nav).toContain("ArchitectureIcon");
  });

  it("uses Harmonia's paper, forest, and acid system without the PNG as graph background", () => {
    const css = read("src/app/dashboard/architecture/architecture.css");
    expect(css).toContain("--arch-paper");
    expect(css).toContain("--arch-forest");
    expect(css).toContain("--arch-acid");
    expect(css).toContain("background:var(--arch-paper)");
    expect(css).toContain("@media (max-width: 639px)");
    expect(css).not.toContain("harmonia-complete-architecture-blueprint.png");
  });

  it("keeps preset overviews readable instead of fitting the entire graph too small", () => {
    expect(read("src/components/architecture/ArchitectureExplorer.tsx")).toContain("minZoom: 0.38");
  });
});
