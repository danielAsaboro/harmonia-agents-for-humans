"use client";

import type { JobSummary } from "@/components/Dashboard";

const STAGE_ORDER = [
  "ingest",
  "normalize",
  "collect",
  "evaluate",
  "plan",
  "awaiting_approval",
  "act",
  "verify",
] as const;

function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "bg-blue-500";
    case "waiting_for_approval":
      return "bg-amber-500";
    case "complete":
      return "bg-emerald-500";
    case "failed":
      return "bg-red-500";
    default:
      return "bg-zinc-400";
  }
}

export default function JobList({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: JobSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        Jobs ({jobs.length})
      </h2>
      {jobs.length === 0 && (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">No jobs yet.</p>
      )}
      <ul className="flex flex-col gap-2">
        {jobs.map((job) => {
          const idx = STAGE_ORDER.indexOf(job.stage as (typeof STAGE_ORDER)[number]);
          return (
            <li key={job.id}>
              <button
                onClick={() => onSelect(job.id)}
                className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                  selectedId === job.id
                    ? "border-zinc-900 bg-zinc-100 dark:border-white dark:bg-zinc-800"
                    : "border-zinc-200 hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-xs font-medium">
                    {job.config.githubOwner}/{job.config.githubRepo}
                  </span>
                  <span className={`h-2 w-2 shrink-0 rounded-full ${statusColor(job.status)}`} />
                </div>
                <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{job.stage}</div>
                {job.stage !== "failed" && job.stage !== "complete" && (
                  <div className="mt-2 flex gap-0.5">
                    {STAGE_ORDER.map((s, i) => (
                      <span
                        key={s}
                        className={`h-1 flex-1 rounded-full ${
                          i <= idx ? "bg-zinc-700 dark:bg-zinc-300" : "bg-zinc-200 dark:bg-zinc-700"
                        }`}
                      />
                    ))}
                  </div>
                )}
                {job.failure && (
                  <div className="mt-2 truncate text-xs text-red-600 dark:text-red-400" title={job.failure.error}>
                    {job.failure.permanent ? "permanent: " : "retrying: "}
                    {job.failure.error}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
