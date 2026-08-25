import { describe, expect, it } from "vitest";

import {
  createEffectCommand,
  decideTerminalOutcome,
  effectCommandDigest,
  invalidateEffectCommand,
  type EffectCommandInput,
} from "@/lib/effectCommands";

function input(text = "Launch"): EffectCommandInput {
  return {
    id: "command-1",
    workspaceId: "workspace-1",
    brandId: "brand-1",
    sourceKind: "scheduled_content",
    sourceId: "content-1",
    jobId: "job-1",
    actionId: "action-1",
    actionType: "publish_x_post",
    payload: { text },
    authorization: { kind: "approval", approvalId: "approval-1", approvedPayloadDigest: "pending" },
    executeAfter: "2026-08-27T09:00:00.000Z",
    now: "2026-08-26T00:00:00.000Z",
  };
}

describe("immutable effect commands", () => {
  it("binds approval to the exact command payload", () => {
    const draft = input();
    const digest = effectCommandDigest(draft);
    expect(() => createEffectCommand({
      ...draft,
      authorization: { kind: "approval", approvalId: "approval-1", approvedPayloadDigest: "f".repeat(64) },
    })).toThrow("approval payload digest mismatch");
    expect(createEffectCommand({
      ...draft,
      authorization: { kind: "approval", approvalId: "approval-1", approvedPayloadDigest: digest },
    }).payloadDigest).toBe(digest);
  });

  it("binds autonomous execution to a durable mandate and evaluated payload", () => {
    const draft = input("Scheduled launch");
    const digest = effectCommandDigest(draft);
    const command = createEffectCommand({
      ...draft,
      authorization: {
        kind: "mandate",
        mandateId: "mandate-1",
        mandateDigest: "a".repeat(64),
        authorizedPayloadDigest: digest,
      },
    });
    expect(command.authorization.kind).toBe("mandate");
  });

  it("creates a new digest and command identity when scheduled text changes", () => {
    expect(effectCommandDigest(input("one"))).not.toBe(effectCommandDigest(input("two")));
    const original = createEffectCommand({
      ...input("one"),
      authorization: { kind: "approval", approvalId: "approval-1", approvedPayloadDigest: effectCommandDigest(input("one")) },
    });
    expect(invalidateEffectCommand(original, "payload_changed", "2026-08-26T01:00:00.000Z")).toMatchObject({ state: "cancelled", invalidatedReason: "payload_changed" });
  });

  it("distinguishes workflow completion from partial and unresolved effect outcomes", () => {
    expect(decideTerminalOutcome([{ state: "applied" }, { state: "failed" }])).toBe("partial");
    expect(decideTerminalOutcome([{ state: "uncertain" }])).toBe("unresolved");
    expect(decideTerminalOutcome([{ state: "failed" }])).toBe("failed");
    expect(decideTerminalOutcome([{ state: "applied" }])).toBe("succeeded");
  });

  it("omits optional scheduling fields instead of serializing Firestore-invalid undefined", () => {
    const { executeAfter: _executeAfter, ...withoutSchedule } = input();
    const digest = effectCommandDigest(withoutSchedule);
    const command = createEffectCommand({
      ...withoutSchedule,
      authorization: { kind: "approval", approvalId: "approval-1", approvedPayloadDigest: digest },
    });
    expect(Object.hasOwn(command, "executeAfter")).toBe(false);
  });
});
