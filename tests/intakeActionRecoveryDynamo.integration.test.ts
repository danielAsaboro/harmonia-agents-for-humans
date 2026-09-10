import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleChat } from "@/lib/chatHandler";
import { parseIntent, type ParsedIntent } from "@/lib/chatIntent";
import { getJob, listJobs } from "@/lib/repository";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import type { IntakeMissingField } from "@/lib/intake/contracts";

vi.mock("@/lib/chatIntent", () => ({ parseIntent: vi.fn() }));
const strategyContext = {
  company: "Harmonia", product: "Content operations for startups", positioning: "Evidence-backed founder content",
  differentiators: ["Approval before effects"], brandVoice: ["clear"], exclusions: [], safetyConstraints: ["Do not invent claims"],
  businessObjectives: ["Educate founders"], campaignObjectives: ["Build awareness"],
  audiences: [{ id: "founders", name: "Founders", pains: ["Limited time"] }],
  funnelStage: "awareness" as const, intendedConversion: "Learn more", requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4,
};
const routed: ParsedIntent = { intent: "create_job", workPlacement: "independent", userOutcome: "Educate founders", desiredOutputs: [], sources: [], strategyContext };
function scoped<T>(surface: "dashboard" | "telegram", work: () => T) {
  const principal = surface === "dashboard"
    ? { kind: "cognito_user", subjectId: "operator", authenticationId: "session", workspaceRole: "owner" }
    : { kind: "telegram_user", subjectId: "operator", authenticationId: "session", workspaceRole: "member", chatIdDigest: "a".repeat(64), callbackQueryIdDigest: "b".repeat(64) };
  return runWithTenant({ workspaceId: `action-recovery-${randomUUID()}`, brandId: "brand", principal } as TenantContext, work);
}
async function send(conversationId: string, surface: "dashboard" | "telegram", message: string, advice: ParsedIntent, requestId = randomUUID()) {
  vi.mocked(parseIntent).mockResolvedValueOnce(advice);
  const response = await handleChat(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ surface, conversationId, requestId, message }) }));
  const result = await response.json();
  expect(response.status, JSON.stringify(result)).toBe(200);
  return result;
}
describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("action-aware durable clarification recovery", () => {
  for (const surface of ["dashboard", "telegram"] as const) {
    it(`retains a conditional source-backed context question until a valid answer on ${surface}`, () => scoped(surface, async () => {
      const conversationId = randomUUID();
      const content: ParsedIntent = { ...routed, strategyContext: undefined, desiredOutputs: ["x_post"], sources: [{ kind: "web", url: "https://example.com/source" }] };
      const first = await send(conversationId, surface, "Create a post from https://example.com/source", { ...content, needsClarification: true, missingField: "strategyContext", clarifyingQuestion: "Which company and audience should this address?" });
      expect(first.intakeDraft.state).toBe("clarifying");
      const acknowledgement = await send(conversationId, surface, "Thanks", content);
      expect(acknowledgement.intakeDraft.state).toBe("clarifying");
      expect(acknowledgement.intakeDraft.clarification).toEqual(first.intakeDraft.clarification);
      expect(acknowledgement.intakeDraft.missingFields).toContain("strategyContext");
      expect(await listJobs()).toHaveLength(0);
      const incomplete = await send(conversationId, surface, "The audience is founders", { ...content, resolvedField: "strategyContext" });
      expect(incomplete.intakeDraft.state).toBe("clarifying");
      expect(await listJobs()).toHaveLength(0);
      const requestId = randomUUID();
      const answer: ParsedIntent = { ...content, strategyContext, resolvedField: "strategyContext" };
      const next = await send(conversationId, surface, "Harmonia helps founders run evidence-backed content operations", answer, requestId);
      expect(next.intakeDraft.id).toBe(first.intakeDraft.id);
      expect(next.intakeDraft.state).toBe("dispatched");
      expect((await getJob(next.jobId)).config.strategyContext).toEqual(strategyContext);
      const replay = await send(conversationId, surface, "Harmonia helps founders run evidence-backed content operations", answer, requestId);
      expect(replay.jobId).toBe(next.jobId);
      expect(await listJobs()).toHaveLength(1);
      vi.mocked(parseIntent).mockReset();
    }));
    it(`does not require blanket context for source-free planning on ${surface}`, () => scoped(surface, async () => {
      const next = await send(randomUUID(), surface, "Write an independent post to educate founders", { ...routed, strategyContext: undefined, desiredOutputs: ["x_post"] });
      expect(next.intakeDraft.state).toBe("ready_for_planning");
      expect(next.intakeDraft.missingFields).toEqual([]);
      expect(await listJobs()).toHaveLength(0);
    }));
    it(`clears a production-context question when the source becomes knowledge-only on ${surface}`, () => scoped(surface, async () => {
      const conversationId = randomUUID();
      const content: ParsedIntent = { ...routed, strategyContext: undefined, desiredOutputs: ["x_post"], sources: [{ kind: "web", url: "https://example.com/source" }] };
      const first = await send(conversationId, surface, "Create a post from https://example.com/source", { ...content, needsClarification: true, missingField: "strategyContext", clarifyingQuestion: "Which company and audience should this address?" });
      const next = await send(conversationId, surface, "Only retain this source as knowledge", { ...content, workPlacement: "knowledge_only" });
      expect(next.intakeDraft.id).toBe(first.intakeDraft.id);
      expect(next.intakeDraft.state).toBe("retained");
      expect(next.intakeDraft.clarification).toBeNull();
      expect(next.intakeDraft.missingFields).toEqual([]);
      expect(await listJobs()).toHaveLength(0);
    }));
    it(`keeps missing context when strategy changes to source-backed content on ${surface}`, () => scoped(surface, async () => {
      const conversationId = randomUUID();
      const content: ParsedIntent = { ...routed, strategyContext: undefined, desiredOutputs: ["x_post"], sources: [{ kind: "web", url: "https://example.com/source" }] };
      const first = await send(conversationId, surface, "Establish a strategy from https://example.com/source", { ...content, intent: "establish_strategy", needsClarification: true, missingField: "strategyContext", clarifyingQuestion: "Which company and audience should this address?" });
      const next = await send(conversationId, surface, "Make one post instead", content);
      expect(next.intakeDraft.id).toBe(first.intakeDraft.id);
      expect(next.intakeDraft.state).toBe("clarifying");
      expect(next.intakeDraft.missingFields).toContain("strategyContext");
      expect(await listJobs()).toHaveLength(0);
    }));
    for (const field of ["activeStrategy", "requestedOutputs"] as const) {
      it(`clears obsolete ${field} when switching to establish_strategy on ${surface}`, () => scoped(surface, async () => {
        const conversationId = randomUUID();
        const question = field === "activeStrategy" ? "There is no approved strategy to revise. Would you like to establish one?" : "Which outputs do you want produced?";
        const first = await send(conversationId, surface, "Help with our content", { ...routed, intent: field === "activeStrategy" ? "revise_strategy" : "create_job", needsClarification: true, missingField: field, clarifyingQuestion: question });
        expect(first.intakeDraft.state).toBe("clarifying");
        expect(first.intakeDraft.missingFields).toContain(field);
        expect(await listJobs()).toHaveLength(0);
        const recovery = { ...routed, intent: "establish_strategy" as const, resolvedField: field };
        const requestId = randomUUID();
        const next = await send(conversationId, surface, "Establish the company strategy instead; no content outputs yet", recovery, requestId);
        expect(next.intakeDraft.id).toBe(first.intakeDraft.id);
        expect(next.intakeDraft.missingFields).toEqual([]);
        expect(next.intakeDraft.clarification).toBeNull();
        expect(next.intakeDraft.state).toBe("dispatched");
        const job = await getJob(next.jobId);
        expect(job.stage).toBe("strategize");
        expect(job.config.sourceManifestId).toBeUndefined();
        expect(job.config.desiredOutputs).toEqual([]);
        expect(job.config.intake?.action).toBe("establish_strategy");
        const replay = await send(conversationId, surface, "Establish the company strategy instead; no content outputs yet", recovery, requestId);
        expect(replay.jobId).toBe(next.jobId);
        expect(await listJobs()).toHaveLength(1);
        vi.mocked(parseIntent).mockReset();
      }));
    }
    it(`retains still-applicable requirements after an action change on ${surface}`, () => scoped(surface, async () => {
      for (const field of ["expectedOutcome", "rights"] as IntakeMissingField[]) {
        const conversationId = randomUUID();
        const sources: ParsedIntent["sources"] = field === "rights" ? [{ kind: "youtube", url: "https://www.youtube.com/watch?v=abcdef12345" }] : [];
        const first = await send(conversationId, surface, "Create content", { ...routed, sources, needsClarification: true, missingField: field, clarifyingQuestion: `Please resolve ${field}` });
        const next = await send(conversationId, surface, "Establish the strategy instead", { ...routed, sources, intent: "establish_strategy", resolvedField: "activeStrategy" });
        expect(next.intakeDraft.id).toBe(first.intakeDraft.id);
        expect(next.intakeDraft.state).toBe("clarifying");
        expect(next.intakeDraft.clarification.field).toBe(field);
        expect(next.intakeDraft.missingFields).toContain(field);
        expect(await listJobs()).toHaveLength(0);
      }
    }));
  }
});
