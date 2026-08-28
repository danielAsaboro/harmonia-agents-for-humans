"use client";

import { useCallback, useEffect, useState } from "react";
import type { AgentActivity } from "@/lib/contracts";
import type { DurableRuntimeSnapshot } from "@/lib/observability/schema";
import { Button } from "@/components/dashboard/Button";
import { Select, TextInput } from "@/components/dashboard/Controls";
import { StatusBadge } from "@/components/dashboard/StatusBadge";
import { Surface } from "@/components/dashboard/Surface";
import { EmptyState, ErrorState, LoadingState } from "@/components/dashboard/SystemState";

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
const STATUS_TONE = { succeeded: "success", retrying: "warning", failed: "danger" } as const;

export default function WorkflowActivityView() {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [error, setError] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<ActivityEvent | null>(null);
  const [runtime, setRuntime] = useState<DurableRuntimeSnapshot | null>(null);
  const [resolution, setResolution] = useState({ reason: "", artifactId: "", digest: "" });
  const [resolutionStatus, setResolutionStatus] = useState("");

  const load = useCallback(async () => {
    const params = new URLSearchParams({ limit: "200" });
    if (role) params.set("role", role);
    if (status) params.set("status", status);
    try {
      const response = await fetch(`/api/events?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("activity request failed");
      const body = await response.json();
      setEvents((body.events as ActivityEvent[]).filter((event) => event.activity));
      setRuntime(body.runtime as DurableRuntimeSnapshot);
      setError("");
    } catch {
      setError("Agent activity could not be loaded. Retry when the service is available.");
      setEvents([]);
    }
  }, [role, status]);

  const resolveEffect = async (
    effect: DurableRuntimeSnapshot["unknownEffects"][number],
    choice: "confirm_applied" | "confirm_not_applied" | "compensate" | "cancel",
  ) => {
    setResolutionStatus("Submitting resolution…");
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(effect.jobId)}/operations/${encodeURIComponent(effect.operationId)}/resolve`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          choice, reason: resolution.reason, expectedEpoch: effect.epoch,
          evidence: [{ artifactId: resolution.artifactId, digest: resolution.digest }],
        }),
      });
      if (!response.ok) throw new Error("resolution rejected");
      setResolutionStatus("Resolution recorded.");
      await load();
    } catch {
      setResolutionStatus("Resolution could not be recorded. Check the epoch and audit evidence.");
    }
  };
  const resolutionReady = resolution.reason.trim().length >= 10
    && /^[0-9a-f-]{36}$/i.test(resolution.artifactId)
    && /^[a-f0-9]{64}$/.test(resolution.digest);

  useEffect(() => {
    // Fetching is the external synchronization performed by this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" aria-label="Agent activity">
      <div className="space-y-3">
        {runtime && <Surface className="space-y-3 p-4" aria-label="Durable runtime health">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            <RuntimeMetric label="Stale leases" value={String(runtime.staleLeases.operations + runtime.staleLeases.inbox + runtime.staleLeases.outbox)} />
            <RuntimeMetric label="Unknown effects" value={String(runtime.unknownEffects.length)} />
            <RuntimeMetric label="Inbox lag" value={`${runtime.inboxLagSeconds}s`} />
            <RuntimeMetric label="Outbox lag" value={`${runtime.outboxLagSeconds}s`} />
            <RuntimeMetric label="Projection compiler" value={runtime.projection.compilerVersion ?? "none"} />
            <RuntimeMetric label="Artifact integrity" value={`${runtime.artifacts.ready} ready · ${runtime.artifacts.failed} failed · ${runtime.artifacts.writing} writing`} />
            <RuntimeMetric label="Recovery work" value={`${runtime.recovery.pending} pending`} />
            <RuntimeMetric label="Observed effects" value={String(runtime.observedEffects)} />
          </div>
          {runtime.unknownEffects.length > 0 && <div className="space-y-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <h2 className="text-sm font-semibold">Resolve unknown effects</h2>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="text-xs text-zinc-500">Reason<TextInput aria-label="Resolution reason" value={resolution.reason} onChange={(event) => setResolution((current) => ({ ...current, reason: event.target.value }))} /></label>
              <label className="text-xs text-zinc-500">Evidence artifact ID<TextInput aria-label="Evidence artifact ID" value={resolution.artifactId} onChange={(event) => setResolution((current) => ({ ...current, artifactId: event.target.value }))} /></label>
              <label className="text-xs text-zinc-500">Evidence digest<TextInput aria-label="Evidence digest" value={resolution.digest} onChange={(event) => setResolution((current) => ({ ...current, digest: event.target.value }))} /></label>
            </div>
            {runtime.unknownEffects.map((effect) => <article key={effect.operationId} className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs dark:border-amber-900 dark:bg-amber-950/30">
              <p className="font-semibold">{effect.commandId}</p>
              <p className="mt-1 break-all font-mono text-[10px] text-zinc-500">{effect.operationId}@{effect.epoch}</p>
              <p className="mt-1 text-zinc-600 dark:text-zinc-300">{effect.reason}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {([
                  ["confirm_applied", "Confirm applied"], ["confirm_not_applied", "Confirm not applied"],
                  ["compensate", "Compensate"], ["cancel", "Cancel"],
                ] as const).map(([choice, label]) => <Button key={choice} disabled={!resolutionReady} onClick={() => void resolveEffect(effect, choice)}>{label}</Button>)}
              </div>
            </article>)}
            {resolutionStatus && <p role="status" className="text-xs text-zinc-500">{resolutionStatus}</p>}
          </div>}
        </Surface>}
        <div className="flex flex-wrap gap-2">
          <Select aria-label="Filter by agent" value={role} onChange={(event) => setRole(event.target.value)}>
            <option value="">all agents</option>
            {ROLES.map((item) => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}
          </Select>
          <Select aria-label="Filter by status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">all states</option><option value="succeeded">succeeded</option><option value="retrying">retrying</option><option value="failed">failed</option>
          </Select>
          <Button onClick={() => void load()}>Refresh</Button>
        </div>
        {error ? <ErrorState title="Agent activity could not be loaded" message={error} action={<Button onClick={() => void load()}>Retry</Button>} /> : events === null ? (
          <LoadingState title="Loading agent activity" />
        ) : events.length === 0 ? (
          <EmptyState title="No structured agent activity matches these filters." />
        ) : (
          <ol className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 dark:divide-zinc-900 dark:border-zinc-800">
            {events.map((event) => {
              const item = event.activity!;
              return <li key={event.id}><button onClick={() => setSelected(event)} className="grid w-full gap-2 p-3 text-left hover:bg-zinc-50 dark:hover:bg-zinc-900 sm:grid-cols-[8rem_1fr_auto]">
                <span className="font-mono text-[10px] text-zinc-400">{event.at ? new Date(event.at).toLocaleString() : "pending"}</span>
                <span><span className="block text-xs font-semibold">{item.kind === "handoff" ? `${item.fromRole} → ${item.toRole}` : `${item.role} · ${item.toolName ?? item.kind}`}</span><span className="mt-1 block text-xs text-zinc-500">{item.publicMessage}</span></span>
                <StatusBadge tone={STATUS_TONE[item.status]}>{item.status}</StatusBadge>
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

function RuntimeMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg bg-zinc-50 p-2 dark:bg-zinc-900"><p className="text-[10px] uppercase tracking-wide text-zinc-400">{label}</p><p className="mt-1 truncate text-xs font-semibold" title={value}>{value}</p></div>;
}
