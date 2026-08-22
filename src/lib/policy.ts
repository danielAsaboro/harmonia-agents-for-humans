import type { ActionType, PlannedAction, RiskLevel } from "./types";

export interface PolicyDecision {
  risk: RiskLevel;
  requiresApproval: boolean;
  reason: string;
}

/**
 * Deterministic action-risk policy. The model may propose actions, but the
 * approval gate is computed here so the model can never self-authorize a
 * risky external effect.
 */
export function evaluateActionPolicy(
  type: ActionType,
  payload: Record<string, unknown>,
): PolicyDecision {
  switch (type) {
    case "github_upsert_file": {
      const targetPath = typeof payload.path === "string" ? payload.path : "";
      if (!targetPath || targetPath.includes("..")) {
        return {
          risk: "high",
          requiresApproval: true,
          reason: "unsafe repository path",
        };
      }
      const protectedPath =
        /^(README\.md|LICENSE|\.github\/workflows\/.*|package-lock\.json)$/i.test(
          targetPath,
        );
      return {
        risk: protectedPath ? "high" : "medium",
        requiresApproval: true,
        reason: protectedPath
          ? `overwrites protected repository file ${targetPath}`
          : `creates or updates repository content at ${targetPath}`,
      };
    }
    case "github_create_issue":
      return {
        risk: "low",
        requiresApproval: false,
        reason: "additive, reversible issue creation scoped to authorized repo",
      };
  }
}

export type ActionSeed = Pick<
  PlannedAction,
  "id" | "jobId" | "type" | "title" | "description" | "payload" | "rubricItemIds"
>;

export function applyPolicy(actions: ActionSeed[]): PlannedAction[] {
  return actions.map((a) => {
    const decision = evaluateActionPolicy(a.type, a.payload);
    return {
      ...a,
      risk: decision.risk,
      requiresApproval: decision.requiresApproval,
      approvalState: decision.requiresApproval ? "pending" : "not_required",
      state: "planned" as const,
    };
  });
}

export function hasPendingApprovals(actions: PlannedAction[]): boolean {
  return actions.some((a) => a.approvalState === "pending");
}

export function approvedPendingExecution(actions: PlannedAction[]): PlannedAction[] {
  return actions.filter(
    (a) =>
      a.state === "planned" &&
      (!a.requiresApproval || a.approvalState === "approved"),
  );
}
