"use client";

import { useCallback, useEffect, useState } from "react";

interface LogEntry {
  id: string;
  jobId: string;
  at: string | null;
  stage: string;
  message: string;
  actor: string;
}

const STAGES = [
  "ingest", "transcribe", "understand", "draft",
  "awaiting_approval", "publish", "verify", "learn",
];
const ACTORS = ["system", "agent", "operator"];

function StageChip({ stage }: { stage: string }) {
  const color =
    stage === "failed"
      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
      : stage === "awaiting_approval"
        ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
        : stage === "learn" || stage === "verify"
          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
          : "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400";
  return <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${color}`}>{stage}</span>;
}

export default function LogsView() {
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [stages, setStages] = useState<string[]>([]);
  const [actor, setActor] = useState("");
  const [jobId, setJobId] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (q) params.set("q", q);
    for (const s of stages) params.append("stage", s);
    if (actor) params.set("actor", actor);
    if (jobId) params.set("jobId", jobId);
    const res = await fetch(`/api/events?${params.toString()}`, { cache: "no-store" });
    if (res.ok) {
      const d = await res.json();
      setEntries(d.events);
      setTotal(d.total);
    }
  }, [q, stages, actor, jobId]);

  useEffect(() => {
    const t = setTimeout(() => void load(), q ? 250 : 0); // debounce typing
    return () => clearTimeout(t);
  }, [load, q]);

  function toggleStage(s: string) {
    setStages((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search messages or job ids…"
          className="w-full max-w-xs rounded-full border border-zinc-300 bg-white px-4 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
        <select
          value={actor}
          onChange={(e) => setActor(e.target.value)}
          className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">all actors</option>
          {ACTORS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
        <input
          value={jobId}
          onChange={(e) => setJobId(e.target.value)}
          placeholder="filter by job id"
          className="w-40 rounded-full border border-zinc-300 bg-white px-3 py-1.5 font-mono text-xs outline-none dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setStages([])}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            stages.length === 0 ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "border border-zinc-300 text-zinc-500 dark:border-zinc-700"
          }`}
        >
          all stages
        </button>
        {STAGES.map((s) => (
          <button
            key={s}
            onClick={() => toggleStage(s)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize ${
              stages.includes(s)
                ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                : "border border-zinc-300 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700"
            }`}
          >
            {s.replace("_", " ")}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-zinc-400">{total} matching event(s)</span>
      </div>

      <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
        {entries === null ? (
          <p className="p-6 text-center text-xs text-zinc-400">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="p-6 text-center text-xs text-zinc-400">No events match these filters.</p>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-zinc-100 overflow-y-auto dark:divide-zinc-900">
            {entries.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-3 py-2 text-xs">
                <span className="w-24 shrink-0 font-mono text-[10px] text-zinc-400">
                  {e.at ? new Date(e.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}
                </span>
                <StageChip stage={e.stage} />
                <span className="min-w-0 flex-1 break-words leading-5 text-zinc-700 dark:text-zinc-300">
                  <span className="text-zinc-400">[{e.actor}]</span> {e.message}
                </span>
                <button
                  onClick={() => setJobId(e.jobId === jobId ? "" : e.jobId)}
                  title="Filter by this job"
                  className="shrink-0 font-mono text-[10px] text-blue-600 underline dark:text-blue-400"
                >
                  {e.jobId.slice(0, 12)}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
