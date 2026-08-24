"use client";

import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from "@xyflow/react";
import type { ArchitectureEdgeKindSchema } from "@/lib/architecture/schema";
import type { z } from "zod";

type EdgeKind = z.infer<typeof ArchitectureEdgeKindSchema>;
export const edgeAppearance: Record<EdgeKind, { label: string; color: string; dash?: string; marker: string }> = {
  workflow: { label: "Durable transition", color: "#38d8ff", marker: "arrow" },
  delegation: { label: "Agent delegation", color: "#a78bfa", marker: "branch" },
  approval: { label: "Human approval", color: "#fbbf24", marker: "gate" },
  effect: { label: "External side effect", color: "#4ade80", marker: "effect" },
  verification: { label: "Independent verification", color: "#86efac", dash: "10 5", marker: "read-back" },
  retrieval: { label: "Read-only retrieval", color: "#94a3b8", dash: "8 7", marker: "read" },
  memory: { label: "Memory retrieval", color: "#c4b5fd", dash: "3 5", marker: "database" },
  telemetry: { label: "Telemetry propagation", color: "#22d3ee", dash: "2 6", marker: "trace" },
  blocked: { label: "Blocked or uncertain", color: "#fb7185", dash: "7 5", marker: "stop" },
};

export function ArchitectureEdge(props: EdgeProps) {
  const kind = (props.data?.kind ?? "workflow") as EdgeKind; const appearance = edgeAppearance[kind];
  const [path, labelX, labelY] = getSmoothStepPath(props);
  return <>
    <BaseEdge path={path} markerEnd={props.markerEnd} style={{ stroke: appearance.color, strokeWidth: 2, strokeDasharray: appearance.dash }} />
    <EdgeLabelRenderer><span className="arch-edge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}>{appearance.marker} · {appearance.label}</span></EdgeLabelRenderer>
  </>;
}
