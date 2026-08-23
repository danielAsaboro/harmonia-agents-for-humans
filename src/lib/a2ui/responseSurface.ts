import type { ChatResponse } from "@/app/api/chat/route";
import { HARMONIA_CATALOG_ID, parseCatalogComponent } from "./contracts";

export function buildResponseSurface(runId: string, response: ChatResponse): Record<string, unknown>[] {
  const children = ["message", "reasoning-summary"];
  const components: Record<string, unknown>[] = [
    { id: "root", component: "Column", children },
    { id: "message", component: "MessageContent", text: response.reply },
    {
      id: "reasoning-summary",
      component: "ReasoningSummary",
      summary: `Harmonia selected the ${response.intent} path from the operator request and validated the resulting application state.`,
    },
  ];

  if (response.job) {
    children.push("job-task");
    components.push({
      id: "job-task",
      component: "TaskView",
      title: response.job.title ?? `Job ${response.job.id}`,
      status: response.job.status === "failed" ? "failed" : response.job.stage === "complete" ? "complete" : "active",
      jobId: response.job.id,
      stage: response.job.stage,
    });
    const stages = ["ingest", "transcribe", "understand", "draft", "awaiting_approval", "publish", "verify", "learn", "complete"];
    const currentIndex = stages.indexOf(response.job.stage);
    children.push("job-plan");
    components.push({
      id: "job-plan",
      component: "PlanView",
      title: "Content workflow",
      steps: stages.map((stage, index) => ({
        id: stage,
        label: stage.replaceAll("_", " "),
        status: response.job?.status === "failed" && index === currentIndex
          ? "failed"
          : index < currentIndex || response.job?.stage === "complete"
            ? "complete"
            : index === currentIndex
              ? "active"
              : "pending",
      })),
    });
  }
  if (response.jobs?.length) {
    children.push("job-queue");
    components.push({
      id: "job-queue",
      component: "QueueView",
      title: "Recent jobs",
      items: response.jobs.map((job) => ({
        id: job.id,
        label: job.title ?? job.id,
        status: job.status === "failed" ? "failed" : job.stage === "complete" ? "complete" : "active",
        jobId: job.id,
      })),
    });
  }
  for (const draft of response.drafts ?? []) {
    const id = `draft-${draft.id}`;
    children.push(id);
    components.push({ id, component: "MessageContent", text: draft.text });
  }
  const responseJobId = response.jobId ?? response.job?.id;
  if (responseJobId) {
    for (const asset of response.assets ?? []) {
      const id = `asset-${asset.actionId}`;
      children.push(id);
      components.push({
        id,
        component: "AttachmentCard",
        attachmentId: asset.actionId,
        filename: asset.actionId,
        mime: asset.mime,
        sizeBytes: 0,
        state: "ready",
        previewUrl: `/api/jobs/${responseJobId}/assets/${asset.actionId}`,
      });
    }
    for (const action of response.pendingActions ?? []) {
      const id = `confirmation-${action.id}`;
      children.push(id);
      components.push({
        id,
        component: "Confirmation",
        jobId: responseJobId,
        actionId: action.id,
        title: action.title,
        description: `${action.type} · action ${action.id}`,
        risk: action.risk === "high" ? "high" : action.risk === "low" ? "low" : "material",
        state: "pending",
      });
    }
  }

  for (const component of components) {
    if (component.component !== "Column") parseCatalogComponent(component);
  }

  return [
    { version: "v0.9", createSurface: { surfaceId: `chat-${runId}`, catalogId: HARMONIA_CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId: `chat-${runId}`, components } },
  ];
}
