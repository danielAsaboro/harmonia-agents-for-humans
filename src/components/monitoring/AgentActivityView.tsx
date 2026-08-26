"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentActivity } from "@/lib/contracts";

interface ActivityEvent {
  id: string;
  jobId: string;
  at: string | null;
  stage: string;
  operationId: string;
  traceId: string;
  activity?: AgentActivity;
}

const ROLES = ["nimi_analyst", "ryan_strategist", "temi_editorial_planner", "noni_copywriter", "dara_editor", "maya_trend_researcher", "nova_liaison"];
const STATUS_STYLE = {
  succeeded: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  retrying: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
};

export default function AgentActivityView() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<ActivityEvent | null>(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (role) params.set("role", role);
    if (status) params.set("status", status);
    try {
      const response = await fetch(`/api/events?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("activity request failed");
      const body = await response.json();
      setEvents((body.events as ActivityEvent[]).filter((event) => event.activity));
      setError("");
    } catch {
      setError("Agent activity could not be loaded. Retry when the service is available.");
      setEvents([]);
    }
  }, [role, status]);

  useEffect(() => {
    // Fetching is the external synchronization performed by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" aria-label="Agent activity">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <select aria-label="Filter by agent" value={role} onChange={(event) => setRole(event.target.value)} className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950">
            <option value="">all agents</option>
            {ROLES.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
          </select>
          <select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)} className="rounded-full border border-zinc-300 bg-white px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-950">
            <option value="">all states</option><option value="succeeded">succeeded</option><option value="retrying">retrying</option><option value="failed">failed</option>
          </select>
          <button onClick={() => void load()} className="rounded-full border border-zinc-300 px-3 py-1.5 text-xs dark:border-zinc-700">Refresh</button>
        </div>
        {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950">{error}</p> : events === null ? (
          <p className="rounded-xl border border-zinc-200 p-6 text-center text-sm text-zinc-400 dark:border-zinc-800">Loading agent activity…</p>
        ) : events.length === 0 ? (
          <p className="rounded-xl border border-zinc-200 p-6 text-center text-sm text-zinc-400 dark:border-zinc-800">No structured agent activity matches these filters.</p>
        ) : (
          <ol className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
            {events.map((event) => {
              const item = event.activity!;
              return <li key={event.id}><button onClick={() => setSelected(event)} className="grid w-full gap-2 p-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900 sm:grid-cols-[8rem_1fr_auto]">
                <span className="font-mono text-[10px] text-zinc-400">{event.at ? new Date(event.at).toLocaleString() : "pending"}</span>
                <span><span className="block text-xs font-semibold">{item.kind === "handoff" ? `${item.fromRole} → ${item.toRole}` : `${item.role} · ${item.toolName ?? item.kind}`}</span><span className="mt-1 block text-xs text-zinc-500">{item.publicMessage}</span></span>
                <span className={`h-fit rounded-full px-2 py-1 text-[10px] font-semibold uppercase ${STATUS_STYLE[item.status]}`}>{item.status}</span>
              </button></li>;
            })}
          </ol>
        )}
      </div>
      <aside className="h-fit rounded-xl border border-zinc-200 p-4 text-xs dark:border-zinc-800">
        <h2 className="font-semibold">Activity details</h2>
        {!selected?.activity ? <p className="mt-3 text-zinc-400">Select an event to inspect its safe structured metadata.</p> : (
          <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-x-2 gap-y-2 break-all">
            <dt className="text-zinc-400">Role</dt><dd>{selected.activity.role}</dd>
            <dt className="text-zinc-400">Kind</dt><dd>{selected.activity.kind}</dd>
            <dt className="text-zinc-400">Code</dt><dd>{selected.activity.code ?? "—"}</dd>
            <dt className="text-zinc-400">Category</dt><dd>{selected.activity.category ?? "—"}</dd>
            <dt className="text-zinc-400">Path</dt><dd>{selected.activity.path ?? "—"}</dd>
            <dt className="text-zinc-400">Attempt</dt><dd>{selected.activity.attempt === undefined ? "—" : `${selected.activity.attempt}/${selected.activity.maxAttempts ?? "—"}`}</dd>
            <dt className="text-zinc-400">Operation</dt><dd className="font-mono">{selected.operationId}</dd>
            <dt className="text-zinc-400">Trace</dt><dd className="font-mono">{selected.traceId}</dd>
          </dl>
        )}
      </aside>
    </section>
  );
}
