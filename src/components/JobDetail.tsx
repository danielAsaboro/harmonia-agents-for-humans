"use client";

import { useState } from "react";
import PipelineStepper from "@/components/PipelineStepper";
import Timeline from "@/components/Timeline";
import type { JobFull, TimelineEvent } from "@/components/Dashboard";
import { evidenceJson, evidenceMarkdown, download } from "@/lib/evidenceExport";
import type { PlannedAction, Receipt } from "@/lib/types";

type Tab = "overview" | "evidence" | "actions" | "receipts" | "packet";

const TABS: Array<{ key: Tab; label: string }> = [
  { key: "overview", label: "Rubric & findings" },
  { key: "evidence", label: "Evidence" },
  { key: "actions", label: "Actions" },
  { key: "receipts", label: "Receipts" },
  { key: "packet", label: "Packet" },
];

function Chip({ children, tone = "zinc" }: { children: React.ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    zinc: "bg-zinc-200 text-zinc-700 dark:bg-zinc-700 dark:text-zinc-300",
    green: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200",
    red: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    blue: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  };
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>
      {children}
    </span>
  );
}

function ActionPreview({ action }: { action: PlannedAction }) {
  const p = action.payload as Record<string, unknown>;
  if (action.type === "github_upsert_file") {
    const content = String(p.content ?? "");
    const truncated = content.length > 4000;
    return (
      <div className="mt-2 space-y-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
        <p>
          <span className="text-zinc-400">path:</span> {String(p.path)}{" "}
          <span className="text-zinc-400">branch:</span> {String(p.branch ?? "main")}
        </p>
        <p className="truncate"><span className="text-zinc-400">commit:</span> {String(p.commitMessage ?? "")}</p>
        <details open={action.risk === "high"}>
          <summary className="cursor-pointer select-none text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            file content ({content.length} chars{truncated ? ", preview truncated" : ""})
          </summary>
          <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-white p-3 leading-4 dark:border-zinc-700 dark:bg-zinc-950">
            {truncated ? `${content.slice(0, 4000)}\n… (${content.length - 4000} more chars)` : content}
          </pre>
        </details>
      </div>
    );
  }
  const body = String((p as { body?: string }).body ?? "");
  return (
    <div className="mt-2 space-y-1 font-mono text-[11px] text-zinc-500 dark:text-zinc-400">
      <p><span className="text-zinc-400">labels:</span> {JSON.stringify((p as { labels?: string[] }).labels ?? [])}</p>
      <details>
        <summary className="cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-300">
          issue body ({body.length} chars)
        </summary>
        <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap rounded-md border border-zinc-200 bg-white p-3 leading-4 dark:border-zinc-700 dark:bg-zinc-950">{body}</pre>
      </details>
    </div>
  );
}

export default function JobDetail({
  job,
  events,
  receipts,
  onDecide,
  onRetry,
}: {
  job: JobFull;
  events: TimelineEvent[];
  receipts: Receipt[];
  onDecide: (actionId: string, decision: "approved" | "rejected") => Promise<void>;
  onRetry: () => Promise<void>;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState(false);

  const verificationByItem = new Map<string, NonNullable<JobFull["verifications"]>[number]>();
  for (const v of job.verifications ?? []) {
    const existing = verificationByItem.get(v.rubricItemId);
    if (!existing || (v.verified && !existing.verified)) {
      verificationByItem.set(v.rubricItemId, v);
    }
  }

  const pendingActions = job.actions.filter((a) => a.approvalState === "pending");
  const verifiedCount = (job.verifications ?? []).filter((v) => v.verified).length;

  async function decide(actionId: string, decision: "approved" | "rejected") {
    setBusy(true);
    try {
      await onDecide(actionId, decision);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-sm font-semibold">
            {job.config.githubOwner}/{job.config.githubRepo}
          </h2>
          <div className="flex items-center gap-2">
            {job.status === "complete" && <Chip tone="green">complete</Chip>}
            {job.status === "failed" && <Chip tone="red">failed</Chip>}
            {job.status === "waiting_for_approval" && <Chip tone="amber">awaiting approval</Chip>}
            {job.status === "running" && <Chip tone="blue">running</Chip>}
            <span className="font-mono text-xs text-zinc-400">{job.id.slice(0, 8)}</span>
          </div>
        </div>

        <div className="mt-4">
          <PipelineStepper stage={job.stage} status={job.status} />
        </div>

        {job.failure && (
          <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/50">
            <p className="text-sm text-red-700 dark:text-red-300">
              {job.failure.permanent ? "Permanent failure" : "Transient failure — Pub/Sub will redeliver"} at{" "}
              <span className="font-mono">{job.failure.stage}</span>: {job.failure.error}
            </p>
            {job.failure.permanent && (
              <button
                onClick={() => void onRetry()}
                disabled={busy}
                className="mt-2 rounded-full bg-red-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
              >
                Retry from failure point
              </button>
            )}
          </div>
        )}

        <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
          <Timeline events={events} />
        </div>
      </section>

      {pendingActions.length > 0 && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/60">
          <h2 className="font-semibold text-amber-900 dark:text-amber-200">
            Approval required — review before allowing repository writes ({pendingActions.length})
          </h2>
          <div className="mt-3 flex flex-col gap-3">
            {pendingActions.map((a) => (
              <div
                key={a.id}
                className={`rounded-lg border bg-white p-3 dark:bg-zinc-900 ${
                  a.risk === "high"
                    ? "border-amber-400 dark:border-amber-600"
                    : "border-amber-200 dark:border-amber-800"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{a.title}</span>
                  <div className="flex gap-1.5">
                    <Chip tone={a.risk === "high" ? "red" : a.risk === "medium" ? "amber" : "green"}>
                      {a.risk} risk
                    </Chip>
                    <Chip tone="blue">{a.type}</Chip>
                  </div>
                </div>
                <p className="mt-1 text-xs leading-5 text-zinc-600 dark:text-zinc-400">{a.description}</p>
                <ActionPreview action={a} />
                <div className="mt-3 flex gap-2">
                  <button
                    onClick={() => void decide(a.id, "approved")}
                    disabled={busy}
                    className="rounded-full bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
                  >
                    Approve write to {String((a.payload as { branch?: string }).branch ?? "main")}
                  </button>
                  <button
                    onClick={() => void decide(a.id, "rejected")}
                    disabled={busy}
                    className="rounded-full border border-zinc-300 px-4 py-1.5 text-xs font-medium transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-600 dark:hover:bg-zinc-800"
                  >
                    Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-zinc-200 dark:border-zinc-800">
        <div className="flex gap-1 overflow-x-auto border-b border-zinc-200 px-2 pt-2 dark:border-zinc-800">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`shrink-0 rounded-t-lg px-3 py-2 text-xs font-medium transition-colors ${
                tab === t.key
                  ? "border-b-2 border-zinc-900 text-zinc-900 dark:border-white dark:text-white"
                  : "border-b-2 border-transparent text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-300"
              }`}
            >
              {t.label}
              {t.key === "actions" && job.actions.length > 0 && ` (${job.actions.length})`}
              {t.key === "receipts" && receipts.length > 0 && ` (${receipts.length})`}
              {t.key === "packet" && job.packet?.unresolved.length ? ` (${job.packet.unresolved.length}!)` : ""}
            </button>
          ))}
        </div>

        <div className="p-4">
          {tab === "overview" && (
            <>
              {job.rubric.length === 0 ? (
                <Empty text="Rubric appears after the normalize stage completes." />
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="text-zinc-500 dark:text-zinc-400">
                    <tr>
                      <th className="pb-2 pr-2 font-medium">Requirement</th>
                      <th className="pb-2 pr-2 font-medium">Finding</th>
                      <th className="pb-2 pr-2 font-medium">Verified</th>
                      <th className="pb-2 font-medium">Artifact</th>
                    </tr>
                  </thead>
                  <tbody className="align-top">
                    {job.rubric.map((item) => {
                      const finding = job.findings.find((f) => f.rubricItemId === item.id);
                      const v = verificationByItem.get(item.id);
                      const links: Array<{ url: string }> = [...(finding?.evidence ?? [])];
                      if (v?.evidence.url && !links.some((l) => l.url === v.evidence.url)) links.push({ url: v.evidence.url });
                      return (
                        <tr key={item.id} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="py-2.5 pr-3">
                            <Chip tone={item.status === "verified" ? "green" : item.status === "pending" ? "zinc" : "red"}>
                              {item.status}
                            </Chip>
                            <span className="mt-1 block leading-5">{String(item.requirement)}</span>
                            <span className="text-[10px] uppercase tracking-wide text-zinc-400">{item.category}</span>
                          </td>
                          <td className="py-2.5 pr-3 text-zinc-600 dark:text-zinc-400">
                            {finding ? (
                              <>
                                <span
                                  className={`font-semibold ${
                                    finding.status === "satisfied"
                                      ? "text-emerald-600 dark:text-emerald-400"
                                      : finding.status === "missing"
                                        ? "text-red-600 dark:text-red-400"
                                        : ""
                                  }`}
                                >
                                  {finding.status}
                                </span>
                                <span className="mt-0.5 block leading-5">{finding.rationale}</span>
                              </>
                            ) : (
                              <span className="text-zinc-400">—</span>
                            )}
                          </td>
                          <td className="py-2.5 pr-3">
                            {v ? (
                              <span title={v.note} className={v.verified ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                                {v.verified ? "confirmed" : "not confirmed"}
                                <span className="block font-mono text-[10px] text-zinc-400">{v.method}</span>
                              </span>
                            ) : (
                              <span className="text-zinc-400">—</span>
                            )}
                          </td>
                          <td className="py-2.5">
                            {links.length > 0 ? (
                              <ul className="space-y-1">
                                {links.slice(0, 3).map((l, i) => (
                                  <li key={i}>
                                    <a
                                      href={l.url}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="break-all font-mono text-[11px] text-blue-600 underline dark:text-blue-400"
                                    >
                                      {l.url.replace(/^https?:\/\/(api\.)?/, "").slice(0, 48)}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <span className="text-zinc-400">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </>
          )}

          {tab === "evidence" && (
            <>
              {(job.observations?.length ?? 0) === 0 ? (
                <Empty text="Raw evidence appears here after the collect stage." />
              ) : (
                <ul className="grid gap-2 sm:grid-cols-2">
                  {(job.observations ?? []).map((o, i) => (
                    <li key={i} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                      <div className="flex items-center justify-between gap-2">
                        <Chip tone={o.ok ? "green" : "red"}>{o.kind.replace("_", " ")}</Chip>
                        {o.httpStatus != null && <span className="font-mono text-[10px] text-zinc-400">HTTP {o.httpStatus}</span>}
                      </div>
                      <p className="mt-1 break-all font-mono text-[11px] font-medium">{o.target}</p>
                      <a href={o.url} target="_blank" rel="noopener noreferrer" className="break-all font-mono text-[10px] text-blue-600 underline dark:text-blue-400">
                        {o.url.replace(/^https?:\/\/(api\.)?/, "").slice(0, 52)}
                      </a>
                      {o.digest && (
                        <p className="mt-1 truncate font-mono text-[10px] text-zinc-400" title={o.digest ?? ""}>
                          sha256 {o.digest.slice(0, 20)}…
                        </p>
                      )}
                      {(o.excerpt || Object.keys(o.detail).length > 0) && (
                        <details className="mt-1">
                          <summary className="cursor-pointer select-none text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                            raw data
                          </summary>
                          {o.excerpt && (
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-50 p-2 text-[10px] leading-4 dark:bg-zinc-950">
                              {o.excerpt.slice(0, 1200)}
                            </pre>
                          )}
                          <pre className="mt-1 max-h-40 overflow-auto rounded-md bg-zinc-50 p-2 text-[10px] leading-4 dark:bg-zinc-950">
                            {JSON.stringify(o.detail, null, 2).slice(0, 1200)}
                          </pre>
                        </details>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === "actions" && (
            <>
              {job.actions.length === 0 ? (
                <Empty text="Corrective actions appear after the plan stage." />
              ) : (
                <ul className="flex flex-col gap-2">
                  {job.actions.map((a) => (
                    <li key={a.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm font-medium">{a.title}</span>
                        <div className="flex gap-1.5">
                          <Chip tone={a.state === "executed" ? "green" : a.state === "skipped" ? "amber" : a.state === "failed" ? "red" : "zinc"}>
                            {a.state}
                          </Chip>
                          <Chip>{a.approvalState.replace("_", " ")}</Chip>
                        </div>
                      </div>
                      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{a.description}</p>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === "receipts" && (
            <>
              {receipts.length === 0 ? (
                <Empty text="Audit receipts appear when approved actions execute." />
              ) : (
                <ul className="flex flex-col gap-2">
                  {receipts.map((r) => (
                    <li key={r.id} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
                      <div className="flex flex-wrap items-center gap-2">
                        <Chip tone={r.outcome === "applied" ? "green" : r.outcome === "already_applied" ? "blue" : "red"}>
                          {r.outcome}
                        </Chip>
                        <span className="font-mono text-xs">{r.actionType}</span>
                        <span className="ml-auto font-mono text-[10px] text-zinc-400">
                          {new Date(r.performedAt).toLocaleTimeString()} · key {r.idempotencyKey.slice(0, 12)}…
                        </span>
                      </div>
                      {r.artifact && (
                        <a
                          href={r.artifact.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 block break-all font-mono text-[11px] text-blue-600 underline dark:text-blue-400"
                        >
                          {r.artifact.url.replace("https://", "")}
                        </a>
                      )}
                      <details className="mt-1">
                        <summary className="cursor-pointer select-none text-[11px] text-zinc-500">detail</summary>
                        <pre className="mt-1 max-h-32 overflow-auto rounded-md bg-zinc-50 p-2 text-[10px] dark:bg-zinc-950">
                          {JSON.stringify(r.detail, null, 2)}
                        </pre>
                      </details>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}

          {tab === "packet" && (
            <>
              {!job.packet ? (
                <Empty text="The evidence packet is assembled after independent verification completes." />
              ) : (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat label="requirements" value={String(job.rubric.length)} />
                    <Stat label="verifications passed" value={`${verifiedCount}/${(job.verifications ?? []).length}`} tone="green" />
                    <Stat label="audit receipts" value={String(receipts.length)} tone="blue" />
                    <Stat
                      label="unresolved gaps"
                      value={String(job.packet.unresolved.length)}
                      tone={job.packet.unresolved.length > 0 ? "red" : "green"}
                    />
                  </div>
                  {job.packet.unresolved.length > 0 && (
                    <ul className="list-disc space-y-1 pl-5 text-sm text-red-700 dark:text-red-300">
                      {job.packet.unresolved.map((u, i) => (
                        <li key={i}>{u}</li>
                      ))}
                    </ul>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => download(`closefold-evidence-${job.id.slice(0, 8)}.md`, evidenceMarkdown(job), "text/markdown")}
                      className="rounded-full bg-zinc-900 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
                    >
                      Download packet (.md)
                    </button>
                    <button
                      onClick={() => download(`closefold-evidence-${job.id.slice(0, 8)}.json`, evidenceJson(job), "application/json")}
                      className="rounded-full border border-zinc-300 px-4 py-2 text-xs font-medium transition-colors hover:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800"
                    >
                      Download raw JSON
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="py-8 text-center text-sm text-zinc-400 dark:text-zinc-500">{text}</div>
  );
}

function Stat({ label, value, tone = "zinc" }: { label: string; value: string; tone?: string }) {
  const colors: Record<string, string> = {
    zinc: "text-zinc-900 dark:text-zinc-100",
    green: "text-emerald-600 dark:text-emerald-400",
    blue: "text-blue-600 dark:text-blue-400",
    red: "text-red-600 dark:text-red-400",
  };
  return (
    <div className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <div className={`text-xl font-bold ${colors[tone]}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-400">{label}</div>
    </div>
  );
}
