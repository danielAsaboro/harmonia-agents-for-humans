import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { submitIntakeTurn, executeIntakeDraft } from "@/lib/intake/commands";
import { readIntakeDraft } from "@/lib/intake/repository";
import { getJob, saveChatMessage, listChatMessages } from "@/lib/repository";
import { awsRepository, recordKey } from "@/lib/dynamo";
import type { IntakeAdvice } from "@/lib/intake/contracts";
import { saveStrategyInvocationContext } from "@/lib/repository";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { requestIntentRoute } from "@/lib/agentRouteClient";
import { strategyFixture } from "./fixtures/strategy";
import { strategyDigest } from "@/lib/strategyApproval";
import { acceptStrategyProposal, decideStrategy } from "@/lib/repository";
import { editorialPlanDigest } from "@/lib/editorialPlan";
import type { EditorialPlan } from "@/lib/types";
import { handleChat } from "@/lib/chatHandler";
import { readActiveStrategyRef, readStrategyProposal } from "@/lib/strategy/repository";
vi.mock("@/lib/chatIntent", () => ({ parseIntent: vi.fn(async () => ({ intent: "create_job", workPlacement: "independent", userOutcome: "Educate founders", desiredOutputs: ["x_post"], sources: [] })) }));

const tenant = { workspaceId: `intake-${randomUUID()}`, brandId: "brand-a", principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" } } as TenantContext;
const run = <T>(work: () => T, brandId = "brand-a") => runWithTenant({ ...tenant, brandId }, work);
const advice: IntakeAdvice = { action: "create_job", disposition: "independent", expectedOutcome: "Educate founders", requestedOutputs: ["x_post"], sourceHandles: [{ kind: "web", url: "https://example.com/product" }] };
const turn = (conversationId = randomUUID(), surface: "dashboard" | "telegram" = "dashboard") => ({ conversationId, requestId: randomUUID(), surface, message: "Write a standalone post to educate founders from https://example.com/product", advice });

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("durable intake commands", () => {
  it("keeps chat history brand-scoped before it reaches the router", () => run(async () => {
    const conversationId = randomUUID();
    await saveChatMessage({ surface: "dashboard", conversationId, role: "user", text: "Private brand A brief" });
    expect(await run(() => listChatMessages(8, "dashboard", conversationId), "brand-b")).toEqual([]);
  }));
  it("dashboard and Telegram use the same durable command and replay without duplicate messages", () => run(async () => {
    for (const surface of ["dashboard", "telegram"] as const) {
      const request = { message: "Write an independent X post to educate founders", surface, conversationId: randomUUID(), requestId: randomUUID() };
      const principal = surface === "telegram" ? { kind: "telegram_user" as const, subjectId: "operator", authenticationId: "telegram-auth", workspaceRole: "member" as const, chatIdDigest: "a".repeat(64), callbackQueryIdDigest: "b".repeat(64) } : tenant.principal;
      const send = () => runWithTenant({ ...tenant, principal }, () => handleChat(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify(request) })));
      const first = await (await send()).json();
      const second = await (await send()).json();
      expect(first.intakeDraft.state).toBe("ready_for_planning");
      expect(second.intakeDraft.id).toBe(first.intakeDraft.id);
      expect((await listChatMessages(8, surface, request.conversationId)).filter(row => row.role === "user")).toHaveLength(1);
      expect((await listChatMessages(8, surface, request.conversationId)).filter(row => row.role === "assistant")).toHaveLength(1);
    }
  }));
  it("hands source-free work to planning without requesting files or creating strategy revisions", () => run(async () => {
    for (const disposition of ["independent", "new_initiative"] as const) {
      const input = { ...turn(), message: "Write an X post to educate founders from my instructions.", advice: { ...advice, disposition, sourceHandles: [] } };
      const draft = await submitIntakeTurn(input);
      expect(draft.state).toBe("ready_for_planning");
      expect(draft.missingFields).toEqual([]);
      expect((await executeIntakeDraft(draft)).jobId).toBeUndefined();
      expect((await submitIntakeTurn(input)).id).toBe(draft.id);
    }
  }));
  it("dispatches a text-only strategy with real Python serialization and no manufactured evidence", () => run(async () => {
    const fixture = execFileSync(resolve("agent/.venv/bin/python"), ["-m", "tests.intake_route_fixture"], { cwd: resolve("agent"), encoding: "utf8" });
    const route = await requestIntentRoute({ message: "Establish our strategy", attachmentCount: 0, recentConversation: [], workspaceContext: { strategyReady: false, planReady: false, calendarReady: false, pendingApprovalCount: 0, goals: [], channels: [], upcomingItemCount: 0, recentJobs: [] } }, { baseUrl: "http://localhost:8080", token: "test", fetchImpl: async () => new Response(fixture) });
    expect(route.workPlacement).toBe("new_initiative");
    const input = { ...turn(), message: "Establish our strategy from the company and audience details in this conversation.", advice: { ...advice, action: "establish_strategy" as const, requestedOutputs: [], sourceHandles: [], strategyContext: route.strategyContext! } };
    const result = await executeIntakeDraft(await submitIntakeTurn(input));
    const job = await getJob(result.jobId!);
    expect(job.stage).toBe("strategize");
    expect(job.config.sourceManifestId).toBeUndefined();
    expect(job.sourceAnalysis).toBeUndefined();
    const context = JSON.parse(execFileSync(resolve("agent/.venv/bin/python"), ["-m", "tests.intake_route_fixture", "strategy-input"], { cwd: resolve("agent"), input: JSON.stringify(job), encoding: "utf8" }));
    expect(context.analysis).toBeNull();
    await saveStrategyInvocationContext(job.id, { revision: 1, sourceIds: [], operatorContextIds: ["context:campaign", "context:company"], performance: [], memoryFacts: [], audienceIds: ["startup-founders"], requestedChannels: ["linkedin"], supportedChannels: ["linkedin"], horizonWeeks: 4, researchRequest: null, searchEvidence: [] });
    const proposal = strategyFixture("text-only-strategy");
    proposal.channelRoles[0].channel = "linkedin";
    proposal.briefs[0].channelCandidates = ["linkedin"];
    proposal.briefs[0].audienceId = "startup-founders";
    proposal.audiencePriorities[0].audienceId = "startup-founders";
    for (const group of [proposal.pillars, proposal.campaignThemes, proposal.briefs]) for (const item of group) item.evidenceRefs = ["context:company"];
    await acceptStrategyProposal(job.id, proposal, strategyDigest(proposal), 1, [], null);
    const accepted = await decideStrategy(job.id, { decision: "approved", expectedActiveRevision: 0, payloadDigest: strategyDigest(proposal) });
    expect(accepted.nextStage).toBe("complete");
    expect(accepted.outboxId).toBeUndefined();
    expect((await getJob(job.id)).stage).toBe("complete");
    const plan = { planId: "launch-plan", version: 1, approvedStrategyDigest: accepted.strategyRef!.digest, items: [{ id: "one", campaignTheme: "Launch" }, { id: "two", campaignTheme: "Launch" }] } as EditorialPlan;
    await awsRepository().patch(recordKey(`workspaces/${tenant.workspaceId}/jobs/${job.id}`), { editorialPlan: plan, editorialPlanDigest: editorialPlanDigest(plan) });
    const placement = { ...turn(), advice: { ...advice, disposition: "existing_plan_item" as const, targetName: "Launch" } };
    const ambiguous = await submitIntakeTurn(placement);
    expect(ambiguous.state).toBe("clarifying");
    expect(ambiguous.missingFields).toEqual(["target"]);
    const resolved = await submitIntakeTurn({ ...placement, requestId: randomUUID(), message: "launch-plan/two", advice: { ...placement.advice, targetName: "launch-plan/two" } });
    expect(resolved.id).toBe(ambiguous.id);
    expect(resolved.target).toEqual({ campaignId: "launch-plan", itemId: "two", name: "Launch" });
    const placed = await executeIntakeDraft(resolved);
    expect((await getJob(placed.jobId!)).config.intake?.target).toEqual(resolved.target);
    const independent = await submitIntakeTurn({ ...turn(), advice: { ...advice, disposition: "independent" } });
    expect(independent.target).toBeUndefined();
    const revisionDraft = await submitIntakeTurn({ ...turn(), message: "Revise the approved strategy toward founder education through LinkedIn posts", advice: { ...input.advice, requestedOutputs: ["linkedin_post"], action: "revise_strategy" } });
    expect(revisionDraft.strategyBaseRef).toEqual(accepted.strategyRef);
    const revisionJob = await getJob((await executeIntakeDraft(revisionDraft)).jobId!);
    expect(revisionJob.strategyRef).toBeUndefined();
    expect(revisionJob.config.intake?.strategyBaseRef).toEqual(accepted.strategyRef);
    await saveStrategyInvocationContext(revisionJob.id, { revision: 1, sourceIds: [], operatorContextIds: ["context:campaign", "context:company"], performance: [], memoryFacts: [], audienceIds: ["startup-founders"], requestedChannels: ["linkedin"], supportedChannels: ["linkedin"], horizonWeeks: 4, researchRequest: null, searchEvidence: [] });
    const revisionBody = { ...proposal, strategyId: "text-only-revision" };
    await acceptStrategyProposal(revisionJob.id, revisionBody, strategyDigest(revisionBody), 1, [], null);
    const storedProposal = await readStrategyProposal((await getJob(revisionJob.id)).strategyProposalId!);
    expect(storedProposal.baseStrategyRef).toEqual(accepted.strategyRef);
    expect(await readActiveStrategyRef()).toEqual(accepted.strategyRef);
    const approvedRevision = await decideStrategy(revisionJob.id, { decision: "approved", payloadDigest: storedProposal.digest, expectedActiveRevision: storedProposal.expectedActiveRevision });
    expect(approvedRevision.nextStage).toBe("complete");
    expect(approvedRevision.outboxId).toBeUndefined();
  }));
  it("concurrent request replay and dispatch create one durable job with exact outputs", () => run(async () => {
    const input = turn();
    const drafts = await Promise.all([submitIntakeTurn(input), submitIntakeTurn(input)]);
    expect(drafts[0].id).toBe(drafts[1].id);
    const result = await Promise.all(drafts.map(executeIntakeDraft));
    expect(result[0].jobId).toBe(result[1].jobId);
    const replay = await submitIntakeTurn(input);
    expect(replay.jobId).toBe(result[0].jobId);
    expect(replay.answers).toHaveLength(1);
    const job = await getJob(replay.jobId!);
    expect(job.config.operatorBrief).toBe(input.message);
    expect(job.config.desiredOutputs).toEqual(["x_post"]);
    expect(job.config.allowedOutputs).toEqual(["x_post"]);
    await expect(submitIntakeTurn({ ...input, message: "Changed" })).rejects.toThrow("reused");
  }));
  it("resumes a clarification from persisted state without chat history", () => run(async () => {
    const input = { ...turn(), advice: { ...advice, expectedOutcome: "", requestedOutputs: [] } };
    const draft = await submitIntakeTurn(input);
    expect(draft.missingFields).toEqual(["expectedOutcome", "requestedOutputs"]);
    const completed = await submitIntakeTurn({ ...input, requestId: randomUUID(), message: "Educate founders; only an X post. Keep this independent.", advice });
    expect(completed.id).toBe(draft.id);
    expect(completed.originalOperatorBrief).toBe(input.message);
    expect(completed.answers).toHaveLength(2);
    expect(completed.state).toBe("ready");
    expect(completed.target).toBeUndefined();
  }));
  it("retains knowledge without any production dispatch on either surface", () => run(async () => {
    for (const surface of ["dashboard", "telegram"] as const) {
      const draft = await submitIntakeTurn({ ...turn(randomUUID(), surface), advice: { ...advice, disposition: "knowledge_only", requestedOutputs: [] } });
      expect(draft.state).toBe("retained");
      expect((await executeIntakeDraft(draft)).jobId).toBeUndefined();
      expect((await awsRepository().read(recordKey(`workspaces/${tenant.workspaceId}/jobs/intake-${draft.id}`))).present).toBe(false);
    }
  }));
  it("preserves attachment handles until explicit rights attestation", () => run(async () => {
    const input = { ...turn(), advice: { ...advice, sourceHandles: [{ kind: "upload" as const, attachmentId: "authorized-file" }] } };
    const draft = await submitIntakeTurn(input);
    expect(draft.missingFields).toEqual(["rights"]);
    const accepted = await submitIntakeTurn({ ...input, requestId: randomUUID(), message: "I confirm I have rights to use this source", advice: { ...advice, sourceHandles: [] } });
    expect(accepted.id).toBe(draft.id);
    expect(accepted.rightsAttested).toBe(true);
    expect(accepted.sourceHandles).toEqual(input.advice.sourceHandles);
  }));
  it("persists new initiatives and isolates other brands", () => run(async () => {
    const draft = await submitIntakeTurn({ ...turn(), advice: { ...advice, disposition: "new_initiative", targetName: "Autumn launch" } });
    expect(draft.disposition).toBe("new_initiative");
    expect(await run(() => readIntakeDraft(draft.id), "brand-b")).toBeNull();
  }));
  it("honors an independent opt-out during ambiguous planned-work clarification", () => run(async () => {
    const input = { ...turn(), advice: { ...advice, disposition: "existing_plan_item" as const, targetName: "not-an-authorized-item" } };
    const first = await submitIntakeTurn(input);
    expect(first.missingFields).toContain("target");
    const standalone = await submitIntakeTurn({ ...input, requestId: randomUUID(), message: "Keep it independent, no campaign", advice });
    expect(standalone.id).toBe(first.id);
    expect(standalone.disposition).toBe("independent");
    expect(standalone.target).toBeUndefined();
    expect(standalone.targetName).toBeUndefined();
    expect(standalone.missingFields).toEqual([]);
  }));
});
