import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { handleChat } from "@/lib/chatHandler";
import { parseIntent, type ParsedIntent } from "@/lib/chatIntent";
import { awsRepository } from "@/lib/dynamo";
import { submitIntakeTurn } from "@/lib/intake/repository";
import { runWithTenant, type TenantContext } from "@/lib/tenancy";
import { decideStrategyProposal, insertStrategyProposal } from "@/lib/strategy/repository";
import { strategyDigest } from "@/lib/strategyApproval";
import { strategyFixture } from "./fixtures/strategy";

vi.mock("@/lib/chatIntent", () => ({ parseIntent: vi.fn() }));

const tenant = (workspaceId = `campaign-append-${randomUUID()}`, brandId = "brand-a"): TenantContext => ({
  workspaceId,
  brandId,
  principal: { kind: "cognito_user", subjectId: "operator", authenticationId: "auth", workspaceRole: "owner" },
});

const telegramTenant = (scope: TenantContext): TenantContext => ({
  ...scope,
  principal: {
    kind: "telegram_user", subjectId: "telegram-operator", authenticationId: "telegram-update",
    workspaceRole: "member", chatIdDigest: "a".repeat(64), callbackQueryIdDigest: "b".repeat(64),
  },
});

async function setupStrategyAndPolicy() {
  const strategy = strategyFixture("append-direction");
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
}

async function createCampaign(name: string) {
  const commands = await import("@/lib/planning/commands");
  const requestId = randomUUID();
  const draft = await submitIntakeTurn({
    requestId, conversationId: randomUUID(), surface: "dashboard",
    message: `Create the first creative invitation for ${name}.`,
    advice: {
      action: "create_job", disposition: "new_initiative", expectedOutcome: `Open ${name}`,
      requestedOutputs: ["x_post"], sourceHandles: [], targetName: name,
    },
  });
  return commands.materializeIntake({ draftId: draft.id, expectedDraftRevision: draft.revision, requestId });
}

async function send(surface: "dashboard" | "telegram", requestId: string, message: string, intent: ParsedIntent) {
  vi.mocked(parseIntent).mockResolvedValueOnce(intent);
  const response = await handleChat(new Request("http://localhost/api/chat", {
    method: "POST", body: JSON.stringify({ surface, conversationId: `${surface}-append`, requestId, message }),
  }));
  return { response, body: await response.json() as Record<string, unknown> };
}

const appendIntent = (targetName: string, name = "Founder follow-up"): ParsedIntent => ({
  intent: "append_deliverable", workPlacement: "existing_plan_item", targetName,
  userOutcome: `Add ${name}`, deliverableName: name, desiredOutputs: ["x_post"],
  platformRecommendations: ["x"], scheduledFor: "2000-09-13T12:00:00Z",
  dependencyItemIds: [], requiredAssetIds: [], sources: [],
});

describe.skipIf(!process.env.AWS_LOCAL_ENDPOINT)("campaign append conversational surface", () => {
  for (const surface of ["dashboard", "telegram"] as const) {
    it(`appends, replays, schedules, and dispatches the exact campaign plan on ${surface}`, async () => {
      const scope = tenant();
      await runWithTenant(scope, async () => {
        await setupStrategyAndPolicy();
        const base = await createCampaign("Launch");
        const routedScope = surface === "telegram" ? telegramTenant(scope) : scope;
        const requestId = randomUUID();
        const message = 'Add an X post called "Founder follow-up" to campaign "Launch" at 2000-09-13T12:00:00Z.';

        const first = await runWithTenant(routedScope, () => send(surface, requestId, message, appendIntent("Launch")));
        expect(first.response.status, JSON.stringify(first.body)).toBe(200);
        expect(first.body).toMatchObject({ intent: "append_deliverable" });

        const campaigns = await import("@/lib/campaigns/repository");
        const plan = await campaigns.currentPlan(base.planRef.id);
        expect(plan.ref.revision).toBe(2);
        const appendedRef = plan.itemRefs.find(ref => !base.itemRefs.some(baseRef => baseRef.id === ref.id));
        expect(appendedRef).toBeDefined();
        const appended = await campaigns.readPlannedItem(appendedRef!);
        expect(appended).toMatchObject({
          name: "Founder follow-up", scheduledFor: "2000-09-13T12:00:00.000Z",
          requestedOutputs: ["x_post"], channel: "x", campaignRef: base.campaignRef,
        });

        const replay = await runWithTenant(routedScope, () => send(surface, requestId, message, appendIntent("Launch")));
        expect(replay.body).toEqual(first.body);
        expect((await campaigns.currentPlan(base.planRef.id)).ref.revision).toBe(2);

        const advance = await runWithTenant(routedScope, () => send(surface, randomUUID(), "Advance the Launch campaign", {
          intent: "advance_plan", targetName: "Launch", userOutcome: "Run the next due campaign item",
        }));
        expect(advance.response.status, JSON.stringify(advance.body)).toBe(200);
        const state = await campaigns.readItemState(appendedRef!);
        expect(state).toMatchObject({ status: "running", jobId: expect.any(String), outboxId: expect.any(String) });
      });
    });
  }

  it("rejects stale revisions and a reused request identity without another plan revision", async () => {
    await runWithTenant(tenant(), async () => {
      await setupStrategyAndPolicy();
      const base = await createCampaign("Launch");
      const requestId = randomUUID();
      const first = await send("dashboard", requestId, `Add an X post called "Founder follow-up" to plan "${base.planRef.id}" at 2000-09-13T12:00:00Z.`, appendIntent(base.planRef.id));
      expect(first.response.status).toBe(200);
      const changed = await send("dashboard", requestId, `Add an X post called "Changed follow-up" to plan "${base.planRef.id}" at 2000-09-13T12:00:00Z.`, appendIntent(base.planRef.id, "Changed follow-up"));
      expect(changed.response.status).toBe(502);
      expect(String(changed.body.error)).toContain("identity reused");

      const commands = await import("@/lib/planning/commands");
      await expect(commands.addPlannedDeliverable({
        planId: base.planRef.id, expectedRevision: 1, requestId: randomUUID(), name: "Stale",
        operatorBrief: "A stale append must not land.", requestedOutputs: ["x_post"], channel: "x",
        scheduledFor: "2000-09-20T12:00:00Z", dependencies: [], requiredAssetIds: [],
      })).rejects.toThrow("stale plan revision");
      expect((await (await import("@/lib/campaigns/repository")).currentPlan(base.planRef.id)).ref.revision).toBe(2);
    });
  });

  it("does not mutate when a campaign target is ambiguous or belongs to another tenant", async () => {
    const owner = tenant();
    let planId = "";
    await runWithTenant(owner, async () => {
      await setupStrategyAndPolicy();
      const first = await createCampaign("Launch");
      await createCampaign("Launch");
      planId = first.planRef.id;
      const ambiguous = await send("dashboard", randomUUID(), "Add a follow-up to Launch", appendIntent("Launch"));
      expect(ambiguous.response.status).toBe(200);
      expect(String(ambiguous.body.reply)).toContain("exactly one current campaign or plan");
      expect((await (await import("@/lib/campaigns/repository")).currentPlan(planId)).ref.revision).toBe(1);
    });

    const outsider = tenant(owner.workspaceId, "brand-b");
    await runWithTenant(outsider, async () => {
      const result = await send("dashboard", randomUUID(), "Add a follow-up to that plan", appendIntent(planId));
      expect(result.response.status).toBe(200);
      expect(String(result.body.reply)).toContain("exactly one current campaign or plan");
    });
    await runWithTenant(owner, async () => {
      expect((await (await import("@/lib/campaigns/repository")).currentPlan(planId)).ref.revision).toBe(1);
    });
  });

  it("persists or visibly rejects source, attachment, and asset constraints instead of dropping them", async () => {
    await runWithTenant(tenant(), async () => {
      await setupStrategyAndPolicy();
      const base = await createCampaign("Launch");
      const campaigns = await import("@/lib/campaigns/repository");
      const commands = await import("@/lib/planning/commands");

      const droppedSource = await send(
        "dashboard",
        randomUUID(),
        'Add an X post called "Source follow-up" to campaign "Launch" at 2026-09-14T12:00:00Z using https://example.com/source.',
        appendIntent("Launch", "Source follow-up"),
      );
      expect(String(droppedSource.body.reply)).toContain("source URL constraints were not preserved exactly");

      const attachment = await commands.executePlanningChat({
        action: "append_deliverable", requestId: randomUUID(), targetName: "Launch",
        message: 'Add an X post called "Attachment follow-up" to campaign "Launch" at 2026-09-15T12:00:00Z.',
        deliverableName: "Attachment follow-up", requestedOutputs: ["x_post"], channel: "x",
        scheduledFor: "2026-09-15T12:00:00Z", dependencyItemIds: [], requiredAssetIds: [],
        sourceUrls: [], attachmentIds: ["attachment-ready"],
      });
      expect(attachment.outcome).toBe("proposal");
      expect(attachment.reply).toContain("attachments require source-rights and evidence binding");

      const asset = await commands.executePlanningChat({
        action: "append_deliverable", requestId: randomUUID(), targetName: "Launch",
        message: 'Add an X post called "Asset follow-up" to campaign "Launch" at 2026-09-16T12:00:00Z, using asset "asset-missing".',
        deliverableName: "Asset follow-up", requestedOutputs: ["x_post"], channel: "x",
        scheduledFor: "2026-09-16T12:00:00Z", dependencyItemIds: [], requiredAssetIds: ["asset-missing"],
        sourceUrls: [], attachmentIds: [],
      });
      expect(asset.outcome).toBe("proposal");
      expect(asset.reply).toContain("required asset IDs must resolve in this workspace");
      expect((await campaigns.currentPlan(base.planRef.id)).ref.revision).toBe(1);

      const proposals = await commands.listPlanningProposals();
      expect(proposals.map(proposal => proposal.input)).toEqual(expect.arrayContaining([
        expect.objectContaining({ attachmentIds: ["attachment-ready"] }),
        expect.objectContaining({ requiredAssetIds: ["asset-missing"] }),
      ]));
    });
  });
});
