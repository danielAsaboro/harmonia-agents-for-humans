import { describe, expect, it } from "vitest";
import { replayBundleSchema, type UnsignedReplayBundle } from "@/lib/recordReplay/schema";
import { canonicalJson, signReplayBundle, verifyReplayBundleDigest } from "@/lib/recordReplay/integrity";
import { createHash } from "node:crypto";

const unsigned: UnsignedReplayBundle = {
  schema: "harmonia.authenticated-replay", schemaVersion: "1.0.0", bundleId: "golden-success-1",
  executionMode: "recorded_replay", evidenceClassification: "historical_replay", scenario: "success",
  capturedAt: "2026-08-26T10:00:00.000Z", captureEndedAt: "2026-08-26T10:00:01.000Z",
  release: "private_candidate",
  provenance: { sourceRunId: "run-1", sourceJobId: "job-1", environment: "authenticated_cloud", sanitizerVersion: "1.0.0", sourceCaptureAuthorized: true },
  events: [
    { sequence: 0, capturedAt: "2026-08-26T10:00:00.000Z", offsetMs: 0, kind: "stage_transition", payload: { jobId: "job-1", stage: "collect_sources", status: "active" } },
    { sequence: 1, capturedAt: "2026-08-26T10:00:01.000Z", offsetMs: 1000, kind: "stage_transition", payload: { jobId: "job-1", stage: "complete", status: "complete" } },
  ],
  terminalStateDigest: "a".repeat(64),
};

describe("authenticated replay bundle", () => {
  it("canonicalizes keys and detects tampering", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    const signed = signReplayBundle(unsigned);
    expect(replayBundleSchema.parse(signed)).toEqual(signed);
    expect(verifyReplayBundleDigest(signed)).toBe(true);
    expect(verifyReplayBundleDigest({ ...signed, scenario: "rejection" })).toBe(false);
  });

  it("uses the shared UTF-8 representation for café and emoji", () => {
    const canonical = canonicalJson({ title: "café", emoji: "🚀" });
    expect(canonical).toBe('{"emoji":"🚀","title":"café"}');
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe("8cb94bc484c5bfb808cc96ee1e5051722a413073e49af6c62f83664d85c80523");
  });

  it("fails closed on unknown fields and sequence gaps", () => {
    const signed = signReplayBundle(unsigned);
    expect(() => replayBundleSchema.parse({ ...signed, unexpected: true })).toThrow();
    expect(() => replayBundleSchema.parse({ ...signed, events: [{ ...signed.events[0], sequence: 1 }] })).toThrow(/sequence/i);
  });
});
