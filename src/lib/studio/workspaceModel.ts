import type { JobFull, PlannedAction, PostDraft, Receipt } from "@/components/jobTypes";
import type { Angle, Moment } from "@/lib/types";

export type StudioMediaKind = "visual" | "motion" | "audio";

export interface StudioAsset {
  actionId: string;
  kind: StudioMediaKind;
  mime: string;
  title: string;
  sizeBytes: number;
  digest: string;
  provider?: "veo" | "lyria";
  momentId?: string;
  momentTitle?: string;
  startSec?: number;
  endSec?: number;
  cropSuitability?: "poor" | "fair" | "good" | "excellent";
  captionSafeRegion?: string;
}

export interface TraceLink {
  draftId?: string;
  actionId?: string;
  momentId?: string;
  angleId?: string;
  sourceSegmentIds: string[];
  valid: boolean;
  error?: string;
}

export interface StudioWorkspaceSources {
  normalizedSources: NonNullable<JobFull["normalizedSources"]>;
  moments: Moment[];
  angles: Angle[];
  receipts: Receipt[];
  unsupportedAssets: Array<NonNullable<JobFull["assets"]>[number]>;
}

export interface StudioWorkspaceModel {
  written: PostDraft[];
  visual: StudioAsset[];
  motion: StudioAsset[];
  audio: StudioAsset[];
  sources: StudioWorkspaceSources;
  pendingActions: PlannedAction[];
  failedActions: PlannedAction[];
  verifiedCount: number;
  traceLinks: TraceLink[];
}

function providerFor(type: PlannedAction["type"]): StudioAsset["provider"] {
  if (type === "generate_veo_broll") return "veo";
  if (type === "generate_lyria_soundtrack") return "lyria";
  return undefined;
}

function kindForMime(mime: string): StudioMediaKind | null {
  if (mime.startsWith("image/")) return "visual";
  if (mime.startsWith("video/")) return "motion";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

function sourceSegmentsForMoment(job: JobFull, momentId: string): string[] {
  return job.sourceAnalysis?.moments.find((candidate) => candidate.id === momentId)?.sourceSegmentRefs ?? [];
}

function traceForReference(
  job: JobFull,
  reference: { draftId?: string; actionId?: string; momentId?: string; angleId?: string },
): TraceLink {
  const moments = job.sourceAnalysis?.moments ?? [];
  const angles = job.sourceAnalysis?.angles ?? [];
  if (reference.momentId && !moments.some((moment) => moment.id === reference.momentId)) {
    return { ...reference, sourceSegmentIds: [], valid: false, error: `moment ${reference.momentId} not found` };
  }
  if (reference.angleId && !angles.some((angle) => angle.id === reference.angleId)) {
    return { ...reference, sourceSegmentIds: [], valid: false, error: `angle ${reference.angleId} not found` };
  }
  return {
    ...reference,
    sourceSegmentIds: reference.momentId ? sourceSegmentsForMoment(job, reference.momentId) : [],
    valid: true,
  };
}

export function buildStudioWorkspace(job: JobFull, receipts: Receipt[]): StudioWorkspaceModel {
  const moments = job.sourceAnalysis?.moments ?? [];
  const angles = job.sourceAnalysis?.angles ?? [];
  const actions = new Map(job.actions.map((action) => [action.id, action]));
  const visual: StudioAsset[] = [];
  const motion: StudioAsset[] = [];
  const audio: StudioAsset[] = [];
  const unsupportedAssets: StudioWorkspaceSources["unsupportedAssets"] = [];

  for (const asset of job.assets ?? []) {
    const action = actions.get(asset.actionId);
    const kind = kindForMime(asset.mime);
    if (!kind) {
      unsupportedAssets.push(asset);
      continue;
    }
    const studioAsset: StudioAsset = {
      actionId: asset.actionId,
      kind,
      mime: asset.mime,
      title: action?.title ?? asset.actionId,
      sizeBytes: asset.sizeBytes,
      digest: asset.digest,
      ...(action ? { provider: providerFor(action.type) } : {}),
      ...(action?.momentId ? (() => {
        const moment = moments.find((candidate) => candidate.id === action.momentId);
        return moment ? {
          momentId: moment.id,
          momentTitle: moment.title,
          startSec: moment.startSec,
          endSec: moment.endSec,
          cropSuitability: moment.cropSuitability,
          captionSafeRegion: moment.captionSafeRegion,
        } : { momentId: action.momentId };
      })() : {}),
    };
    if (kind === "visual") visual.push(studioAsset);
    if (kind === "motion") motion.push(studioAsset);
    if (kind === "audio") audio.push(studioAsset);
  }

  const traceLinks = [
    ...job.drafts.map((draft) => traceForReference(job, {
      draftId: draft.id,
      ...(draft.momentId ? { momentId: draft.momentId } : {}),
      ...(draft.angleId ? { angleId: draft.angleId } : {}),
    })),
    ...job.actions
      .filter((action) => action.momentId || action.angleId)
      .map((action) => traceForReference(job, {
        actionId: action.id,
        ...(action.momentId ? { momentId: action.momentId } : {}),
        ...(action.angleId ? { angleId: action.angleId } : {}),
      })),
  ];

  return {
    written: job.drafts,
    visual,
    motion,
    audio,
    sources: { normalizedSources: job.normalizedSources ?? [], moments, angles, receipts, unsupportedAssets },
    pendingActions: job.actions.filter((action) => action.state === "planned" && action.approvalState === "pending"),
    failedActions: job.actions.filter((action) => action.state === "failed"),
    verifiedCount: (job.verifications ?? []).filter((verification) => verification.verified).length,
    traceLinks,
  };
}
