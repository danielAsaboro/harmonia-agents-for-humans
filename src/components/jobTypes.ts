import type { EvidenceRef, Angle, Moment, PlannedAction, PostDraft, Receipt, Stage } from "@/lib/types";

export interface JobSummary {
  id: string;
  status: string;
  stage: Stage;
  createdAt: string;
  updatedAt: string;
  config: { youtubeUrl?: string; brief?: string; platforms: string[] };
  ingestedTitle?: string;
  failure?: { stage: Stage; error: string; permanent: boolean; at: string };
  learnings?: { summary: string; notes: string[] };
}

export interface JobFull extends JobSummary {
  transcriptSegments: Array<{ id: string; startSec: number; endSec: number; text: string }>;
  moments: Moment[];
  angles: Angle[];
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
    rubricItemId: string;
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
}

export type { Angle, Moment, PlannedAction, PostDraft, Receipt, Stage };
