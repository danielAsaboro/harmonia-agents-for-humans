import { describe, expect, it } from "vitest";
import {
  draftsSubmissionSchema,
  ingestSubmissionSchema,
  receiptSubmissionSchema,
} from "@/lib/contracts";

describe("internal contracts", () => {
  it("accepts a valid ingest submission", () => {
    const parsed = ingestSubmissionSchema.safeParse({
      jobId: "j1", stage: "ingest", videoId: "dQw4w9WgXcQ", title: "t",
      channel: "c", durationSec: 90, mediaBytes: 1024, mediaDigest: "a".repeat(32),
    });
    expect(parsed.success).toBe(true);
  });

  it("validates drafts with proposed publish actions", () => {
    const parsed = draftsSubmissionSchema.safeParse({
      jobId: "j1", stage: "draft",
      drafts: [{ id: "d1", platform: "x", text: "hello world" }],
      proposedActions: [
        { id: "a1", type: "publish_x_post", title: "post", description: "d",
          payload: { type: "publish_x_post", text: "hello world" } },
        { id: "a2", type: "export_content_pack", title: "pack", description: "d",
          payload: { type: "export_content_pack" } },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects receipts for unknown action types", () => {
    const parsed = receiptSubmissionSchema.safeParse({
      jobId: "j1", actionId: "a1", actionType: "github_upsert_file",
      idempotencyKey: "k".repeat(32), outcome: "applied", detail: {},
    });
    expect(parsed.success).toBe(false);
  });
});
