import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('4000').transform((val) => parseInt(val, 10)),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  TEST_DATABASE_URL: z.string().optional(),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  // Agent Layer Configuration
  MODEL_PROVIDER: z.enum(['mock', 'meta', 'meta-spark', 'meta-model', 'spark-open']).default('mock'),
  MAX_AGENT_STEPS: z.string().default('20').transform((val) => parseInt(val, 10)),

  // Optional Meta Model Provider Config (never required for builds or tests)
  META_MODEL_API_KEY: z
    .string()
    .optional()
    .transform((val) => val || process.env.MODEL_API_KEY),
  META_MODEL_NAME: z.string().default('muse-spark-1.3'),
  META_MODEL_BASE_URL: z.string().default('https://api.meta.ai/v1'),
  META_MODEL_TIMEOUT_MS: z.string().default('30000').transform((val) => parseInt(val, 10)),

  // Optional Spark Open Provider Config
  SPARK_OPEN_BASE_URL: z.string().default('http://localhost:8000/v1'),
  SPARK_OPEN_MODEL_NAME: z.string().default('spark-open-7b'),
  SPARK_OPEN_TIMEOUT_MS: z.string().default('60000').transform((val) => parseInt(val, 10)),

  // Optional Geoapify Provider Config
  GEOAPIFY_API_KEY: z.string().optional(),
  GEOAPIFY_BASE_URL: z.string().default('https://api.geoapify.com'),
  SUPPLIER_DISCOVERY_PROVIDER: z.enum(['geoapify', 'mock']).default('mock'),

  // Optional Resend / Supplier Contact Provider Config
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().default('Relay Procurement <procurement@relaycommunity.com>'),
  SUPPLIER_CONTACT_PROVIDER: z.enum(['resend', 'mock']).default('mock'),

  // Negotiation Policy Configuration
  MAX_NEGOTIATION_ROUNDS: z.string().default('3').transform((val) => parseInt(val, 10)),
  MIN_PRICE_IMPROVEMENT_PERCENT: z.string().default('1').transform((val) => parseFloat(val)),

  // Phase 12.5 Real Authentication Providers Configuration
  FRONTEND_URL: z.string().default('http://localhost:3000'),

  // Google OAuth 2.0 / OpenID Connect
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GOOGLE_REDIRECT_URI: z.string().default('http://localhost:4000/api/auth/google/callback'),

  // Phone / SMS OTP Provider (Twilio Verify)
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_VERIFY_SERVICE_SID: z
    .string()
    .optional()
    .transform((val) => val || process.env.TWILIO_SERVICE_SID),
  TWILIO_PHONE_NUMBER: z.string().optional(),
  SMS_PROVIDER: z.enum(['twilio', 'mock']).default('mock'),

  // Reverse-proxy trust: when 'true', Express honors X-Forwarded-For for
  // req.ip (rate-limit keys). Default false: direct clients' XFF headers are
  // untrusted and ignored, so limits cannot be evaded by header rotation.
  TRUST_PROXY: z.string().default('false').transform((val) => val === 'true'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:', parsed.error.format());
  throw new Error('Invalid environment configuration');
}

export const env = parsed.data;
