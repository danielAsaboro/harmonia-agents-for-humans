import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";

import { firebasePrincipal, servicePrincipal } from "@/lib/authority";
import {
  claimEffect,
  db,
  finalizeEffectReceipt,
  getEffectClaim,
  getJob,
  listApprovalDecisions,
  listReceipts,
  listReplayObservations,
  saveContentPack,
  saveVerifications,
} from "@/lib/firestore";
import { actionPayloadDigest } from "@/lib/idempotency";
import { requestReplayProof } from "@/lib/replay";
import { runWithTenant } from "@/lib/tenancy";
import type { PlannedAction, Receipt, VerificationResult } from "@/lib/types";

const emulator = process.env.FIRESTORE_EMULATOR_HOST;
const workspaceId = "local-pack-proof";
const brandId = "brand-proof";
const serviceScope = {
  workspaceId,
  brandId,
  principal: servicePrincipal("local-pack-worker"),
};
const operatorScope = {
  workspaceId,
  brandId,
  principal: firebasePrincipal({
    subjectId: "local-pack-operator", workspaceRole: "owner", authenticationId: "local-pack-session",
  }),
};
const jobId = `local-pack-${Date.now()}`;
const action: PlannedAction = {
  id: "export-pack-1",
  jobId,
  type: "export_content_pack",
  title: "Export content pack",
  description: "Create a deterministic local campaign artifact",
  risk: "low",
  requiresApproval: false,
  approvalState: "not_required",
  payload: { type: "export_content_pack" },
  state: "planned",
};
const jobPath = `workspaces/${workspaceId}/jobs/${jobId}`;

function buildRealContentPack(): string {
  const input = {
    title: "Harmonia launch interview",
    url: "https://www.youtube.com/watch?v=authorized-source",
    moments: [{
      title: "Why approval boundaries matter", startSec: 12, endSec: 34,
      hook: "Autonomy needs explicit authority", quote: "The agent proposes; the operator authorizes.",
    }],
    angles: [{ kind: "insight", title: "Bounded autonomy", rationale: "Safety is part of the product." }],
    drafts: [{ platform: "x", text: "Autonomy is useful only when authority remains explicit." }],
  };
  const program = [
    "import json, sys",
    "from harmonia_agent.content import build_content_pack",
    "p = json.load(sys.stdin)",
    "sys.stdout.write(build_content_pack(p['title'], p['url'], p['moments'], p['angles'], p['drafts']))",
  ].join("\n");
  const result = spawnSync("./.venv/bin/python", ["-c", program], {
    cwd: join(process.cwd(), "agent"),
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`content-pack builder failed: ${result.stderr}`);
  return result.stdout;
}

describe.skipIf(!emulator)("local content-pack action proof", () => {
  it("builds, receipts, independently verifies, and duplicate-suppresses one real local artifact", async () => {
    const proofDirectory = await mkdtemp(join(tmpdir(), "harmonia-local-pack-proof-"));
    try {
      await db().doc(jobPath).set({
        workspaceId,
        brandId,
        createdByUserId: operatorScope.principal.subjectId,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "running",
        stage: "publish",
        config: { platforms: [], youtubeUrl: "https://www.youtube.com/watch?v=authorized-source" },
        actions: [action],
      });

      const markdown = buildRealContentPack();
      expect(markdown).toContain("# Harmonia Content Pack — Harmonia launch interview");
      const artifactPath = join(proofDirectory, "content-pack.md");
      await writeFile(artifactPath, markdown, "utf8");
      const producedDigest = createHash("sha256").update(markdown).digest("hex");
      await expect(runWithTenant(
        serviceScope,
        () => saveContentPack(jobId, markdown, "0".repeat(64)),
      )).rejects.toThrow("content pack digest mismatch");
      await runWithTenant(serviceScope, () => saveContentPack(jobId, markdown, producedDigest));

      const idempotencyKey = actionPayloadDigest(action);
      const operationId = `${jobId}:effect:export-pack-1`;
      const traceId = "1".repeat(32);
      const claimToken = "local-pack-claim-owner";
      const claim = await runWithTenant(serviceScope, () => claimEffect({
        jobId,
        actionId: action.id,
        actionType: action.type,
        idempotencyKey,
        operationId,
        traceId,
        claimToken,
      }));
      expect(claim.outcome).toBe("execute");

      const receipt: Receipt = {
        id: "local-pack-receipt-1",
        jobId,
        actionId: action.id,
        actionType: action.type,
        idempotencyKey,
        performedAt: new Date().toISOString(),
        outcome: "applied",
        artifact: {
          kind: "firestore_doc",
          url: `local-emulator://${jobPath}`,
          fetchedAt: new Date().toISOString(),
          digest: producedDigest,
        },
        detail: { digest: producedDigest, localArtifactPath: artifactPath },
        operationId,
        traceId,
      };
      await runWithTenant(serviceScope, () => finalizeEffectReceipt(receipt, claimToken));

      const reread = await readFile(artifactPath);
      const observedDigest = createHash("sha256").update(reread).digest("hex");
      const verification: VerificationResult = {
        id: "local-pack-verification-1",
        target: "content-pack",
        actionId: action.id,
        receiptId: receipt.id,
        operationId: `${jobId}:verify:${action.id}`,
        traceId,
        verified: observedDigest === producedDigest,
        method: "artifact_digest_reread",
        evidence: {
          kind: "firestore_doc",
          url: `local-emulator://${jobPath}`,
          fetchedAt: new Date().toISOString(),
          digest: observedDigest,
        },
        checkedAt: new Date().toISOString(),
        note: "local artifact digest reread matches the receipted digest",
      };
      await expect(runWithTenant(serviceScope, () => saveVerifications(jobId, [{
        ...verification,
        id: "forged-verification",
        verified: true,
        evidence: { ...verification.evidence, digest: "0".repeat(64) },
      }]))).rejects.toThrow("verified evidence digest does not match receipt");
      await expect(runWithTenant(serviceScope, () => saveVerifications(jobId, [{
        ...verification,
        id: "stale-verification",
        checkedAt: new Date(Date.parse(receipt.performedAt) - 1_000).toISOString(),
      }]))).rejects.toThrow("verification predates its receipt");
      await expect(runWithTenant(serviceScope, () => saveVerifications(jobId, [{
        ...verification,
        id: "reused-operation-verification",
        operationId: receipt.operationId,
      }]))).rejects.toThrow("verification requires a distinct readback operation");
      await expect(runWithTenant(serviceScope, () => saveVerifications(jobId, [{
        ...verification,
        id: "unknown-receipt-verification",
        receiptId: "missing-receipt",
      }]))).rejects.toThrow("verification receipt not found");
      await runWithTenant(serviceScope, () => saveVerifications(jobId, [verification]));

      const replay = await runWithTenant(operatorScope, () => requestReplayProof(jobId, action.id));
      const [storedJob, storedClaim, receipts, replayObservations, approvalDecisions] = await runWithTenant(
        serviceScope,
        () => Promise.all([
          getJob(jobId),
          getEffectClaim(jobId, idempotencyKey),
          listReceipts(jobId),
          listReplayObservations(jobId),
          listApprovalDecisions(jobId),
        ]),
      );

      expect(storedJob.contentPack).toMatchObject({ digest: producedDigest });
      expect(storedJob.verifications).toEqual([expect.objectContaining({
        receiptId: receipt.id, verified: true, evidence: expect.objectContaining({ digest: producedDigest }),
      })]);
      expect(storedClaim).toMatchObject({ state: "applied", receiptId: receipt.id });
      expect(receipts).toHaveLength(1);
      expect(replay.receiptId).toBe(receipt.id);
      expect(replayObservations).toEqual([expect.objectContaining({
        actionId: action.id, receiptId: receipt.id, outcome: "already_applied",
      })]);
      expect(approvalDecisions).toEqual([]);
    } finally {
      await rm(proofDirectory, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    if (emulator) await db().recursiveDelete(db().doc(`workspaces/${workspaceId}`));
  });
});
