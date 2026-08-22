import { describe, expect, it } from "vitest";
import { assemblePacket } from "@/lib/packet";
import type { Finding, PlannedAction, Receipt, RubricItem, VerificationResult } from "@/lib/types";

const rubric: RubricItem[] = [
  { id: "r1", source: "s", requirement: "README setup", category: "readme-setup", status: "pending", weight: 1 },
  { id: "r2", source: "s", requirement: "License", category: "license", status: "pending", weight: 1 },
];

function finding(id: string, status: Finding["status"]): Finding {
  return { rubricItemId: id, status, rationale: "r", evidence: [] };
}

const action: PlannedAction = {
  id: "a1",
  jobId: "j",
  type: "github_upsert_file",
  title: "add docs",
  description: "",
  risk: "medium",
  requiresApproval: true,
  approvalState: "approved",
  state: "executed",
  payload: {},
};

function verification(id: string, verified: boolean): VerificationResult {
  return {
    rubricItemId: id,
    verified,
    method: "mechanical:test",
    evidence: { kind: "github_api", url: "https://api.github.com/x", fetchedAt: new Date().toISOString() },
    checkedAt: new Date().toISOString(),
  };
}

describe("assemblePacket", () => {
  it("lists unverified items as unresolved gaps", () => {
    const packet = assemblePacket({
      jobId: "j",
      config: { devpostUrl: "https://d", githubRepo: "r", githubOwner: "o" },
      rubric,
      findings: [finding("r1", "satisfied"), finding("r2", "missing")],
      actions: [],
      receipts: [],
      verifications: [verification("r1", true)],
    });
    expect(packet.unresolved).toHaveLength(1);
    expect(packet.unresolved[0]).toContain("License");
    expect(packet.rubric.find((i) => i.id === "r1")?.status).toBe("verified");
  });

  it("surfaces pending approvals and rejected actions as gaps", () => {
    const pendingAction: PlannedAction = { ...action, id: "a2", approvalState: "pending", state: "planned" };
    const rejected: PlannedAction = { ...action, id: "a3", approvalState: "rejected", state: "skipped" };
    const packet = assemblePacket({
      jobId: "j",
      config: { devpostUrl: "https://d", githubRepo: "r", githubOwner: "o" },
      rubric,
      findings: [],
      actions: [pendingAction, rejected],
      receipts: [],
      verifications: [],
    });
    expect(packet.unresolved.some((u) => u.includes("approval still pending"))).toBe(true);
    expect(packet.unresolved.some((u) => u.includes("rejected corrective action"))).toBe(true);
  });

  it("keeps failed verifications unresolved even when a finding claims satisfaction", () => {
    const receipt: Receipt = {
      id: "rc",
      jobId: "j",
      actionId: "a1",
      idempotencyKey: "k".repeat(64),
      actionType: "github_upsert_file",
      performedAt: new Date().toISOString(),
      outcome: "applied",
      detail: {},
    };
    const packet = assemblePacket({
      jobId: "j",
      config: { devpostUrl: "https://d", githubRepo: "r", githubOwner: "o" },
      rubric,
      findings: [finding("r1", "satisfied"), finding("r2", "satisfied")],
      actions: [action],
      receipts: [receipt],
      verifications: [verification("r1", true), verification("r2", false)],
    });
    expect(packet.unresolved.some((u) => u.includes("verification failed"))).toBe(true);
    expect(packet.receipts).toHaveLength(1);
  });
});
