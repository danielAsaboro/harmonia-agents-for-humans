import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import MonitoringPage from "../src/app/dashboard/monitoring/page";

describe("monitoring navigation", () => {
  it("exposes autonomy as a monitoring tab", () => {
    const html = renderToStaticMarkup(createElement(MonitoringPage));

    expect(html).toContain(">Autonomy</button>");
  });

  it("exposes proposals as a monitoring tab", () => {
    const html = renderToStaticMarkup(createElement(MonitoringPage));

    expect(html).toContain(">Proposals</button>");
  });

  it("removes the obsolete standalone routes and links notifications to monitoring", () => {
    expect(existsSync("src/app/dashboard/proposals/page.tsx")).toBe(false);
    expect(existsSync("src/app/dashboard/autonomy/page.tsx")).toBe(false);

    const proposalRoute = readFileSync("src/app/api/internal/proposals/route.ts", "utf8");
    expect(proposalRoute).toContain('href: "/dashboard/monitoring?tab=proposals"');
    expect(proposalRoute).not.toContain('href: "/dashboard/proposals"');
  });
});
