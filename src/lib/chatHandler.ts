import { z } from "zod";
import { requestAgentAnswer } from "@/lib/agentAskClient";
import { answerFromContext, fetchContextRecord, isValidContext, mockContextAnswer } from "@/lib/contextAnswer";
import { isMockAi } from "@/lib/chatIntent";
import {
  appendEvent,
  getJob,
  listAssets,
  listJobs,
  saveChatMessage,
} from "@/lib/firestore";
import { currentTenant } from "@/lib/tenancy";
import { parseIntent } from "@/lib/chatIntent";
import { queueStageTrigger } from "@/lib/stageTrigger";
import type { Job, PlannedAction, PostDraft, SourceInput, Stage } from "@/lib/types";
import { requireReadyAttachments, type ChatAttachment } from "@/lib/chatAttachments";
import { actionPayloadDigest } from "@/lib/idempotency";
import { createPendingOperation, type PendingOperation } from "@/lib/pendingOperations";
import { hasRightsAttestation, RIGHTS_ATTESTATION_PHRASE, sourceRightsAuthorization, sourceRightsAuthorizationId } from "@/lib/sourceRights";
import { createSourceJob } from "@/lib/sourceManifest";

const chatSchema = z.object({
  message: z.string().min(1).max(2000),
  surface: z.enum(["dashboard", "telegram"]).default("dashboard"),
  conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).default("primary"),
  /** Grounded Q&A about one record ("chat with any item"). */
  context: z
    .object({
      kind: z.enum(["job", "content_item", "proposal"]),
      id: z.string().min(1),
    })
    .optional(),
  attachmentIds: z.array(z.string().min(1)).max(10).default([]),
});

export interface JobCard {
  id: string;
  stage: Stage;
  status: string;
  title?: string;
  failure?: { stage: Stage; error: string; permanent: boolean };
}

export interface PendingActionSummary {
  id: string;
  title: string;
  type: string;
  risk: string;
  payloadDigest: string;
}

export interface ChatAsset {
  actionId: string;
  mime: string;
}

export interface ChatAttachmentSummary {
  attachmentId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  state: "ready";
  previewUrl: string;
}

export interface ChatResponse {
  intent: string;
  reply: string;
  job?: JobCard;
  jobs?: JobCard[];
  drafts?: PostDraft[];
  pendingActions?: PendingActionSummary[];
  /** Media produced by the referenced job, so conversations render richly. */
  assets?: ChatAsset[];
  attachments?: ChatAttachmentSummary[];
  confirmation?: { operationId: string; payloadDigest: string };
  jobId?: string;
  /** Durable stream run linked to a persisted assistant message. */
  chatRunId?: string;
}

type FullJob = Awaited<ReturnType<typeof getJob>>;
type AnyJob = Pick<Job, "id" | "stage" | "status" | "ingestedTitle" | "failure">;
type ApprovalJob = Pick<FullJob, "id" | "stage" | "status" | "ingestedTitle" | "failure" | "actions" | "contentStrategy" | "strategyDigest" | "strategyApprovalState">;

function toCard(job: AnyJob): JobCard {
  return {
    id: job.id,
    stage: job.stage,
    status: job.status,
    title: job.ingestedTitle,
    failure: job.failure
      ? { stage: job.failure.stage, error: job.failure.error, permanent: job.failure.permanent }
      : undefined,
  };
}

function pendingOf(job: FullJob): PlannedAction[] {
  return job.actions.filter((a) => a.approvalState === "pending" && a.state === "planned");
}

function summarizeActions(actions: PlannedAction[]): PendingActionSummary[] {
  return actions.map((a) => ({
    id: a.id,
    title: a.title,
    type: a.type,
    risk: a.risk,
    payloadDigest: actionPayloadDigest(a),
  }));
}

export async function buildApprovalConfirmation(
  job: ApprovalJob,
  surface: "dashboard" | "telegram",
  createOperation: typeof createPendingOperation = createPendingOperation,
): Promise<ChatResponse> {
  const pending = pendingOf(job as FullJob);
  const strategyPending = job.stage === "awaiting_strategy_approval" && job.strategyApprovalState === "pending" && job.contentStrategy && job.strategyDigest;
  if (strategyPending) {
    const summary: PendingActionSummary = {
      id: "strategy", title: `Ryan strategy v${job.contentStrategy!.version}`,
      type: "content_strategy", risk: "material", payloadDigest: job.strategyDigest!,
    };
    if (surface === "telegram") return {
      intent: "approve", reply: `Job ${job.id} has Ryan's four-week strategy waiting for digest-bound approval.`,
      jobId: job.id, job: toCard(job as FullJob), pendingActions: [summary],
    };
    const operation = await createOperation({
      handler: "decide_strategy", title: `Decide: ${summary.title}`,
      description: job.contentStrategy!.thesis, risk: "material",
      arguments: { jobId: job.id, actionId: "strategy", payloadDigest: job.strategyDigest },
    }) as Pick<PendingOperation, "id">;
    return {
      intent: "approve", reply: `Review Ryan's strategy for job ${job.id}, then use the explicit confirmation control.`,
      jobId: job.id, job: toCard(job as FullJob), pendingActions: [summary],
      confirmation: { operationId: operation.id, payloadDigest: job.strategyDigest! },
    };
  }
  if (pending.length === 0) {
    return {
      intent: "approve",
      reply: `Job ${job.id} has no pending approvals (stage: ${job.stage}).`,
      jobId: job.id,
      job: toCard(job as FullJob),
    };
  }
  if (surface === "telegram") {
    return {
      intent: "approve",
      reply: `Job ${job.id} has ${pending.length} pending action(s). Use the verified inline confirmation:`,
      jobId: job.id,
      job: toCard(job as FullJob),
      pendingActions: summarizeActions(pending),
    };
  }
  const target = pending[0];
  const payloadDigest = actionPayloadDigest(target);
  const operation = await createOperation({
    handler: "decide_job_action",
    title: `Decide: ${target.title}`,
    description: target.description,
    risk: target.risk === "high" ? "high" : target.risk === "low" ? "low" : "material",
    arguments: { jobId: job.id, actionId: target.id, payloadDigest },
  }) as Pick<PendingOperation, "id">;
  return {
    intent: "approve",
    reply: `Review '${target.title}' for job ${job.id}, then use the explicit confirmation control.`,
    jobId: job.id,
    job: toCard(job as FullJob),
    pendingActions: summarizeActions(pending),
    confirmation: { operationId: operation.id, payloadDigest },
  };
}

async function assetsOf(jobId: string) {
  try {
    const assets = await listAssets(jobId);
    if (assets.length === 0) return undefined;
    return assets.map((a) => ({ actionId: a.actionId, mime: a.mime }));
  } catch {
    return undefined;
  }
}

export async function handleChat(req: Request, options: { chatRunId?: string } = {}): Promise<Response> {
  const body = await req.json().catch(() => null);
  const parsed = chatSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "invalid chat payload" }, { status: 400 });
  }
  const { message, surface, conversationId, context, attachmentIds } = parsed.data;

  let attachments: ChatAttachment[] = [];
  try {
    attachments = await requireReadyAttachments(attachmentIds);
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 409 });
  }

  let payload: ChatResponse;
  let status = 200;
  try {
    const result = await buildResponse(req, message, surface, context, attachments);
    if ("__http" in result) return result.__http; // e.g. operator forbidden
    payload = result.payload;
    status = result.status ?? 200;
  } catch (e) {
    return Response.json(
      { error: `chat failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  // Persist the exchange so past conversations render in the console.
  // JSON round-trip drops undefined fields (e.g. titles not yet ingested),
  // which Firestore rejects.
  try {
    await saveChatMessage({
      surface,
      conversationId,
      role: "user",
      text: message,
      data: attachments.length ? {
        attachments: attachments.map((attachment) => ({
          attachmentId: attachment.id,
          filename: attachment.filename,
          mime: attachment.mime,
          sizeBytes: attachment.sizeBytes,
          state: "ready",
          previewUrl: `/api/chat/attachments/${attachment.id}`,
        })),
      } : undefined,
    });
    await saveChatMessage({
      surface,
      conversationId,
      role: "assistant",
      text: payload.reply,
      data: JSON.parse(JSON.stringify({
        ...payload,
        ...(options.chatRunId ? { chatRunId: options.chatRunId } : {}),
      })) as Record<string, unknown>,
    });
  } catch (e) {
    console.error("chat history persistence failed:", e);
  }

  return Response.json(payload, { status });
}

type HandlerResult =
  | { payload: ChatResponse; status?: number }
  | { __http: Response };

async function buildResponse(req: Request, message: string, surface: "dashboard" | "telegram", context?: { kind: "job" | "content_item" | "proposal"; id: string }, attachments: ChatAttachment[] = []): Promise<HandlerResult> {

  // Grounded Q&A about a specific record ("chat with any item").
  if (context && isValidContext(context)) {
    const record = await fetchContextRecord(context);
    if (!record) {
      return { payload: {
        intent: "context_qa",
        reply: `I could not find that ${context.kind.replace("_", " ")} (${context.id}). It may have been removed.`,
      } satisfies ChatResponse };
    }
    let reply: string;
    try {
      reply = isMockAi()
        ? mockContextAnswer(message, record, context.kind)
        : await answerFromContext(message, record);
    } catch (e) {
      return { payload: {
        intent: "context_qa",
        reply: `Contextual answer failed: ${e instanceof Error ? e.message : String(e)}`,
      } satisfies ChatResponse };
    }
    return { payload: {
      intent: "context_qa",
      reply,
      jobId: context.kind === "job" ? context.id : undefined,
    } satisfies ChatResponse as ChatResponse };
  }

  let intent;
  try {
    const attachmentContext = attachments.length
      ? `\n\nAttached files: ${attachments.map((attachment) => `${attachment.filename} (${attachment.mime})`).join(", ")}`
      : "";
    intent = await parseIntent(`${message}${attachmentContext}`);
  } catch (e) {
    return { __http: Response.json(
      { error: `intent parsing failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    ) };
  }

  switch (intent.intent) {
    case "create_job": {
      const descriptors = intent.sources ?? [];
      const needsRightsAttestation = attachments.length > 0 || descriptors.some((source) => source.kind === "youtube");
      if (needsRightsAttestation && !hasRightsAttestation(message)) return { payload: { intent: intent.intent, reply: `Before processing uploaded or YouTube media, send the request again with: “${RIGHTS_ATTESTATION_PHRASE}”.` } satisfies ChatResponse };
      const directSources: SourceInput[] = [];
      for (const attachment of attachments) {
        const authorization = sourceRightsAuthorization(currentTenant(), "upload");
        directSources.push({ kind: "upload", attachmentId: attachment.id, rightsAuthorizationId: sourceRightsAuthorizationId(authorization) });
      }
      for (const source of descriptors) {
        const authorization = sourceRightsAuthorization(currentTenant(), source.kind);
        const rightsAuthorizationId = sourceRightsAuthorizationId(authorization);
        if (source.kind === "pasted_text") directSources.push({ ...source, rightsAuthorizationId });
        else directSources.push({ ...source, rightsAuthorizationId });
      }
      if (directSources.length) {
        const desiredOutputs = intent.desiredOutputs?.length ? intent.desiredOutputs : ["x_post" as const];
        const job = await createSourceJob({ directSources, desiredOutputs, allowedOutputs: desiredOutputs, platforms: ["x"] });
        await appendEvent(job.id, "collect_sources", `source manifest created via ${surface} chat`, "operator");
        await queueStageTrigger(job.id, "collect_sources");
        return { payload: { intent: intent.intent, reply: `Created job ${job.id} with ${directSources.length} source${directSources.length === 1 ? "" : "s"}. Harmonia is collecting and extracting them; any partial failure will pause for resolution before analysis.`, jobId: job.id, job: toCard(job) } satisfies ChatResponse };
      }
      return { payload: {
        intent: intent.intent,
        reply: "Add at least one source: a YouTube or public web URL, an uploaded file, or pasted factual context.",
      } satisfies ChatResponse };
    }

    case "status": {
      if (intent.jobId) {
        const job = await getJob(intent.jobId);
        const reply = job.failure
          ? `Job ${job.id} failed at '${job.failure.stage}' (${job.failure.permanent ? "permanent" : "transient"}): ${job.failure.error}`
          : job.stage === "awaiting_strategy_approval"
            ? `Job ${job.id} is waiting for approval of Ryan's strategy digest ${job.strategyDigest ?? "(missing)"}.`
            : job.stage === "awaiting_approval"
            ? `Job ${job.id} is waiting for your approval on ${pendingOf(job).length} action(s).`
            : `Job ${job.id} is at stage '${job.stage}' (${job.status}).`;
        return { payload: {
          intent: intent.intent,
          reply,
          jobId: job.id,
          job: toCard(job),
          pendingActions: job.stage === "awaiting_approval" ? summarizeActions(pendingOf(job)) : undefined,
          assets: await assetsOf(job.id),
        } satisfies ChatResponse };
      }
      const jobs = await listJobs();
      return { payload: {
        intent: intent.intent,
        reply: jobs.length
          ? `${jobs.length} recent job(s), newest first:`
          : "No jobs yet. Send me a YouTube URL to create one.",
        jobs: jobs.slice(0, 5).map(toCard),
      } satisfies ChatResponse };
    }

    case "list_drafts": {
      if (!intent.jobId) {
        const jobs = await listJobs();
        return { payload: {
          intent: intent.intent,
          reply: "Which job? Recent jobs:",
          jobs: jobs.slice(0, 5).map(toCard),
        } satisfies ChatResponse };
      }
      const job = await getJob(intent.jobId);
      if (job.drafts.length === 0) {
        return { payload: {
          intent: intent.intent,
          reply: `Job ${job.id} has no drafts yet (stage: ${job.stage}).`,
          jobId: job.id,
          job: toCard(job),
        } satisfies ChatResponse };
      }
      return { payload: {
        intent: intent.intent,
        reply: `${job.drafts.length} drafted post(s) for "${job.ingestedTitle ?? job.id}":`,
        jobId: job.id,
        job: toCard(job),
        drafts: job.drafts,
        assets: await assetsOf(job.id),
      } satisfies ChatResponse };
    }

    case "approve": {
      const jobId = intent.jobId;
      let job = jobId ? await getJob(jobId) : null;

      if (!job) {
        const jobs = await listJobs();
        const awaiting = jobs.filter((j) => j.stage === "awaiting_approval" || j.stage === "awaiting_strategy_approval");
        if (awaiting.length === 1) {
          job = await getJob(awaiting[0].id);
        } else if (awaiting.length === 0) {
          return { payload: {
            intent: intent.intent,
            reply: "No jobs are currently awaiting approval.",
            jobs: jobs.slice(0, 5).map(toCard),
          } satisfies ChatResponse };
        } else {
          return { payload: {
            intent: intent.intent,
            reply: `${awaiting.length} jobs are awaiting approval — which one?`,
            jobs: awaiting.map(toCard),
          } satisfies ChatResponse };
        }
      }

      return { payload: await buildApprovalConfirmation(job, surface) };
    }

    default: {
      if (!isMockAi()) {
        try {
          const result = await requestAgentAnswer(message);
          const askJobId = result.operationId;
          for (const item of result.activity) {
            await appendEvent(askJobId, "learn", item.publicMessage, "agent", {
              operationId: result.operationId,
              traceId: result.traceId,
              activity: {
                kind: "tool_call",
                status: item.status,
                role: "nova_liaison",
                toolName: item.toolName,
                publicMessage: item.publicMessage,
                ...(item.code ? { code: item.code } : {}),
                ...(item.category ? { category: item.category } : {}),
                ...(item.retryable === undefined ? {} : { retryable: item.retryable }),
                attempt: item.sequence,
              },
            });
          }
          return { payload: {
            intent: "agent",
            reply: result.answer,
          } satisfies ChatResponse };
        } catch (error) {
          console.error("agent ask failed; falling back to guidance", error);
        }
      }
      return { payload: {
        intent: "unknown",
        reply:
          "I can run your Harmonia content pipeline. Try:\n" +
          "- \"make a job from https://youtu.be/<id>\"\n" +
          "- \"status of job <id>\" or \"status\"\n" +
          "- \"show drafts for <id>\"\n" +
          "- \"approve job <id>\" (strategy and publication effects have separate explicit approvals)",
      } satisfies ChatResponse };
    }
  }
}
