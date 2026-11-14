import { GoogleGenAI, type Content, type GenerateContentParameters } from '@google/genai';
import { photoAnalysisSchema, type GeminiUsage, type JsonGenerator, type JsonGenerationRequest } from '@memories/shared';
import type { Config } from './config.js';
import type { DirectorStore } from './director-store.js';
import { ApiError } from './errors.js';
import { simplifyGeminiSchema } from './gemini-schema.js';

export type GeminiSdk = { models: Pick<GoogleGenAI['models'], 'get' | 'countTokens' | 'generateContent'> };
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Deliberately translates errors without copying the SDK's request-bearing message. */
export function safeGeminiError(error: unknown, operation?:JsonGenerationRequest['operation']): ApiError {
  if (error instanceof ApiError) return error;
  const e = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const status = Number(e.status ?? e.code);
  const headers = e.headers as { get?: (name: string) => string | null } | undefined;
  const retry = headers?.get?.('retry-after');
  let retryAfterMs = retry && Number.isFinite(Number(retry)) ? Math.max(0, Number(retry) * 1000) : retry && Number.isFinite(Date.parse(retry)) ? Math.max(0, Date.parse(retry) - Date.now()) : undefined;
  // js-genai's ApiError exposes status/message, but not always HTTP headers.
  // Read only the typed RetryInfo delay from a bounded JSON error envelope.
  if (retryAfterMs === undefined && typeof e.message === 'string' && e.message.length <= 32_768) {
    try {
      const body = JSON.parse(e.message) as { error?: { details?: unknown[] } };
      for (const detail of body.error?.details ?? []) {
        if (!detail || typeof detail !== 'object') continue;
        const record = detail as Record<string, unknown>;
        if (record['@type'] === 'type.googleapis.com/google.rpc.RetryInfo' && typeof record.retryDelay === 'string' && /^\d+(\.\d+)?s$/.test(record.retryDelay)) retryAfterMs = Math.ceil(Number(record.retryDelay.slice(0, -1)) * 1000);
      }
    } catch { /* A plain SDK message is intentionally ignored. */ }
  }
  if (status === 401 || status === 403) return new ApiError(status, 'GEMINI_AUTHORIZATION', 'Gemini rejected the server API key or its permissions. Check GEMINI_API_KEY and Gemini API billing/access; reconnecting Google Photos does not change this key.');
  if (status === 404) return new ApiError(400, 'GEMINI_MODEL_UNAVAILABLE', 'The configured Gemini model is unavailable for this API key. Check GEMINI_MODEL against Google’s supported models.');
  if (status === 429) return new ApiError(429, 'GEMINI_RATE_LIMIT', 'Gemini is rate limited or its quota is exhausted. Analysis will retry with backoff; check the Gemini project quota and billing if this continues.', retryAfterMs);
  if (status === 400) return new ApiError(400, 'GEMINI_INVALID_REQUEST', `Gemini rejected the ${operation==='storyboard'?'storyboard':operation==='photo_analysis'?'photo analysis':'generation'} request (HTTP 400). The request format or settings were not accepted. Your imported photos and saved analyses are unchanged.`);
  if (status >= 500 || status === 408) return new ApiError(503, 'GEMINI_UNAVAILABLE', 'Gemini is temporarily unavailable. Analysis will retry with backoff.', retryAfterMs);
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return new ApiError(503, 'GEMINI_INTERRUPTED', 'The Gemini request was interrupted or timed out. Its reserved cost is retained because Google may still process it.');
  return new ApiError(503, 'GEMINI_NETWORK', 'Gemini could not be reached. Analysis will retry with backoff.');
}

/** Server-only SDK boundary. No OAuth tokens, remote media URLs, tools, or SDK retries. */
export class GeminiClient implements JsonGenerator {
  private sdk?: GeminiSdk;
  private modelCheck?: Promise<void>;
  readonly model: string;
  constructor(private readonly config: Config, private readonly store: DirectorStore, options: { sdk?: GeminiSdk } = {}) {
    this.model = config.geminiModel ?? 'gemini-3.5-flash-lite';
    this.sdk = options.sdk ?? (config.geminiApiKey ? new GoogleGenAI({ apiKey: config.geminiApiKey, vertexai: false, httpOptions: { timeout: config.geminiTimeoutMs ?? 60_000, retryOptions: { attempts: 1 } } }) : undefined);
  }
  private client(): GeminiSdk {
    if (!this.sdk) throw new ApiError(503, 'GEMINI_NOT_CONFIGURED', 'Set GEMINI_API_KEY in the server environment to enable AI analysis.');
    return this.sdk;
  }
  async checkModel(): Promise<void> {
    const sdk = this.client();
    if (!this.modelCheck) {
      this.modelCheck = sdk.models.get({ model: this.model, config: { httpOptions: { timeout: this.config.geminiTimeoutMs ?? 60_000, retryOptions: { attempts: 1 } } } }).then(() => undefined).catch(error => { this.modelCheck = undefined; throw safeGeminiError(error); });
    }
    await this.modelCheck;
  }
  async generateJson(request: JsonGenerationRequest, signal: AbortSignal): Promise<{ json: unknown; usage: GeminiUsage }> {
    const sdk = this.client();
    if (signal.aborted) throw new ApiError(409, 'ANALYSIS_CANCELLED', 'Analysis was cancelled.');
    try{await this.checkModel();}catch(error){const safe=safeGeminiError(error,request.operation);if(request.productionRunId&&['GEMINI_NETWORK','GEMINI_INTERRUPTED','GEMINI_UNAVAILABLE'].includes(safe.code))throw new ApiError(safe.status,'PRODUCTION_MODEL_PREFLIGHT_FAILED','The free model-availability check failed. No paid request was sent; resume after checking the connection.',safe.retryAfterMs);throw safe;}
    const combined = AbortSignal.any([signal, AbortSignal.timeout(this.config.geminiTimeoutMs ?? 60_000)]);
    if ((request.images?.length ?? 0) > 20 || (request.images ?? []).reduce((sum, image) => sum + image.data.byteLength, 0) > 8 * 1024 * 1024) throw new ApiError(400, 'INVALID_ANALYSIS_IMAGE', 'A single analysis request must use at most 20 local previews and 8 MiB of image data.');
    const parts: NonNullable<Content['parts']> = [{ text: request.prompt }];
    for (const image of request.images ?? []) {
      if (image.data.byteLength > 8 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp'].includes(image.mimeType)) throw new ApiError(400, 'INVALID_ANALYSIS_IMAGE', 'Analysis requires a bounded local image preview.');
      parts.push({ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.data).toString('base64') } });
    }
    const contents: Content[] = [{ role: 'user', parts }];
    // Large nested array bounds/UUID patterns can exceed Gemini's grammar limit.
    // Full Zod and ownership/consent validation still run before saving a board.
    const schema=request.operation==='storyboard'?simplifyGeminiSchema(request.schema):request.schema;
    const httpOptions = { timeout: this.config.geminiTimeoutMs ?? 60_000, retryOptions: { attempts: 1 } };
    let inputTokens: number;
    try{request.beforePaidDispatch?.();}catch(error){throw new ApiError(409,'PRODUCTION_DISPATCH_BLOCKED',error instanceof ApiError?error.message:'Automatic production was blocked before preparing its next paid request.');}
    try {
      // Count image + prompt + schema before reserving. The schema is input too;
      // countTokens has no Developer API generationConfig support, so count its text.
      const counted = await sdk.models.countTokens({ model: this.model, contents: [{ role: 'user', parts: [...parts, { text: JSON.stringify(schema) }] }], config: { abortSignal: combined, httpOptions } });
      const tokens = integer(counted.totalTokens);
      if (tokens === undefined) throw new ApiError(502, 'GEMINI_TOKEN_COUNT', 'Gemini did not return a valid token count. No paid request was sent.');
      inputTokens = tokens + 64; // Conservative envelope/token-boundary allowance.
    } catch (error) { const safe=safeGeminiError(error,request.operation);if(request.productionRunId&&['GEMINI_NETWORK','GEMINI_INTERRUPTED','GEMINI_UNAVAILABLE'].includes(safe.code))throw new ApiError(safe.status,'PRODUCTION_TOKEN_PREFLIGHT_FAILED','The free input-token check failed. No paid request was sent; resume after checking the connection.',safe.retryAfterMs);throw safe; }
    if (combined.aborted) throw new ApiError(409, request.productionRunId?'PRODUCTION_PAUSED':'ANALYSIS_CANCELLED', 'Analysis was cancelled before a paid request was sent.');
    if(request.maximumInputTokens!==undefined&&(!Number.isSafeInteger(request.maximumInputTokens)||request.maximumInputTokens<1||inputTokens>request.maximumInputTokens))throw new ApiError(402,'PRODUCTION_INPUT_LIMIT','This request exceeds the input-token ceiling approved for automatic production. No paid request was sent.');
    const maxOutputTokens = Math.min(request.maxOutputTokens ?? (request.operation === 'photo_analysis' ? 2048 : 8192), this.config.geminiMaxOutputTokens ?? 8192);
    const reservation = request.productionBudgetAuthorized===true&&request.productionRunId?await this.store.reserveUsage(request.projectId, request.operation, this.model, inputTokens, maxOutputTokens,request.productionRunId):await this.store.reserveUsage(request.projectId, request.operation, this.model, inputTokens, maxOutputTokens);
    let settled = false,submitted=false;
    try {
      const params: GenerateContentParameters = { model: this.model, contents, config: { responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens, candidateCount: 1, automaticContinuation: false, temperature: 0.2, abortSignal: combined, httpOptions } };
      try{request.beforePaidDispatch?.();}catch(error){throw new ApiError(409,'PRODUCTION_DISPATCH_BLOCKED',error instanceof ApiError?error.message:'Automatic production was blocked before its next paid request.');}
      if(combined.aborted)throw new ApiError(409,'PRODUCTION_PAUSED','Automatic production was paused before its next paid request.');
      submitted=true;
      const response = await sdk.models.generateContent(params);
      const metadata = response.usageMetadata;
      const measuredInput = integer(metadata?.promptTokenCount);
      const candidateTokens = integer(metadata?.candidatesTokenCount);
      const thoughtTokens = integer(metadata?.thoughtsTokenCount) ?? 0;
      const usage = { inputTokens: measuredInput ?? inputTokens, outputTokens: candidateTokens === undefined ? maxOutputTokens : candidateTokens + thoughtTokens };
      // Even malformed JSON is billable. Missing usage retains the full ceiling.
      await this.store.settleUsage(reservation.id, usage, measuredInput !== undefined && candidateTokens !== undefined ? 'succeeded' : 'unknown');
      settled = true;
      const text = response.candidates?.[0]?.content?.parts?.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('') ?? '';
      if (!text || text.length > 2 * 1024 * 1024) throw new ApiError(502, 'INVALID_GEMINI_JSON', 'Gemini returned an empty, blocked, or oversized structured response. Analysis can be retried.');
      let json: unknown;
      try { json = JSON.parse(text); } catch { throw new ApiError(502, 'INVALID_GEMINI_JSON', 'Gemini returned invalid JSON. Analysis can be retried.'); }
      if (request.operation === 'photo_analysis') {
        const parsed = photoAnalysisSchema.safeParse(json);
        if (!parsed.success) throw new ApiError(502, 'INVALID_GEMINI_JSON', 'Gemini returned photo analysis that does not match the required schema.');
        json = parsed.data;
      }
      return { json, usage };
    } catch (error) {
      if (!settled) {
        const raw = error && typeof error === 'object' ? error as Record<string, unknown> : {};
        const status = Number(raw.status ?? raw.code);
        const definitelyRejected = !submitted||[400, 401, 403, 404, 429].includes(status);
        await this.store.settleUsage(reservation.id, { inputTokens: 0, outputTokens: 0 }, definitelyRejected ? 'failed' : 'unknown');
      }
      throw safeGeminiError(error,request.operation);
    }
  }
}
