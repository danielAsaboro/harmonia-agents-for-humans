"use client";

import AskAiButton from "@/components/AskAiButton";

import { useCallback, useEffect, useState } from "react";

interface Proposal {
  id: string;
  source: "trend_scan" | "engagement_watch" | "calendar_gap" | "recycle";
  topic: string;
  angle: string;
  reason: string;
  sources: string[];
  suggestedPost: string;
  status: "proposed" | "approved" | "rejected";
  jobId?: string;
  createdAt: string;
}

const SOURCE_LABEL: Record<Proposal["source"], string> = {
  trend_scan: "Trend scan",
  engagement_watch: "Engagement watch",
  calendar_gap: "Calendar gap",
  recycle: "Recycle winner",
};

const STATUS_STYLE: Record<Proposal["status"], string> = {
  proposed: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  rejected: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
};

export default function ProposalsView() {
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/proposals", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("failed to load"))))
      .then((d) => setProposals(d.proposals ?? []))
      .catch((e) => setError(e.message));
  }, []);

  useEffect(load, [load]);

  async function decide(id: string, decision: "approved" | "rejected") {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/proposals/decide", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.NEXT_PUBLIC_OPERATOR_TOKEN
            ? { "x-operator-token": process.env.NEXT_PUBLIC_OPERATOR_TOKEN }
            : {}),
        },
        body: JSON.stringify({ id, decision }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error ?? `decision failed (${res.status})`);
      }
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  if (error) {
    return <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p>;
  }
  if (!proposals) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading proposals…</p>;
  }
  if (proposals.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No proposals yet. The proactive agent scans trends and your engagement on a schedule and will drop ideas here for approval.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {proposals.map((p) => (
        <article
          key={p.id}
          className="flex flex-col gap-2 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[11px] font-medium text-violet-800 dark:bg-violet-900/40 dark:text-violet-200">
              {SOURCE_LABEL[p.source]}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[p.status]}`}>
              {p.status}
            </span>
            <AskAiButton kind="proposal" id={p.id} label={p.topic.slice(0, 60)} />
            <time className="ml-auto text-[11px] text-zinc-400">
              {new Date(p.createdAt).toLocaleString()}
            </time>
          </div>
          <h3 className="text-sm font-semibold leading-snug">{p.topic}</h3>
          {p.angle && <p className="text-sm text-zinc-700 dark:text-zinc-300">{p.angle}</p>}
          {p.reason && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              <span className="font-medium">Why now:</span> {p.reason}
            </p>
          )}
          {p.suggestedPost && (
            <blockquote className="rounded-lg border-l-2 border-violet-400 bg-zinc-50 px-3 py-2 text-xs italic text-zinc-600 dark:bg-zinc-800/60 dark:text-zinc-300">
              {p.suggestedPost}
            </blockquote>
          )}
          {p.sources.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {p.sources.map((u) => (
                <a
                  key={u}
                  href={u}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="max-w-xs truncate text-xs text-blue-600 underline underline-offset-2 dark:text-blue-400"
                >
                  {u.replace(/^https?:\/\//, "")}
                </a>
              ))}
            </div>
          )}
          {p.status === "proposed" ? (
            <div className="mt-1 flex gap-2">
              <button
                onClick={() => decide(p.id, "approved")}
                disabled={busy === p.id}
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-300"
              >
                {busy === p.id ? "Starting…" : "Approve & create job"}
              </button>
              <button
                onClick={() => decide(p.id, "rejected")}
                disabled={busy === p.id}
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 transition hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Dismiss
              </button>
            </div>
          ) : (
            p.jobId && (
              <a href={`/dashboard/monitoring`} className="text-xs text-blue-600 underline underline-offset-2 dark:text-blue-400">
                Job {p.jobId.slice(0, 8)}…
              </a>
            )
          )}
        </article>
      ))}
    </div>
  );
}
