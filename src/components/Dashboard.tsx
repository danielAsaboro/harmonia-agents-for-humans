"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { EvidenceRef, Finding, Observation, PlannedAction, Receipt, RubricItem, Stage } from "@/lib/types";
import NewJobForm from "@/components/NewJobForm";
import JobList from "@/components/JobList";
import JobDetail from "@/components/JobDetail";
import { apiFetch, getOperatorToken, setOperatorToken } from "@/lib/clientApi";

export interface JobSummary {
  id: string;
  status: string;
  stage: Stage;
  createdAt: string;
  updatedAt: string;
  config: { devpostUrl: string; githubRepo: string; githubOwner: string; cloudRunUrl?: string };
  failure?: { stage: Stage; error: string; permanent: boolean; at: string };
}

export interface JobFull extends JobSummary {
  rubric: RubricItem[];
  findings: Finding[];
  actions: PlannedAction[];
  observations?: Observation[];
  verifications?: Array<{
    rubricItemId: string;
    verified: boolean;
    method: string;
    evidence: Pick<EvidenceRef, "url" | "digest"> & { fetchedAt: string };
    note?: string;
  }>;
  packet?: {
    generatedAt: string;
    unresolved: string[];
    receipts: Receipt[];
  };
}

export interface TimelineEvent {
  at: string | null;
  stage: string;
  message: string;
  actor: string;
}

export default function Dashboard() {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobFull | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [tokenInput, setTokenInput] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setTokenInput(getOperatorToken()), 0);
    return () => clearTimeout(t);
  }, []);

  const refreshJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/jobs", { cache: "no-store" });
      if (!res.ok) throw new Error(`jobs ${res.status}`);
      const data = await res.json();
      setJobs(data.jobs);
      setOffline(false);
      setError(null);
    } catch (e) {
      setOffline(true);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshDetail = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/jobs/${id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setDetail(data.job);
      setEvents(data.events);
      setReceipts(data.receipts);
    } catch {
      /* transient poll errors surface via refreshJobs banner */
    }
  }, []);

  useEffect(() => {
    const kickoff = setTimeout(() => void refreshJobs(), 0);
    pollRef.current = setInterval(() => {
      if (document.hidden) return;
      void refreshJobs();
      if (selectedId) void refreshDetail(selectedId);
    }, 3000);
    return () => {
      clearTimeout(kickoff);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [refreshJobs, refreshDetail, selectedId]);

  useEffect(() => {
    if (selectedId) {
      const t = setTimeout(() => void refreshDetail(selectedId), 0);
      return () => clearTimeout(t);
    }
  }, [selectedId, refreshDetail]);

  async function decide(actionId: string, decision: "approved" | "rejected") {
    if (!selectedId) return;
    const res = await apiFetch(`/api/jobs/${selectedId}/actions/${actionId}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}) as { error?: string });
      setError(data.error ?? `decision failed (${res.status})`);
    }
    await Promise.all([refreshDetail(selectedId), refreshJobs()]);
  }

  async function retry() {
    if (!selectedId) return;
    const res = await apiFetch(`/api/jobs/${selectedId}/retry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}) as { error?: string });
      setError(data.error ?? `retry failed (${res.status})`);
    }
    await Promise.all([refreshDetail(selectedId), refreshJobs()]);
  }

  function saveToken() {
    setOperatorToken(tokenInput.trim());
    setError(null);
  }

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-8 px-4 py-10 sm:px-8">
      <header className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h1 className="text-3xl font-semibold tracking-tight">Closefold</h1>
          <span className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium uppercase tracking-wider text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
            The Taskmaster
          </span>
        </div>
        <p className="max-w-2xl text-sm leading-6 text-zinc-600 dark:text-zinc-400">
          Autonomous submission-evidence agent. It ingests live Devpost requirements,
          audits an authorized repository and Google Cloud deployment, proposes corrective
          actions behind a human approval gate, then independently verifies that real
          artifacts now exist.
        </p>
      </header>

      {error && (
        <div className={`flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-sm ${
          offline
            ? "border-zinc-300 bg-zinc-50 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
            : "border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
        }`}>
          <span>{offline ? `Connection issue — retrying automatically (${error})` : error}</span>
          {!offline && (
            <button onClick={() => setError(null)} className="text-xs underline opacity-70 hover:opacity-100">
              dismiss
            </button>
          )}
        </div>
      )}

      <NewJobForm onCreated={(id) => setSelectedId(id)} />

      <section className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div className="lg:w-80 lg:shrink-0">
          <JobList jobs={jobs} selectedId={selectedId} onSelect={setSelectedId} />
          <details className="mt-4">
            <summary className="cursor-pointer select-none text-[11px] uppercase tracking-wide text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
              Operator token
            </summary>
            <div className="mt-2 flex gap-1.5">
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="required for mutations in cloud"
                className="w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 font-mono text-[11px] outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
              />
              <button
                onClick={saveToken}
                className="shrink-0 rounded-md bg-zinc-800 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-zinc-600 dark:bg-zinc-200 dark:text-black"
              >
                Save
              </button>
            </div>
            <p className="mt-1 text-[10px] leading-4 text-zinc-400">
              Stored only in this browser (localStorage) and sent as x-operator-token.
            </p>
          </details>
        </div>
        <div className="min-w-0 flex-1">
          {detail ? (
            <JobDetail job={detail} events={events} receipts={receipts} onDecide={decide} onRetry={retry} />
          ) : (
            <div className="rounded-xl border border-dashed border-zinc-300 px-6 py-16 text-center text-sm text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
              Select or create a job to watch the pipeline run.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
