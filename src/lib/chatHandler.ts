import { z } from "zod";
import { requestAgentAnswer } from "@/lib/agentAskClient";
import { answerFromContext, fetchContextRecord, isValidContext, mockContextAnswer } from "@/lib/contextAnswer";
import { isMockAi } from "@/lib/chatIntent";
import {
  appendEvent,
  createJob,
  getJob,
  listAssets,
  listJobs,
  saveChatMessage,
  saveIngestMeta,
} from "@/lib/firestore";
import { currentTenant } from "@/lib/tenancy";
import { parseIntent } from "@/lib/chatIntent";
import { publishStage } from "@/lib/pubsub";
import { parseYouTubeUrl } from "@/lib/youtubeUrl";
import type { PlannedAction, PostDraft, Stage } from "@/lib/types";
import { requireReadyAttachments, type ChatAttachment } from "@/lib/chatAttachments";
import { actionPayloadDigest } from "@/lib/idempotency";
import { createPendingOperation, type PendingOperation } from "@/lib/pendingOperations";
import { hasRightsAttestation, RIGHTS_ATTESTATION_PHRASE, sourceRightsAuthorization } from "@/lib/sourceRights";

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
  attachmentIds: z.array(z.string().min(1)).max(20).default([]),
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
type AnyJob = FullJob | Awaited<ReturnType<typeof createJob>>;
type ApprovalJob = Pick<FullJob, "id" | "stage" | "status" | "ingestedTitle" | "failure" | "actions">;

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
      const videoId = intent.youtubeUrl ? parseYouTubeUrl(intent.youtubeUrl) : null;
      const media = attachments.find((attachment) => attachment.category === "video" || attachment.category === "audio");
      if (media) {
        if (!hasRightsAttestation(message)) return { payload: {
          intent: intent.intent,
          reply: `Before processing this upload, send the request again with: “${RIGHTS_ATTESTATION_PHRASE}”.`,
        } satisfies ChatResponse };
        const job = await createJob({
          mediaAttachmentId: media.id,
          mediaFilename: media.filename,
          mediaMime: media.mime,
          mediaStorageUri: media.storageUri,
          sourceRights: sourceRightsAuthorization(currentTenant(), "upload"),
          platforms: ["x"],
        }, "ingest");
        await appendEvent(job.id, "queued", `job created via ${surface} chat for uploaded ${media.category}`, "operator");
        await publishStage(currentTenant(), job.id, "ingest");
        return { payload: {
          intent: intent.intent,
          reply: `Created job ${job.id} from ${media.filename}. The pipeline is running and will stop at the approval gate before any external action.`,
          jobId: job.id,
          job: toCard(job),
        } satisfies ChatResponse };
      }
      if (videoId) {
        if (!hasRightsAttestation(message)) return { payload: {
          intent: intent.intent,
          reply: `Before downloading or clipping this video, send the request again with: “${RIGHTS_ATTESTATION_PHRASE}”.`,
        } satisfies ChatResponse };
        const job = await createJob(
          { youtubeUrl: intent.youtubeUrl as string, platforms: ["x"], sourceRights: sourceRightsAuthorization(currentTenant(), "youtube") },
          "ingest",
        );
        await appendEvent(job.id, "queued", `job created via ${surface} chat for video ${videoId}`, "operator");
        await publishStage(currentTenant(), job.id, "ingest");
        return { payload: {
          intent: intent.intent,
          reply: `Created job ${job.id} for video ${videoId}. Pipeline is running: ingest → transcribe → understand → draft. I'll pause at the approval gate before anything is published.`,
          jobId: job.id,
          job: toCard(job),
        } satisfies ChatResponse };
      }
      if (intent.topic && intent.topic.length >= 20) {
        const title = intent.topic.length > 60 ? `${intent.topic.slice(0, 57)}...` : intent.topic;
        const job = await createJob({ brief: intent.topic, platforms: ["x"] }, "understand");
        await saveIngestMeta(job.id, { videoId: "brief", title, channel: "operator", durationSec: 0 });
        await appendEvent(job.id, "understand", `concept job created via ${surface} chat`, "operator");
        await publishStage(currentTenant(), job.id, "understand");
        return { payload: {
          intent: intent.intent,
          reply: `Created concept job ${job.id} from your brief. Running research + ideation + drafting — I'll pause at the approval gate before anything is published.`,
          jobId: job.id,
          job: toCard(job),
        } satisfies ChatResponse };
      }
      return { payload: {
        intent: intent.intent,
        reply: "Give me either a YouTube video URL or a topic to post about (a sentence or two works best).",
      } satisfies ChatResponse };
    }

    case "status": {
      if (intent.jobId) {
        const job = await getJob(intent.jobId);
        const reply = job.failure
          ? `Job ${job.id} failed at '${job.failure.stage}' (${job.failure.permanent ? "permanent" : "transient"}): ${job.failure.error}`
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
        const awaiting = jobs.filter((j) => j.stage === "awaiting_approval");
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
          const answer = await requestAgentAnswer(message);
          return { payload: {
            intent: "agent",
            reply: answer,
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
          "- \"approve job <id>\" (publishing still requires this explicit approval)",
      } satisfies ChatResponse };
    }
  }
}
