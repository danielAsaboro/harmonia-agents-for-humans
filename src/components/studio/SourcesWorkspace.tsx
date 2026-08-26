import type { JobFull, Receipt } from "@/components/jobTypes";

function timestamp(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function planDate(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: timezone }).format(new Date(value));
}

function planDateTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: timezone, timeZoneName: "short",
  }).format(new Date(value));
}

function EditorialPlanSection({ job }: { job: JobFull }) {
  const plan = job.editorialPlan;
  if (!plan) return null;
  return (
    <section className="border border-black/15 bg-[#e8f1ff] p-5" data-canvas-artifact="editorial-plan:current">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-[9px] font-black uppercase tracking-[0.18em] text-[#3157ff]">Temi editorial plan · v{plan.version}</p><h3 className="mt-1 font-serif text-xl">{plan.summary}</h3></div>
        <span className="rounded-full border border-black/15 px-2 py-1 font-mono text-[8px]">{plan.confidence} confidence</span>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-xs">
        <div><dt className="text-black/40">Planning horizon</dt><dd>{planDate(plan.horizonStartAt, plan.timezone)} – {planDate(plan.horizonEndAt, plan.timezone)}</dd></div>
        <div><dt className="text-black/40">Timezone</dt><dd>{plan.timezone}</dd></div>
        <div><dt className="text-black/40">Cadence</dt><dd>{plan.cadenceRationale}</dd></div>
        <div><dt className="text-black/40">Sequence</dt><dd>{plan.sequencingRationale}</dd></div>
      </dl>
      <ol className="mt-4 space-y-3">
        {plan.items.map((item) => {
          const state = job.editorialItemStates?.[item.id]?.status ?? item.productionStatus;
          const isSelected = item.id === job.selectedNextItemId && item.id === plan.selectedNextItemId;
          return <li key={item.id} className={`border-t pt-3 text-xs ${isSelected ? "border-[#3157ff]" : "border-black/10"}`} data-canvas-artifact={`editorial-item:${item.id}`}>
            <div className="flex items-start justify-between gap-2"><div><strong>{item.id}</strong><span className="ml-2 text-black/45">{item.campaignTheme} · {item.contentPillar}</span></div><span className="rounded-full bg-white px-2 py-1 font-mono text-[8px]">{state}</span></div>
            <p className="mt-2 text-black/65">{item.planningRationale}</p>
            {isSelected ? <p className="mt-1 font-medium text-[#3157ff]">Selected next: {item.selectionRationale}</p> : null}
            <p className="mt-1 text-[10px] text-black/50">Priority {item.priority} · Selection score {item.selectionScore} · {item.confidence} item confidence</p>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-black/60">
              <div><dt className="text-black/35">Posting window</dt><dd>{planDateTime(item.publicationWindowStartAt, plan.timezone)} – {planDateTime(item.publicationWindowEndAt, plan.timezone)}</dd></div>
              <div><dt className="text-black/35">Production deadline</dt><dd>{planDateTime(item.productionDeadlineAt, plan.timezone)}</dd></div>
              <div><dt className="text-black/35">Channel / format</dt><dd>{item.channel} · {item.format}</dd></div>
              <div><dt className="text-black/35">Dependencies</dt><dd>{item.dependencies.length ? item.dependencies.join(" · ") : "None"}</dd></div>
            </dl>
            {item.constraints.length ? <p className="mt-2 text-[10px]">Constraints: {item.constraints.join(" · ")}</p> : null}
            {item.requiredAssets.length ? <p className="mt-1 text-[10px]">Required assets: {item.requiredAssets.join(" · ")}</p> : null}
            <code className="mt-2 block text-[9px] text-black/40">Evidence: {item.evidenceRefs.join(" · ")}</code>
          </li>;
        })}
      </ol>
      {plan.assumptions.length ? <div className="mt-4 border-t border-black/10 pt-3"><p className="text-[9px] font-bold uppercase text-black/40">Assumptions</p><ul className="mt-1 text-[10px] text-black/60">{plan.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul></div> : null}
      {job.editorialPlanEvidenceLineage?.length ? <code className="mt-3 block text-[9px] text-black/40">Plan provenance: {job.editorialPlanEvidenceLineage.join(" · ")}</code> : null}
    </section>
  );
}

function ProductionTraceSection({ job }: { job: JobFull }) {
  const trace = job.productionTrace;
  if (!trace) return null;
  const accepted = trace.acceptedDraft;
  return (
    <section className="border border-black/15 bg-[#fff2ea] p-5" data-canvas-artifact="production-trace:current">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-[9px] font-black uppercase tracking-[0.18em] text-[#ff5c35]">Noni writing · Dara review</p><h3 className="mt-1 font-serif text-xl">Accepted draft · revision {accepted.revision}</h3></div>
        <span className="rounded-full border border-black/15 px-2 py-1 font-mono text-[8px]">{accepted.confidence} confidence</span>
      </div>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{accepted.text}</p>
      <dl className="mt-4 grid grid-cols-2 gap-2 text-[10px] text-black/60">
        <div><dt className="text-black/35">Objective</dt><dd>{accepted.objective}</dd></div>
        <div><dt className="text-black/35">CTA</dt><dd>{accepted.ctaTreatment}</dd></div>
        <div><dt className="text-black/35">Audience / funnel</dt><dd>{accepted.audienceId} · {accepted.funnelStage}</dd></div>
        <div><dt className="text-black/35">Conversion</dt><dd>{accepted.intendedConversion}</dd></div>
      </dl>
      <details className="mt-4"><summary className="cursor-pointer text-[10px] font-bold uppercase">Claims, provenance, and review trace</summary>
        <ol className="mt-2 space-y-2">{accepted.claims.map((claim) => <li key={`${claim.text}:${claim.evidenceRefs.join(":")}`} className="border-t border-black/10 pt-2 text-xs"><span>{claim.text}</span><code className="mt-1 block text-[9px] text-black/40">Evidence: {claim.evidenceRefs.join(" · ")}</code></li>)}</ol>
        <p className="mt-3 text-[10px] text-black/55">Applied constraints: {accepted.appliedConstraints.join(" · ")}</p>
        {accepted.assumptions.length ? <p className="mt-1 text-[10px] text-black/55">Assumptions: {accepted.assumptions.join(" · ")}</p> : null}
        <ol className="mt-3 space-y-2">{trace.reviews.map((review) => <li key={review.id} className="border-t border-black/10 pt-2 text-[10px]"><b>Dara revision {review.revision}: {review.verdict}</b>{review.issues.map((issue) => <p key={issue.id} className="mt-1">{issue.category} · {issue.severity}: {issue.instruction} <code>{issue.evidenceRefs.join(" · ")}</code></p>)}</li>)}</ol>
        {job.productionTraceDigest ? <code className="mt-3 block text-[9px] text-black/40">Trace digest: {job.productionTraceDigest}</code> : null}
      </details>
    </section>
  );
}

export function SourcesWorkspace({ job, receipts }: { job: JobFull; receipts: Receipt[] }) {
  return (
    <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
      <section className="border border-black/15 bg-[#fffdf7] p-5"><div className="mb-4 flex items-end justify-between"><div><p className="text-[9px] font-black uppercase tracking-[0.18em] text-[#3157ff]">Ground truth</p><h3 className="font-serif text-2xl">Transcript</h3></div><span className="font-mono text-[10px] text-black/40">{job.transcriptSegments.length} segments</span></div><ol className="max-h-[56vh] space-y-3 overflow-y-auto pr-2">{job.transcriptSegments.map((segment) => <li key={segment.id} data-canvas-artifact={`source:${segment.id}`} className="grid grid-cols-[3.5rem_1fr] gap-3 border-t border-black/10 pt-3"><span className="font-mono text-xs text-[#ff5c35]">{timestamp(segment.startSec)}</span><p className="text-sm leading-6 text-black/70">{segment.text}</p></li>)}</ol>{!job.transcriptSegments.length ? <p className="py-8 text-sm text-black/40">No transcript has been persisted for this job.</p> : null}</section>
      <div className="space-y-5">
        {job.contentStrategy ? <section className="border border-black/15 bg-[#f0edff] p-5" data-canvas-artifact="strategy:current"><div className="flex items-start justify-between gap-3"><div><p className="text-[9px] font-black uppercase tracking-[0.18em] text-[#5165ff]">Ryan strategy · v{job.contentStrategy.version}</p><h3 className="mt-1 font-serif text-xl">{job.contentStrategy.thesis}</h3></div><span className="rounded-full border border-black/15 px-2 py-1 font-mono text-[8px]">{job.strategyApprovalState ?? "pending"}</span></div><p className="mt-3 text-xs leading-5 text-black/60">{job.contentStrategy.differentiatedNarrative}</p><dl className="mt-4 grid grid-cols-3 gap-2 text-xs"><div><dt className="text-black/40">Horizon</dt><dd>{job.contentStrategy.horizonWeeks} weeks</dd></div><div><dt className="text-black/40">Confidence</dt><dd>{job.contentStrategy.confidence}</dd></div><div><dt className="text-black/40">Briefs</dt><dd>{job.contentStrategy.briefs.length}</dd></div></dl><div className="mt-4 flex flex-wrap gap-1">{job.contentStrategy.pillars.map((pillar) => <span key={pillar.name} className="rounded-full bg-white px-2 py-1 text-[9px]">{pillar.name}</span>)}</div><details className="mt-4"><summary className="cursor-pointer text-[10px] font-bold uppercase">Briefs and provenance</summary><ol className="mt-2 space-y-2">{job.contentStrategy.briefs.map((brief) => <li key={brief.id} className="border-t border-black/10 pt-2 text-xs"><b>{brief.title}</b><p className="mt-1 text-black/55">{brief.keyMessage}</p><code className="mt-1 block text-[9px] text-black/40">{brief.evidenceRefs.join(" · ")}</code></li>)}</ol>{job.contentStrategy.assumptions.length ? <ul className="mt-3 text-[10px] text-black/50">{job.contentStrategy.assumptions.map((item) => <li key={item.text}>Assumption ({item.confidence}): {item.text}</li>)}</ul> : null}</details></section> : null}
        <EditorialPlanSection job={job} />
        <ProductionTraceSection job={job} />
        <section className="border border-black/15 bg-[#d9ff43]/30 p-5"><h3 className="font-serif text-xl">Detected moments</h3><div className="mt-3 space-y-3">{job.moments.map((moment) => <article key={moment.id} className="border-t border-black/15 pt-3"><div className="flex justify-between gap-3"><strong className="text-sm">{moment.title}</strong><span className="shrink-0 font-mono text-[10px]">{timestamp(moment.startSec)}–{timestamp(moment.endSec)}</span></div><p className="mt-1 text-xs leading-5 text-black/60">{moment.hook}</p>{moment.cropSuitability ? <span className="mt-2 inline-block bg-white/70 px-2 py-1 text-[9px] font-bold uppercase">crop {moment.cropSuitability}</span> : null}</article>)}</div></section>
        <section className="border border-black/15 bg-[#fffdf7] p-5"><h3 className="font-serif text-xl">Narrative angles</h3><div className="mt-3 space-y-3">{job.angles.map((angle) => <article key={angle.id}><span className="text-[9px] font-black uppercase tracking-wider text-[#8d5cff]">{angle.kind}</span><strong className="block text-sm">{angle.title}</strong><p className="mt-1 text-xs leading-5 text-black/55">{angle.rationale}</p></article>)}</div></section>
        <section className="border border-black/15 bg-[#17151e] p-5 text-white"><div className="flex justify-between"><h3 className="font-serif text-xl">Receipts & verification</h3><span className="font-mono text-xs text-white/45">{receipts.length}</span></div><ul className="mt-3 space-y-2">{receipts.map((receipt) => <li key={receipt.id} className="border-t border-white/15 pt-2 text-xs"><div className="flex justify-between gap-2"><span>{receipt.actionType}</span><span className={receipt.outcome === "applied" || receipt.outcome === "already_applied" ? "text-[#d9ff43]" : "text-[#ff896d]"}>{receipt.outcome}</span></div>{receipt.artifact?.url ? <a href={receipt.artifact.url} target="_blank" rel="noreferrer" className="mt-1 block truncate font-mono text-[10px] text-white/45 underline">{receipt.artifact.url}</a> : null}</li>)}</ul>{!receipts.length ? <p className="mt-3 text-xs text-white/45">No execution receipts exist yet.</p> : null}{(job.verifications ?? []).map((verification) => <div key={verification.rubricItemId} className="mt-3 border-t border-white/15 pt-3 text-xs"><span className={verification.verified ? "text-[#d9ff43]" : "text-[#ff896d]"}>{verification.verified ? "Verified" : "Unverified"}</span> · {verification.method}{verification.evidence.url ? <a href={verification.evidence.url} target="_blank" rel="noreferrer" className="ml-2 underline">evidence</a> : null}</div>)}</section>
      </div>
    </div>
  );
}
