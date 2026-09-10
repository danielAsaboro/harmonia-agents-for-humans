import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { handleChat } from "@/lib/chatHandler";
import { listJobs } from "@/lib/repository";

vi.mock("@/lib/agentRouteClient", async original => {
  const actual = await original<typeof import("@/lib/agentRouteClient")>();
  return { ...actual, requestIntentRoute: async (input: import("@/lib/agentRouteClient").IntentRouteRequest) => actual.requestIntentRoute(input, {
    baseUrl: "http://localhost:8080", token: "local-contract-test",
    fetchImpl: async () => new Response(execFileSync(resolve("agent/.venv/bin/python"), ["-m", "tests.intake_source_route_fixture"], { cwd: resolve("agent"), input: JSON.stringify(input), encoding: "utf8" })),
  }) };
});

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("source authority across actual Python routing and shared chat", () => {
  it("does not reuse a completed source for a new source-free request on either surface", async () => {
    for (const surface of ["dashboard", "telegram"] as const) {
      const scope = { workspaceId: `source-authority-${randomUUID()}`, brandId: "a", principal: surface === "dashboard"
        ? { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" }
        : { kind: "telegram_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "member", chatIdDigest: "a".repeat(64), callbackQueryIdDigest: "b".repeat(64) } } as TenantContext;
      await runWithTenant(scope, async () => {
        const conversationId = randomUUID();
        const send = async (message: string) => (await handleChat(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ message, surface, conversationId, requestId: randomUUID() }) }))).json();
        const previous = await send("Create an X post from https://old.example/completed to recruit founders");
        expect(previous.error).toBeUndefined();
        expect(previous.intakeDraft.state).toBe("dispatched");
        const next = await send("Write a new source-free X post to recruit founders");
        expect(next.intakeDraft.state).toBe("ready_for_planning");
        expect(next.intakeDraft.sourceHandles).toEqual([]);
        expect(next.jobId).toBeUndefined();
        expect(await listJobs()).toHaveLength(1);
        const clarification = await send("Clarify an announcement from https://current.example/source");
        expect(clarification.intakeDraft.clarification).toEqual({ field: "expectedOutcome", question: "What outcome should this announcement achieve?" });
        expect(clarification.intakeDraft.state).toBe("clarifying");
        expect(await listJobs()).toHaveLength(1);
        const unrelated = await send("Thanks");
        expect(unrelated.intakeDraft.state).toBe("clarifying");
        const resolved = await send("Recruit founders for the pilot");
        expect(resolved.intakeDraft.state).toBe("dispatched");
        expect(resolved.intakeDraft.sourceHandles).toEqual([{ kind: "web", url: "https://current.example/source" }]);
        expect(await listJobs()).toHaveLength(2);
      });
    }
  }, 20_000);
});
