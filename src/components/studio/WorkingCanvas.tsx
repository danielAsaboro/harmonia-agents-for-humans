"use client";

import { useEffect, useState } from "react";
import type { JobFull, Receipt } from "@/components/jobTypes";
import type { TimelineEvent } from "@/components/Timeline";
import { buildStudioWorkspace } from "@/lib/studio/workspaceModel";
import { partitionStudioOperations } from "@/lib/a2ui/studioRegions";
import { HarmoniaA2uiHost } from "@/components/a2ui/HarmoniaCatalog";
import { ArtifactBoard } from "./ArtifactBoard";
import { MediaWorkspace } from "./MediaWorkspace";
import { SourcesWorkspace } from "./SourcesWorkspace";
import { StudioEmpty, StudioFailure, StudioLoading } from "./StudioStates";
import { WrittenWorkspace } from "./WrittenWorkspace";

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
  runId?: string;
  operations?: unknown[];
}

export function WorkingCanvas({ job, events, receipts, loading, error, selectedArtifactId, onSelectedArtifactChange, onRetry, supplemental, runId, operations = [] }: WorkingCanvasProps) {
  const [view, setView] = useState<CanvasView>("board");
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
    canvasOperations = runId && operations.length ? partitionStudioOperations(runId, operations).canvas : [];
  } catch (partitionError) {
    a2uiError = partitionError instanceof Error ? partitionError.message : String(partitionError);
  }

  useEffect(() => {
    if (!selectedArtifactId) return;
    const timer = window.setTimeout(() => document.querySelector<HTMLElement>(`[data-canvas-artifact="${CSS.escape(selectedArtifactId)}"]`)?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [selectedArtifactId]);

  const tabs: Array<{ key: CanvasView; label: string; count?: number }> = [
    { key: "board", label: "Board" },
    { key: "written", label: "Written", count: model?.written.length },
    { key: "visual", label: "Visual", count: model?.visual.length },
    { key: "motion", label: "Motion", count: model?.motion.length },
    { key: "audio", label: "Audio", count: model?.audio.length },
    { key: "sources", label: "Sources", count: model ? model.sources.transcriptSegments.length + model.sources.moments.length : undefined },
  ];

  function selectFromBoard(artifactId: string, nextView?: string) {
    if (nextView && tabs.some((tab) => tab.key === nextView)) setView(nextView as CanvasView);
    onSelectedArtifactChange(artifactId || null);
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#ece7dd]">
      <header className="border-b border-black/10 bg-[#fffdf7]/85 px-5 py-4 backdrop-blur">
        <div className="flex items-center justify-between gap-4"><div><p className="text-[9px] font-black uppercase tracking-[0.2em] text-[#ff5c35]">Living canvas</p><h2 className="font-serif text-2xl">{job ? (job.config.brief || job.config.youtubeUrl || job.id).slice(0, 72) : "No working set selected"}</h2></div>{job ? <div className="hidden items-center gap-2 sm:flex"><span className={`h-2.5 w-2.5 rounded-full ${job.status === "failed" ? "bg-red-600" : job.status === "complete" ? "bg-emerald-500" : "animate-pulse bg-[#3157ff]"}`} /><span className="font-mono text-[10px] uppercase text-black/45">{job.stage}</span></div> : null}</div>
        <nav className="mt-4 flex gap-1 overflow-x-auto" aria-label="Canvas views">{tabs.map((tab) => <button key={tab.key} type="button" onClick={() => { setView(tab.key); onSelectedArtifactChange(null); }} aria-current={visibleView === tab.key ? "page" : undefined} className={`shrink-0 border-b-2 px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] ${visibleView === tab.key ? "border-[#3157ff] text-[#3157ff]" : "border-transparent text-black/40 hover:text-black"}`}>{tab.label}{tab.count !== undefined ? <span className="ml-1.5 font-mono opacity-55">{tab.count}</span> : null}</button>)}</nav>
      </header>
      <div className="flex-1 overflow-y-auto p-5 xl:p-7">
        {loading ? <StudioLoading /> : null}
        {!loading && error ? <StudioFailure message={error} onRetry={onRetry} /> : null}
        {!loading && !error && !job ? <StudioEmpty title="Your working canvas is ready">Start a conversation or open a real job. Written posts, visual concepts, clips, video, audio, sources, policy, and verification will assemble here.</StudioEmpty> : null}
        {!loading && !error && job && model ? <>
          {a2uiError ? <div className="mb-5"><StudioFailure message={`A2UI protocol error: ${a2uiError}`} permanent /></div> : null}
          {canvasOperations.length ? <HarmoniaA2uiHost operations={canvasOperations} className="mb-5 grid gap-3 xl:grid-cols-2" /> : null}
          {supplemental ? <div className="mb-5">{supplemental}</div> : null}
          {visibleView === "board" ? <ArtifactBoard job={job} model={model} onSelect={selectFromBoard} /> : null}
          {visibleView === "written" ? <WrittenWorkspace job={job} traceLinks={model.traceLinks} selectedArtifactId={selectedArtifactId} onSelect={onSelectedArtifactChange} /> : null}
          {visibleView === "visual" ? <MediaWorkspace kind="visual" jobId={job.id} assets={model.visual} selectedArtifactId={selectedArtifactId} onSelect={onSelectedArtifactChange} /> : null}
          {visibleView === "motion" ? <MediaWorkspace kind="motion" jobId={job.id} assets={model.motion} selectedArtifactId={selectedArtifactId} onSelect={onSelectedArtifactChange} /> : null}
          {visibleView === "audio" ? <MediaWorkspace kind="audio" jobId={job.id} assets={model.audio} selectedArtifactId={selectedArtifactId} onSelect={onSelectedArtifactChange} /> : null}
          {visibleView === "sources" ? <SourcesWorkspace job={job} receipts={receipts} /> : null}
          {events.length ? <details className="mt-6 border-t border-black/15 pt-3"><summary className="cursor-pointer text-[10px] font-black uppercase tracking-[0.14em] text-black/40">Execution timeline · {events.length} events</summary><ol className="mt-3 space-y-2">{[...events].reverse().map((event, index) => <li key={`${event.at}-${index}`} className="grid grid-cols-[5rem_1fr] gap-3 text-xs"><span className="font-mono text-black/35">{event.at ? new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}</span><span>{event.message}</span></li>)}</ol></details> : null}
        </> : null}
      </div>
    </section>
  );
}
