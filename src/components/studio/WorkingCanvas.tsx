"use client";

import { useEffect, useState } from "react";
import type { JobFull, Receipt } from "@/components/jobTypes";
import type { TimelineEvent } from "@/components/Timeline";
import { buildStudioWorkspace } from "@/lib/studio/workspaceModel";
import { latestSurfaceOperations } from "@/lib/a2ui/surfaceSlots";
import { surfaceRevisionRequest } from "@/lib/a2ui/workspaceActions";
import { HarmoniaA2uiHost } from "@/components/a2ui/HarmoniaCatalog";
import { ArtifactBoard } from "./ArtifactBoard";
import { MediaWorkspace } from "./MediaWorkspace";
import { SourcesWorkspace } from "./SourcesWorkspace";
import { StudioEmpty, StudioFailure, StudioLoading } from "./StudioStates";
import { WrittenWorkspace } from "./WrittenWorkspace";
import { ApprovalDock } from "./ApprovalDock";
import { JobExecutionProof } from "./JobExecutionProof";

export type CanvasView = "board" | "written" | "visual" | "motion" | "audio" | "sources";

interface WorkingCanvasProps {
  job: JobFull | null;
  events: TimelineEvent[];
  receipts: Receipt[];
  loading?: boolean;
  error?: string | null;
  selectedArtifactId: string | null;
  onSelectedArtifactChange: (artifactId: string | null) => void;
  onRetry?: () => void;
  supplemental?: React.ReactNode;
  operations?: unknown[];
  operationsLive?: boolean;
  approvalBusy?: boolean;
  onDecide?: (jobId: string, actionId: string, decision: "approved" | "rejected") => Promise<void> | void;
  onOperationDecision?: (operationId: string, decision: "approved" | "rejected") => Promise<void> | void;
  onRequestSurfaceRevision?: (message: string) => Promise<void> | void;
}

export function WorkingCanvas({ job, events, receipts, loading, error, selectedArtifactId, onSelectedArtifactChange, onRetry, supplemental, operations = [], operationsLive = false, approvalBusy = false, onDecide, onOperationDecision, onRequestSurfaceRevision }: WorkingCanvasProps) {
  const [view, setView] = useState<CanvasView>("board");
  const [a2uiActionError, setA2uiActionError] = useState<string | null>(null);
  const model = job ? buildStudioWorkspace(job, receipts) : null;
  const selectedView: CanvasView | null = selectedArtifactId?.startsWith("draft:") ? "written"
    : selectedArtifactId?.startsWith("visual:") ? "visual"
      : selectedArtifactId?.startsWith("motion:") ? "motion"
        : selectedArtifactId?.startsWith("audio:") ? "audio"
          : null;
  const visibleView = selectedView ?? view;
  let canvasOperations: unknown[] = [];
  let a2uiError: string | null = null;
  try {
    canvasOperations = operations.length ? latestSurfaceOperations(operations, "canvas") : [];
  } catch (partitionError) {
    a2uiError = partitionError instanceof Error ? partitionError.message : String(partitionError);
  }

  useEffect(() => {
    if (!selectedArtifactId) return;
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>(`[data-canvas-artifact="${CSS.escape(selectedArtifactId)}"]`)?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [selectedArtifactId]);

  const tabs: Array<{ key: CanvasView; label: string; count?: number }> = [
    { key: "board", label: "Board", count: model ? model.written.length + model.visual.length + model.motion.length + model.audio.length : undefined },
    { key: "written", label: "Written", count: model?.written.length },
    { key: "visual", label: "Visual", count: model?.visual.length },
    { key: "motion", label: "Motion", count: model?.motion.length },
    { key: "audio", label: "Audio", count: model?.audio.length },
    { key: "sources", label: "Sources", count: model ? model.sources.normalizedSources.length : undefined },
  ];

  function selectFromBoard(artifactId: string, nextView?: string) {
    if (nextView && tabs.some((tab) => tab.key === nextView)) setView(nextView as CanvasView);
    onSelectedArtifactChange(artifactId || null);
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-r-[23px] bg-[#f3f0e8]" data-a2ui-slot="canvas">
      <header className="flex h-[72px] shrink-0 items-center gap-3 border-b border-black/10 px-[22px]">
        <strong className="text-lg font-extrabold">harmonia</strong>
        <span className="min-w-0 truncate font-mono text-[9px] text-[#77736b]">/ {job ? (job.ingestedTitle || `Source bundle ${job.config.sourceManifestId.slice(0, 8)}`).slice(0, 44) : "No campaign"} / Working set</span>
        <span className="ml-auto hidden rounded-full border border-black/10 px-2 py-1.5 font-mono text-[8px] text-[#77736b] sm:inline"><b className="text-[#33906a]">✓</b> autosaved</span>
        <button type="button" onClick={() => { const details = document.querySelector<HTMLDetailsElement>("[aria-label='Approval boundary'] > details"); if (details) details.open = true; }} className="rounded-full bg-[#11110f] px-3 py-2.5 text-[9px] font-bold text-white">Review <b className="text-[#d8ff3e]">{model?.pendingActions.length ?? 0}</b></button>
      </header>
      <div className="flex-1 overflow-y-auto px-[22px] py-5">
        {loading ? <StudioLoading /> : null}
        {!loading && error ? <StudioFailure message={error} onRetry={onRetry} /> : null}
        {!loading && !error && !job ? <StudioEmpty title="Your working canvas is ready">Start a conversation or open a real job. Written posts, visual concepts, clips, video, audio, sources, policy, and verification will assemble here.</StudioEmpty> : null}
        {!loading && !error && job && model ? <>
          <div className="mb-4 flex items-end gap-4"><div><p className="font-mono text-[7px] uppercase tracking-[0.12em] text-[#817d74]">Current working set</p><h1 className="mt-1 text-[31px] font-extrabold leading-none tracking-[-0.05em]">One conversation,<br /><em className="font-serif text-[#5165ff]">{model.written.length + model.visual.length + model.motion.length + model.audio.length} living artifacts.</em></h1></div><div className="ml-auto text-right font-mono text-[8px] text-[#77736b]">{job.stage}<br />updated from persisted state</div></div>
          <nav className="mb-[14px] flex gap-1 overflow-x-auto" aria-label="Canvas views">{tabs.map((tab) => <button key={tab.key} type="button" onClick={() => { setView(tab.key); onSelectedArtifactChange(null); }} aria-current={visibleView === tab.key ? "page" : undefined} className={`shrink-0 rounded-full px-2.5 py-1.5 font-mono text-[8px] ${visibleView === tab.key ? "bg-[#11110f] text-white" : "bg-[#e3ded4] text-[#77736b]"}`}><b className={visibleView === tab.key ? "text-[#d8ff3e]" : ""}>{tab.label}</b>{tab.count !== undefined ? ` ${tab.count}` : ""}</button>)}</nav>
          {a2uiError ? <div className="mb-5"><StudioFailure message={`A2UI protocol error: ${a2uiError}`} permanent /></div> : null}
          {canvasOperations.length ? <HarmoniaA2uiHost operations={canvasOperations} live={operationsLive} className="mb-5 flex w-full flex-col gap-3" onAction={(action) => {
            if (action.name !== "request_surface_revision") {
              setA2uiActionError(`Unknown A2UI action: ${action.name}`);
              return;
            }
            const actionJobId = String(action.context.jobId ?? "");
            const draftId = String(action.context.draftId ?? "");
            if (!job || actionJobId !== job.id || !job.drafts.some((draft) => draft.id === draftId) || !onRequestSurfaceRevision) {
              setA2uiActionError("The generated revision request did not match the active persisted draft.");
              return;
            }
            setA2uiActionError(null);
            void onRequestSurfaceRevision(surfaceRevisionRequest(actionJobId, draftId));
          }} /> : null}
          {a2uiActionError ? <div className="mb-5"><StudioFailure message={`A2UI action blocked: ${a2uiActionError}`} permanent /></div> : null}
          {supplemental ? <div className="mb-5">{supplemental}</div> : null}
          <JobExecutionProof job={job} events={events} receipts={receipts} />
          {visibleView === "board" ? <ArtifactBoard job={job} model={model} onSelect={selectFromBoard} /> : null}
          {visibleView === "written" ? <WrittenWorkspace job={job} traceLinks={model.traceLinks} selectedArtifactId={selectedArtifactId} onSelect={onSelectedArtifactChange} /> : null}
          {visibleView === "visual" ? <MediaWorkspace kind="visual" jobId={job.id} assets={model.visual} selectedArtifactId={selectedArtifactId} onSelect={onSelectedArtifactChange} /> : null}
          {visibleView === "motion" ? <MediaWorkspace kind="motion" jobId={job.id} assets={model.motion} selectedArtifactId={selectedArtifactId} onSelect={onSelectedArtifactChange} /> : null}
          {visibleView === "audio" ? <MediaWorkspace kind="audio" jobId={job.id} assets={model.audio} selectedArtifactId={selectedArtifactId} onSelect={onSelectedArtifactChange} /> : null}
          {visibleView === "sources" ? <SourcesWorkspace job={job} receipts={receipts} /> : null}
          {events.length ? <details className="mt-6 border-t border-black/15 pt-3"><summary className="cursor-pointer text-[10px] font-black uppercase tracking-[0.14em] text-black/40">Execution timeline · {events.length} events</summary><ol className="mt-3 space-y-2">{[...events].reverse().map((event, index) => <li key={`${event.at}-${index}`} className="grid grid-cols-[5rem_1fr] gap-3 text-xs"><span className="font-mono text-black/35">{event.at ? new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</span><span>{event.message}</span></li>)}</ol></details> : null}
        </> : null}
      </div>
      {job && onDecide ? <ApprovalDock job={job} jobId={job.id} actions={job.actions} verifications={job.verifications ?? []} receipts={receipts} claims={job.claims ?? []} busy={approvalBusy} onDecide={onDecide} operations={operations} operationsLive={operationsLive} onOperationDecision={onOperationDecision} /> : null}
    </section>
  );
}
