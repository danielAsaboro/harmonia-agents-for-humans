import type { AgentActivity } from "@/lib/observability/schema";

function TraceNode({ item, children }: { item: AgentActivity; children: Map<string, AgentActivity[]> }) {
  return <li className="ml-3 border-l border-zinc-200 pl-3 dark:border-zinc-800">
    <details open={!item.parentSpanId}>
      <summary className="cursor-pointer py-2 text-xs"><span className="font-mono font-medium">{item.agent}</span> · {item.eventName} · {item.durationMs} ms <Outcome value={item.outcome} /></summary>
      <div className="mb-2 grid gap-1 text-[11px] text-zinc-500 sm:grid-cols-2"><span>stage: {item.stage}</span><span>span: {item.spanId}</span><span>model: {item.model ?? "—"}</span><span>tool: {item.tool ?? "—"}</span></div>
      {(children.get(item.spanId) ?? []).length > 0 && <ul>{children.get(item.spanId)!.map((child) => <TraceNode key={child.id} item={child} children={children} />)}</ul>}
    </details>
  </li>;
}

export default function TraceTree({ records }: { records: AgentActivity[] }) {
  const traces = records.filter((record) => record.signalType === "trace");
  const grouped = new Map<string, AgentActivity[]>();
  for (const trace of traces) grouped.set(trace.traceId, [...(grouped.get(trace.traceId) ?? []), trace]);
  if (!grouped.size) return <Empty />;
  return <div className="space-y-3">{[...grouped.entries()].map(([traceId, items]) => {
    const ids = new Set(items.map((item) => item.spanId));
    const children = new Map<string, AgentActivity[]>();
    for (const item of items) if (item.parentSpanId && ids.has(item.parentSpanId)) children.set(item.parentSpanId, [...(children.get(item.parentSpanId) ?? []), item]);
    const roots = items.filter((item) => !item.parentSpanId || !ids.has(item.parentSpanId));
    return <section key={traceId} className="rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"><p className="mb-1 break-all font-mono text-[11px] text-zinc-500">trace {traceId}</p><ul>{roots.map((root) => <TraceNode key={root.id} item={root} children={children} />)}</ul></section>;
  })}</div>;
}

function Outcome({ value }: { value: "success" | "error" }) { return <span className={value === "success" ? "text-emerald-600" : "text-red-600"}>{value}</span>; }
function Empty() { return <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">No trace spans match these filters.</p>; }
