import { describe, expect, it } from "vitest";
import {
  findingsSubmissionSchema,
  ingestSubmissionSchema,
  observationsSubmissionSchema,
  receiptSubmissionSchema,
  verificationSubmissionSchema,
} from "@/lib/contracts";

describe("internal contract nullability (Python workers serialize None)", () => {
  const baseObservation = {
    kind: "github_file",
    target: "README.md",
    url: "https://api.github.com/repos/o/r/contents/README.md",
    ok: false,
  };

  it("accepts null httpStatus/digest/excerpt", () => {
    const parsed = observationsSubmissionSchema.safeParse({
      jobId: "j1",
      stage: "collect",
      observations: [
        { ...baseObservation, httpStatus: null, digest: null, excerpt: null, detail: {} },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects malformed observation urls", () => {
    const parsed = observationsSubmissionSchema.safeParse({
      jobId: "j1",
      stage: "collect",
      observations: [{ ...baseObservation, url: "not-a-url", detail: {} }],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts a receipt whose artifact is explicitly null", () => {
    const parsed = receiptSubmissionSchema.safeParse({
      jobId: "j1",
      actionId: "a1",
      actionType: "github_create_issue",
      idempotencyKey: "k".repeat(64),
      outcome: "failed",
      artifact: null,
      detail: {},
    });
    expect(parsed.success).toBe(true);
  });

  it("keeps verification evidence digest nullable", () => {
    const parsed = verificationSubmissionSchema.safeParse({
      jobId: "j1",
      results: [
        {
          rubricItemId: "r1",
          verified: false,
          method: "mechanical:test",
          evidence: {
            kind: "http_probe",
            url: "https://svc.example.run.app/",
            fetchedAt: new Date().toISOString(),
            digest: null,
          },
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("still enforces required strings on ingest submissions", () => {
    const parsed = ingestSubmissionSchema.safeParse({
      jobId: "j1",
      stage: "ingest",
      sourceUrl: "https://x.devpost.com/",
      httpStatus: 200,
      bytes: 10,
      digest: "a".repeat(20),
    });
    expect(parsed.success).toBe(true);
    const bad = findingsSubmissionSchema.safeParse({
      jobId: "j1",
      stage: "evaluate",
      findings: [{ rubricItemId: "", status: "satisfied", rationale: "r", evidence: [] }],
    });
    expect(bad.success).toBe(false);
  });
});
