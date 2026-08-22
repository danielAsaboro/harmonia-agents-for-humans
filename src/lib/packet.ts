import type {
  EvidencePacket,
  Finding,
  PlannedAction,
  Receipt,
  RubricItem,
  VerificationResult,
} from "./types";

export interface PacketInputs {
  jobId: string;
  config: EvidencePacket["config"];
  rubric: RubricItem[];
  findings: Finding[];
  actions: PlannedAction[];
  receipts: Receipt[];
  verifications: VerificationResult[];
}

/**
 * Assembles the final evidence packet. An item is "verified" only when a
 * verification result with verified=true exists for it; everything else is
 * listed as an unresolved gap. Model assertions never satisfy this rule.
 */
export function assemblePacket(inputs: PacketInputs): EvidencePacket {
  const verificationByItem = new Map<string, VerificationResult>();
  for (const v of inputs.verifications) {
    if (!verificationByItem.has(v.rubricItemId) || v.verified) {
      verificationByItem.set(v.rubricItemId, v);
    }
  }

  const unresolved: string[] = [];
  for (const item of inputs.rubric) {
    const v = verificationByItem.get(item.id);
    if (!v || !v.verified) {
      const f = inputs.findings.find((x) => x.rubricItemId === item.id);
      unresolved.push(
        `${item.requirement} (${f?.status ?? "no finding"}; ${v ? `verification failed via ${v.method}` : "never verified"})`,
      );
    } else if (item.status !== "verified") {
      item.status = "verified";
    }
  }

  for (const action of inputs.actions) {
    if (action.approvalState === "pending") {
      unresolved.push(`approval still pending: ${action.title}`);
    }
    if (action.approvalState === "rejected" && action.state === "skipped") {
      unresolved.push(`operator rejected corrective action: ${action.title}`);
    }
  }

  return {
    jobId: inputs.jobId,
    generatedAt: new Date().toISOString(),
    config: inputs.config,
    rubric: inputs.rubric,
    findings: inputs.findings,
    receipts: inputs.receipts,
    verifications: inputs.verifications,
    unresolved,
  };
}
