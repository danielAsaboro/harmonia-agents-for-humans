import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { handleChat } from "@/lib/chatHandler";
import { awsRepository } from "@/lib/dynamo";
import { submitIntakeTurn } from "@/lib/intake/repository";
import { listJobs } from "@/lib/repository";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { decideStrategyProposal, insertStrategyProposal } from "@/lib/strategy/repository";
import { strategyDigest } from "@/lib/strategyApproval";
import { strategyFixture } from "./fixtures/strategy";

vi.mock("@/lib/agentRouteClient", async original => {
  const actual = await original<typeof import("@/lib/agentRouteClient")>();
  return {
    ...actual,
    requestIntentRoute: async (input: import("@/lib/agentRouteClient").IntentRouteRequest) => actual.requestIntentRoute(input, {
      baseUrl: "http://localhost:8080",
      token: "local-contract-test",
      fetchImpl: async () => new Response(execFileSync(
        resolve("agent/.venv/bin/python"), ["-m", "tests.append_route_fixture"],
        { cwd: resolve("agent"), input: JSON.stringify(input), encoding: "utf8" },
      )),
    }),
  };
});

const tenant = (surface: "dashboard" | "telegram"): TenantContext => ({
  workspaceId: `append-constraints-${surface}-${randomUUID()}`,
  brandId: "brand-a",
  principal: surface === "dashboard"
    ? { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" }
    : { kind: "telegram_user", subjectId: "operator", authenticationId: "telegram-update", workspaceRole: "member", chatIdDigest: "a".repeat(64), callbackQueryIdDigest: "b".repeat(64) },
});

async function setupCampaign() {
  const strategy = strategyFixture("append-constraint-direction");
  const proposal = await awsRepository().atomic(tx => insertStrategyProposal(tx, {
    jobId: `strategy-${randomUUID()}`, attempt: 1, strategy, digest: strategyDigest(strategy),
    evidenceLineage: ["operator:append"], invocationContext: {
      revision: 1, sourceIds: [], operatorContextIds: ["operator:append"], performance: [], memoryFacts: [],
      audienceIds: ["founders"], requestedChannels: ["x"], supportedChannels: ["x"], horizonWeeks: 4,
      researchRequest: null, searchEvidence: [],
    }, proposedAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z",
  }));
  await awsRepository().atomic(tx => decideStrategyProposal(tx, proposal.id, {
    decision: "approved", payloadDigest: proposal.digest, expectedActiveRevision: 0,
  }));
  const campaigns = await import("@/lib/campaigns/repository");
  await campaigns.configurePlanningPolicy({
    timezone: "UTC", productionCapacity: { maxItems: 24, maxItemsPerWeek: 6 },
    cadenceConstraints: { minimumHoursBetweenItems: 24, maxItemsPerChannelPerWeek: 4 }, maxConcurrentItems: 1,
  }, 0);
  const requestId = randomUUID();
  const draft = await submitIntakeTurn({
    requestId, conversationId: randomUUID(), surface: "dashboard", message: "Create the first Launch item.",
    advice: { action: "create_job", disposition: "new_initiative", expectedOutcome: "Launch", requestedOutputs: ["x_post"], sourceHandles: [], targetName: "Launch" },
  });
  return (await import("@/lib/planning/commands")).materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId });
}

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("append constraints across actual Python classification and shared chat", () => {
  for (const surface of ["dashboard", "telegram"] as const) {
    it(`appends an exact fully consumed grammar request on ${surface}`, async () => {
      await runWithTenant(tenant(surface), async () => {
        const base = await setupCampaign();
        const message = 'Add an X post called "Launch follow-up" to campaign "Launch" at 2026-09-14T12:00:00Z.';
        const response = await handleChat(new Request("http://localhost/api/chat", {
          method: "POST",
          body: JSON.stringify({ surface, conversationId: `${surface}-exact-append`, requestId: randomUUID(), message }),
        }));
        const body = await response.json() as Record<string, unknown>;
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(body.intent).toBe("append_deliverable");
        expect(String(body.reply)).toContain("Added Launch follow-up");
        const plan = await (await import("@/lib/campaigns/repository")).currentPlan(base.planRef.id);
        expect(plan.ref.revision).toBe(2);
        expect(plan.itemRefs).toHaveLength(2);
      });
    }, 20_000);

    it(`retains dependency and source constraints and blocks append on ${surface}`, async () => {
      await runWithTenant(tenant(surface), async () => {
        const base = await setupCampaign();
        const message = 'Add an X post called "Launch follow-up" to campaign "Launch" at 2026-09-14T12:00:00Z, only after item-first is completed, using https://example.com/approved-source.';
        const response = await handleChat(new Request("http://localhost/api/chat", {
          method: "POST",
          body: JSON.stringify({ surface, conversationId: `${surface}-append-constraints`, requestId: randomUUID(), message }),
        }));
        const body = await response.json() as Record<string, unknown>;
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(body.intent).toBe("append_deliverable");
        expect(String(body.reply)).toContain("source-rights and evidence binding");
        expect(String(body.reply)).toContain("No plan revision was created");

        const commands = await import("@/lib/planning/commands");
        const proposals = await commands.listPlanningProposals();
        expect(proposals).toHaveLength(1);
        expect(proposals[0].input).toMatchObject({
          action: "append_deliverable",
          targetName: "Launch",
          deliverableName: "Launch follow-up",
          dependencyItemIds: ["item-first"],
          sourceUrls: ["https://example.com/approved-source"],
          attachmentIds: [],
          appendParseReceipt: {
            grammarVersion: "append-v1",
            normalizedText: message,
            consumedText: message,
          },
        });
        expect((await (await import("@/lib/campaigns/repository")).currentPlan(base.planRef.id)).ref.revision).toBe(1);
      });
    }, 20_000);

    for (const [label, clause] of [
      ["only-when", "only when item-first succeeds."],
      ["do-not-begin", "do not begin until item-first is completed."],
    ] as const) {
      it(`durably blocks the unconsumed ${label} clause on ${surface}`, async () => {
        await runWithTenant(tenant(surface), async () => {
          const base = await setupCampaign();
          const message = `Add an X post called "Launch follow-up" to campaign "Launch" at 2026-09-14T12:00:00Z, ${clause}`;
          const response = await handleChat(new Request("http://localhost/api/chat", {
            method: "POST",
            body: JSON.stringify({ surface, conversationId: `${surface}-${label}`, requestId: randomUUID(), message }),
          }));
          const body = await response.json() as Record<string, unknown>;
          expect(response.status, JSON.stringify(body)).toBe(200);
          expect(body.intent).toBe("append_deliverable");
          expect(String(body.reply)).toContain("unsupported or unconsumed clause");
          expect(String(body.reply)).toContain("No plan revision was created");

          const campaigns = await import("@/lib/campaigns/repository");
          expect((await campaigns.currentPlan(base.planRef.id)).itemRefs).toEqual(base.itemRefs);
          expect(await listJobs()).toHaveLength(0);
          const proposals = await (await import("@/lib/planning/commands")).listPlanningProposals();
          expect(proposals).toHaveLength(1);
          expect(proposals[0].input).toMatchObject({
            action: "append_deliverable",
            message,
            appendParseReceipt: null,
            clarifyingQuestion: expect.stringContaining(clause.slice(0, -1)),
          });
        });
      }, 20_000);
    }
  }
});
