import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config as dotenv } from 'dotenv';
import { z } from 'zod';

export const PHOTOS_SCOPE = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
export interface Config {
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  googlePhotosScope: string;
  webOrigin: string;
  apiPort: number;
  sessionSecret: string;
  mediaStoragePath: string;
  sessionStoragePath: string;
  nodeEnv: string;
  databasePath?:string;
  importConcurrency?:number;
  importBatchSize?:number;
  importMaxAttempts?:number;
  importRetryBaseMs?:number;
  storageQuotaBytes?:number;
  minFreeDiskBytes?:number;
  maxImageBytes?:number;
  geminiApiKey?:string;
  geminiModel?:string;
  geminiTimeoutMs?:number;
  geminiMaxOutputTokens?:number;
  geminiInputPricePerMillion?:number;
  geminiOutputPricePerMillion?:number;
  geminiMaxProjectSpendUsd?:number;
  analysisConcurrency?:number;
  analysisBatchSize?:number;
  analysisMaxAttempts?:number;
  analysisRetryBaseMs?:number;
  analysisPipelineVersion?:string;
  analysisImageMaxDimension?:number;
  analysisNearDuplicateDistance?:number;
  productionDefaultBudgetUsd?:number;productionPollIntervalMs?:number;productionMaxStageAttempts?:number;
  movieThreads?:number;movieMemoryLimitMb?:number;movieMaxWorkspaceBytes?:number;movieMaxOutputBytes?:number;movieMaxSoundtrackBytes?:number;movieRenderTimeoutMs?:number;movieDurationToleranceSeconds?:number;movieFontSerifPath?:string;movieFontSansPath?:string;
  videoProvider?:'omni'|'veo';omniModel?:string;veoModel?:string;
  videoResolution?:'720p'|'1080p';videoAspectRatio?:'16:9'|'9:16';videoDurationSeconds?:number;
  videoMaxConcurrentJobs?:number;videoMaxProjectBudgetUsd?:number;videoMaxAutomaticRetries?:number;
  videoPollIntervalMs?:number;videoRequestTimeoutMs?:number;videoMaxBytes?:number;
  videoKeyframeModel?:string;videoQualityModel?:string;videoKeyframeEstimateUsd?:number;videoQualityEstimateUsd?:number;
  ffmpegPath?:string;ffprobePath?:string;
}

function repositoryRoot() {
  let current = process.cwd();
  while (true) {
    const path = resolve(current, 'package.json');
    if (existsSync(path)) {
      try { if (JSON.parse(readFileSync(path, 'utf8')).workspaces) return current; } catch { /* Continue to ancestor. */ }
    }
    const parent = dirname(current);
    if (parent === current) return process.cwd();
    current = parent;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = repositoryRoot();
  if (env === process.env) dotenv({ path: resolve(root, '.env') });
  const schema = z.object({
    GOOGLE_CLIENT_ID: z.string().default(''),
    GOOGLE_CLIENT_SECRET: z.string().default(''),
    GOOGLE_REDIRECT_URI: z.string().url().default('http://localhost:3001/auth/google/callback'),
    GOOGLE_PHOTOS_SCOPE: z.literal(PHOTOS_SCOPE).default(PHOTOS_SCOPE),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    SESSION_SECRET: z.string().min(32),
    MEDIA_STORAGE_PATH: z.string().min(1).default('./data/imports'),
    DATABASE_PATH:z.string().min(1).default('./data/studio.sqlite'),
    IMPORT_CONCURRENCY:z.coerce.number().int().min(1).max(32).default(4),
    IMPORT_BATCH_SIZE:z.coerce.number().int().min(1).max(100).default(100),
    IMPORT_MAX_ATTEMPTS:z.coerce.number().int().min(1).max(20).default(5),
    IMPORT_RETRY_BASE_MS:z.coerce.number().int().min(10).max(60000).default(1000),
    STORAGE_QUOTA_BYTES:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(20*1024**3),
    MIN_FREE_DISK_BYTES:z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(128*1024**2),
    MAX_IMAGE_BYTES:z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(100*1024**2),
    GEMINI_API_KEY:z.string().default(''),
    GEMINI_MODEL:z.string().regex(/^[a-zA-Z0-9._-]+$/).default('gemini-3.5-flash-lite'),
    GEMINI_TIMEOUT_MS:z.coerce.number().int().min(1000).max(300000).default(60000),
    GEMINI_MAX_OUTPUT_TOKENS:z.coerce.number().int().min(256).max(32768).default(12288),
    GEMINI_INPUT_PRICE_PER_MILLION:z.coerce.number().finite().nonnegative().max(1000).default(0.30),
    GEMINI_OUTPUT_PRICE_PER_MILLION:z.coerce.number().finite().nonnegative().max(1000).default(2.50),
    GEMINI_MAX_PROJECT_SPEND_USD:z.coerce.number().finite().positive().max(100000).default(10),
    ANALYSIS_CONCURRENCY:z.coerce.number().int().min(1).max(8).default(2),
    ANALYSIS_BATCH_SIZE:z.coerce.number().int().min(1).max(100).default(20),
    ANALYSIS_MAX_ATTEMPTS:z.coerce.number().int().min(1).max(20).default(5),
    ANALYSIS_RETRY_BASE_MS:z.coerce.number().int().min(10).max(60000).default(1000),
    ANALYSIS_PIPELINE_VERSION:z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/).default('photo-v1'),
    ANALYSIS_IMAGE_MAX_DIMENSION:z.coerce.number().int().min(256).max(2048).default(1024),
    ANALYSIS_NEAR_DUPLICATE_DISTANCE:z.coerce.number().int().min(0).max(16).default(5),
    VIDEO_PROVIDER:z.enum(['omni','veo']).default('omni'),
    OMNI_MODEL:z.enum(['gemini-omni-1.1-flash','gemini-omni-1.2-flash']).default('gemini-omni-1.1-flash'),
    VEO_MODEL:z.string().default('veo-3.1-fast-generate-001'),
    VIDEO_RESOLUTION:z.enum(['720p','1080p']).default('720p'),VIDEO_ASPECT_RATIO:z.enum(['16:9','9:16']).default('16:9'),
    VIDEO_DURATION_SECONDS:z.coerce.number().int().min(3).max(15).default(8),
    VIDEO_MAX_CONCURRENT_JOBS:z.coerce.number().int().min(1).max(4).default(1),
    VIDEO_MAX_PROJECT_BUDGET_USD:z.coerce.number().finite().positive().max(10000).default(10),
    VIDEO_MAX_AUTOMATIC_RETRIES:z.coerce.number().int().min(0).max(3).default(1),
    VIDEO_POLL_INTERVAL_MS:z.coerce.number().int().min(1000).max(60000).default(10000),
    VIDEO_REQUEST_TIMEOUT_MS:z.coerce.number().int().min(1000).max(300000).default(60000),
    VIDEO_MAX_BYTES:z.coerce.number().int().positive().max(1024**3).default(512*1024**2),
    VIDEO_KEYFRAME_MODEL:z.string().regex(/^[a-zA-Z0-9._-]+$/).default('gemini-3.1-flash-image'),
    VIDEO_QUALITY_MODEL:z.string().regex(/^[a-zA-Z0-9._-]+$/).default('gemini-3.5-flash-lite'),
    VIDEO_KEYFRAME_ESTIMATE_USD:z.coerce.number().finite().positive().max(10).default(0.25),
    VIDEO_QUALITY_ESTIMATE_USD:z.coerce.number().finite().positive().max(1).default(0.05),
    FFMPEG_PATH:z.string().default(''),FFPROBE_PATH:z.string().default(''),
    PRODUCTION_DEFAULT_BUDGET_USD:z.coerce.number().finite().positive().max(10000).default(20),
    PRODUCTION_POLL_INTERVAL_MS:z.coerce.number().int().min(50).max(10000).default(1000),
    PRODUCTION_MAX_STAGE_ATTEMPTS:z.coerce.number().int().min(1).max(3).default(2),
    MOVIE_THREADS:z.coerce.number().int().min(1).max(8).default(2),
    MOVIE_MEMORY_LIMIT_MB:z.coerce.number().int().min(256).max(8192).default(1024),
    MOVIE_MAX_WORKSPACE_BYTES:z.coerce.number().int().min(64*1024**2).max(32*1024**3).default(4*1024**3),
    MOVIE_MAX_OUTPUT_BYTES:z.coerce.number().int().min(1024**2).max(8*1024**3).default(1024**3),
    MOVIE_MAX_SOUNDTRACK_BYTES:z.coerce.number().int().min(1024).max(512*1024**2).default(100*1024**2),
    MOVIE_RENDER_TIMEOUT_MS:z.coerce.number().int().min(1000).max(12*60*60*1000).default(60*60*1000),
    MOVIE_DURATION_TOLERANCE_SECONDS:z.coerce.number().finite().min(0.05).max(1).default(0.15),
    MOVIE_FONT_SERIF_PATH:z.string().default(''),MOVIE_FONT_SANS_PATH:z.string().default(''),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  });
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}. See .env.example; SESSION_SECRET must contain at least 32 characters.`);
  }
  const e = parsed.data;
  const web = new URL(e.WEB_ORIGIN);
  const redirect = new URL(e.GOOGLE_REDIRECT_URI);
  if (web.origin !== e.WEB_ORIGIN || redirect.pathname !== '/auth/google/callback' || redirect.search || redirect.hash || redirect.username || redirect.password) {
    throw new Error('WEB_ORIGIN must be an origin and GOOGLE_REDIRECT_URI must end in /auth/google/callback without a query.');
  }
  if (e.NODE_ENV === 'production' && (web.protocol !== 'https:' || redirect.protocol !== 'https:')) {
    throw new Error('Production cookies require HTTPS origins.');
  }
  return {
    googleClientId: e.GOOGLE_CLIENT_ID, googleClientSecret: e.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: e.GOOGLE_REDIRECT_URI, googlePhotosScope: e.GOOGLE_PHOTOS_SCOPE,
    webOrigin: e.WEB_ORIGIN, apiPort: e.API_PORT, sessionSecret: e.SESSION_SECRET,
    mediaStoragePath: resolve(root, e.MEDIA_STORAGE_PATH), sessionStoragePath: resolve(root, 'data/.sessions'), nodeEnv: e.NODE_ENV,
    databasePath:resolve(root,e.DATABASE_PATH),importConcurrency:e.IMPORT_CONCURRENCY,importBatchSize:e.IMPORT_BATCH_SIZE,importMaxAttempts:e.IMPORT_MAX_ATTEMPTS,importRetryBaseMs:e.IMPORT_RETRY_BASE_MS,
    storageQuotaBytes:e.STORAGE_QUOTA_BYTES,minFreeDiskBytes:e.MIN_FREE_DISK_BYTES,maxImageBytes:e.MAX_IMAGE_BYTES,
    geminiApiKey:e.GEMINI_API_KEY,geminiModel:e.GEMINI_MODEL,geminiTimeoutMs:e.GEMINI_TIMEOUT_MS,geminiMaxOutputTokens:e.GEMINI_MAX_OUTPUT_TOKENS,
    geminiInputPricePerMillion:e.GEMINI_INPUT_PRICE_PER_MILLION,geminiOutputPricePerMillion:e.GEMINI_OUTPUT_PRICE_PER_MILLION,geminiMaxProjectSpendUsd:e.GEMINI_MAX_PROJECT_SPEND_USD,
    analysisConcurrency:e.ANALYSIS_CONCURRENCY,analysisBatchSize:e.ANALYSIS_BATCH_SIZE,analysisMaxAttempts:e.ANALYSIS_MAX_ATTEMPTS,analysisRetryBaseMs:e.ANALYSIS_RETRY_BASE_MS,
    analysisPipelineVersion:e.ANALYSIS_PIPELINE_VERSION,analysisImageMaxDimension:e.ANALYSIS_IMAGE_MAX_DIMENSION,analysisNearDuplicateDistance:e.ANALYSIS_NEAR_DUPLICATE_DISTANCE,
    videoProvider:e.VIDEO_PROVIDER,omniModel:e.OMNI_MODEL,veoModel:e.VEO_MODEL,videoResolution:e.VIDEO_RESOLUTION,videoAspectRatio:e.VIDEO_ASPECT_RATIO,videoDurationSeconds:e.VIDEO_DURATION_SECONDS,
    videoMaxConcurrentJobs:e.VIDEO_MAX_CONCURRENT_JOBS,videoMaxProjectBudgetUsd:e.VIDEO_MAX_PROJECT_BUDGET_USD,videoMaxAutomaticRetries:e.VIDEO_MAX_AUTOMATIC_RETRIES,
    videoPollIntervalMs:e.VIDEO_POLL_INTERVAL_MS,videoRequestTimeoutMs:e.VIDEO_REQUEST_TIMEOUT_MS,videoMaxBytes:e.VIDEO_MAX_BYTES,
    videoKeyframeModel:e.VIDEO_KEYFRAME_MODEL,videoQualityModel:e.VIDEO_QUALITY_MODEL,videoKeyframeEstimateUsd:e.VIDEO_KEYFRAME_ESTIMATE_USD,videoQualityEstimateUsd:e.VIDEO_QUALITY_ESTIMATE_USD,
    ffmpegPath:e.FFMPEG_PATH,ffprobePath:e.FFPROBE_PATH,
    productionDefaultBudgetUsd:e.PRODUCTION_DEFAULT_BUDGET_USD,productionPollIntervalMs:e.PRODUCTION_POLL_INTERVAL_MS,productionMaxStageAttempts:e.PRODUCTION_MAX_STAGE_ATTEMPTS,
    movieThreads:e.MOVIE_THREADS,movieMemoryLimitMb:e.MOVIE_MEMORY_LIMIT_MB,movieMaxWorkspaceBytes:e.MOVIE_MAX_WORKSPACE_BYTES,movieMaxOutputBytes:e.MOVIE_MAX_OUTPUT_BYTES,movieMaxSoundtrackBytes:e.MOVIE_MAX_SOUNDTRACK_BYTES,movieRenderTimeoutMs:e.MOVIE_RENDER_TIMEOUT_MS,movieDurationToleranceSeconds:e.MOVIE_DURATION_TOLERANCE_SECONDS,movieFontSerifPath:e.MOVIE_FONT_SERIF_PATH,movieFontSansPath:e.MOVIE_FONT_SANS_PATH,
  };
}
