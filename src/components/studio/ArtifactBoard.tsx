/* eslint-disable @next/next/no-img-element */
import type { JobFull } from "@/components/jobTypes";
import type { StudioWorkspaceModel } from "@/lib/studio/workspaceModel";
import { contentArtifactPreview } from "@/lib/contentArtifacts/presentation";

function directionFor(job: JobFull): string {
  const artifact = job.contentArtifacts?.[0];
  return job.sourceAnalysis?.angles[0]?.title || job.sourceAnalysis?.moments[0]?.hook || (artifact ? contentArtifactPreview(artifact).split(/[.!?]/)[0] : "") || job.sourceAnalysis?.summary || "Content direction in progress";
}

export function ArtifactBoard({ job, model, onSelect }: { job: JobFull; model: StudioWorkspaceModel; onSelect: (artifactId: string, view?: string) => void }) {
  const invalidTraces = model.traceLinks.filter((trace) => !trace.valid);
  const artifact = model.written[0];
  const visual = model.visual[0];
  const audio = model.audio[0];
  const decisions = [
    ...(job.sourceAnalysis?.angles ?? []).slice(0, 2).map((angle) => ({ label: angle.title, source: `${angle.angleType} · ${angle.evidenceKind}` })),
    ...(job.sourceAnalysis?.moments ?? []).slice(0, 3).map((moment) => ({ label: moment.hook || moment.title, source: `${moment.startSec}s` })),
  ].slice(0, 3);

  if (invalidTraces.length) return <section role="alert" className="rounded-[18px] border-2 border-red-600 bg-red-50 p-4"><strong className="text-sm text-red-800">Source trace protocol error</strong><ul className="mt-2 list-disc pl-5 text-xs text-red-700">{invalidTraces.map((trace, index) => <li key={`${trace.artifactId ?? trace.actionId}-${index}`}>{trace.error}</li>)}</ul></section>;

  return (
    <div className="grid gap-3 xl:grid-cols-[1.08fr_.92fr] xl:grid-rows-[230px_190px]">
      <article className="relative flex min-h-[430px] flex-col overflow-hidden rounded-[18px] bg-[#11110f] p-[15px] text-white xl:row-span-2 xl:min-h-0">
        <div className="flex items-center font-mono text-[8px] uppercase tracking-[0.1em]">Campaign direction <span className="ml-auto rounded-full bg-[#292925] px-2 py-1 text-[#d8ff3e]">from conversation</span></div>
        <h2 className="mt-6 max-w-md text-[28px] font-extrabold leading-[1.02] tracking-[-0.045em]">{directionFor(job)}</h2>
        <p className="mt-3 max-w-md text-[10px] leading-[1.55] text-[#aaa]">The thread is the decision history. This canvas is the current truth, assembled only from persisted drafts, media, moments, and source links.</p>
        <div className="mt-5">
          {decisions.length ? decisions.map((decision, index) => <div key={`${decision.source}-${index}`} className="grid grid-cols-[20px_1fr_auto] items-center gap-2 border-t border-[#33332e] py-2 text-[9px]"><i className="grid h-[18px] w-[18px] place-items-center rounded-md bg-[#292925] not-italic text-[#d8ff3e]">✓</i><b className="truncate">{decision.label}</b><span className="font-mono text-[7px] text-[#888]">{decision.source}</span></div>) : <div className="border-t border-[#33332e] py-3 text-[9px] text-[#888]">Direction will sharpen as evidence and angles are persisted.</div>}
        </div>
        <div className="relative mt-auto h-[90px] before:absolute before:left-[50px] before:right-[40px] before:top-[42px] before:rotate-[8deg] before:border-t before:border-[#444] after:absolute after:left-[50px] after:right-[40px] after:top-[42px] after:-rotate-[10deg] after:border-t after:border-[#444]" aria-label="Source trace graph">
          <span className="absolute left-2 top-4 z-10 grid h-[52px] w-[52px] place-items-center rounded-full bg-[#d8ff3e] font-mono text-[7px] font-semibold text-black">{job.normalizedSources?.length ? "SOURCE" : "PENDING"}</span>
          <span className="absolute left-[43%] top-0 z-10 grid h-[52px] w-[52px] place-items-center rounded-full bg-[#ff765f] font-mono text-[7px] font-semibold text-black">DRAFT</span>
          <span className="absolute right-2 top-[30px] z-10 grid h-[52px] w-[52px] place-items-center rounded-full bg-[#a566ff] font-mono text-[7px] font-semibold text-black">MEDIA</span>
        </div>
      </article>

      <button type="button" onClick={() => artifact && onSelect(`artifact:${artifact.id}`, "written")} className="overflow-hidden rounded-[18px] border border-black/10 bg-white p-[14px] text-left transition hover:-translate-y-0.5 hover:border-[#5165ff] disabled:cursor-default" disabled={!artifact}>
        <div className="flex items-center font-mono text-[8px] uppercase tracking-[0.1em]">Content artifact <span className="ml-auto rounded-full bg-[#efffb6] px-2 py-1 text-black">{artifact ? `revision ${artifact.revision}` : "not created"}</span></div>
        {artifact ? <><blockquote className="my-5 line-clamp-4 whitespace-pre-wrap text-[17px] font-bold leading-[1.25] tracking-[-0.03em]">{contentArtifactPreview(artifact)}</blockquote><div className="flex gap-2 font-mono text-[7px]"><span className="flex-1 rounded-lg border border-black/10 p-2 text-[#777]">{artifact.outputType.replaceAll("_", " ")}</span><span className="flex-1 rounded-lg border border-[#758636] bg-[#f2ffc0] p-2 text-[#414822]">{artifact.sourceSegmentRefs.length} sources · {artifact.contentDigest.slice(0, 12)}</span></div></> : <p className="mt-8 text-sm text-black/45">No persisted content artifact exists yet.</p>}
      </button>

      <article className="grid min-h-[190px] grid-cols-2 gap-2 rounded-[18px] border border-black/10 bg-white p-[14px]">
        <button type="button" onClick={() => visual && onSelect(`visual:${visual.actionId}`, "visual")} className="relative overflow-hidden rounded-xl bg-[#222] text-left" disabled={!visual}>
          {visual ? <img src={`/api/jobs/${job.id}/assets/${visual.actionId}`} alt={visual.title} className="h-full w-full object-cover opacity-90" /> : <div className="grid h-full min-h-32 place-items-center bg-[#ded9ce] p-3 text-center font-mono text-[8px] text-black/45">No persisted image</div>}
          <span className="absolute left-2 top-2 rounded-full bg-white/85 px-2 py-1 font-mono text-[7px] text-black">{visual ? "Image · open asset" : "Visual · unresolved"}</span>
        </button>
        <button type="button" onClick={() => audio && onSelect(`audio:${audio.actionId}`, "audio")} className="rounded-xl bg-[#5165ff] p-3 text-left text-white" disabled={!audio}>
          <div className="flex h-[55px] items-center gap-0.5" aria-hidden>{Array.from({ length: 14 }, (_, index) => <i key={index} className="w-[3px] rounded bg-[#d8ff3e]" style={{ height: `${20 + ((index * 17) % 38)}px` }} />)}</div>
          <b className="block text-[9px]">{audio?.title ?? "Audio not created"}</b>
          <p className="mt-1 font-mono text-[7px] text-[#c8cdff]">{audio ? `${audio.mime} · persisted` : "unresolved · no simulated asset"}</p>
        </button>
      </article>
    </div>
  );
}
