import type { AnalysisResearchRequest, AnalysisSearchEvidence, ApprovalDecision, EvidenceRef, Angle, ContentStrategy, DraftWorkflowResult, EditorialPlan, EditorialPlanningSnapshot, EffectClaimSummary, JobConfig, JobSourceManifest, Moment, NormalizedSource, PlannedAction, PostDraft, Receipt, SourceAnalysis, Stage, StrategyApproval } from "@/lib/types";

export interface JobSummary {
  id: string;
  status: string;
  stage: Stage;
  createdAt: string;
  updatedAt: string;
  config: JobConfig;
  ingestedTitle?: string;
  ingestedDurationSec?: number;
  failure?: { stage: Stage; error: string; permanent: boolean; at: string };
  learnings?: { summary: string; notes: string[] };
}

export interface JobFull extends JobSummary {
  contentStrategy?: ContentStrategy;
  strategyDigest?: string;
  strategyRevision?: number;
  strategyApprovalState?: "pending" | "approved" | "rejected";
  strategyApproval?: StrategyApproval;
  strategyApprovalExpiresAt?: string;
  strategyEvidenceLineage?: string[];
  editorialPlan?: EditorialPlan;
  editorialPlanDigest?: string;
  editorialPlanRevision?: number;
  editorialPlanEvidenceLineage?: string[];
  editorialPlanningSnapshot?: EditorialPlanningSnapshot;
  editorialPlanningSnapshotDigest?: string;
  selectedNextItemId?: string;
  editorialItemStates?: Record<string, { status: "planned" | "selected" | "drafting" | "reviewed" | "awaiting_approval"; updatedAt: string }>;
  productionTrace?: DraftWorkflowResult;
  productionTraceDigest?: string;
  sourceManifest?: JobSourceManifest;
  normalizedSources: NormalizedSource[];
  sourceAnalysis?: SourceAnalysis;
  analysisDigest?: string;
  analysisResearchRequest?: AnalysisResearchRequest | null;
  analysisSearchEvidence?: AnalysisSearchEvidence[];
  analysisGroundingMetadata?: Record<string, unknown> | null;
  drafts: PostDraft[];
  contentPack?: { markdown: string; digest: string; generatedAt: string };
  actions: PlannedAction[];
  engagement?: Array<{
    actionId: string;
    postId: string;
    url?: string;
    likes: number;
    replies: number;
    reposts: number;
    quotes: number;
    impressions?: number;
    checkedAt: string;
  }>;
  learnings?: { summary: string; notes: string[] };
  verifications?: Array<{
    id?: string;
    rubricItemId: string;
    actionId?: string;
    receiptId?: string;
    operationId?: string;
    traceId?: string;
    checkedAt?: string;
    verified: boolean;
    method: string;
    evidence: Pick<EvidenceRef, "url" | "digest"> & { fetchedAt: string };
    note?: string;
  }>;
  packet?: {
    generatedAt: string;
    unresolved: string[];
    receipts: Receipt[];
  };
  assets?: Array<{ actionId: string; mime: string; sizeBytes: number; digest: string }>;
  claims?: EffectClaimSummary[];
  decisions?: ApprovalDecision[];
}

export type { Angle, Moment, PlannedAction, PostDraft, Receipt, Stage };
