/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- A2UI's v0.9 generic binder types currently exhaust TypeScript's
// heap when expanded across a custom catalog. Runtime Zod schemas remain strict.
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod/v3";
import {
  A2uiMessageSchema,
  Catalog,
  type ComponentApi,
  MessageProcessor,
  type A2uiClientAction,
  type SurfaceModel,
} from "@a2ui/web_core/v0_9";
import {
  A2uiSurface,
  basicCatalog,
  createComponentImplementation,
  type ReactComponentImplementation,
} from "@a2ui/react/v0_9";
import { HARMONIA_CATALOG_ID } from "@/lib/a2ui/contracts";
import {
  ActivityTrace,
  AttachmentCard,
  ConfirmationCard,
  ContextUsage,
  InlineCitation,
  MessageContent,
  PlanView,
  QueueView,
  ReasoningSummary,
  TaskView,
  ToolActivity,
  type ActivityStep,
  type AttachmentView,
  type ElementStatus,
} from "./HarmoniaElements";

const status = z.enum(["pending", "active", "complete", "failed"]);
const step = z.object({ id: z.string(), label: z.string(), description: z.string().optional(), status });

const ActivityTraceApi: ComponentApi = { name: "ActivityTrace", schema: z.object({ title: z.string(), steps: z.array(step) }) };
const ReasoningSummaryApi: ComponentApi = { name: "ReasoningSummary", schema: z.object({ summary: z.string() }) };
const AttachmentCardApi: ComponentApi = { name: "AttachmentCard", schema: z.object({ attachmentId: z.string().min(1), filename: z.string(), mime: z.string(), sizeBytes: z.number(), state: z.enum(["uploading", "ready", "failed"]), previewUrl: z.string().refine((value) => value.startsWith("/api/chat/attachments/") || /^\/api\/jobs\/[^/]+\/assets\/[^/]+$/.test(value)).optional() }) };
const InlineCitationApi: ComponentApi = { name: "InlineCitation", schema: z.object({ title: z.string(), url: z.string().url().refine((value) => ["http:", "https:"].includes(new URL(value).protocol)), sourceId: z.string().optional(), excerpt: z.string().optional() }) };
const PlanViewApi: ComponentApi = { name: "PlanView", schema: z.object({ title: z.string(), steps: z.array(step) }) };
const QueueViewApi: ComponentApi = { name: "QueueView", schema: z.object({ title: z.string(), items: z.array(step.extend({ jobId: z.string().optional() })) }) };
const ToolActivityApi: ComponentApi = { name: "ToolActivity", schema: z.object({ name: z.string(), status, inputSummary: z.string().optional(), outputSummary: z.string().optional(), durationMs: z.number().optional(), traceId: z.string().optional() }) };
const TaskViewApi: ComponentApi = { name: "TaskView", schema: z.object({ title: z.string(), owner: z.string().optional(), status, jobId: z.string().optional(), stage: z.string().optional() }) };
const ContextUsageApi: ComponentApi = { name: "ContextUsage", schema: z.object({ model: z.string(), inputTokens: z.number(), outputTokens: z.number(), contextLimit: z.number().optional(), cachedTokens: z.number().optional(), estimatedCostUsd: z.number().optional() }) };
const MessageContentApi: ComponentApi = { name: "MessageContent", schema: z.object({ text: z.string() }) };
const ConfirmationApi: ComponentApi = { name: "Confirmation", schema: z.object({ operationId: z.string().min(1).optional(), jobId: z.string().min(1).optional(), actionId: z.string().min(1).optional(), title: z.string(), description: z.string().optional(), risk: z.enum(["low", "material", "high"]), state: z.enum(["pending", "approved", "rejected", "expired"]) }).refine((value) => Boolean(value.operationId) !== Boolean(value.jobId && value.actionId)) };

const customImplementations: ReactComponentImplementation[] = [
  createComponentImplementation(ActivityTraceApi, ({ props }) => <ActivityTrace title={props.title} steps={props.steps as ActivityStep[]} />),
  createComponentImplementation(ReasoningSummaryApi, ({ props }) => <ReasoningSummary summary={props.summary} />),
  createComponentImplementation(AttachmentCardApi, ({ props }) => <AttachmentCard attachment={props as AttachmentView} />),
  createComponentImplementation(InlineCitationApi, ({ props }) => <InlineCitation {...props} />),
  createComponentImplementation(PlanViewApi, ({ props }) => <PlanView title={props.title} steps={props.steps as ActivityStep[]} />),
  createComponentImplementation(QueueViewApi, ({ props }) => <QueueView title={props.title} items={props.items as Array<ActivityStep & { jobId?: string }>} />),
  createComponentImplementation(ToolActivityApi, ({ props }) => <ToolActivity {...props} status={props.status as ElementStatus} />),
  createComponentImplementation(TaskViewApi, ({ props }) => <TaskView {...props} status={props.status as ElementStatus} />),
  createComponentImplementation(ContextUsageApi, ({ props }) => <ContextUsage {...props} />),
  createComponentImplementation(MessageContentApi, ({ props }) => <MessageContent text={props.text} />),
  createComponentImplementation(ConfirmationApi, ({ props, context }) => (
    <ConfirmationCard
      {...props}
      onDecision={(decision) => void context.surface.dispatchAction(props.jobId && props.actionId ? {
        name: "decide_job_action",
        context: { jobId: props.jobId, actionId: props.actionId, decision },
      } : {
        name: "decide_operation",
        context: { operationId: props.operationId, decision },
      }, context.component.id)}
    />
  )),
];

export const harmoniaCatalog = new Catalog<ReactComponentImplementation>(
  HARMONIA_CATALOG_ID,
  [...basicCatalog.components.values(), ...customImplementations],
  [...basicCatalog.functions.values()],
);

export function parseHarmoniaA2uiOperation(operation: unknown) {
  const parsed = A2uiMessageSchema.parse(operation);
  if ("updateComponents" in parsed) {
    for (const component of parsed.updateComponents.components) {
      const implementation = harmoniaCatalog.components.get(component.component);
      if (!implementation) throw new Error(`A2UI component is not registered: ${component.component}`);
      const properties = { ...component };
      delete properties.id;
      delete properties.component;
      implementation.schema.parse(properties);
    }
  }
  return parsed;
}

export function HarmoniaA2uiHost({ operations, onAction, onProtocolError, className }: { operations: unknown[]; onAction?: (action: A2uiClientAction) => void | Promise<void>; onProtocolError?: (error: Error) => void; className?: string }) {
  const processor = useMemo(() => new MessageProcessor<ReactComponentImplementation>(
    [harmoniaCatalog],
    (action) => onAction?.(action),
  ), [onAction]);
  const processed = useRef(0);
  const [surfaces, setSurfaces] = useState<Array<SurfaceModel<ReactComponentImplementation>>>([]);
  const [protocolError, setProtocolError] = useState<string | null>(null);

  useEffect(() => {
    processed.current = 0;
    const sync = () => setSurfaces(Array.from(processor.model.surfacesMap.values()));
    const created = processor.onSurfaceCreated(sync);
    const deleted = processor.onSurfaceDeleted(sync);
    sync();
    return () => { created.unsubscribe(); deleted.unsubscribe(); processor.model.dispose(); };
  }, [processor]);

  useEffect(() => {
    try {
      if (operations.length < processed.current) processed.current = 0;
      const next = operations.slice(processed.current).map(parseHarmoniaA2uiOperation);
      if (next.length) processor.processMessages(next);
      processed.current = operations.length;
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      // The error is emitted by the external A2UI processor synchronized in
      // this effect; surfacing it is the fail-closed UI state.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProtocolError(failure.message);
      onProtocolError?.(failure);
    }
  }, [onProtocolError, operations, processor]);

  return <div className={className ?? "flex flex-col gap-2"}>{protocolError && <p className="rounded-xl border border-red-300 bg-red-50 p-3 text-xs text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">A2UI protocol error: {protocolError}</p>}{surfaces.map((surface) => <A2uiSurface key={surface.id} surface={surface} />)}</div>;
}
