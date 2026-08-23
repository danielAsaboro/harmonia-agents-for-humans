import { parseHarmoniaA2uiOperation } from "@/components/a2ui/HarmoniaCatalog";
import { HARMONIA_CATALOG_ID } from "./contracts";

export type StudioA2uiRegion = "conversation" | "canvas" | "approval";

const REGION_BY_COMPONENT: Record<string, StudioA2uiRegion | "host"> = {
  MessageContent: "host",
  ReasoningSummary: "conversation",
  ActivityTrace: "conversation",
  ToolActivity: "conversation",
  AttachmentCard: "canvas",
  TaskView: "canvas",
  PlanView: "canvas",
  QueueView: "canvas",
  InlineCitation: "canvas",
  ContextUsage: "canvas",
  Confirmation: "approval",
};

type ComponentRecord = Record<string, unknown> & { id: string; component: string; children?: string[] };

export function countStudioComponents(operations: unknown[], componentName: string): number {
  let count = 0;
  for (const input of operations) {
    const operation = input as { updateComponents?: { components?: ComponentRecord[] } };
    count += (operation.updateComponents?.components ?? []).filter((component) => component.component === componentName).length;
  }
  return count;
}

function regionOperations(runId: string, region: StudioA2uiRegion, components: ComponentRecord[]): unknown[] {
  if (components.length === 0) return [];
  const surfaceId = `studio-${runId}-${region}`;
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: HARMONIA_CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components: [
      { id: "root", component: "Column", children: components.map((component) => component.id) },
      ...components,
    ] } },
  ];
}

export function partitionStudioOperations(runId: string, operations: unknown[]): Record<StudioA2uiRegion, unknown[]> {
  const allComponents = new Map<string, ComponentRecord>();
  let sawSurface = false;

  for (const input of operations) {
    const operation = parseHarmoniaA2uiOperation(input) as unknown as Record<string, unknown>;
    if ("createSurface" in operation) sawSurface = true;
    const update = operation.updateComponents as { components?: ComponentRecord[] } | undefined;
    for (const component of update?.components ?? []) {
      if (allComponents.has(component.id)) throw new Error(`duplicate A2UI component id: ${component.id}`);
      allComponents.set(component.id, component);
    }
  }

  if (operations.length > 0 && !sawSurface) throw new Error("A2UI region stream is missing createSurface");
  for (const component of allComponents.values()) {
    for (const child of component.children ?? []) {
      if (!allComponents.has(child)) throw new Error(`dangling child ${child} from ${component.id}`);
    }
  }

  const root = allComponents.get("root");
  if (allComponents.size > 0 && (!root || root.component !== "Column")) throw new Error("A2UI studio surface requires a Column root");
  const orderedIds = root?.children ?? [];
  const grouped: Record<StudioA2uiRegion, ComponentRecord[]> = { conversation: [], canvas: [], approval: [] };
  for (const id of orderedIds) {
    const component = allComponents.get(id);
    if (!component) throw new Error(`dangling child ${id} from root`);
    const region = REGION_BY_COMPONENT[component.component];
    if (!region) throw new Error(`A2UI component has no studio region: ${component.component}`);
    if (region !== "host") grouped[region].push(component);
  }

  return {
    conversation: regionOperations(runId, "conversation", grouped.conversation),
    canvas: regionOperations(runId, "canvas", grouped.canvas),
    approval: regionOperations(runId, "approval", grouped.approval),
  };
}
