"use client";
import type { ReactNode } from "react";
import type { UIMessage } from "ai";
import { parseCatalogComponent, parseHarmoniaSurfacePart, type HarmoniaSurfacePart } from "@/lib/ai-sdk/contracts";
import { ActivityTrace, AttachmentCard, ConfirmationCard, ContextUsage, InlineCitation, MessageContent, PlanView, QueueView, ReasoningSummary, TaskView, ToolActivity } from "./HarmoniaElements";
import { ApprovalReview, CampaignBrief, DraftComparison, JobProgress, MomentExplorer, PlatformPreview, SourceEvidence, SurfaceEmpty, SurfaceFailure, SurfaceLoading, SurfaceUnresolved, VerificationReceipt } from "./HarmoniaWorkspaceElements";
import styles from "./HarmoniaWorkspaceElements.module.css";

export interface HarmoniaClientAction { name: "decide_job_action" | "decide_operation" | "request_surface_revision"; context: Record<string, string> }
export type HarmoniaMessage = UIMessage<never, { "harmonia-surface": HarmoniaSurfacePart["data"] }>;
export const parseHarmoniaSurface = parseHarmoniaSurfacePart;
export interface SurfaceFrameMetadata { composition: "stack" | "split" | "mosaic" | "rail"; rhythm: "editorial" | "operational" | "cinematic" | "evidence"; energy: "quiet" | "active" | "resolved"; revision: number }
const DEFAULT_FRAME: SurfaceFrameMetadata = { composition: "stack", rhythm: "editorial", energy: "quiet", revision: 1 };
export function surfaceFrameMetadata(part?: HarmoniaSurfacePart): SurfaceFrameMetadata {
  const root = part?.data.components.find((component) => "surfaceComposition" in component);
  return root ? { composition: root.surfaceComposition as SurfaceFrameMetadata["composition"], rhythm: root.surfaceRhythm as SurfaceFrameMetadata["rhythm"], energy: root.surfaceEnergy as SurfaceFrameMetadata["energy"], revision: part!.data.revision } : part ? { ...DEFAULT_FRAME, revision: part.data.revision } : DEFAULT_FRAME;
}
export function surfaceMotionState({ live, partsGrew, previousRevision, revision }: { live: boolean; partsGrew: boolean; previousRevision?: number; revision: number }) { return { liveUpdate: live && partsGrew, revisionChanged: live && previousRevision !== undefined && revision > previousRevision }; }

function render(component: ReturnType<typeof parseCatalogComponent>, children: ReactNode, onAction?: (action: HarmoniaClientAction) => void | Promise<void>): ReactNode {
  // Runtime Zod validation above makes this safe while keeping each visual component strongly typed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const props = component as any;
  switch (component.component) {
    case "ActivityTrace": return <ActivityTrace title={component.title} steps={component.steps} />;
    case "ReasoningSummary": return <ReasoningSummary summary={component.summary} />;
    case "AttachmentCard": return <AttachmentCard attachment={component} />;
    case "InlineCitation": return <InlineCitation {...component} />;
    case "PlanView": return <PlanView title={component.title} steps={component.steps} />;
    case "QueueView": return <QueueView title={component.title} items={component.items} />;
    case "ToolActivity": return <ToolActivity {...component} />;
    case "TaskView": return <TaskView {...component} />;
    case "ContextUsage": return <ContextUsage {...component} />;
    case "MessageContent": return <MessageContent text={component.text} />;
    case "Confirmation": return <ConfirmationCard {...component} onDecision={(decision) => void onAction?.(component.jobId && component.actionId ? { name: "decide_job_action", context: { jobId: component.jobId, actionId: component.actionId, decision } } : { name: "decide_operation", context: { operationId: component.operationId!, decision } })} />;
    case "CampaignBrief": return <CampaignBrief {...props}>{children}</CampaignBrief>;
    case "JobProgress": return <JobProgress {...props}>{children}</JobProgress>;
    case "MomentExplorer": return <MomentExplorer {...props}>{children}</MomentExplorer>;
    case "DraftComparison": return <DraftComparison {...props} onRequestRevision={(draftId: string) => void onAction?.({ name: "request_surface_revision", context: { jobId: component.jobId, draftId } })}>{children}</DraftComparison>;
    case "PlatformPreview": return <PlatformPreview {...props}>{children}</PlatformPreview>;
    case "SourceEvidence": return <SourceEvidence {...props}>{children}</SourceEvidence>;
    case "ApprovalReview": return <ApprovalReview {...props}>{children}</ApprovalReview>;
    case "VerificationReceipt": return <VerificationReceipt {...props}>{children}</VerificationReceipt>;
    case "SurfaceLoading": return <SurfaceLoading {...props}>{children}</SurfaceLoading>;
    case "SurfaceEmpty": return <SurfaceEmpty {...props}>{children}</SurfaceEmpty>;
    case "SurfaceUnresolved": return <SurfaceUnresolved {...props}>{children}</SurfaceUnresolved>;
    case "SurfaceFailure": return <SurfaceFailure {...props}>{children}</SurfaceFailure>;
  }
}
function Surface({ part, onAction }: { part: HarmoniaSurfacePart; onAction?: (action: HarmoniaClientAction) => void | Promise<void> }) {
  const components = new Map(part.data.components.map((input) => { const parsed = parseCatalogComponent(input); return [parsed.id, parsed] as const; }));
  const active = new Set<string>();
  const build = (id: string): ReactNode => { if (active.has(id)) throw new Error(`cyclic component tree at ${id}`); const component = components.get(id); if (!component) throw new Error(`missing component ${id}`); active.add(id); const childIds = "children" in component ? component.children : []; const children = childIds.map((childId) => <span key={childId}>{build(childId)}</span>); active.delete(id); return component.component === "Column" ? <div className="flex flex-col gap-2">{children}</div> : render(component, children, onAction); };
  const frame = surfaceFrameMetadata(part);
  return <div className={styles.surfaceFrame} data-composition={frame.composition} data-rhythm={frame.rhythm} data-energy={frame.energy} data-revision={frame.revision}>{build("root")}</div>;
}
export function HarmoniaMessageRenderer({ parts, onAction, onProtocolError, className }: { parts: unknown[]; onAction?: (action: HarmoniaClientAction) => void | Promise<void>; onProtocolError?: (error: Error) => void; className?: string; live?: boolean }) {
  return <div className={className ?? "flex flex-col gap-2"}>{parts.map((input, index) => { try { const part = parseHarmoniaSurface(input); return <Surface key={part.id} part={part} onAction={onAction} />; } catch (error) { const failure = error instanceof Error ? error : new Error(String(error)); onProtocolError?.(failure); return <p key={index} className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700">AI SDK message error: {failure.message}</p>; } })}</div>;
}
