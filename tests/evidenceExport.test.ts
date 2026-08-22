import { describe, expect, it } from "vitest";
import { evidenceJson, evidenceMarkdown } from "@/lib/evidenceExport";
import type { JobFull } from "@/components/Dashboard";

const job: JobFull = {
  id: "11111111-2222-3333-4444-555555555555",
  status: "complete",
  stage: "complete",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  config: {
    devpostUrl: "https://example.devpost.com/",
    githubRepo: "closefold",
    githubOwner: "danielAsaboro",
    cloudRunUrl: "https://svc.run.app",
  },
  rubric: [
    { id: "r1", source: "s", requirement: "README setup", category: "readme-setup", status: "verified", weight: 1 },
    { id: "r2", source: "s", requirement: "License", category: "license", status: "unresolved", weight: 1 },
  ],
  findings: [
    { rubricItemId: "r1", status: "satisfied", rationale: "README present", evidence: [{ kind: "github_api", url: "https://api.github.com/x", fetchedAt: "2026-08-22T00:00:00Z" }] },
  ],
  actions: [],
  observations: [
    { kind: "github_file", target: "README.md", url: "https://api.github.com/x", ok: true, httpStatus: 200, digest: "a".repeat(64), excerpt: null, detail: {} },
  ],
  verifications: [
    { rubricItemId: "r1", verified: true, method: "mechanical:readme-setup", evidence: { url: "https://api.github.com/x", fetchedAt: "2026-08-22T00:00:00Z" } },
  ],
  packet: { generatedAt: new Date().toISOString(), unresolved: ["License (missing; never verified)"], receipts: [] },
};

describe("evidence export builders", () => {
  it("markdown includes rubric table, findings, verifications and unresolved gaps", () => {
    const md = evidenceMarkdown(job);
    expect(md).toContain("# Closefold Evidence Packet");
    expect(md).toContain("| README setup | readme-setup | verified | yes");
    expect(md).toContain("**r1** — satisfied");
    expect(md).toContain("VERIFIED via mechanical:readme-setup");
    expect(md).toContain("- License (missing; never verified)");
  });

  it("json export round-trips the full job state", () => {
    const parsed = JSON.parse(evidenceJson(job));
    expect(parsed.job.id).toBe(job.id);
    expect(parsed.observations).toHaveLength(1);
    expect(parsed.packet.unresolved).toHaveLength(1);
    expect(parsed.rubric).toHaveLength(2);
  });
});
