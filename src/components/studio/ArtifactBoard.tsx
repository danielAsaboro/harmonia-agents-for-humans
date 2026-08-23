import type { JobFull } from "@/components/jobTypes";
import type { StudioWorkspaceModel } from "@/lib/studio/workspaceModel";

export function ArtifactBoard({ job, model, onSelect }: { job: JobFull; model: StudioWorkspaceModel; onSelect: (artifactId: string, view?: string) => void }) {
  const invalidTraces = model.traceLinks.filter((trace) => !trace.valid);
  return (
    <div className="space-y-5">
      <section className="relative overflow-hidden border-2 border-[#161512] bg-[#fffdf7] p-6 shadow-[9px_9px_0_#161512]">
        <div className="absolute -right-10 -top-16 h-52 w-52 rotate-12 rounded-full bg-[#d9ff43]" aria-hidden />
        <div className="relative max-w-2xl"><p className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-[#3157ff]">Working set · {job.id}</p><h2 className="mt-3 max-w-xl font-serif text-4xl leading-[0.95]">{job.ingestedTitle || job.config.brief || job.config.youtubeUrl || "Untitled content direction"}</h2><div className="mt-5 flex flex-wrap gap-2"><span className="bg-[#161512] px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-white">{job.stage}</span><span className="border border-black/20 bg-white/70 px-3 py-1.5 text-[10px] font-black uppercase tracking-wider">{job.status}</span>{model.pendingActions.length ? <span className="bg-[#ff5c35] px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-white">{model.pendingActions.length} decisions</span> : null}</div></div>
      </section>
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">{[
        ["Written", model.written.length, "#ff5c35", "written"],
        ["Visual", model.visual.length, "#d9ff43", "visual"],
        ["Motion", model.motion.length, "#3157ff", "motion"],
        ["Audio", model.audio.length, "#8d5cff", "audio"],
      ].map(([label, count, color, view]) => <button key={String(label)} type="button" onClick={() => onSelect("", String(view))} className="border border-black/15 bg-white/60 p-4 text-left transition hover:-translate-y-1" style={{ boxShadow: `inset 0 -5px 0 ${color}` }}><span className="font-mono text-3xl">{count}</span><span className="mt-4 block text-[10px] font-black uppercase tracking-[0.16em] text-black/45">{label}</span></button>)}</section>
      {invalidTraces.length ? <section role="alert" className="border-2 border-red-600 bg-red-50 p-4"><strong className="text-sm text-red-800">Source trace protocol error</strong><ul className="mt-2 list-disc pl-5 text-xs text-red-700">{invalidTraces.map((trace, index) => <li key={`${trace.draftId ?? trace.actionId}-${index}`}>{trace.error}</li>)}</ul></section> : (
        <section className="border border-black/15 bg-white/55 p-5"><div className="flex items-center justify-between"><div><p className="text-[9px] font-black uppercase tracking-[0.16em] text-[#8d5cff]">Trace graph</p><h3 className="font-serif text-xl">Draft → idea → evidence</h3></div><span className="font-mono text-xs text-black/40">{model.traceLinks.length} links</span></div><div className="mt-4 flex flex-wrap gap-2">{model.traceLinks.map((trace, index) => <button type="button" key={`${trace.draftId ?? trace.actionId}-${index}`} onClick={() => trace.draftId && onSelect(`draft:${trace.draftId}`, "written")} className="border border-black/15 bg-[#fffdf7] px-3 py-2 text-left text-[10px] hover:border-[#3157ff]"><span className="font-mono">{trace.draftId ?? trace.actionId}</span><span className="mx-2 text-[#ff5c35]">→</span><span>{trace.momentId ?? trace.angleId ?? "working set"}</span><span className="ml-2 text-black/35">({trace.sourceSegmentIds.length})</span></button>)}</div>{!model.traceLinks.length ? <p className="mt-3 text-xs text-black/40">No source-linked drafts or actions exist yet.</p> : null}</section>
      )}
    </div>
  );
}
