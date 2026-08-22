import { describe, expect, it } from "vitest";
import { applyPolicy, approvedPendingExecution, evaluateActionPolicy, hasPendingApprovals } from "@/lib/policy";

describe("evaluateActionPolicy", () => {
  it("always gates repository file writes behind approval", () => {
    const d = evaluateActionPolicy("github_upsert_file", { path: "docs/notes.md" });
    expect(d.requiresApproval).toBe(true);
    expect(d.risk).toBe("medium");
  });

  it("marks protected paths high risk", () => {
    for (const path of ["README.md", "LICENSE", ".github/workflows/ci.yml"]) {
      const d = evaluateActionPolicy("github_upsert_file", { path });
      expect(d.risk).toBe("high");
      expect(d.requiresApproval).toBe(true);
    }
  });

  it("rejects traversal paths as unsafe", () => {
    const d = evaluateActionPolicy("github_upsert_file", { path: "../evil" });
    expect(d.risk).toBe("high");
    expect(d.reason).toContain("unsafe");
  });

  it("allows additive issue creation without approval", () => {
    const d = evaluateActionPolicy("github_create_issue", {});
    expect(d.risk).toBe("low");
    expect(d.requiresApproval).toBe(false);
  });
});

describe("applyPolicy", () => {
  it("stamps approval state from the deterministic policy", () => {
    const actions = applyPolicy([
      {
        id: "1",
        jobId: "j",
        type: "github_upsert_file",
        title: "write docs",
        description: "",
        payload: { type: "github_upsert_file", path: "docs/evidence.md", branch: "main", content: "", commitMessage: "m" },
        rubricItemIds: [],
      },
      {
        id: "2",
        jobId: "j",
        type: "github_create_issue",
        title: "track gap",
        description: "",
        payload: { type: "github_create_issue", title: "t", body: "b", labels: [] },
        rubricItemIds: [],
      },
    ]);
    expect(actions[0].approvalState).toBe("pending");
    expect(actions[0].state).toBe("planned");
    expect(actions[1].approvalState).toBe("not_required");
    expect(hasPendingApprovals(actions)).toBe(true);
    expect(approvedPendingExecution(actions)).toEqual([actions[1]]);
  });
});
