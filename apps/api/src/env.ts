import { z } from "zod";

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  PUBLIC_BASE_URL: z.string().url().default("http://localhost:4000"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL required"),
  DIRECT_URL: z.string().optional(),
  // No longer used: the queue moved from BullMQ/Redis to Postgres polling.
  // Kept optional so an existing REDIS_URL in .env doesn't fail validation.
  REDIS_URL: z.string().optional(),

  TOKEN_ENCRYPTION_KEY: z
    .string()
    .min(1, "TOKEN_ENCRYPTION_KEY required (32-byte base64)"),

  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),
  META_WEBHOOK_VERIFY_TOKEN: z.string().optional(),

  THREADS_APP_ID: z.string().optional(),
  THREADS_APP_SECRET: z.string().optional(),
  THREADS_ACCESS_TOKEN: z.string().optional(),

  INSTAGRAM_APP_ID: z.string().optional(),
  INSTAGRAM_APP_SECRET: z.string().optional(),
  INSTAGRAM_USER_ID: z.string().optional(),
  INSTAGRAM_ACCESS_TOKEN: z.string().optional(),

  // DeepSeek (preferred per user note in memory: cheaper than Claude for this).
  DEEPSEEK_API_KEY: z.string().optional(),
  // DeepSeek V4 Flash — fast + cheap variant the user has standardized on for
  // all AI features (captions, /inspire, image prompts, dashboard insights).
  // Override via DEEPSEEK_MODEL env var if you want to pin a different model.
  DEEPSEEK_MODEL: z.string().default("deepseek-v4-flash"),

  // OpenRouter is used ONLY for from-image mode (vision). One key, many
  // models; pricing is pay-per-use. Sign up at https://openrouter.ai/keys
  OPENROUTER_API_KEY: z.string().optional(),
  // Default to a balanced Qwen3-VL — cheap enough for personal use, accurate
  // enough to describe fashion / outfit / vibe photos.
  OPENROUTER_VISION_MODEL: z.string().default("qwen/qwen3-vl-32b-instruct"),

  // Where the local-disk driver writes media. Defaults to apps/api/uploads.
  // In production (Fly), set this to the volume mount point (e.g. /data/uploads).
  UPLOAD_DIR: z.string().optional(),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_PUBLIC_URL_BASE: z.string().optional(),

  // Encrypted Postgres backups to Cloudflare R2 (see services/db-backup.ts).
  // Disabled until all five values are present — a half-configured backup that
  // silently no-ops is worse than none, so maybeRunBackup logs when enabled
  // without credentials.
  BACKUP_ENABLED: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  BACKUP_R2_ENDPOINT: z.string().url().optional(),
  BACKUP_R2_BUCKET: z.string().optional(),
  BACKUP_R2_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_R2_SECRET_ACCESS_KEY: z.string().optional(),
  // gpg symmetric passphrase. Losing this loses every backup — store it
  // somewhere that is NOT this database.
  BACKUP_PASSPHRASE: z.string().optional(),

  KILL_SWITCH: z
    .string()
    .default("false")
    .transform((v) => v === "true"),

  // Stage 2 engagement worker (auto-reply on Threads).
  // Set to "false" on Fly if memory gets tight and run it locally instead.
  ENGAGEMENT_ENABLED: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),
});

export const env = Env.parse(process.env);
export type Env = z.infer<typeof Env>;
