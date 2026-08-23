const CATALOG_ID = "https://harmonia.app/a2ui/catalogs/chat/v1";

/**
 * Deterministic local fixture for exercising the same A2UI event protocol as
 * live chat. It never represents a provider invocation or simulated success.
 */
export function buildDemoChatRunEvents(input) {
  const surfaceId = `chat-${input.runId}`;
  const reply = "The source has been analyzed and the multimodal content package is ready for operator review.";
  const children = [
    "message", "reasoning", "activity", "plan", "task", "queue", "tool",
    "source-citation", "context", "image", "clip", "reel", "confirmation",
  ];
  const components = [
    { id: "root", component: "Column", children },
    { id: "message", component: "MessageContent", text: reply },
    {
      id: "reasoning",
      component: "ReasoningSummary",
      summary: "Safe summary: the analyst linked two transcript-backed moments to one X draft, then deterministic stage logic prepared the image, clip, and reel previews. Internal chain-of-thought is not exposed.",
    },
    {
      id: "activity",
      component: "ActivityTrace",
      title: "Agent activity",
      steps: [
        { id: "coordinator", label: "Coordinator routed video understanding", description: "Selected the analyst path from the source-bearing request.", status: "complete" },
        { id: "analyst", label: "Analyst grounded moments in transcript evidence", description: "Preserved source segment and timestamp references.", status: "complete" },
        { id: "draft-workflow", label: "Copywriter → critic → planner", description: "Reviewed the X draft once before proposing an approval-gated action.", status: "complete" },
      ],
    },
    {
      id: "plan",
      component: "PlanView",
      title: "Content workflow",
      steps: [
        { id: "ingest", label: "Ingest source", status: "complete" },
        { id: "understand", label: "Understand video", status: "complete" },
        { id: "draft", label: "Draft and review", status: "complete" },
        { id: "approval", label: "Operator approval", status: "active" },
        { id: "publish", label: "Publish and verify", status: "pending" },
      ],
    },
    { id: "task", component: "TaskView", title: "Prepare multimodal launch package", owner: "harmonia_coordinator", status: "complete", jobId: input.jobId, stage: "complete" },
    {
      id: "queue",
      component: "QueueView",
      title: "Execution queue",
      items: [
        { id: "source-ready", label: "Source evidence indexed", status: "complete", jobId: input.jobId },
        { id: "approval-wait", label: "Launch post awaits operator decision", status: "active", jobId: input.confirmationJobId },
        { id: "verification-wait", label: "Independent verification waits for publishing", status: "pending", jobId: input.confirmationJobId },
      ],
    },
    {
      id: "tool",
      component: "ToolActivity",
      name: "video_understanding",
      status: "complete",
      inputSummary: "4 transcript segments and 2 timestamped moments",
      outputSummary: "2 grounded moments, 2 angles, and 1 reviewed X draft",
      durationMs: 842,
      traceId: "demo-local-trace",
    },
    {
      id: "source-citation",
      component: "InlineCitation",
      title: "Source video",
      url: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
      sourceId: "source-video",
      excerpt: "Demo source associated with the timestamped transcript and moments.",
    },
    {
      id: "context",
      component: "ContextUsage",
      model: "Local demo fixture — no model invocation",
      inputTokens: 0,
      outputTokens: 0,
      contextLimit: 1,
      cachedTokens: 0,
      estimatedCostUsd: 0,
    },
    { id: "image", component: "AttachmentCard", attachmentId: "act-img-demo01", filename: "onboarding-angle.png", mime: "image/png", sizeBytes: input.imageSizeBytes, state: "ready", previewUrl: `/api/jobs/${input.jobId}/assets/act-img-demo01` },
    { id: "clip", component: "AttachmentCard", attachmentId: "act-clip-demo1", filename: "nine-days-to-forty-hours.mp4", mime: "video/mp4", sizeBytes: input.clipSizeBytes, state: "ready", previewUrl: `/api/jobs/${input.jobId}/assets/act-clip-demo1` },
    { id: "reel", component: "AttachmentCard", attachmentId: "act-reel-top2", filename: "top-two-moments-reel.mp4", mime: "video/mp4", sizeBytes: input.reelSizeBytes, state: "ready", previewUrl: `/api/jobs/${input.jobId}/assets/act-reel-top2` },
    {
      id: "confirmation",
      component: "Confirmation",
      jobId: input.confirmationJobId,
      actionId: input.confirmationActionId,
      title: "Approve launch post",
      description: "Publishing remains blocked until an operator approves this real pending job action.",
      risk: "high",
      state: "pending",
    },
  ];

  const payloads = [
    { type: "run_started", startedAt: input.startedAt },
    { type: "activity", activity: { id: "coordinator", label: "Coordinator routed the request", description: "Local replay fixture using the production event contract.", status: "complete" } },
    { type: "tool_activity", tool: { name: "harmonia_chat_router", status: "complete", inputSummary: "video source + content request", outputSummary: "intent=create_job", durationMs: 48, traceId: "demo-router-trace" } },
    { type: "a2ui_operation", operation: { version: "v0.9", createSurface: { surfaceId, catalogId: CATALOG_ID } } },
    { type: "a2ui_operation", operation: { version: "v0.9", updateComponents: { surfaceId, components } } },
    { type: "job_updated", jobId: input.jobId, stage: "complete", status: "complete" },
    { type: "run_completed", completedAt: input.completedAt, reply },
  ];
  return payloads.map((payload, sequence) => ({ ...payload, runId: input.runId, sequence }));
}
