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
