import { z } from "zod";

const envSchema = z.object({
  AWS_REGION: z.string().default("us-east-1"),
  DYNAMODB_TABLE: z.string().min(1).default("harmonia"),
  S3_BUCKET: z.string().optional(),
  SQS_STAGE_QUEUE_URL: z.string().url().optional(),
  SQS_DATA_QUEUE_URL: z.string().url().optional(),
  SQS_PRODUCTION_QUEUE_URL: z.string().url().optional(),
  INTERNAL_API_TOKEN: z.string().min(1),
  AGENT_SERVICE_URL: z.string().url(),
  MODEL_ID: z.string().default("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
  MODEL_PRICING_VERSION: z.string().min(1).default("unconfigured"),
  ELEVENLABS_MUSIC_COST_PER_SECOND_USD: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^\d+\.\d{6}$/).optional()),
  NOVA_REEL_COST_PER_SECOND_USD: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^\d+\.\d{6}$/).optional()),
  NOVA_CANVAS_COST_PER_IMAGE_USD: z.preprocess((value) => value === "" ? undefined : value, z.string().regex(/^\d+\.\d{6}$/).optional()),
  NOVA_CANVAS_MODEL_ID: z.string().optional(),
  NOVA_REEL_MODEL_ID: z.string().optional(),
  ELEVENLABS_MUSIC_MODEL_ID: z.string().optional(),
  HARMONIA_ALLOW_PAID_AWS: z.enum(["true", "false"]).optional(),
  GENERATIVE_MEDIA_ENABLED: z.enum(["true", "false"]).optional(),
  MEDIA_OUTPUT_BUCKET: z.string().min(1).optional(),
  ELEVENLABS_API_KEY: z.string().min(1).optional(),
  DEFAULT_JOB_BUDGET_USD: z.string().regex(/^\d+\.\d{1,6}$/).default("5.00"),
  DEFAULT_JOB_APPROVAL_THRESHOLD_USD: z.string().regex(/^\d+\.\d{1,6}$/).default("0.25"),
  DEFAULT_WORKSPACE_BUDGET_USD: z.string().regex(/^\d+\.\d{1,6}$/).default("100.00"),
  PUBLIC_BASE_URL: z.string().url().optional(),
  ATTACHMENT_ALLOWED_ORIGINS: z.string().min(1).optional(),
});

const budgetEnvSchema = envSchema.pick({
  DEFAULT_JOB_BUDGET_USD: true,
  DEFAULT_JOB_APPROVAL_THRESHOLD_USD: true,
  DEFAULT_WORKSPACE_BUDGET_USD: true,
});

export function parseBudgetConfig(environment: Record<string, string | undefined>) {
  return budgetEnvSchema.parse(environment);
}

export type Config = z.infer<typeof envSchema>;

/** Parse a supplied runtime environment without mutating the process cache. */
export function parseConfig(environment: Record<string, string | undefined>): Config {
  return envSchema.parse(environment);
}

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration -> ${missing}`);
  }
  cached = parsed.data;
  return cached;
}

export function isEmulatorMode(): boolean {
  return Boolean(process.env.AWS_LOCAL_ENDPOINT);
}
