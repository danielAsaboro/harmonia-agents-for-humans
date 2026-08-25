"use client";
import { useEffect, useState } from "react";

type Row = { id: string; type?: string; state?: string; outcome?: string; scheduledAt?: string; briefing?: string; estimatedCostUsd?: number };
type Data = { provenance: string; cycles: Row[]; agendas: Row[]; experiments: Row[]; revisions: Row[]; attention: Row[] };
export default function AutonomousOperationsView() {
  const [data, setData] = useState<Data | null>(null); const [error, setError] = useState("");
  useEffect(() => { fetch("/api/autonomy", { cache: "no-store" }).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }).then(setData).catch((e) => setError(String(e))); }, []);
  if (error) return <div role="alert" className="rounded-xl border border-red-300 p-4">Autonomy state unavailable: {error}</div>;
  if (!data) return <p>Loading resident autonomy state…</p>;
  const cost = data.cycles.reduce((sum, row) => sum + (row.estimatedCostUsd ?? 0), 0);
  return <section className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-4">{[["Cycles", data.cycles.length], ["Experiments", data.experiments.length], ["Open attention", data.attention.filter((x) => x.state === "open").length], ["Estimated cost", `$${cost.toFixed(4)}`]].map(([label, value]) => <div key={label} className="rounded-2xl border border-zinc-200 p-4 dark:border-zinc-800"><div className="text-xs text-zinc-500">{label}</div><div className="mt-1 text-xl font-semibold">{value}</div></div>)}</div>
    <div className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800"><h2 className="font-semibold">Resident cycles</h2><p className="text-xs text-zinc-500">Persisted tenant-scoped state · {data.provenance}</p>{data.cycles.length === 0 ? <p className="mt-4 text-sm">No resident cycles have run. Schedules are disabled by default.</p> : <ul className="mt-3 divide-y divide-zinc-200 dark:divide-zinc-800">{data.cycles.map((cycle) => <li key={cycle.id} className="py-3 text-sm"><b>{cycle.type}</b> · {cycle.state}<div className="text-zinc-500">{cycle.outcome}</div></li>)}</ul>}</div>
    <div className="rounded-2xl border border-zinc-200 p-5 dark:border-zinc-800"><h2 className="font-semibold">Wakeup agendas</h2>{data.agendas.length === 0 ? <p className="mt-3 text-sm">No durable agenda yet.</p> : data.agendas.map((a) => <p key={a.id} className="mt-3 text-sm">{a.briefing}</p>)}</div>
  </section>;
}
