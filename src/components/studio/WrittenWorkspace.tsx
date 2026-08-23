import type { JobFull } from "@/components/jobTypes";
import type { TraceLink } from "@/lib/studio/workspaceModel";
import { StudioEmpty } from "./StudioStates";

export function WrittenWorkspace({ job, traceLinks, selectedArtifactId, onSelect }: { job: JobFull; traceLinks: TraceLink[]; selectedArtifactId: string | null; onSelect: (artifactId: string) => void }) {
  if (!job.drafts.length) return <StudioEmpty title="No reviewed writing yet">Drafts appear here after the writing workflow persists them.</StudioEmpty>;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {job.drafts.map((draft, index) => {
        const artifactId = `draft:${draft.id}`;
        const trace = traceLinks.find((candidate) => candidate.draftId === draft.id);
        const moment = job.moments.find((candidate) => candidate.id === draft.momentId);
        const angle = job.angles.find((candidate) => candidate.id === draft.angleId);
        return (
          <article key={draft.id} tabIndex={-1} data-canvas-artifact={artifactId} onClick={() => onSelect(artifactId)} className={`group relative min-h-72 cursor-pointer border-2 bg-[#fffdf7] p-5 transition ${selectedArtifactId === artifactId ? "border-[#ff5c35] shadow-[8px_8px_0_#ff5c35]" : "border-black/15 hover:-translate-y-1 hover:border-black/50"}`}>
            <div className="flex items-start justify-between gap-3"><div><span className="font-mono text-xs text-[#ff5c35]">0{index + 1}</span><h3 className="mt-2 font-serif text-2xl">{draft.platform.toUpperCase()} post</h3></div><span className={`px-2 py-1 text-[9px] font-black uppercase tracking-[0.15em] ${draft.valid ? "bg-[#d9ff43] text-[#283600]" : "bg-[#ff5c35]/15 text-[#9f2c11]"}`}>{draft.valid ? "Reviewed" : "Invalid"}</span></div>
            <p className="mt-6 whitespace-pre-wrap text-[15px] leading-7 text-[#24211d]">{draft.text}</p>
            <div className="mt-7 border-t border-black/10 pt-3 text-[10px] text-black/45"><div className="flex justify-between font-mono"><span>{draft.text.length}/280 characters</span><span>{draft.id}</span></div>{trace?.valid && (moment || angle) ? <p className="mt-2 font-semibold">↳ {moment?.title ?? angle?.title} · {trace.sourceSegmentIds.length} source segment{trace.sourceSegmentIds.length === 1 ? "" : "s"}</p> : null}{trace && !trace.valid ? <p role="alert" className="mt-2 font-bold text-red-700">Trace error: {trace.error}</p> : null}</div>
          </article>
        );
      })}
    </div>
  );
}
