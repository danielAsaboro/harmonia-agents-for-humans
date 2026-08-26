import type { ChatResponse } from "@/app/api/chat/route";
import type { JobFull, Receipt } from "@/components/jobTypes";
import { uiContextSchema, type UiContext } from "./presentationContracts";

interface BuildUiContextInput {
  runId: string;
  message: string;
  response: ChatResponse;
  job?: JobFull | null;
  receipts: Receipt[];
}

function mediaKind(mime: string): "image" | "video" | "audio" | "document" | "other" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf" || mime.startsWith("text/")) return "document";
  return "other";
}

function sourceKind(job: JobFull): "written" | "video" | "audio" | "mixed" {
  const hasWritten = Boolean(job.config.brief);
  const hasVideo = Boolean(job.config.youtubeUrl) || job.config.mediaMime?.startsWith("video/") === true;
  const hasAudio = job.config.mediaMime?.startsWith("audio/") === true;
  if (hasWritten && (hasVideo || hasAudio)) return "mixed";
  if (hasVideo) return "video";
  if (hasAudio) return "audio";
  return "written";
}

function clock(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(value / 60).toString().padStart(2, "0");
  const remainder = (value % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function receiptIsVerified(job: JobFull, receipt: Receipt): boolean {
  return (job.verifications ?? []).some((verification) => {
    const candidate = verification as typeof verification & { actionId?: string };
    return verification.verified && (
      candidate.actionId === receipt.actionId
      || Boolean(receipt.artifact?.digest && verification.evidence.digest === receipt.artifact.digest)
    );
  });
}

export function buildUiContext(input: BuildUiContextInput): UiContext {
  const { job, response } = input;
  const responseJob = response.job;
  const actions = job
    ? job.actions.slice(0, 20).map((action) => ({
      id: action.id,
      type: action.type,
      pending: action.approvalState === "pending" && action.state === "planned",
    }))
    : (response.pendingActions ?? []).slice(0, 20).map((action) => ({
      id: action.id,
      type: action.type,
      pending: true,
    }));
  const sources = job ? [
    ...(job.config.youtubeUrl ? [{
      id: "source-video",
      kind: "video" as const,
      label: (job.ingestedTitle || "Source video").slice(0, 300),
    }] : []),
    ...(job.config.mediaAttachmentId ? [{
      id: "source-upload",
      kind: (job.config.mediaMime?.startsWith("audio/") ? "audio" : "media") as "audio" | "media",
      label: (job.config.mediaFilename || "Uploaded source").slice(0, 300),
    }] : []),
    ...job.transcriptSegments.slice(0, 48).map((segment) => ({
      id: segment.id,
      kind: "transcript" as const,
      label: `Transcript ${clock(segment.startSec)}–${clock(segment.endSec)}`,
    })),
  ].slice(0, 50) : [];

  return uiContextSchema.parse({
    runId: input.runId,
    operatorRequest: input.message,
    intent: response.intent,
    job: job ? {
      id: job.id,
      stage: job.stage,
      status: job.status,
      ...(job.ingestedTitle ? { title: job.ingestedTitle.slice(0, 300) } : {}),
      sourceKind: sourceKind(job),
    } : responseJob ? {
      id: responseJob.id,
      stage: responseJob.stage,
      status: responseJob.status,
      ...(responseJob.title ? { title: responseJob.title.slice(0, 300) } : {}),
      sourceKind: "written" as const,
    } : null,
    drafts: (job?.drafts ?? response.drafts ?? []).slice(0, 20).map((draft) => ({
      id: draft.id,
      platform: draft.platform,
      valid: draft.valid,
      ...(draft.momentId ? { momentId: draft.momentId } : {}),
      ...(draft.angleId ? { angleId: draft.angleId } : {}),
    })),
    moments: (job?.sourceAnalysis?.moments ?? []).slice(0, 20).map((moment) => ({
      id: moment.id,
      title: moment.title.slice(0, 300),
      startSec: moment.startSec,
      endSec: moment.endSec,
    })),
    sources,
    assets: (job?.assets ?? response.assets ?? []).slice(0, 20).map((asset) => ({
      actionId: asset.actionId,
      kind: mediaKind(asset.mime),
      mime: asset.mime,
    })),
    actions,
    receipts: input.receipts.slice(0, 20).map((receipt) => ({
      id: receipt.id,
      actionId: receipt.actionId,
      outcome: receipt.outcome,
      verified: job ? receiptIsVerified(job, receipt) : false,
    })),
  });
}
