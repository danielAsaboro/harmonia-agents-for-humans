"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, MarkerType, MiniMap, ReactFlow, ReactFlowProvider, type Edge, type Node, type ReactFlowInstance } from "@xyflow/react";
import { useRouter, useSearchParams } from "next/navigation";
import { architectureDefinition } from "@/lib/architecture/data";
import { applyPreset, createDefaultExplorerState, parseExplorerQuery, serializeExplorerQuery, toggleGroup, type ExplorerState } from "@/lib/architecture/explorerState";
import { layoutArchitecture, type LayoutResult } from "@/lib/architecture/layout";
import { projectArchitecture } from "@/lib/architecture/project";
import { ArchitectureDetails } from "./ArchitectureDetails";
import { ArchitectureEdge, edgeAppearance } from "./ArchitectureEdge";
import { ArchitectureLegend } from "./ArchitectureLegend";
import { ArchitectureMobileTree } from "./ArchitectureMobileTree";
import { ArchitectureNode } from "./ArchitectureNode";
import { ArchitectureToolbar } from "./ArchitectureToolbar";

const nodeTypes = { architecture: ArchitectureNode }; const edgeTypes = { architecture: ArchitectureEdge };

function ExplorerInner() {
  const router = useRouter(); const searchParams = useSearchParams();
  const [state, setState] = useState<ExplorerState>(() => typeof window === "undefined" ? createDefaultExplorerState(architectureDefinition) : parseExplorerQuery(new URLSearchParams(window.location.search), architectureDefinition));
  const projection = useMemo(() => projectArchitecture(architectureDefinition, state), [state]);
  const [layout, setLayout] = useState<LayoutResult>({ nodes: [], edges: [], width: 0, height: 0 }); const [layingOut, setLayingOut] = useState(true);
  const instance = useRef<ReactFlowInstance | null>(null); const shouldFit = useRef(true);
  const update = useCallback((next: ExplorerState) => { setState(next); router.replace(`?${serializeExplorerQuery(next)}`, { scroll: false }); }, [router]);
  useEffect(() => { const restored = parseExplorerQuery(new URLSearchParams(searchParams.toString()), architectureDefinition); setState(restored); }, [searchParams]);
  useEffect(() => { let active = true; setLayingOut(true); layoutArchitecture(projection, "desktop").then((result) => { if (!active) return; setLayout(result); setLayingOut(false); if (shouldFit.current) requestAnimationFrame(() => instance.current?.fitView({ padding: 0.16, duration: 500 })); shouldFit.current = false; }); return () => { active = false; }; }, [projection]);
  const selected = architectureDefinition.nodes.find((node) => node.id === state.selectedNodeId);
  const select = (id?: string) => update({ ...state, selectedNodeId: id });
  const preset = (id: string) => { shouldFit.current = true; update(applyPreset(state, id, architectureDefinition)); };
  const expandAll = () => update({ ...state, expanded: architectureDefinition.nodes.filter((node) => node.kind === "group").map((node) => node.id) });
  return <div className="architecture-shell">
    <ArchitectureToolbar definition={architectureDefinition} state={state} onChange={update} onPreset={preset} onExpandAll={expandAll} onCollapseAll={() => update({ ...state, expanded: [] })} onFit={() => instance.current?.fitView({ padding: 0.16, duration: 400 })} />
    <div className="arch-live" aria-live="polite">{projection.nodes.length} components visible{layingOut ? " · updating layout" : ""}</div>
    <main className="arch-stage">
      <div className="arch-graph"><ReactFlow<Node, Edge> nodes={layout.nodes} edges={layout.edges.map((edge) => { const kind = (edge.data?.kind ?? "workflow") as keyof typeof edgeAppearance; return { ...edge, markerEnd: { type: MarkerType.ArrowClosed, color: edgeAppearance[kind].color } }; })} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={(flow) => { instance.current = flow; }} onNodeClick={(_, graphNode) => select(graphNode.id)} nodesDraggable={false} fitView minZoom={0.15} maxZoom={1.8}><Background color="#1c3650" gap={24} size={1} /><Controls showInteractive={false} /><MiniMap pannable zoomable nodeColor="#7357b8" maskColor="rgba(2,8,18,.72)" /></ReactFlow>{layingOut ? <div className="arch-layout-state">Recalculating architecture…</div> : null}</div>
      <ArchitectureMobileTree definition={architectureDefinition} visibleNodes={projection.nodes} expanded={state.expanded} onToggle={(id) => update(toggleGroup(state, id))} onSelect={select} />
      <ArchitectureLegend />
      <ArchitectureDetails node={selected} definition={architectureDefinition} onClose={() => select(undefined)} />
    </main>
  </div>;
}

export function ArchitectureExplorer() { return <ReactFlowProvider><ExplorerInner /></ReactFlowProvider>; }
