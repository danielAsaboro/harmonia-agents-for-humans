import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import PrivacyPage from "@/app/privacy/page";

describe("public legal pages", () => {
  it("renders an actionable privacy policy for OAuth users", () => {
    const html = renderToStaticMarkup(createElement(PrivacyPage));

    expect(html).toContain("Privacy Policy");
    expect(html).toContain("Google");
    expect(html).toContain("LinkedIn");
    expect(html).toContain("Instagram");
    expect(html).toContain("YouTube");
    expect(html).toContain("disconnect");
    expect(html).toContain("delete");
    expect(html).toContain('href="/"');
  });
});
