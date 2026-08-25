export type StageOutboxState = "pending" | "claimed" | "published";

export interface StageOutboxRecord {
  id: string;
  workspaceId: string;
  brandId: string;
  jobId: string;
  stage: string;
  attempt: number;
  completedStage?: string;
  note?: string;
  state: StageOutboxState;
  createdAt: string;
  claimTokenDigest?: string;
  claimUntil?: string;
  publishedAt?: string;
  pubsubMessageId?: string;
}

export type StageOutboxClaimDecision =
  | { outcome: "publish"; record: StageOutboxRecord }
  | { outcome: "in_progress" | "already_published" };

export function decideStageOutboxClaim(
  current: StageOutboxRecord,
  claimTokenDigest: string,
  now: Date,
  leaseMs = 60_000,
): StageOutboxClaimDecision {
  if (current.state === "published") return { outcome: "already_published" };
  if (current.state === "claimed") {
    const claimUntil = Date.parse(current.claimUntil ?? "");
    if (!Number.isFinite(claimUntil)) throw new Error("stage outbox claim lease is invalid");
    if (claimUntil > now.getTime()) return { outcome: "in_progress" };
  }
  return {
    outcome: "publish",
    record: {
      ...current,
      state: "claimed",
      claimTokenDigest,
      claimUntil: new Date(now.getTime() + leaseMs).toISOString(),
    },
  };
}

export function finalizeStageOutbox(
  current: StageOutboxRecord,
  claimTokenDigest: string,
  pubsubMessageId: string,
  now: Date,
): StageOutboxRecord {
  if (current.state === "published") {
    if (current.pubsubMessageId !== pubsubMessageId) {
      throw new Error("stage outbox was already finalized with another message");
    }
    return current;
  }
  if (current.state !== "claimed" || current.claimTokenDigest !== claimTokenDigest) {
    throw new Error("stage outbox finalization is not owned by this claim");
  }
  return {
    ...current,
    state: "published",
    publishedAt: now.toISOString(),
    pubsubMessageId,
  };
}

export function releaseStageOutboxClaim(
  current: StageOutboxRecord,
  claimTokenDigest: string,
): StageOutboxRecord {
  if (current.state !== "claimed" || current.claimTokenDigest !== claimTokenDigest) return current;
  const { claimTokenDigest: _token, claimUntil: _until, ...rest } = current;
  return { ...rest, state: "pending" };
}
