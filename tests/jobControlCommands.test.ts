import { describe, expect, it } from "vitest";

import {
  createCommandEnvelope,
  decideJobControl,
  type JobControlState,
} from "@/lib/operations/commands";

const actor = {
  actorType: "firebase_operator" as const,
  subjectId: "user-1",
  authenticationId: "firebase-session-1",
};
const state: JobControlState = {
  jobId: "job-1",
  status: "running",
  desiredState: "run",
  controlVersion: 2,
};

function envelope(action: "pause" | "resume" | "cancel", expectedControlVersion = 2, commandId = `command-${action}`) {
  return createCommandEnvelope({
    commandId,
    jobId: "job-1",
    action,
    expectedControlVersion,
    actor,
    receivedAt: "2026-08-31T00:00:00.000Z",
  });
}

describe("job control commands", () => {
  it("applies pause, resume, and cancellation as versioned desired state", () => {
    const paused = decideJobControl(state, envelope("pause"));
    expect(paused).toMatchObject({ accepted: true, next: { desiredState: "pause_requested", controlVersion: 3 } });

    const resumed = decideJobControl(paused.next!, envelope("resume", 3));
    expect(resumed).toMatchObject({ accepted: true, next: { desiredState: "run", controlVersion: 4 } });

    const cancelled = decideJobControl(state, envelope("cancel"));
    expect(cancelled).toMatchObject({ accepted: true, next: { desiredState: "cancel_requested", controlVersion: 3 } });
  });

  it("rejects stale versions and invalid lifecycle transitions without mutating state", () => {
    const stale = decideJobControl(state, envelope("pause", 1));
    expect(stale).toMatchObject({
      accepted: false,
      errorCode: "stale_control_version",
    });
    expect(stale).not.toHaveProperty("next");
    expect(decideJobControl({ ...state, status: "complete" }, envelope("cancel"))).toMatchObject({
      accepted: false,
      errorCode: "job_terminal",
    });
    expect(decideJobControl(state, envelope("resume"))).toMatchObject({
      accepted: false,
      errorCode: "job_not_paused",
    });
  });

  it("binds the command digest to action, aggregate, version, and actor", () => {
    const original = envelope("pause");
    expect(original.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(envelope("cancel").payloadDigest).not.toBe(original.payloadDigest);
    expect(createCommandEnvelope({
      commandId: original.commandId,
      jobId: "job-1",
      action: "pause",
      expectedControlVersion: 2,
      actor: { ...actor, subjectId: "user-2" },
      receivedAt: original.receivedAt,
    }).payloadDigest).not.toBe(original.payloadDigest);
  });
});
