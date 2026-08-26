import type { ActivityFiltersState } from "./AgentActivityView";

const agents = ["nimi_analyst", "ryan_strategist", "temi_editorial_planner", "noni_copywriter", "dara_editor", "maya_renderer", "nova_liaison"];
const input = "rounded-lg border border-zinc-300 bg-white px-2.5 py-2 text-xs outline-none dark:border-zinc-700 dark:bg-zinc-950";

export default function ActivityFilters({ filters, onChange }: { filters: ActivityFiltersState; onChange: (next: ActivityFiltersState) => void }) {
  const set = <K extends keyof ActivityFiltersState>(key: K, value: ActivityFiltersState[K]) => onChange({ ...filters, [key]: value });
  return <div className="grid gap-2 rounded-xl border border-zinc-200 p-3 sm:grid-cols-2 lg:grid-cols-4 dark:border-zinc-800">
    <input aria-label="Search activity" className={`${input} sm:col-span-2`} placeholder="Search safe IDs and labels" value={filters.q} onChange={(e) => set("q", e.target.value)} />
    <select aria-label="Agent" className={input} value={filters.agent} onChange={(e) => set("agent", e.target.value)}><option value="">All agents</option>{agents.map((v) => <option key={v}>{v}</option>)}</select>
    <input aria-label="Stage" className={input} placeholder="Stage" value={filters.stage} onChange={(e) => set("stage", e.target.value)} />
    <select aria-label="Outcome" className={input} value={filters.outcome} onChange={(e) => set("outcome", e.target.value)}><option value="">All outcomes</option><option>success</option><option>error</option></select>
    <select aria-label="Severity" className={input} value={filters.severity} onChange={(e) => set("severity", e.target.value)}><option value="">All severities</option>{["debug", "info", "warning", "error"].map((v) => <option key={v}>{v}</option>)}</select>
    <input aria-label="Model" className={input} placeholder="Model" value={filters.model} onChange={(e) => set("model", e.target.value)} />
    <input aria-label="Tool" className={input} placeholder="Tool" value={filters.tool} onChange={(e) => set("tool", e.target.value)} />
    <input aria-label="Job ID" className={input} placeholder="Job ID" value={filters.jobId} onChange={(e) => set("jobId", e.target.value)} />
    <input aria-label="Trace ID" className={input} placeholder="Trace ID" value={filters.traceId} onChange={(e) => set("traceId", e.target.value)} />
    <label className="text-[11px] text-zinc-500">Since<input type="datetime-local" className={`${input} mt-1 w-full`} value={filters.since} onChange={(e) => set("since", e.target.value)} /></label>
    <label className="text-[11px] text-zinc-500">Until<input type="datetime-local" className={`${input} mt-1 w-full`} value={filters.until} onChange={(e) => set("until", e.target.value)} /></label>
  </div>;
}
