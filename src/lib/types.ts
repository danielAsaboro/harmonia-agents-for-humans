export const STAGES = [
  "queued",
  "ingest",
  "transcribe",
  "understand",
  "draft",
  "awaiting_approval",
  "publish",
  "verify",
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
  youtubeUrl: string;
  platforms: string[];
}

export interface Job {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  stage: Stage;
  config: JobConfig;
  failure?: {
    stage: Stage;
    error: string;
    permanent: boolean;
    at: string;
  };
}

export interface EvidenceRef {
  kind:
    | "youtube_api"
    | "media_file"
    | "gemini_call"
    | "x_api"
    | "http_probe"
    | "firestore_doc";
  url: string;
  fetchedAt: string;
  digest?: string | null;
}

export type RiskLevel = "low" | "medium" | "high";

export type ActionType = "export_content_pack" | "publish_x_post";

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
