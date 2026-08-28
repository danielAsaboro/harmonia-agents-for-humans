import type { Firestore } from "@google-cloud/firestore";

import { assertResourceWorkspace, currentTenant, tenantDocumentPath } from "../tenancy";
import type { JobStatus } from "../types";
import { decideJobControl, type CommandEnvelope, type JobControlState } from "./commands";
import { jobDesiredStateSchema, type JobDesiredState } from "./jobShell";

export interface CommandReceipt {
  commandId: string;
  jobId: string;
  workspaceId: string;
  brandId: string;
  action: CommandEnvelope["action"];
  payloadDigest: string;
  actor: CommandEnvelope["actor"];
  receivedAt: string;
  recordedAt: string;
  accepted: boolean;
  resultingControlVersion?: number;
  resultingDesiredState?: JobDesiredState;
  errorCode?: string;
  error?: string;
}

export class JobControlCommandStore {
  constructor(private readonly firestore: Firestore) {}

  async record(command: CommandEnvelope): Promise<CommandReceipt> {
    const tenant = currentTenant();
    const expectedActorType = tenant.principal.kind === "firebase_user"
      ? "firebase_operator"
      : tenant.principal.kind === "telegram_user"
        ? "telegram_operator"
        : null;
    if (
      command.actor.actorType !== expectedActorType
      || command.actor.subjectId !== tenant.principal.subjectId
      || command.actor.authenticationId !== tenant.principal.authenticationId
    ) throw new Error("job control command actor does not match authenticated tenant principal");

    const jobRef = this.firestore.doc(tenantDocumentPath(tenant, "jobs", command.jobId));
    const receiptRef = jobRef.collection("control_commands").doc(command.commandId);
    return this.firestore.runTransaction(async (transaction) => {
      const [jobSnapshot, receiptSnapshot] = await Promise.all([
        transaction.get(jobRef),
        transaction.get(receiptRef),
      ]);
      if (receiptSnapshot.exists) {
        const receipt = receiptSnapshot.data() as CommandReceipt;
        if (receipt.payloadDigest !== command.payloadDigest) throw new Error("command id was already used with a different payload");
        return receipt;
      }
      if (!jobSnapshot.exists) throw new Error(`job not found: ${command.jobId}`);
      const job = jobSnapshot.data() as {
        workspaceId: string;
        brandId: string;
        status: JobStatus;
        desiredState: JobDesiredState;
        controlVersion: number;
      };
      assertResourceWorkspace(tenant, job);
      const state: JobControlState = {
        jobId: command.jobId,
        status: job.status,
        desiredState: jobDesiredStateSchema.parse(job.desiredState),
        controlVersion: job.controlVersion,
      };
      const decision = decideJobControl(state, command);
      const receipt: CommandReceipt = {
        commandId: command.commandId,
        jobId: command.jobId,
        workspaceId: tenant.workspaceId,
        brandId: tenant.brandId,
        action: command.action,
        payloadDigest: command.payloadDigest,
        actor: command.actor,
        receivedAt: command.receivedAt,
        recordedAt: new Date().toISOString(),
        accepted: decision.accepted,
        ...(decision.accepted ? {
          resultingControlVersion: decision.next.controlVersion,
          resultingDesiredState: decision.next.desiredState,
        } : { errorCode: decision.errorCode, error: decision.error }),
      };
      if (decision.accepted) {
        transaction.update(jobRef, {
          desiredState: decision.next.desiredState,
          controlVersion: decision.next.controlVersion,
          updatedAt: receipt.recordedAt,
        });
      }
      transaction.create(receiptRef, receipt);
      return receipt;
    });
  }
}
