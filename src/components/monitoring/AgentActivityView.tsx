"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentActivity, ObservabilityPage } from "@/lib/observability/schema";
import ActivityFilters from "./ActivityFilters";
import ActivityMetrics from "./ActivityMetrics";
import TraceTree from "./TraceTree";

type SignalType = "log" | "trace" | "metric";
export interface ActivityFiltersState { types: SignalType[]; agent: string; stage: string; outcome: string; severity: string; model: string; tool: string; jobId: string; traceId: string; since: string; until: string; q: string; }
export interface ActivityPagination { cursor: string | null; history: Array<string | null>; }
export const emptyActivityFilters = (): ActivityFiltersState => ({ types: [], agent: "", stage: "", outcome: "", severity: "", model: "", tool: "", jobId: "", traceId: "", since: "", until: "", q: "" });
export const resetPagination = (_pagination: ActivityPagination): ActivityPagination => ({ cursor: null, history: [] });

export function buildActivityQuery(filters: ActivityFiltersState, cursor: string | null): URLSearchParams {
  const query = new URLSearchParams({ limit: "25" });
  for (const type of filters.types) query.append("type", type);
  for (const key of ["agent", "stage", "outcome", "severity", "model", "tool", "jobId", "traceId", "q"] as const) if (filters[key]) query.set(key, filters[key]);
  for (const key of ["since", "until"] as const) if (filters[key]) query.set(key, new Date(filters[key]).toISOString());
  if (cursor) query.set("cursor", cursor);
  return query;
}

const modes: Array<{ label: string; type: SignalType }> = [{ label: "Logs", type: "log" }, { label: "Traces", type: "trace" }, { label: "Metrics", type: "metric" }];

export default function AgentActivityView() {
  const [filters, setFilters] = useState<ActivityFiltersState>(emptyActivityFilters);
  const [pagination, setPagination] = useState<ActivityPagination>({ cursor: null, history: [] });
  const [page, setPage] = useState<ObservabilityPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const query = useMemo(() => buildActivityQuery(filters, pagination.cursor).toString(), [filters, pagination.cursor]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const response = await fetch(`/api/observability?${query}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Activity request failed (${response.status})`);
        setPage(await response.json() as ObservabilityPage);
        const url = new URL(window.location.href); url.searchParams.set("activity", query); window.history.replaceState(null, "", url);
      } catch (cause) { if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Activity request failed"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }, filters.q ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, filters.q]);

  const changeFilters = useCallback((next: ActivityFiltersState) => { setFilters(next); setPagination(resetPagination); }, []);
  const selectMode = (type: SignalType) => changeFilters({ ...filters, types: [type] });
  const items = page?.items ?? [];

  return <section className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-medium">Agent activity</h2><p className="text-xs text-zinc-500">Safe operational metadata only. Prompt and response content is never stored here.</p></div>
      <div className="flex rounded-full border border-zinc-200 p-1 text-xs dark:border-zinc-800">{modes.map((mode) => <button key={mode.type} className={`rounded-full px-3 py-1.5 ${filters.types[0] === mode.type && filters.types.length === 1 ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "text-zinc-500"}`} onClick={() => selectMode(mode.type)}>{mode.label}</button>)}</div>
    </div>
    <ActivityFilters filters={filters} onChange={changeFilters} />
    {error && <div role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error} <button className="underline" onClick={() => setPagination((v) => ({ ...v }))}>Retry</button></div>}
    {loading ? <p className="p-8 text-center text-sm text-zinc-500">Loading agent activity…</p> : filters.types[0] === "metric" && filters.types.length === 1 ? <ActivityMetrics records={items} /> : filters.types[0] === "trace" && filters.types.length === 1 ? <TraceTree records={items} /> : <ActivityTable records={items} />}
    <div className="flex items-center justify-between text-xs"><span className="text-zinc-500">{items.length} records on this page</span><div className="flex gap-2"><button disabled={!pagination.history.length || loading} className="rounded-full border px-3 py-1.5 disabled:opacity-40 dark:border-zinc-700" onClick={() => setPagination((current) => ({ cursor: current.history.at(-1) ?? null, history: current.history.slice(0, -1) }))}>Previous</button><button disabled={!page?.hasMore || !page.nextCursor || loading} className="rounded-full border px-3 py-1.5 disabled:opacity-40 dark:border-zinc-700" onClick={() => setPagination((current) => ({ cursor: page!.nextCursor, history: [...current.history, current.cursor] }))}>Next</button></div></div>
  </section>;
}

function ActivityTable({ records }: { records: AgentActivity[] }) {
  if (!records.length) return <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">No activity matches these filters.</p>;
  return <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800"><table className="w-full text-left text-xs"><thead className="bg-zinc-50 text-zinc-500 dark:bg-zinc-900"><tr>{["Time", "Signal", "Agent / stage", "Event", "Outcome", "Duration", "Details"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead><tbody>{records.map((item) => <tr key={item.id} className="border-t border-zinc-200 align-top dark:border-zinc-800"><td className="whitespace-nowrap px-3 py-2">{new Date(item.occurredAt).toLocaleString()}</td><td className="px-3 py-2">{item.signalType}</td><td className="px-3 py-2"><span className="font-mono">{item.agent}</span><br/><span className="text-zinc-500">{item.stage}</span></td><td className="px-3 py-2">{item.eventName}</td><td className={item.outcome === "error" ? "px-3 py-2 text-red-600" : "px-3 py-2 text-emerald-600"}>{item.outcome}</td><td className="px-3 py-2">{item.durationMs} ms</td><td className="px-3 py-2"><details><summary className="cursor-pointer">Inspect</summary><pre className="mt-2 max-w-sm whitespace-pre-wrap break-all text-[10px] text-zinc-500">{JSON.stringify(item, null, 2)}</pre></details></td></tr>)}</tbody></table></div>;
}
