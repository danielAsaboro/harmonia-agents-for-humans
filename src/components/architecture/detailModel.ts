import type { ArchitectureDefinition, ArchitectureNode } from "@/lib/architecture/schema";

export function getResponsiveMode(width: number): "tree" | "graph" { return width < 640 ? "tree" : "graph"; }

export function buildArchitectureDetail(node: ArchitectureNode, _definition: ArchitectureDefinition) {
  const authorityNote = node.id === "agent-temi" ? "Temi proposes actions but does not execute them." : node.summary;
  return { ...node, model: node.model?.name, authorityNote, deepLink: `?node=${node.id}` };
}
