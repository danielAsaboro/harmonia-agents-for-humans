"use client";

import { useEffect, useMemo, useState } from "react";
import type { JobSummary } from "@/components/jobTypes";

export default function JobsTableView({ onOpenJob }: { onOpenJob?: (id: string) => void }) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [sortDesc, setSortDesc] = useState(true);
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/jobs", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => setJobs(d.jobs))
        .catch(() => setJobs([]));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const rows = useMemo(() => {
    let out = jobs ?? [];
    if (statusFilter) out = out.filter((j) => j.status === statusFilter);
    if (q) {
      const needle = q.toLowerCase();
      out = out.filter(
        (j) =>
          j.id.toLowerCase().includes(needle) ||
          (j.config.youtubeUrl ?? "").toLowerCase().includes(needle) ||
          (j.config.brief ?? "").toLowerCase().includes(needle),
      );
    }
    return [...out].sort((a, b) =>
      sortDesc
        ? Date.parse(b.createdAt) - Date.parse(a.createdAt)
        : Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
  }, [jobs, statusFilter, sortDesc, q]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search url, brief, or job id…"
          className="w-full max-w-xs rounded-full border border-zinc-300 bg-white px-4 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">all statuses</option>
          <option value="running">running</option>
          <option value="waiting_for_approval">waiting for approval</option>
          <option value="complete">complete</option>
          <option value="failed">failed</option>
        </select>
        <button
          onClick={() => setSortDesc((d) => !d)}
          className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs text-zinc-600 dark:border-zinc-700 dark:text-zinc-300"
        >
          created {sortDesc ? "↓ newest first" : "↑ oldest first"}
        </button>
        <span className="ml-auto text-[11px] text-zinc-400">{rows.length} job(s)</span>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="bg-zinc-50 uppercase tracking-wide text-[10px] text-zinc-400 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 font-medium">Job</th>
              <th className="px-3 py-2 font-medium">Source</th>
              <th className="px-3 py-2 font-medium">Stage</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Created</th>
              <th className="px-3 py-2 font-medium">Failure</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {rows.map((j) => (
              <tr
                key={j.id}
                onClick={() => onOpenJob?.(j.id)}
                className={`transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/60 ${onOpenJob ? "cursor-pointer" : ""}`}
              >
                <td className="px-3 py-2 font-mono">{j.id.slice(0, 16)}</td>
                <td className="max-w-[220px] truncate px-3 py-2">
                  {j.config.youtubeUrl ?? `brief: ${(j.config.brief ?? "").slice(0, 40)}`.replace(/^https?:\/\//, "")}
                </td>
                <td className="px-3 py-2 capitalize">{j.stage.replace("_", " ")}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    j.status === "complete" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                    : j.status === "failed" ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                    : j.status === "waiting_for_approval" ? "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400"
                    : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-400"
                  }`}>
                    {j.status.replace("_", " ")}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-500">
                  {new Date(j.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="max-w-[200px] truncate px-3 py-2 text-red-600 dark:text-red-400" title={j.failure?.error}>
                  {j.failure ? `${j.failure.stage}: ${j.failure.error.slice(0, 60)}` : "—"}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-zinc-400">No jobs match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
