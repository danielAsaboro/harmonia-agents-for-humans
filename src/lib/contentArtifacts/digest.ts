import { createHash } from "node:crypto";
import { canonicalJson } from "../recordReplay/integrity";
import type { ContentArtifact } from "./contracts";

export function contentArtifactDigest(artifact: Omit<ContentArtifact, "contentDigest"> | ContentArtifact): string {
  const { contentDigest: _ignored, ...meaning } = artifact as ContentArtifact;
  return createHash("sha256").update(canonicalJson(meaning)).digest("hex");
}

export function sealContentArtifact(artifact: Omit<ContentArtifact, "contentDigest">): ContentArtifact {
  return { ...artifact, contentDigest: contentArtifactDigest(artifact) } as ContentArtifact;
}
