import type { ChatRunState } from "@/lib/a2ui/chatReducer";
import { ActivityTrace, ToolActivity } from "@/components/a2ui/HarmoniaElements";
import { HarmoniaA2uiHost } from "@/components/a2ui/HarmoniaCatalog";
import { partitionStudioOperations } from "@/lib/a2ui/studioRegions";
import { StudioFailure } from "./StudioStates";

export function AgentRunSummary({ run }: { run: ChatRunState }) {
  const label = run.status === "running" ? "Harmonia is working" : run.status === "failed" ? "Agent run failed" : "Agent run complete";
  const totalDuration = run.tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  let conversationOperations: unknown[] = [];
  let protocolError: string | null = null;
  try {
    conversationOperations = run.operations.length ? partitionStudioOperations(run.runId, run.operations).conversation : [];
  } catch (error) {
    protocolError = error instanceof Error ? error.message : String(error);
  }
  return (
    <details open={run.status !== "complete"} className="group border-l-2 border-[#3157ff] bg-[#3157ff]/[0.045] px-3 py-2">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[11px] font-black uppercase tracking-[0.14em] text-[#2340b8]">
        <span className={`h-2 w-2 rounded-full ${run.status === "running" ? "animate-pulse bg-[#ff5c35]" : run.status === "failed" ? "bg-red-600" : "bg-[#3157ff]"}`} />
        {label}
        {totalDuration > 0 ? <span className="ml-auto font-mono font-medium tracking-normal text-black/40">{(totalDuration / 1000).toFixed(1)}s</span> : null}
      </summary>
      <div className="mt-3 space-y-2">
        {run.activities.length > 0 ? <ActivityTrace title="Activity summary" steps={run.activities} /> : null}
        {run.tools.map((tool, index) => <ToolActivity key={`${tool.traceId ?? tool.name}-${index}`} {...tool} />)}
        {conversationOperations.length ? <HarmoniaA2uiHost operations={conversationOperations} /> : null}
        {protocolError ? <StudioFailure message={`A2UI protocol error: ${protocolError}`} permanent /> : null}
        {run.error ? <StudioFailure message={run.error} permanent={run.permanent} /> : null}
      </div>
    </details>
  );
}
