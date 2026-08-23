import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
  ActivityTrace,
  ContextUsage,
  InlineCitation,
  ReasoningSummary,
} from "../src/components/a2ui/HarmoniaElements";

describe("Harmonia A2UI elements", () => {
  test("activity trace renders safe progress without private reasoning", () => {
    const html = renderToStaticMarkup(createElement(ActivityTrace, {
      title: "Agent activity",
      steps: [{ id: "s1", label: "Analyst inspected the video", status: "complete" }],
    }));
    expect(html).toContain("Agent activity");
    expect(html).toContain("Analyst inspected the video");
    expect(html).not.toContain("rawReasoning");
  });

  test("context usage derives bounded utilization", () => {
    const html = renderToStaticMarkup(createElement(ContextUsage, {
      model: "gemini",
      inputTokens: 750,
      outputTokens: 25,
      contextLimit: 1_000,
    }));
    expect(html).toContain("77.5%");
    expect(html).toContain("775 / 1,000 tokens");
  });

  test("citations open safely without granting opener access", () => {
    const html = renderToStaticMarkup(createElement(InlineCitation, {
      title: "Source",
      url: "https://example.com/source",
      sourceId: "source-1",
    }));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
  });

  test("reasoning is explicitly labeled as a summary", () => {
    const html = renderToStaticMarkup(createElement(ReasoningSummary, {
      summary: "The draft cites the uploaded transcript.",
    }));
    expect(html).toContain("Reasoning summary");
    expect(html).toContain("uploaded transcript");
  });
});
