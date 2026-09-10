import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { awsRepository, partition, recordKey } from "@/lib/dynamo";
import { submitIntakeTurn, executeIntakeDraft } from "@/lib/intake/commands";
import { getJob } from "@/lib/repository";
import { handleChat } from "@/lib/chatHandler";
import type { IntakeAdvice } from "@/lib/intake/contracts";

vi.mock("@/lib/chatIntent", () => ({ parseIntent: vi.fn(async (message: string) => ({
  intent: "create_job", workPlacement: "independent", userOutcome: "Create an announcement", desiredOutputs: ["x_post"],
  sources: [{ kind: "web", url: "https://example.com/current" }],
  needsClarification: /^(Clarify|Different)/.test(message), missingField: message.startsWith("Clarify") ? "expectedOutcome" : message.startsWith("Different") ? "requestedOutputs" : null,
  clarifyingQuestion: message.startsWith("Clarify") ? "What outcome should this announcement achieve?" : message.startsWith("Different") ? "Which outputs?" : null,
  resolvedField: message.startsWith("Recruit") ? "expectedOutcome" : null,
})) }));
const scope = { workspaceId: `intake-review-${randomUUID()}`, brandId: "a", principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" } } as TenantContext;
const run = <T>(fn: () => T, brandId = "a") => runWithTenant({ ...scope, brandId }, fn);
const advice: IntakeAdvice = { action: "create_job", disposition: "independent", expectedOutcome: "Recruit founders", requestedOutputs: ["x_post"], sourceHandles: [{ kind: "web", url: "https://example.com/current" }] };
const turn = () => ({ surface: "dashboard" as const, conversationId: randomUUID(), requestId: randomUUID(), message: "Write from https://example.com/current to recruit founders", advice });
const outboxKey = (jobId: string) => recordKey(`workspaces/${scope.workspaceId}/stage_outbox/${createHash("sha256").update(`${jobId}:collect_sources:0`).digest("hex")}`);

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("Task 2 review regressions", () => {
  it("scopes identical client identities to different brands, jobs and outboxes", async () => {
    const input = turn();
    const a = await run(() => submitIntakeTurn(input), "a");
    const b = await run(() => submitIntakeTurn(input), "b");
    expect(a.id).not.toBe(b.id);
    const [doneA, doneB] = await Promise.all([run(() => executeIntakeDraft(a), "a"), run(() => executeIntakeDraft(b), "b")]);
    expect(doneA.jobId).not.toBe(doneB.jobId);
    expect((await run(() => getJob(doneA.jobId!), "a")).brandId).toBe("a");
    expect((await run(() => getJob(doneB.jobId!), "b")).brandId).toBe("b");
    expect((await awsRepository().read(outboxKey(doneA.jobId!))).value?.brandId).toBe("a");
    expect((await awsRepository().read(outboxKey(doneB.jobId!))).value?.brandId).toBe("b");
  });
  it("persists the exact router clarification on both surfaces until that field is resolved", () => run(async () => {
    for (const surface of ["dashboard", "telegram"] as const) {
      const conversationId = randomUUID();
      const principal = surface === "telegram" ? { kind: "telegram_user" as const, subjectId: "operator", authenticationId: "telegram-auth", workspaceRole: "member" as const, chatIdDigest: "a".repeat(64), callbackQueryIdDigest: "b".repeat(64) } : scope.principal;
      const send = async (message: string) => (await runWithTenant({ ...scope, principal }, () => handleChat(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ surface, conversationId, requestId: randomUUID(), message }) })))).json();
      const first = await send("Clarify the announcement from https://example.com/current");
      expect(first.intakeDraft.state).toBe("clarifying");
      expect(first.intakeDraft.missingFields).toContain("expectedOutcome");
      expect(first.reply).toBe("What outcome should this announcement achieve?");
      expect(first.jobId).toBeUndefined();
      expect((await awsRepository().read(outboxKey(`intake-${first.intakeDraft.id}`))).present).toBe(false);
      const unrelated = await send("Thanks");
      expect(unrelated.intakeDraft.state).toBe("clarifying");
      const changedQuestion = await send("Different topic");
      expect(changedQuestion.intakeDraft.clarification.field).toBe("expectedOutcome");
      expect(changedQuestion.reply).toBe(first.reply);
      const resolved = await send("Recruit founders for the pilot");
      expect(resolved.intakeDraft.id).toBe(first.intakeDraft.id);
      expect(resolved.intakeDraft.state).toBe("dispatched");
      expect((await awsRepository().read(outboxKey(resolved.jobId))).present).toBe(true);
    }
  }));
  it("revalidates exact-source rights at dispatch after revocation", () => run(async () => {
    const draft = await submitIntakeTurn(turn());
    const authorizationId = Object.values(draft.sourceRights)[0];
    await awsRepository().patch(recordKey(`workspaces/${scope.workspaceId}/brands/a/source_rights/${authorizationId}`), { revokedAt: new Date().toISOString() });
    await expect(executeIntakeDraft(draft)).rejects.toThrow("revoked");
    expect((await awsRepository().read(outboxKey(`intake-${draft.id}`))).present).toBe(false);
  }));
  it("does not extend upload A rights to a later upload B and replays authorizations once", () => run(async () => {
    const input = turn();
    const a = { kind: "upload" as const, attachmentId: "upload-a" };
    const b = { kind: "upload" as const, attachmentId: "upload-b" };
    const first = await submitIntakeTurn({ ...input, message: "I confirm I have rights to use this source", advice: { ...advice, expectedOutcome: "", sourceHandles: [a] } });
    expect(first.state).toBe("clarifying");
    const second = await submitIntakeTurn({ ...input, requestId: randomUUID(), message: "Add upload B and recruit founders", advice: { ...advice, sourceHandles: [b] } });
    expect(second.missingFields).toContain("rights");
    expect((await executeIntakeDraft(second)).jobId).toBeUndefined();
    expect((await awsRepository().read(outboxKey(`intake-${second.id}`))).present).toBe(false);
    expect(Object.keys(second.sourceRights)).toHaveLength(1);
    expect(Object.values(second.sourceRights)).toEqual(Object.values(first.sourceRights));
    const attestation = { ...input, requestId: randomUUID(), message: "I confirm I have rights to use this source", advice: { ...advice, sourceHandles: [] } };
    const final = await submitIntakeTurn(attestation);
    expect(final.state).toBe("ready");
    expect(Object.keys(final.sourceRights)).toHaveLength(2);
    expect((await submitIntakeTurn(attestation)).sourceRights).toEqual(final.sourceRights);
    for (const source of [a, b]) await awsRepository().put(recordKey(`workspaces/${scope.workspaceId}/chat_attachments/${source.attachmentId}`), { id: source.attachmentId, workspaceId: scope.workspaceId, brandId: scope.brandId, state: "ready" });
    const dispatched = await executeIntakeDraft(final);
    expect(dispatched.state).toBe("dispatched");
    expect((await executeIntakeDraft(final)).jobId).toBe(dispatched.jobId);
    expect((await awsRepository().read(outboxKey(dispatched.jobId!))).present).toBe(true);
    const rights = await awsRepository().query(partition(`workspaces/${scope.workspaceId}/brands/a/source_rights`));
    for (const id of Object.values(final.sourceRights)) expect(rights.rows.filter(row => row.id === id)).toHaveLength(1);
  }));
});
