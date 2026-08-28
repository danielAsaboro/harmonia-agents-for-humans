import type { JobFull, Receipt } from "@/components/jobTypes";
import { HARMONIA_CATALOG_ID, parseCatalogComponent } from "./contracts";
import { surfacePlanSchema, type SurfaceComponentName, type SurfacePlan, type SurfaceSlot } from "./presentationContracts";
import { resolveNodeArtDirection, type PresentationLifecycle } from "./presentationPolicy";

export interface HydratedSurfaceSet {
  canvas: Record<string, unknown>[];
  conversation: Record<string, unknown>[];
  approval: Record<string, unknown>[];
}

interface HydrateSurfacePlanInput {
  runId: string;
  plan: SurfacePlan;
  job?: JobFull | null;
  receipts: Receipt[];
}

type PlannedSurface = SurfacePlan["surfaces"][number];
type PlannedNode = PlannedSurface["nodes"][number];
type CatalogRecord = Record<string, unknown> & { id: string; component: string };

const STAGES = ["queued", "ingest", "transcribe", "understand", "strategize", "awaiting_strategy_approval", "plan", "draft", "awaiting_approval", "publish", "verify", "learn", "complete"];

function isHttpUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function selected<T extends { id: string }>(values: T[], ids: string[], limit: number): T[] {
  if (ids.length === 0) return values.slice(0, limit);
  const wanted = new Set(ids);
  return values.filter((value) => wanted.has(value.id)).slice(0, limit);
}

function sourceCount(job: JobFull, momentId?: string, angleId?: string): number {
  const moment = momentId ? job.sourceAnalysis?.moments.find((candidate) => candidate.id === momentId) : undefined;
  return (moment?.transcriptSegmentRefs.length ?? 0)
    + (angleId && job.sourceAnalysis?.angles.some((angle) => angle.id === angleId) ? 1 : 0);
}

function hydratedDraft(job: JobFull, draft: JobFull["drafts"][number], selectedDraft: boolean) {
  return {
    id: draft.id,
    platform: draft.platform,
    text: draft.text,
    valid: draft.valid,
    ...(draft.validationNote ? { validationNote: draft.validationNote } : {}),
    ...(draft.momentId ? { momentId: draft.momentId } : {}),
    ...(draft.angleId ? { angleId: draft.angleId } : {}),
    selected: selectedDraft,
    sourceCount: sourceCount(job, draft.momentId, draft.angleId),
  };
}

function actionPreview(action: JobFull["actions"][number]): string | undefined {
  for (const key of ["text", "caption", "prompt", "markdown"] as const) {
    const value = action.payload[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 20_000);
  }
  return undefined;
}

function actionDestination(type: JobFull["actions"][number]["type"]): string {
  if (type === "publish_x_post") return "X";
  if (type === "export_content_pack") return "Content pack export";
  if (type === "render_clip" || type === "render_reel") return "Harmonia asset library";
  return "Harmonia working set";
}

function verificationFor(job: JobFull, receipt: Receipt) {
  return (job.verifications ?? []).find((verification) => {
    const candidate = verification as typeof verification & { actionId?: string };
    return candidate.actionId === receipt.actionId
      || Boolean(receipt.artifact?.digest && verification.evidence.digest === receipt.artifact.digest);
  });
}

function framing(
  surface: PlannedSurface,
  node: PlannedNode,
  fallbackTitle: string,
  component: SurfaceComponentName = node.component,
  lifecycle: PresentationLifecycle = {},
) {
  return {
    title: node.title || fallbackTitle,
    emphasis: node.emphasis,
    agentFraming: Boolean(node.title),
    children: node.children,
    ...resolveNodeArtDirection({ component, requested: node.artDirection, lifecycle }),
    surfaceRhythm: surface.artDirection.rhythm,
    surfaceComposition: surface.artDirection.composition,
    surfaceEnergy: surface.artDirection.energy,
    revision: surface.revision,
  };
}

function missingReferences(node: PlannedNode, job: JobFull | null | undefined, receipts: Receipt[]): string[] {
  if (!job) return [node.refs.jobId || "active-job"];
  const missing: string[] = [];
  if (node.refs.jobId && node.refs.jobId !== job.id) missing.push(node.refs.jobId);
  const maps = {
    draftIds: new Set(job.drafts.map((value) => value.id)),
    momentIds: new Set((job.sourceAnalysis?.moments ?? []).map((value) => value.id)),
    sourceIds: new Set([
      ...(job.config.youtubeUrl ? ["source-video"] : []),
      ...(job.config.mediaAttachmentId ? ["source-upload"] : []),
      ...job.transcriptSegments.map((value) => value.id),
    ]),
    assetActionIds: new Set((job.assets ?? []).map((value) => value.actionId)),
    actionIds: new Set(job.actions.map((value) => value.id)),
    receiptIds: new Set(receipts.map((value) => value.id)),
  };
  for (const key of Object.keys(maps) as Array<keyof typeof maps>) {
    for (const reference of node.refs[key]) {
      if (!maps[key].has(reference)) missing.push(reference);
    }
  }
  if ((node.component === "DraftComparison" || node.component === "PlatformPreview") && node.refs.draftIds.length === 0) missing.push("draftIds");
  if (node.component === "ApprovalReview" && node.refs.actionIds.length === 0) missing.push("actionIds");
  if (node.component === "VerificationReceipt" && node.refs.receiptIds.length === 0) missing.push("receiptIds");
  return [...new Set(missing)].slice(0, 100);
}

function unresolved(surface: PlannedSurface, node: PlannedNode, missingRefs: string[]): CatalogRecord {
  return parseCatalogComponent({
    id: node.id,
    component: "SurfaceUnresolved",
    ...framing(surface, node, "This view needs refreshed data", "SurfaceUnresolved"),
    message: "Harmonia could not resolve every requested item from the current persisted job state.",
    missingRefs,
  }) as CatalogRecord;
}

function hydrateNode(surface: PlannedSurface, node: PlannedNode, job: JobFull | null | undefined, receipts: Receipt[]): CatalogRecord {
  const missing = missingReferences(node, job, receipts);
  if (missing.length > 0 || !job) return unresolved(surface, node, missing.length ? missing : ["active-job"]);

  const base = { id: node.id, jobId: job.id, ...framing(surface, node, node.component) };
  switch (node.component) {
    case "CampaignBrief":
      return parseCatalogComponent({
        ...base,
        component: node.component,
        ...framing(surface, node, job.ingestedTitle || "Campaign direction"),
        brief: job.config.brief || "Build platform-native content from the selected source.",
        sourceKind: job.config.youtubeUrl || job.config.mediaMime?.startsWith("video/")
          ? (job.config.brief ? "mixed" : "video")
          : job.config.mediaMime?.startsWith("audio/")
            ? (job.config.brief ? "mixed" : "audio")
            : "written",
        platforms: job.config.platforms.slice(0, 10),
        angles: (job.sourceAnalysis?.angles ?? []).slice(0, 20),
      }) as CatalogRecord;
    case "JobProgress": {
      const current = Math.max(0, STAGES.indexOf(job.stage));
      return parseCatalogComponent({
        ...base,
        component: node.component,
        ...framing(surface, node, "Content workflow", node.component, { failed: job.status === "failed" }),
        stage: job.stage,
        status: job.status,
        stages: STAGES.map((stage, index) => ({
          id: stage,
          label: stage.replaceAll("_", " "),
          status: job.status === "failed" && stage === job.stage
            ? "failed"
            : index < current || job.stage === "complete"
              ? "complete"
              : index === current
                ? "active"
                : "pending",
        })),
      }) as CatalogRecord;
    }
    case "MomentExplorer": {
      const moments = selected(job.sourceAnalysis?.moments ?? [], node.refs.momentIds, 20);
      const selectedIds = new Set(moments.map((moment) => moment.id));
      const segmentIds = new Set(moments.flatMap((moment) => moment.transcriptSegmentRefs));
      const transcript = job.transcriptSegments.filter((segment) => (
        moments.length === 0 || segmentIds.has(segment.id)
      )).slice(0, 200);
      const source = job.config.youtubeUrl ? {
        id: "source-video",
        label: job.ingestedTitle || "Source video",
        kind: "video" as const,
        externalUrl: job.config.youtubeUrl,
        ...(typeof (job as JobFull & { ingestedDurationSec?: number }).ingestedDurationSec === "number"
          ? { durationSec: (job as JobFull & { ingestedDurationSec?: number }).ingestedDurationSec }
          : {}),
      } : job.config.mediaAttachmentId ? {
        id: "source-upload",
        label: job.config.mediaFilename || "Uploaded source",
        kind: job.config.mediaMime?.startsWith("audio/") ? "audio" as const : "media" as const,
        previewUrl: `/api/chat/attachments/${job.config.mediaAttachmentId}`,
      } : undefined;
      return parseCatalogComponent({
        ...base,
        component: node.component,
        ...framing(surface, node, "Clip-worthy moments"),
        ...(source ? { source } : {}),
        moments: moments.map((moment) => ({
          id: moment.id,
          title: moment.title,
          startSec: moment.startSec,
          endSec: moment.endSec,
          hook: moment.hook,
          quote: moment.quote,
          ...(moment.visualHook ? { visualHook: moment.visualHook } : {}),
          ...(moment.cropSuitability ? { cropSuitability: moment.cropSuitability } : {}),
          selected: selectedIds.has(moment.id),
        })),
        transcript,
      }) as CatalogRecord;
    }
    case "DraftComparison": {
      const drafts = selected(job.drafts, node.refs.draftIds, 20);
      return parseCatalogComponent({
        ...base,
        component: node.component,
        ...framing(surface, node, "Compare platform drafts"),
        drafts: drafts.map((draft, index) => hydratedDraft(job, draft, index === 0)),
      }) as CatalogRecord;
    }
    case "PlatformPreview": {
      const draft = selected(job.drafts, node.refs.draftIds, 1)[0];
      const assets = (job.assets ?? []).filter((asset) => node.refs.assetActionIds.includes(asset.actionId)).slice(0, 20);
      return parseCatalogComponent({
        ...base,
        component: node.component,
        ...framing(surface, node, `${draft.platform.toUpperCase()} preview`),
        draft: hydratedDraft(job, draft, true),
        assets: assets.map((asset) => ({
          actionId: asset.actionId,
          mime: asset.mime,
          previewUrl: `/api/jobs/${job.id}/assets/${asset.actionId}`,
        })),
      }) as CatalogRecord;
    }
    case "SourceEvidence": {
      const wanted = new Set(node.refs.sourceIds);
      const allSources = [
        ...(job.config.youtubeUrl ? [{ id: "source-video", kind: "video" as const, label: job.ingestedTitle || "Source video", url: job.config.youtubeUrl }] : []),
        ...(job.config.mediaAttachmentId ? [{ id: "source-upload", kind: "media" as const, label: job.config.mediaFilename || "Uploaded source" }] : []),
        ...job.transcriptSegments.map((segment) => ({ id: segment.id, kind: "transcript" as const, label: `Transcript ${segment.startSec}s–${segment.endSec}s`, excerpt: segment.text })),
      ];
      const sources = (wanted.size ? allSources.filter((source) => wanted.has(source.id)) : allSources).slice(0, 100);
      if (sources.length === 0) return unresolved(surface, node, ["sourceIds"]);
      return parseCatalogComponent({
        ...base,
        component: node.component,
        ...framing(surface, node, "Source evidence"),
        sources,
        links: job.drafts.flatMap((draft) => draft.momentId
          ? [{ fromId: draft.id, toId: draft.momentId, label: "grounded in moment" }]
          : []).slice(0, 200),
      }) as CatalogRecord;
    }
    case "ApprovalReview": {
      const action = job.actions.find((candidate) => candidate.id === node.refs.actionIds[0]);
      if (!action) return unresolved(surface, node, [node.refs.actionIds[0] || "actionIds"]);
      return parseCatalogComponent({
        ...base,
        component: node.component,
        ...framing(surface, node, action.title, node.component, {
          failed: action.state === "failed",
          approvalPending: action.approvalState === "pending",
          highRisk: action.risk === "high",
        }),
        actionId: action.id,
        actionType: action.type,
        description: action.description,
        risk: action.risk,
        requiresApproval: action.requiresApproval,
        approvalState: action.approvalState,
        actionState: action.state,
        destination: actionDestination(action.type),
        ...(actionPreview(action) ? { previewText: actionPreview(action) } : {}),
      }) as CatalogRecord;
    }
    case "VerificationReceipt": {
      const receipt = receipts.find((candidate) => candidate.id === node.refs.receiptIds[0]);
      if (!receipt) return unresolved(surface, node, [node.refs.receiptIds[0] || "receiptIds"]);
      const verification = verificationFor(job, receipt);
      return parseCatalogComponent({
        ...base,
        component: node.component,
        ...framing(surface, node, "Verified external effect", node.component, {
          failed: receipt.outcome === "failed" || receipt.outcome === "rejected",
          verified: verification?.verified ?? false,
        }),
        receiptId: receipt.id,
        actionId: receipt.actionId,
        actionType: receipt.actionType,
        performedAt: receipt.performedAt,
        outcome: receipt.outcome,
        verified: verification?.verified ?? false,
        ...(verification?.method ? { verificationMethod: verification.method } : {}),
        ...(verification?.note ? { verificationNote: verification.note } : {}),
        ...(receipt.artifact ? { artifact: {
          kind: receipt.artifact.kind,
          ...(isHttpUrl(receipt.artifact.url) ? { url: receipt.artifact.url } : {}),
          ...(receipt.artifact.digest !== undefined ? { digest: receipt.artifact.digest } : {}),
        } } : {}),
      }) as CatalogRecord;
    }
  }
}

function hydrateSurface(runId: string, surface: PlannedSurface, job: JobFull | null | undefined, receipts: Receipt[]) {
  const components = surface.nodes.map((node) => hydrateNode(surface, node, job, receipts));
  if (surface.rootId !== "root") {
    if (surface.nodes.some((node) => node.id === "root")) {
      throw new Error("A2UI surface reserves root for its reachable layout root");
    }
    components.unshift({ id: "root", component: "Column", children: [surface.rootId] });
  }
  const surfaceId = `studio-${runId}-${surface.slot}-r${surface.revision}`;
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: HARMONIA_CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
  ];
}

export function hydrateSurfacePlan(input: HydrateSurfacePlanInput): HydratedSurfaceSet {
  const result: HydratedSurfaceSet = { canvas: [], conversation: [], approval: [] };
  const plan = surfacePlanSchema.parse(input.plan);
  for (const surface of plan.surfaces) {
    result[surface.slot as SurfaceSlot] = hydrateSurface(input.runId, surface, input.job, input.receipts);
  }
  return result;
}
