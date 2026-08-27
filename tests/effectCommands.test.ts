import { describe, expect, it } from "vitest";

import {
  createEffectCommand,
  decideTerminalOutcome,
  effectCommandDigest,
  invalidateEffectCommand,
  markEffectDispatched,
  markEffectObserved,
  markEffectUnknown,
  restoreEffectPrepared,
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
    expect(decideTerminalOutcome([{ state: "unknown" }])).toBe("unresolved");
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

  it("records intent before effect and the provider observation before finalization", () => {
    const draft = input();
    const prepared = createEffectCommand({
      ...draft,
      authorization: { kind: "approval", approvalId: "approval-1", approvedPayloadDigest: effectCommandDigest(draft) },
    });
    expect(prepared.state).toBe("prepared");
    const dispatched = markEffectDispatched(prepared, {
      operationId: "job:job-1:effect:command-1", operationEpoch: 1, attempt: 1,
      now: "2026-08-27T09:00:00.000Z",
    });
    expect(dispatched).toMatchObject({
      state: "dispatched", operationId: "job:job-1:effect:command-1",
      operationEpoch: 1, dispatchAttempt: 1, dispatchedAt: "2026-08-27T09:00:00.000Z",
    });
    const observed = markEffectObserved(dispatched, {
      operationId: dispatched.operationId!, operationEpoch: 1,
      outcome: "applied", detail: { id: "post-1" },
      now: "2026-08-27T09:00:01.000Z",
    });
    expect(observed).toMatchObject({ state: "observed", observedOutcome: "applied" });
    expect(observed.observationDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("fails closed after dispatch and permits reset only with not-started proof", () => {
    const draft = input();
    const prepared = createEffectCommand({
      ...draft,
      authorization: { kind: "approval", approvalId: "approval-1", approvedPayloadDigest: effectCommandDigest(draft) },
    });
    const dispatched = markEffectDispatched(prepared, {
      operationId: "job:job-1:effect:command-1", operationEpoch: 1, attempt: 1,
      now: "2026-08-27T09:00:00.000Z",
    });
    expect(markEffectUnknown(dispatched, {
      operationId: dispatched.operationId!, operationEpoch: 1,
      reason: "TimeoutError after provider entry", now: "2026-08-27T09:00:02.000Z",
    })).toMatchObject({ state: "unknown", unknownReason: "TimeoutError after provider entry" });
    expect(() => restoreEffectPrepared(dispatched, {
      operationId: dispatched.operationId!, operationEpoch: 1,
      proof: "ordinary_error" as "provider_not_started", now: "2026-08-27T09:00:02.000Z",
    })).toThrow("provider_not_started");
    expect(restoreEffectPrepared(dispatched, {
      operationId: dispatched.operationId!, operationEpoch: 1,
      proof: "provider_not_started", now: "2026-08-27T09:00:02.000Z",
    })).toMatchObject({ state: "prepared" });
  });
});
