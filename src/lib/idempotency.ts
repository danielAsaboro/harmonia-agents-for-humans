import { createHash, randomUUID } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function idempotencyKey(
  jobId: string,
  actionId: string,
  contentHash: string,
): string {
  return createHash("sha256")
    .update(`${jobId}|${actionId}|${contentHash}`)
    .digest("hex");
}

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
