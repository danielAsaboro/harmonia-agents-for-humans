import { describe, expect, it } from "vitest";

import { appendMessageSourceUrls, parseExactAppendSyntax } from "@/lib/planning/commands";

describe("append-v1 full-consumption grammar", () => {
  it("parses the complete positive and dependency/source forms", () => {
    expect(parseExactAppendSyntax('Add an X post called "Launch follow-up" to campaign "Launch" at 2026-09-14T12:00:00Z.')).toMatchObject({
      targetName: "Launch", deliverableName: "Launch follow-up", scheduledFor: "2026-09-14T12:00:00Z",
      dependencyItemIds: [], sourceUrls: [], requestedOutputs: ["x_post"], channel: "x",
    });
    expect(parseExactAppendSyntax('Add an X post called "Launch follow-up" to campaign "Launch" at 2026-09-14T12:00:00Z, only after item-first is completed, using https://example.com/approved-source.')).toMatchObject({
      dependencyItemIds: ["item-first"], sourceUrls: ["https://example.com/approved-source"],
    });
  });

  it.each([
    "only when item-first succeeds.",
    "do not begin until item-first is completed.",
  ])("rejects an unconsumed clause: %s", clause => {
    expect(parseExactAppendSyntax(`Add an X post called "Launch follow-up" to campaign "Launch" at 2026-09-14T12:00:00Z, ${clause}`)).toBeNull();
  });

  it("retains raw source URLs even when surrounding syntax is not in the grammar", () => {
    const message = 'Add an X post called "Launch follow-up" to campaign "Launch" at 2026-09-14T12:00:00Z using https://example.com/source.';
    expect(parseExactAppendSyntax(message)).toBeNull();
    expect(appendMessageSourceUrls(message)).toEqual(["https://example.com/source"]);
  });
});
