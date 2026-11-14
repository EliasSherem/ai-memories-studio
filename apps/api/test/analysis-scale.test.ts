import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import type { Asset, JsonGenerator, JsonGenerationRequest } from '@memories/shared';
import { AnalysisQueue } from '../src/analysis-queue.js';
import { DirectorStore } from '../src/director-store.js';
import { loadConfig } from '../src/config.js';
import { MediaStore } from '../src/media-store.js';
import { ApiError } from '../src/errors.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const result = { schemaVersion: '1.0', sharpness: 80, exposure: 80, composition: 85, animationSuitability: 85, storytellingPotential: 90, suitability: 'ANIMATED_ORIGINAL', description: 'An outdoor scene.', sceneType: 'outdoors', visibleLocations: [], activities: [], objects: [], emotionalTone: 'warm', diversityTags: ['outdoor'], uncertaintyNotes: [] };
async function fixture(count: number, handler?: (request: JsonGenerationRequest, signal: AbortSignal, attempt: number) => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'director-scale-'));
  const config = loadConfig({ SESSION_SECRET: 'private-long-analysis-scale-session-secret', GEMINI_API_KEY: 'simulated-server-key', ANALYSIS_BATCH_SIZE: '7', ANALYSIS_RETRY_BASE_MS: '10', NODE_ENV: 'test' });
  const media = new MediaStore(root, { databasePath: join(root, 'studio.sqlite'), minFreeDiskBytes: 0 });
  const store = new DirectorStore(media, config);
  const owner = randomUUID(); await store.ensure(owner);
  const jpeg = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#72b4a4' } }).jpeg().toBuffer();
  const assets: Asset[] = [];
  for (let index = 0; index < count; index++) {
    const id = randomUUID(), bytes = Buffer.concat([jpeg, Buffer.from(`original-metadata-${index}`)]), sha256 = createHash('sha256').update(bytes).digest('hex');
    const asset: Asset = { id, projectId: owner, contributorId: 'person1', filename: `photo-${index}.jpg`, mimeType: 'image/jpeg', bytes: bytes.length, importedAt: new Date().toISOString(), selected: true, sha256, url: `/api/projects/${owner}/assets/${id}/content` };
    await writeFile(join(root, owner, `${id}.jpg`), bytes);
    store.db.connection.prepare('INSERT INTO assets(id,project_id,sha256,storage_name,bytes,selected,public_json) VALUES(?,?,?,?,?,1,?)').run(id, owner, sha256, `${id}.jpg`, bytes.length, JSON.stringify({ ...asset, storageName: `${id}.jpg` }));
    store.db.connection.prepare('INSERT INTO media_sources(id,asset_id,project_id,contributor_id,google_media_id,original_metadata_json) VALUES(?,?,?,?,?,?)').run(randomUUID(), id, owner, 'person1', `google-${index}`, JSON.stringify({ id: `google-${index}`, createTime: '2020-01-01T00:00:00Z', originalCamera: `camera-${index}` }));
    assets.push(asset);
  }
  let active = 0, peak = 0, calls = 0;
  const generateJson = vi.fn(async (request: JsonGenerationRequest, signal: AbortSignal) => {
    calls++; active++; peak = Math.max(peak, active);
    try {
      const json = handler ? await handler(request, signal, calls) : (await delay(1), result);
      return { json, usage: { inputTokens: 100, outputTokens: 50 } };
    } finally { active--; }
  });
  const generator: JsonGenerator = { generateJson };
  const queues: AnalysisQueue[] = [];
  function queue() { const value = new AnalysisQueue(generator, store, config); queues.push(value); return value; }
  const worker = queue();
  cleanups.push(async () => { await Promise.all(queues.map(queue => queue.dispose())); media.db.close(); await rm(root, { recursive: true, force: true }); });
  return { worker, queue, store, media, owner, config, assets, generateJson, get calls() { return calls; }, get peak() { return peak; } };
}
async function until(check: () => boolean, maximum = 5000) {
  const deadline = Date.now() + maximum;
  while (!check()) { if (Date.now() > deadline) throw new Error('Analysis checkpoint timed out'); await delay(5); }
}
describe('persistent bounded photo analysis', () => {
  it.each([100, 500, 1000])('analyzes %i simulated local photos in bounded batches without repeating completed work', async count => {
    const f = await fixture(count); const run = await f.worker.start(f.owner); await f.worker.drain();
    expect(f.worker.latest(f.owner)).toMatchObject({ id: run.id, status: 'complete', total: count, completed: count, pending: 0, active: 0, failed: 0 });
    expect(f.calls).toBe(count); expect(f.peak).toBeLessThanOrEqual(2); expect(f.peak).toBe(2);
    expect(f.store.db.connection.prepare('SELECT COUNT(*) AS count FROM p3_local_features WHERE project_id=? AND duplicate_of IS NOT NULL').get(f.owner)).toMatchObject({ count: count - 1 });
    const original = f.store.db.connection.prepare('SELECT original_metadata_json FROM media_sources WHERE asset_id=?').get(f.assets[0].id) as { original_metadata_json: string };
    expect(original.original_metadata_json).toContain('camera-0');
    expect(f.store.db.connection.prepare('SELECT features_json FROM p3_local_features WHERE asset_id=?').get(f.assets[0].id)).toMatchObject({ features_json: expect.stringContaining('GOOGLE_METADATA') });
    await f.worker.start(f.owner); await f.worker.drain(); expect(f.calls).toBe(count);
    expect(f.worker.latest(randomUUID())).toBeUndefined();
  }, 45000);
  it('retries transient errors with Retry-After and preserves durable attempt counts', async () => {
    const times: number[] = [];
    const f = await fixture(1, async () => { times.push(Date.now()); if (times.length === 1) throw new ApiError(429, 'GEMINI_RATE_LIMIT', 'Rate limited.', 60); return result; });
    await f.worker.start(f.owner); await f.worker.drain();
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(60);
    expect(f.worker.latest(f.owner)).toMatchObject({ completed: 1, failed: 0 });
    expect(f.store.db.connection.prepare('SELECT attempts FROM p3_analysis_items').get()).toMatchObject({ attempts: 2 });
  });
  it('persists a global model cooldown so new photos wait for Retry-After', async () => {
    const times: number[] = [];
    const f = await fixture(3, async () => { times.push(Date.now()); if (times.length === 1) throw new ApiError(429, 'GEMINI_RATE_LIMIT', 'Rate limited.', 150); return result; });
    f.config.analysisConcurrency = 1;
    await f.worker.start(f.owner); await until(() => !!f.store.db.connection.prepare('SELECT 1 FROM p3_rate_limits').get());
    const cooldown = f.store.db.connection.prepare('SELECT until_at FROM p3_rate_limits WHERE model=?').get(f.config.geminiModel!) as { until_at: number };
    expect(cooldown.until_at).toBeGreaterThanOrEqual(times[0] + 150);
    await f.worker.dispose();
    // The next worker must observe SQLite's cooldown before making new calls.
    const next = f.queue(); await delay(30); expect(times).toHaveLength(1);
    await next.drain();
    expect(times.slice(1).every(time => time >= cooldown.until_at)).toBe(true);
    expect(times).toHaveLength(4); expect(next.latest(f.owner)).toMatchObject({ status: 'complete', total: 3, completed: 3, failed: 0 });
  });
  it('bounds invalid JSON retries and allows explicit retry of only failed items', async () => {
    let malformed = true;
    const f = await fixture(2, async () => malformed ? { invalid: true } : result);
    const run = await f.worker.start(f.owner); await f.worker.drain();
    expect(f.worker.latest(f.owner)).toMatchObject({ completed: 0, failed: 2 }); expect(f.calls).toBe(4);
    malformed = false; f.worker.retryFailed(f.owner, run.id); await f.worker.drain();
    expect(f.worker.latest(f.owner)).toMatchObject({ completed: 2, failed: 0 }); expect(f.calls).toBe(6);
  });
  it('pauses at the project budget without discarding photo checkpoints', async () => {
    let budget = true;
    const f = await fixture(3, async () => { if (budget) throw new ApiError(402, 'PROJECT_BUDGET_EXCEEDED', 'Project spending limit reached.'); return result; });
    const run = await f.worker.start(f.owner); await f.worker.drain();
    expect(f.worker.latest(f.owner)).toMatchObject({ status: 'paused', completed: 0, pending: 3, failed: 0 });
    budget = false; f.worker.resume(f.owner, run.id); await f.worker.drain(); expect(f.worker.latest(f.owner)).toMatchObject({ status: 'complete', completed: 3 });
  });
  it('cancels in-flight work, rejects other owners, and resumes checkpoints after worker restart', async () => {
    let block = true;
    const f = await fixture(8, async (_request, signal) => {
      if (block) await new Promise<void>((_resolve, reject) => { signal.addEventListener('abort', () => reject(new ApiError(409, 'ANALYSIS_CANCELLED', 'Cancelled.')), { once: true }); });
      return result;
    });
    const run = await f.worker.start(f.owner); await until(() => f.calls >= 2);
    expect(() => f.worker.cancel(randomUUID(), run.id)).toThrow('not found');
    f.worker.cancel(f.owner, run.id); await f.worker.drain();
    expect(f.worker.latest(f.owner)).toMatchObject({ status: 'cancelled', completed: 0, pending: 8 });
    await f.worker.dispose(); block = false;
    const next = f.queue(); next.resume(f.owner, run.id); await next.drain();
    expect(next.latest(f.owner)).toMatchObject({ status: 'complete', completed: 8 });
    expect(f.calls).toBe(10);
  });
  it('automatically recovers a stopped running job, without reprocessing completed photos or a second coordinator', async () => {
    let block = false;
    const f = await fixture(6, async (_request, signal, attempt) => {
      if (attempt > 2 && block) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ApiError(409, 'ANALYSIS_CANCELLED', 'Cancelled.')), { once: true }));
      else await delay(5);
      return result;
    });
    block = true; const run = await f.worker.start(f.owner);
    await until(() => (f.worker.latest(f.owner)?.completed ?? 0) >= 2 && f.calls >= 4);
    await f.worker.dispose(); block = false;
    const completedBefore = (f.store.db.connection.prepare("SELECT COUNT(*) AS count FROM p3_analysis_items WHERE status='complete'").get() as { count: number }).count;
    const one = f.queue(), two = f.queue(); await Promise.all([one.drain(), two.drain()]);
    expect(one.latest(f.owner)).toMatchObject({ id: run.id, completed: 6, status: 'complete' });
    expect(completedBefore).toBe(2); expect(f.calls).toBe(8); expect(f.peak).toBeLessThanOrEqual(2);
  });
  it('fences a late response from a cancelled attempt after the same worker resumes its item', async () => {
    let release: (value: unknown) => void = () => {};
    const f = await fixture(1, async (_request, _signal, attempt) => attempt === 1 ? await new Promise(resolve => { release = resolve; }) : { ...result, description: 'The resumed attempt.' });
    const run = await f.worker.start(f.owner); await until(() => f.calls === 1);
    f.worker.cancel(f.owner, run.id); f.worker.resume(f.owner, run.id);
    await until(() => f.worker.latest(f.owner)?.completed === 1);
    release({ ...result, description: 'A stale cancelled response.' }); await f.worker.drain();
    expect(f.store.rows(f.owner)[0].analysis?.description).toBe('The resumed attempt.');
    expect(f.calls).toBe(2);
  });
  it('supersedes an interrupted run after model/pipeline configuration changes', async () => {
    const f = await fixture(1); await f.worker.start(f.owner); await f.worker.drain();
    const old = await f.worker.start(f.owner, true); await f.worker.dispose();
    f.config.analysisPipelineVersion = 'photo-v2';
    const next = f.queue();
    expect(next.latest(f.owner)).toMatchObject({ id: old.id, status: 'paused', message: expect.stringContaining('pipeline changed') });
    expect(() => next.retryFailed(f.owner, old.id)).toThrow('different model or pipeline');
    const current = await next.start(f.owner); expect(current.id).not.toBe(old.id); await next.drain();
    expect(next.latest(f.owner)).toMatchObject({ status: 'complete', completed: 1 }); expect(f.calls).toBe(2);
    expect(f.store.db.connection.prepare('SELECT pipeline_version FROM p3_photo_analysis').get()).toMatchObject({ pipeline_version: 'photo-v2' });
  });
  it('recovers its own expired coordinator lease without stranding a fenced item', async () => {
    let release: (value: unknown) => void = () => {};
    const f = await fixture(1, async (_request, _signal, attempt) => attempt === 1 ? await new Promise(resolve => { release = resolve; }) : result);
    await f.worker.start(f.owner); await until(() => f.calls === 1);
    f.store.db.connection.prepare('UPDATE p3_worker_lease SET expires_at=0').run();
    release(result); await delay(5); await f.worker.drain();
    expect(f.worker.latest(f.owner)).toMatchObject({ completed: 1, active: 0, pending: 0 }); expect(f.calls).toBe(2);
  });
  it('resumes a paused orphaned claim while its own coordinator lease remains valid', async () => {
    const f = await fixture(1, async (_request, signal, attempt) => {
      if (attempt === 1) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new ApiError(409, 'ANALYSIS_CANCELLED', 'Cancelled.')), { once: true }));
      return result;
    });
    const run = await f.worker.start(f.owner); await until(() => f.calls === 1);
    const coordinator = f.store.db.connection.prepare('SELECT owner FROM p3_worker_lease').get() as { owner: string };
    f.worker.cancel(f.owner, run.id); await f.worker.drain();
    f.store.db.connection.prepare('INSERT INTO p3_worker_lease(id,owner,expires_at) VALUES(1,?,?)').run(coordinator.owner, Date.now() + 60_000);
    f.store.db.connection.prepare("UPDATE p3_analysis_runs SET status='paused' WHERE id=?").run(run.id);
    f.store.db.connection.prepare("UPDATE p3_analysis_items SET status='running',lease_owner=?,lease_until=? WHERE run_id=?").run(`${coordinator.owner}:orphan`, Date.now() + 60_000, run.id);
    f.worker.resume(f.owner, run.id); await f.worker.drain();
    expect(f.worker.latest(f.owner)).toMatchObject({ status: 'complete', completed: 1, active: 0, pending: 0 }); expect(f.calls).toBe(2);
  });
});
