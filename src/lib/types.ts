export const STAGES = [
  "queued",
  "ingest",
  "transcribe",
  "understand",
  "draft",
  "awaiting_approval",
  "publish",
  "verify",
  "learn",
  "packet",
  "complete",
  "failed",
] as const;

export type Stage = (typeof STAGES)[number];

export type JobStatus =
  | "running"
  | "waiting_for_approval"
  | "complete"
  | "failed";

export interface JobConfig {
  youtubeUrl?: string;
  /** Operator-supplied topic/brief for concept jobs that skip ingest+transcribe. */
  brief?: string;
  platforms: string[];
}

export interface Job {
  id: string;
  workspaceId: string;
  brandId: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  stage: Stage;
  config: JobConfig;
  ingestedTitle?: string;
  ingestedChannel?: string;
  ingestedDurationSec?: number;
  mediaDigest?: string;
  videoId?: string;
  budget?: JobBudget;
  failure?: {
    stage: Stage;
    error: string;
    permanent: boolean;
    at: string;
  };
}

export interface JobBudget {
  estimatedUsd: string;
  observedUsd: string;
  reservedUsd: string;
  limitUsd: string;
  approvalThresholdUsd: string;
}

export interface UsageRecord {
  id: string;
  jobId: string;
  operationId: string;
  stage: string;
  role: string;
  model: string;
  inputUnits: number;
  outputUnits: number;
  unitType: "tokens" | "images" | "video_seconds" | "audio_seconds" | "endpoint_seconds" | "media_generations";
  estimatedCostUsd: string;
  observedCostUsd?: string;
  pricingVersion: string;
  traceId: string;
  createdAt: string;
}

export interface EvidenceRef {
  kind:
    | "youtube_api"
    | "media_file"
    | "gemini_call"
    | "x_api"
    | "http_probe"
    | "firestore_doc"
    | "asset_store";
  url: string;
  fetchedAt: string;
  digest?: string | null;
}

export type RiskLevel = "low" | "medium" | "high";

export type ActionType =
  | "export_content_pack"
  | "publish_x_post"
  | "generate_image"
  | "generate_veo_broll"
  | "generate_lyria_soundtrack"
  | "render_clip"
  | "render_reel";

export interface PlannedAction {
  id: string;
  jobId: string;
  type: ActionType;
  title: string;
  description: string;
  momentId?: string;
  angleId?: string;
  risk: RiskLevel;
  requiresApproval: boolean;
  approvalState: "not_required" | "pending" | "approved" | "rejected";
  payload: Record<string, unknown>;
  state: "planned" | "executed" | "skipped" | "failed";
}

export interface Receipt {
  id: string;
  jobId: string;
  actionId: string;
  idempotencyKey: string;
  actionType: ActionType;
  performedAt: string;
  outcome: "applied" | "already_applied" | "rejected" | "failed";
  artifact?: EvidenceRef;
  detail: Record<string, unknown>;
}

export interface VerificationResult {
  target: string;
  actionId?: string;
  verified: boolean;
  method: string;
  evidence: EvidenceRef;
  checkedAt: string;
  note?: string;
}

export interface StageEvent {
  id: string;
  jobId: string;
  at: string;
  stage: Stage;
  message: string;
  actor: "system" | "agent" | "operator";
}

export interface Observation {
  kind: "devpost_source" | "github_repo" | "github_file" | "cloud_run_url";
  target: string;
  url: string;
  ok: boolean;
  httpStatus?: number | null;
  digest?: string | null;
  excerpt?: string | null;
  detail: Record<string, unknown>;
}

export interface Moment {
  id: string;
  title: string;
  startSec: number;
  endSec: number;
  hook: string;
  quote: string;
  visualHook?: string;
  cropSuitability?: "poor" | "fair" | "good" | "excellent";
  captionSafeRegion?: string;
  visualEvidenceIds?: string[];
}

export interface Angle {
  id: string;
  kind: "trend" | "meme";
  title: string;
  rationale: string;
}

export interface PostDraft {
  id: string;
  platform: string;
  momentId?: string;
  angleId?: string;
  text: string;
  valid: boolean;
  validationNote?: string;
}

export interface EvidencePacket {
  jobId: string;
  generatedAt: string;
  config: JobConfig;
  drafts: PostDraft[];
  verifications: VerificationResult[];
  unresolved: string[];
}

/** Reaction metrics captured for one published post during the learn stage. */
export interface Engagement {
  actionId: string;
  postId: string;
  url?: string;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  impressions?: number;
  checkedAt: string;
}

/** Deterministic takeaways fed back into future research/ideation prompts. */
export interface Learnings {
  summary: string;
  notes: string[];
  generatedAt: string;
}

export type ContentItemStatus =
  | "draft"
  | "scheduled"
  | "awaiting_final_review"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled";

export type PublishMode = "auto" | "approval";

export interface ContentItemRevision {
  text: string;
  at: string;
}

export interface ContentItem {
  id: string;
  jobId: string;
  draftId?: string;
  text: string;
  platforms: string[];
  status: ContentItemStatus;
  publishMode: PublishMode;
  scheduledFor?: string;
  revisions?: ContentItemRevision[];
  /** Rendered media attached to this post (image/clip action ids on the parent job). */
  assetActionIds?: string[];
  publishedPostId?: string;
  publishedUrl?: string;
  publishedAt?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export type NotificationSeverity = "info" | "warning" | "critical";

export interface AppNotification {
  id?: string;
  kind: string;
  title: string;
  body: string;
  severity: NotificationSeverity;
  refType?: "job" | "content_item" | "connection";
  refId?: string;
  href?: string;
  readAt?: string | null;
  createdAt: string;
}
