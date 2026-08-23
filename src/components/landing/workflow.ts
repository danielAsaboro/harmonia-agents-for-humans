export type WorkflowStageId =
  | "source"
  | "transcribe"
  | "understand"
  | "draft"
  | "approve"
  | "publish"
  | "verify"
  | "learn";

export type WorkflowStage = {
  id: WorkflowStageId;
  index: string;
  verb: string;
  title: string;
  detail: string;
  signal: string;
};

export const WORKFLOW_STAGES: readonly WorkflowStage[] = [
  {
    id: "source",
    index: "01",
    verb: "Ingest",
    title: "One long-form source",
    detail: "A real YouTube link or uploaded video enters the engine once.",
    signal: "16:42 source locked",
  },
  {
    id: "transcribe",
    index: "02",
    verb: "Transcribe",
    title: "Speech becomes timed signal",
    detail: "Gemini turns the recording into searchable, time-aware material.",
    signal: "2,846 words aligned",
  },
  {
    id: "understand",
    index: "03",
    verb: "Understand",
    title: "Moments emerge from the noise",
    detail: "Hooks, claims, stories, clip ranges, and meme angles are ranked.",
    signal: "7 moments found",
  },
  {
    id: "draft",
    index: "04",
    verb: "Shape",
    title: "Ideas become platform-native",
    detail: "One insight branches into a post, thread, caption, and short clip.",
    signal: "4 outputs drafted",
  },
  {
    id: "approve",
    index: "05",
    verb: "Approve",
    title: "The machine waits for you",
    detail: "Nothing leaves Harmonia until a human approves the exact action.",
    signal: "approval required",
  },
  {
    id: "publish",
    index: "06",
    verb: "Publish",
    title: "Approved content leaves safely",
    detail: "Official platform APIs execute one idempotent action at a time.",
    signal: "1 action dispatched",
  },
  {
    id: "verify",
    index: "07",
    verb: "Verify",
    title: "Receipts replace assumptions",
    detail: "Independent reads confirm the external state and preserve proof.",
    signal: "receipt verified",
  },
  {
    id: "learn",
    index: "08",
    verb: "Learn",
    title: "Every result feeds the next cycle",
    detail: "Performance becomes structured memory for sharper future work.",
    signal: "memory updated",
  },
] as const;

export function getWorkflowStage(index: number): WorkflowStage {
  const length = WORKFLOW_STAGES.length;
  const wrappedIndex = ((index % length) + length) % length;

  return WORKFLOW_STAGES[wrappedIndex];
}

export type LiveWorkflowFrameId =
  | "source"
  | "transcribe"
  | "signals"
  | "draft"
  | "approval"
  | "publish"
  | "verified";

export type LiveWorkflowFrame = {
  id: LiveWorkflowFrameId;
  step: string;
  label: string;
  detail: string;
  mode: "source" | "intelligence" | "drafts" | "delivery";
  requiresClick: boolean;
};

export const LIVE_WORKFLOW_FRAMES: readonly LiveWorkflowFrame[] = [
  {
    id: "source",
    step: "01",
    label: "Source enters",
    detail: "The original asset is fingerprinted and held as the traceable root.",
    mode: "source",
    requiresClick: true,
  },
  {
    id: "transcribe",
    step: "02",
    label: "Gemini listens",
    detail: "Timed speech becomes searchable material without losing its place in the source.",
    mode: "intelligence",
    requiresClick: false,
  },
  {
    id: "signals",
    step: "03",
    label: "Moments emerge",
    detail: "Claims, hooks, stories, and clip ranges resolve into ranked opportunities.",
    mode: "intelligence",
    requiresClick: false,
  },
  {
    id: "draft",
    step: "04",
    label: "One idea branches",
    detail: "The same evidence becomes native drafts for each selected platform.",
    mode: "drafts",
    requiresClick: true,
  },
  {
    id: "approval",
    step: "05",
    label: "The machine waits",
    detail: "A human reviews the exact content and action before anything can leave Harmonia.",
    mode: "drafts",
    requiresClick: true,
  },
  {
    id: "publish",
    step: "06",
    label: "Approved action runs",
    detail: "One idempotent dispatch travels through the official platform integration.",
    mode: "delivery",
    requiresClick: false,
  },
  {
    id: "verified",
    step: "07",
    label: "The loop closes",
    detail: "An independent read confirms external state and writes the receipt back to memory.",
    mode: "delivery",
    requiresClick: false,
  },
] as const;

export function getLiveWorkflowFrame(index: number): LiveWorkflowFrame {
  const length = LIVE_WORKFLOW_FRAMES.length;
  const wrappedIndex = ((index % length) + length) % length;

  return LIVE_WORKFLOW_FRAMES[wrappedIndex];
}

export type ApprovalDecision = "pending" | "approved" | "revision";

export function getApprovalOutcome(decision: ApprovalDecision) {
  if (decision === "approved") {
    return { label: "Approved", detail: "Publish action unlocked" } as const;
  }
  if (decision === "revision") {
    return { label: "Revision requested", detail: "Publishing remains locked" } as const;
  }
  return { label: "Awaiting your decision", detail: "Publishing is locked" } as const;
}
