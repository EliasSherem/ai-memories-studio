import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { PickerState, ProjectState, SessionInfo } from '@memories/shared';
import { createApp } from '../src/app.js';
import { loadConfig, PHOTOS_SCOPE } from '../src/config.js';
import { GoogleClient } from '../src/google.js';
import { EncryptedSessionStore } from '../src/session-store.js';

const API = 'https://photospicker.googleapis.com/v1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=', 'base64');
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
function photo(index: number) {
  return {
    id: `photo-${index}`, type: 'PHOTO', createTime: '2024-05-06T12:00:00Z',
    mediaFile: {
      baseUrl: `https://lh3.googleusercontent.com/p/photo-${index}`,
      mimeType: 'image/png', filename: `photo-${index}.png`,
      mediaFileMetadata: { width: 1, height: 1, cameraModel: `Original camera ${index}`, photoMetadata: { isoEquivalent: 100 + index } },
    },
  };
}
type FixtureOptions = {
  count: number;
  latencyMs?: number;
  duplicateBytes?: boolean;
  retryStatuses?: number[];
  retryBaseMs?: number;
  maxAttempts?: number;
  expireFirstMediaUrls?: boolean;
};

async function fixture(options: FixtureOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'memories-scale-'));
  const config = loadConfig({
    SESSION_SECRET: 'a-long-private-test-secret-only-for-scale-integration',
    GOOGLE_CLIENT_ID: 'simulated-scale-client', GOOGLE_CLIENT_SECRET: 'simulated-scale-secret',
    MEDIA_STORAGE_PATH: join(directory, 'imports'), DATABASE_PATH: join(directory, 'studio.sqlite'),
    IMPORT_BATCH_SIZE: '100', IMPORT_MAX_ATTEMPTS: String(options.maxAttempts ?? 5),
    IMPORT_RETRY_BASE_MS: String(options.retryBaseMs ?? 10),
    STORAGE_QUOTA_BYTES: String(1024 * 1024 * 1024), MIN_FREE_DISK_BYTES: '0', NODE_ENV: 'test',
  });
  // Session files must be isolated too, because a restarted worker restores them.
  config.sessionStoragePath = join(directory, 'sessions');
  const items = Array.from({ length: options.count }, (_, index) => photo(index));
  const downloads = new Map<string, number>();
  const attemptTimes: number[] = [];
  let active = 0;
  let peak = 0;
  let pickerNumber = 0;
  let listingRound = 0;
  let expired = false;
  let revoke = false;
  const failures = [...(options.retryStatuses ?? [])];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url === 'https://oauth2.googleapis.com/token') {
      if (revoke && new URLSearchParams(String(init?.body)).get('grant_type') === 'refresh_token') return json({ error: 'invalid_grant' }, 400);
      return json({ access_token: 'private-scale-access', refresh_token: 'private-scale-refresh', expires_in: 3600, token_type: 'Bearer', scope: PHOTOS_SCOPE });
    }
    if (url === 'https://oauth2.googleapis.com/tokeninfo') return json({ scope: PHOTOS_SCOPE, aud: config.googleClientId, sub: 'fixture-account-person1', expires_in: 3600 });
    if (url === `${API}/sessions` && init?.method === 'POST') {
      pickerNumber++;
      return json({ id: `picker-${pickerNumber}`, pickerUri: `https://photos.google.com/picker/${pickerNumber}`, expireTime: new Date(Date.now() + 3600_000).toISOString(), mediaItemsSet: true });
    }
    if (url.startsWith(`${API}/sessions/`) && init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.startsWith(`${API}/sessions/`)) {
      if (expired) return json({ error: { status: 'NOT_FOUND' } }, 404);
      return json({ id: url.split('/').at(-1), expireTime: new Date(Date.now() + 3600_000).toISOString(), mediaItemsSet: true });
    }
    if (url.startsWith(`${API}/mediaItems?`)) {
      if (expired) return json({ error: { status: 'NOT_FOUND' } }, 404);
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get('pageToken') ?? 0);
      const next = start + 100;
      if (start === 0) listingRound++;
      const pageItems = items.slice(start, next).map(item => options.expireFirstMediaUrls ? { ...item, mediaFile: { ...item.mediaFile, baseUrl: `${item.mediaFile.baseUrl}--version-${listingRound}` } } : item);
      return json({ mediaItems: pageItems, ...(next < items.length ? { nextPageToken: String(next) } : {}) });
    }
    if (url.startsWith('https://lh3.googleusercontent.com/p/')) {
      const mediaPath = url.split('/').at(-1)!.replace(/=d$/, '');
      const id = mediaPath.split('--version-')[0];
      downloads.set(id, (downloads.get(id) ?? 0) + 1);
      if (id === 'photo-0' && failures.length) {
        attemptTimes.push(Date.now());
        return json({ error: { status: 'TEMPORARY_FAILURE' } }, failures.shift()!, { 'retry-after': '1' });
      }
      if (id === 'photo-0' && attemptTimes.length) attemptTimes.push(Date.now());
      if (options.expireFirstMediaUrls && mediaPath.endsWith('--version-1')) return json({ error: { status: 'PERMISSION_DENIED' } }, 403);
      if (revoke) return json({ error: { status: 'UNAUTHENTICATED' } }, 401);
      if (expired) return json({ error: { status: 'NOT_FOUND' } }, 404);
      const bytes = Buffer.concat([PNG, Buffer.from(options.duplicateBytes ? 'same-bytes' : id)]);
      active++;
      peak = Math.max(peak, active);
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      const finish = () => { if (!settled) { settled = true; active--; } };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          timer = setTimeout(() => {
            if (init?.signal?.aborted) { finish(); controller.error(new Error('Simulated stream cancellation')); return; }
            controller.enqueue(bytes);
            controller.close();
            finish();
          }, options.latencyMs ?? 3);
          init?.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            if (!settled) { finish(); controller.error(new Error('Simulated stream cancellation')); }
          }, { once: true });
        },
        cancel() { clearTimeout(timer); finish(); },
      });
      return new Response(stream, { headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) } });
    }
    throw new Error('Unexpected simulated Google request');
  });

  const build = () => createApp(config, { google: new GoogleClient(config, fetchMock as typeof fetch), store: new EncryptedSessionStore(config.sessionStoragePath, config.sessionSecret) });
  let instance = build();
  let cookie = '';
  let csrf = '';
  const api = async (method: 'get' | 'post' | 'delete' | 'patch', path: string, body?: unknown) => {
    let test = request(instance.app)[method](path).set('Cookie', cookie);
    if (method !== 'get') test = test.set('Origin', config.webOrigin).set('X-CSRF-Token', csrf);
    if (body !== undefined) test = test.send(body as object);
    const response = await test;
    const setCookie = response.headers['set-cookie'];
    if (setCookie?.[0]) cookie = String(setCookie[0]).split(';')[0];
    return response;
  };
  const authorize = async () => {
    await api('get', '/api/session');
    const start = await api('get', '/auth/google?person=person1');
    expect(start.status).toBe(302);
    const state = new URL(start.headers.location).searchParams.get('state');
    const callback = await api('get', `/auth/google/callback?state=${encodeURIComponent(state!)}&code=simulated-private-code`);
    expect(callback.headers.location).toContain('auth=connected');
    const info = (await api('get', '/api/session')).body as SessionInfo;
    csrf = info.csrfToken;
    return info;
  };
  const create = async () => {
    const result = await api('post', '/api/picker/sessions', { contributorId: 'person1' });
    expect(result.status).toBe(201);
    return result.body as PickerState;
  };
  const start = async (id: string) => {
    const result = await api('post', `/api/picker/sessions/${id}/import`, {});
    expect(result.status).toBe(202);
    return result.body as PickerState;
  };
  const waitFor = async (id: string, predicate: (state: PickerState) => boolean, timeout = 25_000): Promise<PickerState> => {
    const deadline = Date.now() + timeout;
    let last: PickerState | undefined;
    while (Date.now() < deadline) {
      const result = await api('get', `/api/picker/sessions/${id}`);
      expect(result.status).toBe(200);
      last = result.body;
      if (predicate(last!)) return last!;
      await delay(15);
    }
    throw new Error(`Simulated import did not reach its expected state: ${JSON.stringify(last)}`);
  };
  const project = async () => {
    const response = await api('get', '/api/project');
    expect(response.status).toBe(200);
    return response.body as ProjectState;
  };
  const restart = async () => {
    await instance.picker.dispose();
    instance.media.db.close();
    instance = build();
  };
  cleanups.push(async () => { await instance.picker.dispose(); instance.media.db.close(); await rm(directory, { recursive: true, force: true }); });
  return { api, authorize, create, start, waitFor, project, restart, downloads, attemptTimes, config, directory, fetchMock, peak: () => peak, active: () => active, expire: () => { expired = true; }, revoke: () => { revoke = true; }, restoreAuthorization: () => { revoke = false; }, database: () => instance.media.db.connection };
}

describe('large persistent imports through the authenticated API', () => {
  for (const count of [100, 500, 1000]) {
    it(`imports all pages of ${count} simulated photos with four bounded concurrent streams`, async () => {
      const f = await fixture({ count });
      await f.authorize();
      const created = await f.create();
      const creation = f.fetchMock.mock.calls.find(([url, init]) => String(url) === `${API}/sessions` && init?.method === 'POST');
      expect(JSON.parse(String(creation?.[1]?.body ?? '{}')).pickingConfig?.maxItemCount).toBeUndefined();
      await f.start(created.id);
      const done = await f.waitFor(created.id, state => state.status === 'complete' && !state.cleanupPending);
      expect(done).toMatchObject({ total: count, imported: count, failed: 0, skipped: 0, remaining: 0 });
      expect(done.completed).toBe(count);
      expect(f.peak()).toBeGreaterThan(1);
      expect(f.peak()).toBeLessThanOrEqual(4);
      expect(f.downloads.size).toBe(count);
      for (const attempts of f.downloads.values()) expect(attempts).toBe(1);
      const pages = f.fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${API}/mediaItems?`));
      expect(pages).toHaveLength(Math.ceil(count / 100));
      for (let page = 0; page < pages.length; page++) {
        const url = new URL(String(pages[page][0]));
        expect(url.searchParams.get('pageSize')).toBe('100');
        expect(url.searchParams.get('pageToken') ?? '0').toBe(String(page * 100));
      }
      const project = await f.project();
      expect(project.assets).toHaveLength(count);
      expect(project.assets.every(asset => asset.url.startsWith('/api/projects/') && !asset.url.includes('googleusercontent'))).toBe(true);
      const files = await readdir(join(f.config.mediaStoragePath, project.project.id));
      expect(files.filter(file => file.endsWith('.png'))).toHaveLength(count);
      const persisted = f.database().prepare("SELECT count(*) AS total FROM import_items WHERE status='completed'").get() as { total: number };
      expect(persisted.total).toBe(count);
      await f.restart();
      expect((await f.project()).assets).toHaveLength(count);
      await delay(100);
      for (const attempts of f.downloads.values()) expect(attempts).toBe(1);
      if (count === 1000) {
        const bulk = await f.api('patch', `/api/projects/${project.project.id}/assets/selection`, { query: { contributorId: 'person1' }, selected: false });
        expect(bulk.status).toBe(200);
        expect(bulk.body.updated).toBe(1000);
        expect((await f.project()).assets.every(asset => !asset.selected)).toBe(true);
        const matching = await f.api('patch', `/api/projects/${project.project.id}/assets/selection`, { query: { search: 'photo-99' }, selected: true });
        expect(matching.status).toBe(200);
        expect(matching.body.updated).toBe(11);
        expect((await f.project()).assets.filter(asset => asset.selected)).toHaveLength(11);
      }
    }, 30_000);
  }

  it('deduplicates SHA-256 content without replacing original photo metadata', async () => {
    const f = await fixture({ count: 2, duplicateBytes: true });
    await f.authorize();
    const created = await f.create();
    await f.start(created.id);
    const done = await f.waitFor(created.id, state => state.status === 'complete');
    expect(done.imported).toBe(1);
    expect(done.skipped).toBe(1);
    const project = await f.project();
    expect(project.assets).toHaveLength(1);
    const firstFilename = project.assets[0].filename;
    expect(['photo-0.png', 'photo-1.png']).toContain(firstFilename);
    const files = await readdir(join(f.config.mediaStoragePath, project.project.id));
    expect(files.filter(file => file.endsWith('.png'))).toHaveLength(1);
    const sources = f.database().prepare('SELECT * FROM media_sources').all();
    expect(sources).toHaveLength(2);
    const metadata = JSON.stringify(sources);
    expect(metadata).toContain('Original camera 0');
    expect(metadata).toContain('Original camera 1');
    expect(metadata).not.toContain('googleusercontent');
    expect((await f.project()).assets[0].filename).toBe(firstFilename);
    const originalSidecar = JSON.parse(await readFile(join(f.config.mediaStoragePath, project.project.id, `${project.assets[0].id}.metadata.json`), 'utf8'));
    expect(originalSidecar.originalMetadata.mediaFile.filename).toBe(firstFilename);
  });

  it('resumes interrupted work without downloading completed checkpoints again', async () => {
    const f = await fixture({ count: 100, latencyMs: 15 });
    await f.authorize();
    const created = await f.create();
    await f.start(created.id);
    await f.waitFor(created.id, state => state.imported >= 8 && state.status === 'importing');
    const completedBefore = (await f.project()).assets.map(asset => asset.filename.replace(/\.png$/, ''));
    expect(completedBefore.length).toBeGreaterThan(0);
    expect(completedBefore.length).toBeLessThan(100);
    await f.restart();
    const done = await f.waitFor(created.id, state => state.status === 'complete');
    expect(done.imported).toBe(100);
    expect((await f.project()).assets).toHaveLength(100);
    for (const id of completedBefore) expect(f.downloads.get(id)).toBe(1);
  }, 30_000);

  it('persists retries and honors Retry-After alongside exponential backoff', async () => {
    const f = await fixture({ count: 1, retryStatuses: [429, 503], retryBaseMs: 600 });
    await f.authorize();
    const created = await f.create();
    await f.start(created.id);
    const done = await f.waitFor(created.id, state => state.status === 'complete');
    expect(done).toMatchObject({ imported: 1, failed: 0, remaining: 0 });
    expect(f.downloads.get('photo-0')).toBe(3);
    expect(f.attemptTimes).toHaveLength(3);
    expect(f.attemptTimes[1] - f.attemptTimes[0]).toBeGreaterThanOrEqual(900);
    expect(f.attemptTimes[2] - f.attemptTimes[1]).toBeGreaterThanOrEqual(1100);
  }, 15_000);

  it('cancels outstanding streams and keeps already completed local photos', async () => {
    const f = await fixture({ count: 100, latencyMs: 30 });
    await f.authorize();
    const created = await f.create();
    await f.start(created.id);
    await f.waitFor(created.id, state => state.imported >= 4 && state.status === 'importing');
    const cancelled = await f.api('delete', `/api/picker/sessions/${created.id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    const callsAtCancel = [...f.downloads.values()].reduce((total, count) => total + count, 0);
    await delay(150);
    expect([...f.downloads.values()].reduce((total, count) => total + count, 0)).toBe(callsAtCancel);
    expect(f.active()).toBe(0);
    const project = await f.project();
    expect(project.assets.length).toBeGreaterThanOrEqual(4);
    expect(project.assets.length).toBeLessThan(100);
    expect(f.fetchMock.mock.calls.some(([url, init]) => String(url).includes('/sessions/') && init?.method === 'DELETE')).toBe(true);
  });

  it('retries failed items without downloading completed photos again', async () => {
    const f = await fixture({ count: 2, retryStatuses: [400], maxAttempts: 1 });
    await f.authorize();
    const created = await f.create();
    await f.start(created.id);
    const first = await f.waitFor(created.id, state => state.status === 'complete');
    expect(first).toMatchObject({ imported: 1, failed: 1 });
    const retry = await f.api('post', `/api/picker/sessions/${created.id}/retry`, {});
    expect(retry.status).toBe(202);
    const done = await f.waitFor(created.id, state => state.status === 'complete' && state.failed === 0);
    expect(done.imported).toBe(2);
    expect(f.downloads.get('photo-0')).toBe(2);
    expect(f.downloads.get('photo-1')).toBe(1);
  });

  it('refreshes expired temporary URLs once for concurrent workers while the Picker is live', async () => {
    const f = await fixture({ count: 12, expireFirstMediaUrls: true });
    await f.authorize();
    const created = await f.create();
    await f.start(created.id);
    const done = await f.waitFor(created.id, state => state.status === 'complete', 10_000);
    expect(done).toMatchObject({ imported: 12, failed: 0, requiresReselection: false });
    expect((await f.project()).assets).toHaveLength(12);
    const listings = f.fetchMock.mock.calls.filter(([url]) => String(url).startsWith(`${API}/mediaItems?`));
    expect(listings).toHaveLength(2);
  }, 15_000);

  it('keeps completed media and asks for renewed selection when the Picker session expires', async () => {
    const f = await fixture({ count: 100, latencyMs: 20 });
    await f.authorize();
    const created = await f.create();
    await f.start(created.id);
    await f.waitFor(created.id, state => state.imported >= 4 && state.status === 'importing');
    f.expire();
    const expired = await f.waitFor(created.id, state => state.status === 'expired');
    expect(expired.requiresReselection).toBe(true);
    expect(expired.message).toMatch(/select|selection/i);
    const project = await f.project();
    expect(project.assets.length).toBeGreaterThanOrEqual(4);
    expect(project.assets.length).toBeLessThan(100);
  });

  it('pauses for revoked OAuth credentials, reconnects the same account, and resumes checkpoints', async () => {
    const f = await fixture({ count: 40, latencyMs: 20 });
    await f.authorize();
    const created = await f.create();
    await f.start(created.id);
    await f.waitFor(created.id, state => state.imported >= 4 && state.status === 'importing');
    f.revoke();
    const paused = await f.waitFor(created.id, state => state.status === 'paused');
    expect(paused.requiresAuthorization).toBe(true);
    const saved = (await f.project()).assets.map(asset => asset.filename.replace(/\.png$/, ''));
    expect(saved.length).toBeGreaterThanOrEqual(4);
    f.restoreAuthorization();
    await f.authorize();
    const resumed = await f.api('post', `/api/picker/sessions/${created.id}/resume`, {});
    expect(resumed.status).toBe(202);
    const done = await f.waitFor(created.id, state => state.status === 'complete');
    expect(done).toMatchObject({ imported: 40, failed: 0, remaining: 0 });
    for (const id of saved) expect(f.downloads.get(id)).toBe(1);
  }, 20_000);

  it('does not store OAuth tokens or plaintext temporary media URLs in durable project records', async () => {
    const f = await fixture({ count: 1 });
    await f.authorize();
    const created = await f.create();
    await f.start(created.id);
    await f.waitFor(created.id, state => state.status === 'complete');
    const project = await f.project();
    const serialized = JSON.stringify(project);
    expect(serialized).not.toContain('private-scale-access');
    expect(serialized).not.toContain('private-scale-refresh');
    expect(serialized).not.toContain('googleusercontent');
    const disk = await readFile(f.config.databasePath!);
    expect(disk.includes(Buffer.from('private-scale-access'))).toBe(false);
    expect(disk.includes(Buffer.from('https://lh3.googleusercontent.com/p/'))).toBe(false);
  });
});
