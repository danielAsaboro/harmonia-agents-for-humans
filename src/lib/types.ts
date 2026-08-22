export const STAGES = [
  "queued",
  "ingest",
  "normalize",
  "collect",
  "evaluate",
  "plan",
  "awaiting_approval",
  "act",
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
  devpostUrl: string;
  githubRepo: string;
  githubOwner: string;
  cloudRunUrl?: string;
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

export type RubricItemStatus = "pending" | "verified" | "unresolved" | "failed";

export interface RubricItem {
  id: string;
  source: string;
  requirement: string;
  category: string;
  evidenceHint?: string;
  status: RubricItemStatus;
  weight: number;
}

export interface EvidenceRef {
  kind:
    | "github_blob"
    | "github_api"
    | "http_probe"
    | "devpost_page"
    | "cloud_run_revision"
    | "pubsub_message"
    | "firestore_doc";
  url: string;
  fetchedAt: string;
  digest?: string | null;
}

export type FindingStatus = "satisfied" | "missing" | "partial" | "unknown";

export interface Finding {
  rubricItemId: string;
  status: FindingStatus;
  rationale: string;
  evidence: EvidenceRef[];
}

export type RiskLevel = "low" | "medium" | "high";

export type ActionType = "github_upsert_file" | "github_create_issue";

export interface PlannedAction {
  id: string;
  jobId: string;
  type: ActionType;
  title: string;
  description: string;
  rubricItemIds?: string[];
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
  rubricItemId: string;
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

export interface EvidencePacket {
  jobId: string;
  generatedAt: string;
  config: JobConfig;
  rubric: RubricItem[];
  findings: Finding[];
  receipts: Receipt[];
  verifications: VerificationResult[];
  unresolved: string[];
}
