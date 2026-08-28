import type { JobFull } from "@/components/jobTypes";
import type { TraceLink } from "@/lib/studio/workspaceModel";
import { StudioEmpty } from "./StudioStates";
import { contentArtifactPreview } from "@/lib/contentArtifacts/presentation";

export function WrittenWorkspace({ job, traceLinks, selectedArtifactId, onSelect }: { job: JobFull; traceLinks: TraceLink[]; selectedArtifactId: string | null; onSelect: (artifactId: string) => void }) {
  const artifacts = job.contentArtifacts ?? [];
  if (!artifacts.length) return <StudioEmpty title="No reviewed content yet">Accepted immutable artifacts appear here after production and review.</StudioEmpty>;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {artifacts.map((artifact, index) => {
        const artifactId = `artifact:${artifact.id}`;
        const trace = traceLinks.find((candidate) => candidate.artifactId === artifact.id);
        const exportAction = job.actions.find((action) => action.type === "export_content_artifact" && action.payload.artifactId === artifact.id);
        const verification = job.verifications?.find((item) => item.actionId === exportAction?.id);
        return (
          <article key={artifact.id} tabIndex={-1} data-canvas-artifact={artifactId} onClick={() => onSelect(artifactId)} className={`group relative min-h-72 cursor-pointer border-2 bg-[#fffdf7] p-5 transition ${selectedArtifactId === artifactId ? "border-[#ff5c35] shadow-[8px_8px_0_#ff5c35]" : "border-black/15 hover:-translate-y-1 hover:border-black/50"}`}>
            <div className="flex items-start justify-between gap-3"><div><span className="font-mono text-xs text-[#ff5c35]">0{index + 1}</span><h3 className="mt-2 font-serif text-2xl">{artifact.title}</h3><p className="mt-1 font-mono text-[9px] uppercase">{artifact.outputType.replaceAll("_", " ")} · revision {artifact.revision}</p></div><span className={`px-2 py-1 text-[9px] font-black uppercase tracking-[0.15em] ${verification?.verified ? "bg-[#d9ff43] text-[#283600]" : "bg-[#e8e4dc] text-[#625e56]"}`}>{verification?.verified ? "Verified" : exportAction?.state ?? "Accepted"}</span></div>
            <p className="mt-6 whitespace-pre-wrap text-[15px] leading-7 text-[#24211d]">{contentArtifactPreview(artifact)}</p>
            <div className="mt-7 border-t border-black/10 pt-3 text-[10px] text-black/45"><div className="flex justify-between gap-3 font-mono"><span>{artifact.sourceSegmentRefs.length} source reference{artifact.sourceSegmentRefs.length === 1 ? "" : "s"}</span><span className="truncate">{artifact.contentDigest}</span></div>{trace && !trace.valid ? <p role="alert" className="mt-2 font-bold text-red-700">Trace error: {trace.error}</p> : null}</div>
          </article>
        );
      })}
    </div>
  );
}
