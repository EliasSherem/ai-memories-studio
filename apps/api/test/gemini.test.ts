import { describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import type { JsonGenerationRequest } from '@memories/shared';
import { storyboardContentSchema } from '@memories/shared';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { GeminiClient, safeGeminiError, type GeminiSdk } from '../src/gemini.js';
import { loadConfig } from '../src/config.js';
import type { DirectorStore } from '../src/director-store.js';
import { ApiError } from '../src/errors.js';

const analysis = { schemaVersion: '1.0', sharpness: 85, exposure: 80, composition: 90, animationSuitability: 80, storytellingPotential: 90, suitability: 'ANIMATED_ORIGINAL', description: 'Two people outdoors in a garden.', sceneType: 'outdoor', visibleLocations: ['garden'], activities: ['walking'], objects: ['trees'], emotionalTone: 'warm', diversityTags: ['outdoor'], uncertaintyNotes: [] };
function fixture(overrides: { response?: unknown; error?: unknown; usage?: boolean; configured?: boolean; budget?: boolean } = {}) {
  const config = loadConfig({ SESSION_SECRET: 'a-private-long-test-session-secret-for-gemini', GEMINI_API_KEY: overrides.configured === false ? '' : 'private-test-key', NODE_ENV: 'test' });
  const reserveUsage = vi.fn(() => { if (overrides.budget) throw new ApiError(402, 'PROJECT_BUDGET_EXCEEDED', 'Budget exhausted.'); return { id: 'reservation', reservedUsd: 0.1 }; });
  const settleUsage = vi.fn();
  const response = { candidates: [{ content: { parts: [{ text: typeof overrides.response === 'string' ? overrides.response : JSON.stringify(overrides.response ?? analysis) }] } }], ...(overrides.usage === false ? {} : { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 45, thoughtsTokenCount: 15 } }) } as GenerateContentResponse;
  const sdk = { models: { get: vi.fn(async () => ({ name: config.geminiModel })), countTokens: vi.fn(async () => ({ totalTokens: 150 })), generateContent: vi.fn(async () => { if (overrides.error) throw overrides.error; return response; }) } } as unknown as GeminiSdk;
  const store = { reserveUsage, settleUsage } as unknown as DirectorStore;
  return { client: new GeminiClient(config, store, overrides.configured === false ? {} : { sdk }), sdk, reserveUsage, settleUsage };
}
const request: JsonGenerationRequest = { projectId: 'project', operation: 'photo_analysis', prompt: 'Inspect this image safely.', schema: { type: 'object' }, images: [{ data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }], maxOutputTokens: 2048 };
describe('server-only Gemini SDK boundary', () => {
  it('sends a compact storyboard grammar while retaining strict validation of the generated result', async () => {
    const board={schemaVersion:'1.0',title:'A cinematic story',synopsis:'A synthetic story.',targetDurationSeconds:150,scenes:Array.from({length:6},(_,index)=>({id:randomUUID(),sequenceNumber:index+1,type:index<3?'ORIGINAL_ANIMATION':'NEW_CINEMATIC_SCENE',title:index<3?'Original moment':'Fictional moment',description:'A synthetic scene.',durationSeconds:25,sourcePhotoIds:[randomUUID()],protagonistIds:['person1','person2'],visualStyle:'Warm light',cameraDirection:'Slow push',motionPrompt:'Gentle movement',emotionalTone:'Warm',continuityNotes:'Thematic placement.',generationInstructions:'Use confirmed references.',isFictional:index>=3,requiresUserConfirmation:index>=3,userConfirmed:false}))};
    const schema=z.toJSONSchema(storyboardContentSchema);
    const original=structuredClone(schema);
    const f=fixture({response:board});
    const response=await f.client.generateJson({...request,operation:'storyboard',schema,maxOutputTokens:12000},new AbortController().signal);
    const wire=vi.mocked(f.sdk.models.generateContent).mock.calls[0][0].config!.responseJsonSchema as typeof schema;
    expect(JSON.stringify(wire)).not.toMatch(/"(?:maxItems|minItems|minimum|maximum|pattern|format)":/);
    expect(wire.properties?.scenes).toMatchObject({type:'array',items:{type:'object',required:expect.arrayContaining(['sourcePhotoIds','durationSeconds','requiresUserConfirmation'])}});
    expect(schema).toEqual(original);
    expect(storyboardContentSchema.safeParse(response.json).success).toBe(true);
    expect(storyboardContentSchema.safeParse({...board,targetDurationSeconds:30}).success).toBe(false);
    expect(f.reserveUsage).toHaveBeenCalledWith('project','storyboard',expect.any(String),214,12000);
  });
  it('reports storyboard HTTP 400 as a request-format failure without blaming photo authorization or exposing SDK contents', async () => {
    const f=fixture({error:{status:400,message:'Private image and API key in a raw SDK failure'}});
    await expect(f.client.generateJson({...request,operation:'storyboard'},new AbortController().signal)).rejects.toMatchObject({code:'GEMINI_INVALID_REQUEST',message:expect.stringContaining('storyboard request (HTTP 400)')});
    const safe=safeGeminiError({status:400,message:'private content'},'storyboard');
    expect(safe.message).not.toMatch(/private content|API key|analysis request/);
    expect(f.settleUsage).toHaveBeenCalledWith('reservation',{inputTokens:0,outputTokens:0},'failed');
  });
  it('checks the model, counts actual image input, reserves cost, and records visible plus thought output', async () => {
    const f = fixture();
    const result = await f.client.generateJson(request, new AbortController().signal);
    expect(result.json).toEqual(analysis); expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 60 });
    expect(f.reserveUsage).toHaveBeenCalledWith('project', 'photo_analysis', expect.any(String), 214, 2048);
    expect(f.settleUsage).toHaveBeenCalledWith('reservation', { inputTokens: 100, outputTokens: 60 }, 'succeeded');
    expect(f.sdk.models.countTokens).toHaveBeenCalledWith(expect.objectContaining({ contents: [expect.objectContaining({ parts: expect.arrayContaining([expect.objectContaining({ inlineData: { data: 'AQID', mimeType: 'image/jpeg' } })]) })] }));
    expect(f.sdk.models.generateContent).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ responseMimeType: 'application/json', responseJsonSchema: request.schema, maxOutputTokens: 2048, automaticContinuation: false, candidateCount: 1, httpOptions: expect.objectContaining({ retryOptions: { attempts: 1 } }) }) }));
    await f.client.checkModel(); expect(f.sdk.models.get).toHaveBeenCalledTimes(1);
  });
  it('records billed usage even when the model returns malformed JSON or invalid analysis', async () => {
    for (const response of ['not JSON', { ...analysis, sharpness: 500 }]) {
      const f = fixture({ response });
      await expect(f.client.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_GEMINI_JSON' });
      expect(f.settleUsage).toHaveBeenCalledWith('reservation', { inputTokens: 100, outputTokens: 60 }, 'succeeded');
    }
  });
  it('retains a full conservative reservation for missing usage and ambiguous network failures', async () => {
    const f = fixture({ usage: false }); await f.client.generateJson(request, new AbortController().signal);
    expect(f.settleUsage).toHaveBeenCalledWith('reservation', { inputTokens: 214, outputTokens: 2048 }, 'unknown');
    const g = fixture({ error: new Error('private API key and image in an SDK error') });
    await expect(g.client.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ code: 'GEMINI_NETWORK' });
    expect(g.settleUsage).toHaveBeenCalledWith('reservation', { inputTokens: 0, outputTokens: 0 }, 'unknown');
  });
  it('releases known rejected calls, respects Retry-After, and never exposes raw SDK diagnostics', async () => {
    const f = fixture({ error: { status: 429, message: 'private key', headers: new Headers({ 'retry-after': '3' }) } });
    await expect(f.client.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ code: 'GEMINI_RATE_LIMIT', retryAfterMs: 3000 });
    expect(f.settleUsage).toHaveBeenCalledWith('reservation', { inputTokens: 0, outputTokens: 0 }, 'failed');
    expect(safeGeminiError({ status: 403, message: 'private token' }).message).not.toContain('private token');
    expect(safeGeminiError({ status: 404 }).code).toBe('GEMINI_MODEL_UNAVAILABLE');
    expect(safeGeminiError({ status: 429, message: JSON.stringify({ error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2.5s' }] } }) })).toMatchObject({ retryAfterMs: 2500 });
  });
  it('reports model-availability failure before counting, reserving, or making a paid request', async () => {
    const f = fixture(); vi.mocked(f.sdk.models.get).mockRejectedValue({ status: 404, message: 'Private request-bearing SDK diagnostic' });
    await expect(f.client.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ code: 'GEMINI_MODEL_UNAVAILABLE' });
    expect(f.sdk.models.countTokens).not.toHaveBeenCalled(); expect(f.reserveUsage).not.toHaveBeenCalled(); expect(f.sdk.models.generateContent).not.toHaveBeenCalled();
  });
  it('does not make a paid request without a configured key, a budget reservation, or after cancellation', async () => {
    await expect(fixture({ configured: false }).client.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ code: 'GEMINI_NOT_CONFIGURED' });
    const f = fixture({ budget: true }); await expect(f.client.generateJson(request, new AbortController().signal)).rejects.toMatchObject({ code: 'PROJECT_BUDGET_EXCEEDED' }); expect(f.sdk.models.generateContent).not.toHaveBeenCalled();
    const g = fixture(); const controller = new AbortController(); controller.abort(); await expect(g.client.generateJson(request, controller.signal)).rejects.toMatchObject({ code: 'ANALYSIS_CANCELLED' }); expect(g.sdk.models.generateContent).not.toHaveBeenCalled();
  });
});
