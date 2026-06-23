import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  SESSION_SECRET: z.string().min(32),
  APP_URL: z.string().url().default("http://localhost:3000"),
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  S3_BUCKET: z.string().optional(),
  AWS_REGION: z.string().default("us-east-1"),
  // Payments master switch (docs/pricing.md). Discovery-first launch leaves this
  // false: Gigit processes no gig money — the venue pays the act directly. Set
  // true (together with the Stripe keys below) to turn the payments rail on at
  // monetization. Requiring an explicit flag means payments are never activated
  // by accident just because a key is present.
  PAYMENTS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  // Payments: unset → NullGateway. Both required together for Stripe.
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  // AI gateway: Gemini. Unset → heuristic fallbacks / "not configured" errors.
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.5-flash"),
  // Notifications: unset → structured-log sink (dev).
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),
  EMAIL_FROM: z.string().optional(), // SES verified sender
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
      throw new Error(
        `invalid environment: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }
    if (parsed.data.STORAGE_DRIVER === "s3" && !parsed.data.S3_BUCKET) {
      throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
    }
    cached = parsed.data;
  }
  return cached;
}
