import { z } from "zod";

const envSchema = z.object({
  GOOGLE_CLOUD_PROJECT: z.string().min(1).default("closefold-local"),
  GOOGLE_CLOUD_LOCATION: z.string().default("us-central1"),
  FIRESTORE_JOB_COLLECTION: z.string().default("jobs"),
  PUBSUB_STAGE_TOPIC: z.string().default("closefold-stages"),
  INTERNAL_API_TOKEN: z.string().min(1),
  OPERATOR_TOKEN: z.string().min(8).optional(),
  MODEL_ID: z.string().default("gemini-3.5-flash"),
  PUBLIC_BASE_URL: z.string().url().optional(),
});

export type Config = z.infer<typeof envSchema>;

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
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.PUBSUB_EMULATOR_HOST);
}
