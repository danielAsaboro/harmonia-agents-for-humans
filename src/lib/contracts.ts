import { z } from "zod";

export const evidenceRefSchema = z.object({
  kind: z.enum([
    "github_blob",
    "github_api",
    "http_probe",
    "devpost_page",
    "cloud_run_revision",
    "pubsub_message",
    "firestore_doc",
  ]),
  url: z.string().url(),
  fetchedAt: z.string(),
  digest: z.string().nullable().optional(),
});

export const rubricItemSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  requirement: z.string().min(1),
  category: z.string().min(1),
  evidenceHint: z.string().optional(),
  weight: z.number().positive().default(1),
});

export const ingestSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("ingest"),
  sourceUrl: z.string().url(),
  httpStatus: z.number().int(),
  bytes: z.number().int().nonnegative(),
  digest: z.string().min(16),
  extractedSections: z.array(z.string()).default([]),
});

export const rubricSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("normalize"),
  sourceUrl: z.string().url(),
  items: z.array(rubricItemSchema).min(1),
});

export const observationSchema = z.object({
  kind: z.enum([
    "devpost_source",
    "github_repo",
    "github_file",
    "cloud_run_url",
  ]),
  target: z.string().min(1),
  url: z.string().url(),
  ok: z.boolean(),
  httpStatus: z.number().int().nullable().optional(),
  digest: z.string().nullable().optional(),
  excerpt: z.string().max(20000).nullable().optional(),
  detail: z.record(z.string(), z.unknown()).default({}),
});

export const observationsSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("collect"),
  observations: z.array(observationSchema),
});

export const findingSchema = z.object({
  rubricItemId: z.string().min(1),
  status: z.enum(["satisfied", "missing", "partial", "unknown"]),
  rationale: z.string().min(1),
  evidence: z.array(evidenceRefSchema).default([]),
});

export const findingsSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("evaluate"),
  findings: z.array(findingSchema),
});

export const actionPayloadSchema = z.union([
  z.object({
    type: z.literal("github_upsert_file"),
    path: z.string().min(1),
    branch: z.string().min(1),
    content: z.string(),
    commitMessage: z.string().min(1),
  }),
  z.object({
    type: z.literal("github_create_issue"),
    title: z.string().min(1),
    body: z.string().min(1),
    labels: z.array(z.string()).default([]),
  }),
]);

export const proposedActionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["github_upsert_file", "github_create_issue"]),
  title: z.string().min(1),
  description: z.string().min(1),
  rubricItemIds: z.array(z.string()).max(5).default([]),
  payload: actionPayloadSchema,
});

export const planSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.literal("plan"),
  actions: z.array(proposedActionSchema).max(10),
});

export const receiptSubmissionSchema = z.object({
  jobId: z.string().min(1),
  actionId: z.string().min(1),
  actionType: z.enum(["github_upsert_file", "github_create_issue"]),
  idempotencyKey: z.string().min(16),
  outcome: z.enum(["applied", "already_applied", "rejected", "failed"]),
  artifact: evidenceRefSchema.nullable().optional(),
  detail: z.record(z.string(), z.unknown()).default({}),
});

export const verificationSubmissionSchema = z.object({
  jobId: z.string().min(1),
  results: z.array(
    z.object({
      rubricItemId: z.string().min(1),
      actionId: z.string().optional(),
      verified: z.boolean(),
      method: z.string().min(1),
      evidence: evidenceRefSchema,
      note: z.string().optional(),
    }),
  ),
});

export const failureSubmissionSchema = z.object({
  jobId: z.string().min(1),
  stage: z.string().min(1),
  error: z.string().min(1),
  permanent: z.boolean(),
});
