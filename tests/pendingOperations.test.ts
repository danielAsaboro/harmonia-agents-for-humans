import { describe, expect, test } from "vitest";
import { decideOperationRecord, type PendingOperation } from "../src/lib/pendingOperations";

const pending: PendingOperation = {
  id: "op-1",
  workspaceId: "ws-1",
  brandId: "brand-1",
  createdByUserId: "user-1",
  handler: "publish_preview",
  title: "Create preview",
  risk: "material",
  arguments: { jobId: "job-1", actionId: "action-1", payloadDigest: "a".repeat(64) },
  state: "pending",
  createdAt: "2026-08-23T00:00:00.000Z",
  expiresAt: "2026-08-23T01:00:00.000Z",
};

describe("pending operation decisions", () => {
  test("records one approved decision without changing server arguments", () => {
    const decided = decideOperationRecord(pending, "approved", new Date("2026-08-23T00:30:00.000Z"), "operator-1");
    expect(decided).toMatchObject({ state: "approved", decidedByUserId: "operator-1", arguments: { jobId: "job-1", actionId: "action-1", payloadDigest: "a".repeat(64) } });
  });

  test("rejects replay and expiry", () => {
    expect(() => decideOperationRecord({ ...pending, state: "approved" }, "rejected", new Date("2026-08-23T00:30:00.000Z"), "operator-1")).toThrow("already decided");
    expect(() => decideOperationRecord(pending, "approved", new Date("2026-08-23T02:00:00.000Z"), "operator-1")).toThrow("expired");
  });

  test("rejects approval operations that are not bound to an action payload", () => {
    expect(() => decideOperationRecord(
      { ...pending, arguments: { jobId: "job-1" } },
      "approved",
      new Date("2026-08-23T00:30:00.000Z"),
      "operator-1",
    )).toThrow("payload-bound");
  });
});
