"use client";

import { useEffect, useMemo, useState } from "react";
import type { JobSummary } from "@/components/jobTypes";
import { Button } from "@/components/dashboard/Button";
import { Select, TextInput } from "@/components/dashboard/Controls";
import { DataShell } from "@/components/dashboard/DataShell";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/SystemState";

export default function JobsTableView({ onOpenJob }: { onOpenJob?: (id: string) => void }) {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [sortDesc, setSortDesc] = useState(true);
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/jobs", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => { setJobs(d.jobs); setError(""); })
        .catch((cause) => setError(cause instanceof Error ? cause.message : "Jobs request failed"));
    }, 0);
    return () => clearTimeout(t);
  }, [reload]);

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
    <div className="ops-stack">
      <div className="ops-filter-row">
        <TextInput aria-label="Search jobs"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search url, brief, or job id…"
        />
        <Select aria-label="Filter jobs by status"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
        >
          <option value="">all statuses</option>
          <option value="running">running</option>
          <option value="waiting_for_approval">waiting for approval</option>
          <option value="complete">complete</option>
          <option value="failed">failed</option>
        </Select>
        <Button variant="quiet"
          onClick={() => setSortDesc((d) => !d)}
        >
          created {sortDesc ? "↓ newest first" : "↑ oldest first"}
        </Button>
        <span className="ml-auto text-[11px] text-zinc-400">{rows.length} job(s)</span>
      </div>

      {error ? <ErrorState title="Jobs could not be loaded" message={error} action={<Button onClick={() => setReload((value) => value + 1)}>Retry</Button>} /> : jobs === null ? <LoadingState title="Loading jobs" /> : rows.length === 0 ? <EmptyState title="No jobs match" message="Change the search or status filter to widen the query." /> : <DataShell>
        <table className="ops-table">
          <thead>
            <tr>
              <th>Job</th><th>Source</th><th>Stage</th><th>Status</th><th>Created</th><th>Failure</th>
            </tr>
          </thead>
          <tbody>
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
                  <StatusBadge tone={j.status === "complete" ? "success" : j.status === "failed" ? "danger" : j.status === "waiting_for_approval" ? "warning" : "info"}>
                    {j.status.replace("_", " ")}
                  </StatusBadge>
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-500">
                  {new Date(j.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="max-w-[200px] truncate px-3 py-2 text-red-600 dark:text-red-400" title={j.failure?.error}>
                  {j.failure ? `${j.failure.stage}: ${j.failure.error.slice(0, 60)}` : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DataShell>}
    </div>
  );
}
