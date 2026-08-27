import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

let pathname = "/dashboard";

vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));

import DashboardFrame from "../src/components/DashboardFrame";
import NavRail, * as navRailModule from "../src/components/NavRail";

function openingTag(html: string, ariaLabel: string): string {
  return html.match(new RegExp(`<a[^>]*aria-label="${ariaLabel}"[^>]*>`))?.[0] ?? "";
}

describe("dashboard navigation rail", () => {
  beforeEach(() => {
    pathname = "/dashboard";
  });

  it("orders the workflow destinations between the logo and logout dividers", () => {
    const html = renderToStaticMarkup(createElement(NavRail));
    const labels = [
      "Harmonia home",
      "Console",
      "Calendar",
      "Proposals",
      "Monitoring",
      "Notifications",
      "Autonomy",
      "Architecture",
      "Settings",
      "Sign out",
    ];

    for (let index = 1; index < labels.length; index += 1) {
      expect(html.indexOf(`aria-label="${labels[index - 1]}`)).toBeLessThan(
        html.indexOf(`aria-label="${labels[index]}`),
      );
    }
    expect(html.match(/role="separator"/g)).toHaveLength(2);
  });

  it("marks only the exact dashboard destination as current", () => {
    pathname = "/dashboard/calendar";
    const html = renderToStaticMarkup(createElement(NavRail));

    expect(openingTag(html, "Console")).not.toContain('aria-current="page"');
    expect(openingTag(html, "Calendar")).toContain('aria-current="page"');
  });

  it("starts collapsed behind an accessible desktop edge trigger", () => {
    const html = renderToStaticMarkup(createElement(NavRail));

    expect(html).toContain('aria-label="Open navigation"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-hidden="true"');
  });

  it("tracks pointer and keyboard presence independently", () => {
    const reducePresence = (navRailModule as unknown as {
      reduceRailPresence?: (
        state: { pointerInside: boolean; focusInside: boolean },
        event: "pointer-enter" | "pointer-leave" | "focus-enter" | "focus-leave",
      ) => { pointerInside: boolean; focusInside: boolean };
    }).reduceRailPresence;

    expect(reducePresence).toBeTypeOf("function");
    if (!reducePresence) return;

    const pointerOpen = reducePresence({ pointerInside: false, focusInside: false }, "pointer-enter");
    const focusAlsoOpen = reducePresence(pointerOpen, "focus-enter");
    const pointerGone = reducePresence(focusAlsoOpen, "pointer-leave");
    expect(pointerGone).toEqual({ pointerInside: false, focusInside: true });
    expect(reducePresence(pointerGone, "focus-leave")).toEqual({ pointerInside: false, focusInside: false });
  });

  it("renders the shared rail on the dashboard root", () => {
    const html = renderToStaticMarkup(createElement(DashboardFrame, null, createElement("div", null, "Studio")));

    expect(html).toContain('aria-label="Open navigation"');
    expect(html).toContain("Studio");
  });
});
