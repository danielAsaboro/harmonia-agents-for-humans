"use client";

import { useEffect, useMemo, useState } from "react";
import type { Receipt } from "@/lib/types";

const OUTCOMES = ["applied", "already_applied", "failed", "rejected"] as const;

export default function ReceiptsLedger() {
  const [receipts, setReceipts] = useState<Array<Receipt & { jobTitle?: string }> | null>(null);
  const [outcomeFilter, setOutcomeFilter] = useState<string>("");
  const [q, setQ] = useState("");

  useEffect(() => {
    const t = setTimeout(() => {
      fetch("/api/receipts", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
        .then((d) => setReceipts(d.receipts))
        .catch(() => setReceipts([]));
    }, 0);
    return () => clearTimeout(t);
  }, []);

  const rows = useMemo(() => {
    let out = receipts ?? [];
    if (outcomeFilter) out = out.filter((r) => r.outcome === outcomeFilter);
    if (q) {
      const n = q.toLowerCase();
      out = out.filter(
        (r) =>
          r.actionType.toLowerCase().includes(n) ||
          r.idempotencyKey.includes(n) ||
          (r.jobTitle ?? "").toLowerCase().includes(n),
      );
    }
    return out;
  }, [receipts, outcomeFilter, q]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setOutcomeFilter("")}
          className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
            !outcomeFilter ? "bg-zinc-900 text-white dark:bg-white dark:text-black" : "border border-zinc-300 text-zinc-500 dark:border-zinc-700"
          }`}
        >
          all outcomes
        </button>
        {OUTCOMES.map((o) => (
          <button
            key={o}
            onClick={() => setOutcomeFilter(outcomeFilter === o ? "" : o)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
              outcomeFilter === o
                ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                : "border border-zinc-300 text-zinc-500 hover:border-zinc-400 dark:border-zinc-700"
            }`}
          >
            {o.replace("_", " ")}
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search type, key, or job…"
          className="ml-auto w-56 rounded-full border border-zinc-300 bg-white px-4 py-1.5 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full min-w-[680px] text-left text-xs">
          <thead className="bg-zinc-50 uppercase tracking-wide text-[10px] text-zinc-400 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Outcome</th>
              <th className="px-3 py-2 font-medium">Job</th>
              <th className="px-3 py-2 font-medium">Idempotency key</th>
              <th className="px-3 py-2 font-medium">Artifact</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-3 py-2 text-zinc-500">
                  {new Date(r.performedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">{r.actionType}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    r.outcome === "applied" ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                    : r.outcome === "already_applied" ? "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-400"
                    : r.outcome === "rejected" ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
                    : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400"
                  }`}>
                    {r.outcome.replace("_", " ")}
                  </span>
                </td>
                <td className="max-w-[180px] truncate px-3 py-2" title={r.jobTitle}>{r.jobTitle ?? "—"}</td>
                <td className="px-3 py-2 font-mono text-[10px] text-zinc-400">{r.idempotencyKey.slice(0, 16)}…</td>
                <td className="max-w-[160px] truncate px-3 py-2">
                  {r.artifact?.url ? (
                    <a href={r.artifact.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 underline dark:text-blue-400">
                      {r.artifact.kind}
                    </a>
                  ) : (
                    <span className="text-zinc-400">—</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="px-3 py-8 text-center text-zinc-400">No receipts match.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
