"use client";

import { useState } from "react";
import MonitoringView from "@/components/MonitoringView";
import LogsView from "@/components/monitoring/LogsView";
import JobsTableView from "@/components/monitoring/JobsTableView";
import AssetsGallery from "@/components/monitoring/AssetsGallery";
import ReceiptsLedger from "@/components/monitoring/ReceiptsLedger";
import AgentActivityView from "@/components/monitoring/AgentActivityView";

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "agents", label: "Agents" },
  { key: "logs", label: "Logs" },
  { key: "jobs", label: "Jobs" },
  { key: "assets", label: "Assets" },
  { key: "receipts", label: "Receipts" },
] as const;

type Tab = (typeof TABS)[number]["key"];

export default function MonitoringPage() {
  const [tab, setTab] = useState<Tab>("overview");

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Monitoring</h1>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Pipeline health, agent handoffs, tool calls, jobs, generated assets, and the audit ledger.
          </p>
        </div>
        <nav className="flex gap-1 rounded-full border border-zinc-200 p-1 text-xs dark:border-zinc-800">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`rounded-full px-3 py-1.5 font-medium transition-colors ${
                tab === t.key
                  ? "bg-zinc-900 text-white dark:bg-white dark:text-black"
                  : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === "overview" && <MonitoringView />}
      {tab === "agents" && <AgentActivityView />}
      {tab === "logs" && <LogsView />}
      {tab === "jobs" && <JobsTableView />}
      {tab === "assets" && <AssetsGallery />}
      {tab === "receipts" && <ReceiptsLedger />}
    </div>
  );
}
