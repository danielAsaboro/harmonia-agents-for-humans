import type { ArchitectureNode } from "@/lib/architecture/schema";

export function getResponsiveMode(width: number): "tree" | "graph" { return width < 640 ? "tree" : "graph"; }

export function buildArchitectureDetail(node: ArchitectureNode) {
  const authorityNote = node.id === "agent-temi" ? "Temi makes an editorial-plan proposal with no external calendar authority; deterministic code owns validation, persistence, selection, scheduling, approval, and effects." : node.summary;
  return { ...node, model: node.model?.name, authorityNote, deepLink: `?node=${node.id}` };
}
