import { createHash, randomUUID } from 'node:crypto';
import type { Session, SessionData } from 'express-session';
import type { ContributorId, PickerState } from '@memories/shared';
import { ApiError } from './errors.js';
import type { GoogleClient, PickedMediaItem } from './google.js';
import { displayFilename, IMAGE_TYPES, type MediaStore } from './media-store.js';

export type WorkspaceSession = Session & SessionData;
export type QueueGoogle = Pick<GoogleClient, 'createSession' | 'getSession' | 'deleteSession' | 'listMediaItems' | 'downloadMedia'> &
  Partial<Pick<GoogleClient, 'listMediaItemsPage'>>;
export interface QueueOptions {
  concurrency?: number;
  batchSize?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  loadSession?: (sessionId: string) => Promise<WorkspaceSession | null>;
}
export interface JobRow {
  id: string; owner_id: string; project_id: string; contributor_id: ContributorId;
  google_session_id: string; session_id: string; picker_uri: string | null;
  status: PickerState['status']; phase: string; poll_interval_ms: number; next_poll_at: number;
  deadline: number; expires_at: number; created_at: number; updated_at: number; message: string | null;
  listing_complete: number; next_page_token: string | null; listing_attempts: number; next_list_at: number;
  rate_limited_until: number; requires_auth: number; requires_selection: number;
  cleanup_pending: number; cleanup_done: number; cleanup_after: number; url_refreshes: number;
  account_id?:string|null; credential_fingerprint?:string|null;
}
export interface ItemRow {
  id: string; job_id: string; google_media_id: string; metadata_json: string; base_url: string | null;
  url_expires_at: number; status: string; attempts: number; next_attempt_at: number;
  lease_owner: string | null; asset_id: string | null; duplicate: number;
  error_code: string | null; error_message: string | null; created_at: number; updated_at: number; url_failures:number; url_generation:number;
}
export const transient = (error: unknown): error is ApiError => error instanceof ApiError &&
  (error.status === 408 || error.status === 429 || error.status >= 500) &&
  !['INVALID_GOOGLE_RESPONSE', 'UNSAFE_MEDIA_URL', 'INVALID_GOOGLE_CREDENTIALS'].includes(error.code);

/** A single fenced coordinator owns a bounded pool of asynchronous streamed downloads. */
export class ImportQueue {
  readonly workerId = randomUUID();
  readonly concurrency: number;
  protected readonly db;
  protected readonly sessions = new Map<string, WorkspaceSession>();
  private readonly listing = new Map<string, Promise<void>>();
  private readonly listingAbort = new Map<string, AbortController>();
  private readonly downloads = new Map<string, { promise: Promise<void>; abort: AbortController; jobId: string }>();
  private readonly cleanups = new Map<string, Promise<void>>();
  private readonly terminalTasks=new Set<Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private ticking = false;
  private stopped = false;
  private leaseHeld = false;
  private readonly batchSize: number;
  private readonly maxAttempts: number;
  private readonly retryBaseMs: number;

  constructor(protected readonly google: QueueGoogle, protected readonly media: MediaStore, protected readonly options: QueueOptions = {}) {
    this.db = media.db;
    this.concurrency = options.concurrency ?? 4;
    this.batchSize = Math.max(1, Math.min(100, options.batchSize ?? 100));
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryBaseMs = options.retryBaseMs ?? 1000;
    this.timer = setInterval(() => { void this.wake().catch(()=>{}); }, 100);
    this.timer.unref();
    this.heartbeat=setInterval(()=>{
      if(this.stopped || !this.leaseHeld) return;
      let held=false;
      try{held=this.db.acquireLease(this.workerId);}catch{/* A busy or unavailable database must never allow unfenced writes. */}
      if(!held) {
        this.leaseHeld=false;
        for(const task of this.downloads.values()) task.abort.abort();
        for(const abort of this.listingAbort.values()) abort.abort();
      }
    },1000);
    this.heartbeat.unref();
    void this.wake().catch(()=>{});
  }

  protected remember(session: WorkspaceSession) {
    this.sessions.set(session.workspaceId, session);
  }

  protected job(id: string): JobRow | undefined {
    return this.db.connection.prepare('SELECT * FROM import_jobs WHERE id=?').get(id) as unknown as JobRow | undefined;
  }

  protected ownerJob(ownerId: string, id: string): JobRow {
    const job = this.job(id);
    if (!job || job.owner_id !== ownerId) throw new ApiError(404, 'NOT_FOUND', 'Photo import not found.');
    return job;
  }

  protected state(job: JobRow): PickerState {
    const counts = this.db.connection.prepare(`SELECT COUNT(*) total,
      COALESCE(SUM(status='completed' AND duplicate=0),0) completed,
      COALESCE(SUM(status='failed'),0) failed,
      COALESCE(SUM(status='skipped' OR (status='completed' AND duplicate=1)),0) skipped,
      COALESCE(SUM(status='retry'),0) retrying,
      COALESCE(SUM(status='completed' AND duplicate=1),0) duplicates,
      COALESCE(SUM(error_message IS NOT NULL),0) issuesTotal,
      COALESCE(SUM(status='downloading'),0) active
      FROM import_items WHERE job_id=?`).get(job.id) as unknown as Record<string, number>;
    const issues = this.db.connection.prepare(`SELECT metadata_json,error_message FROM import_items
      WHERE job_id=? AND error_message IS NOT NULL ORDER BY updated_at DESC LIMIT 50`).all(job.id) as unknown as { metadata_json: string; error_message: string }[];
    const processed = counts.completed + counts.failed + counts.skipped;
    return {
      id: job.id, contributorId: job.contributor_id, status: job.status, createdAt:job.created_at,
      pickerUri: job.picker_uri && ['waiting', 'ready'].includes(job.status) ? this.db.unseal(job.picker_uri) : undefined,
      pollIntervalMs: job.poll_interval_ms, nextPollAt: job.next_poll_at, deadline: job.deadline,
      message: job.message ?? undefined, total: counts.total, processed,
      imported: counts.completed, completed: counts.completed, failed: counts.failed, skipped: counts.skipped,
      remaining: counts.total - processed, retrying: counts.retrying, activeDownloads: counts.active, duplicates:counts.duplicates, issueCount:counts.issuesTotal, expiresAt:job.expires_at,
      listingComplete: Boolean(job.listing_complete), requiresAuthorization: Boolean(job.requires_auth),
      requiresReselection: Boolean(job.requires_selection), resumable: !job.requires_selection && !job.cleanup_done && job.expires_at > Date.now(),
      cleanupPending: Boolean(job.cleanup_pending),
      issues: issues.map(issue => ({ filename: displayFilename((JSON.parse(issue.metadata_json) as PickedMediaItem).mediaFile.filename), message: issue.error_message })),
    };
  }

  protected async sessionFor(job: JobRow): Promise<WorkspaceSession> {
    if (this.options.loadSession) {
      const loaded = await this.options.loadSession(this.db.unseal(job.session_id));
      if (loaded && loaded.workspaceId === job.owner_id) {
        this.assertAccountBinding(job,loaded);
        this.remember(loaded);
        return loaded;
      }
    } else {
      const cached = this.sessions.get(job.owner_id);
      if (cached) {this.assertAccountBinding(job,cached);return cached;}
    }
    throw new ApiError(401, 'RECONNECT_REQUIRED', 'Your local Google session expired. Reconnect this Google account, then resume the import.');
  }

  async authorized(session: WorkspaceSession): Promise<void> {
    this.remember(session);
    const jobs=this.db.connection.prepare('SELECT * FROM import_jobs WHERE owner_id=? AND cleanup_done=0').all(session.workspaceId) as unknown as JobRow[];
    for(const job of jobs) {
      try {this.assertAccountBinding(job,session);}
      catch(error) {
        const selection=error instanceof ApiError && error.code==='PICKER_ACCOUNT_VERIFICATION_REQUIRED';
        this.update(job.id,{status:'paused',requires_auth:selection?0:1,requires_selection:selection?1:0,message:error instanceof ApiError?error.message:'Reconnect the account that created this selection.'});
      }
      this.update(job.id,{session_id:this.db.seal(session.id ?? session.workspaceId)});
    }
  }

  protected bindJobAccount(job:JobRow,value:WorkspaceSession):void {
    const tokens=value.credentials?.[job.contributor_id];
    if(!tokens) return;
    const fingerprint=createHash('sha256').update(tokens.authorizationId ?? tokens.refreshToken ?? tokens.accessToken).digest('hex');
    this.update(job.id,{account_id:tokens.accountId?this.db.seal(tokens.accountId):null,credential_fingerprint:fingerprint});
  }

  protected assertAccountBinding(job:JobRow,value:WorkspaceSession):void {
    const tokens=value.credentials?.[job.contributor_id];
    if(!tokens) throw new ApiError(401,'RECONNECT_REQUIRED','Reconnect the Google account that created this selection.');
    if(!job.account_id && !job.credential_fingerprint) {
      if(this.db.unseal(job.session_id)!==(value.id ?? value.workspaceId)) throw new ApiError(409,'PICKER_ACCOUNT_VERIFICATION_REQUIRED','This selection predates account verification. Choose the outstanding photos again; completed photos are preserved.');
      this.bindJobAccount(job,value);return;
    }
    const previousAccount=job.account_id?this.db.unseal(job.account_id):undefined;
    if(previousAccount && tokens.accountId) {
      if(previousAccount!==tokens.accountId) throw new ApiError(403,'ACCOUNT_MISMATCH','This Picker selection belongs to a different Google account. Reconnect its original account or start a new selection.');
      return;
    }
    const fingerprint=createHash('sha256').update(tokens.authorizationId ?? tokens.refreshToken ?? tokens.accessToken).digest('hex');
    if(job.credential_fingerprint!==fingerprint) throw new ApiError(409,'PICKER_ACCOUNT_VERIFICATION_REQUIRED','The Google connection changed and Google did not supply an account identifier to verify ownership of the old selection. Choose the outstanding photos again; completed photos are preserved.');
    if(!previousAccount && tokens.accountId) this.bindJobAccount(job,value);
  }

  protected update(id: string, values: Partial<JobRow>) {
    const entries = Object.entries({ ...values, updated_at: Date.now() });
    this.db.connection.prepare(`UPDATE import_jobs SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`)
      .run(...entries.map(([, value]) => value === undefined ? null : value), id);
  }

  protected delay(attempt: number, error: unknown): number {
    const exponential = Math.min(5 * 60_000, this.retryBaseMs * 2 ** Math.max(0, attempt - 1));
    const jitter = Math.floor(exponential * 0.2 * Math.random());
    return Math.max(exponential + jitter, error instanceof ApiError ? error.retryAfterMs ?? 0 : 0);
  }

  async wake(): Promise<void> {
    if (this.stopped || this.ticking) return;
    this.ticking = true;
    try {
      if(!this.leaseHeld && (this.downloads.size || this.listing.size)) await Promise.allSettled([...this.listing.values(),...[...this.downloads.values()].map(task=>task.promise)]);
      if(this.stopped) return;
      const held = this.db.acquireLease(this.workerId);
      if (!held) {
        this.leaseHeld = false;
        for (const running of this.downloads.values()) running.abort.abort();
        for(const abort of this.listingAbort.values()) abort.abort();
        return;
      }
      if (!this.leaseHeld) {
        this.leaseHeld=true;
        await this.media.recoverStaging(this.workerId);
        if(this.stopped || !this.db.leaseOwned(this.workerId)) return;
        // No living coordinator's work is reclaimed. Completed rows are never downloaded again.
        this.db.connection.prepare(`UPDATE import_items SET status='pending',lease_owner=NULL,updated_at=?
          WHERE status='downloading'`).run(Date.now());
      }
      this.leaseHeld = true;
      for(const task of this.downloads.values()) if(this.job(task.jobId)?.status!=='importing') task.abort.abort();
      const jobs = this.db.connection.prepare(`SELECT * FROM import_jobs WHERE status IN ('importing','waiting','ready','complete','error','cancelled','expired','paused') ORDER BY expires_at,created_at`)
        .all() as unknown as JobRow[];
      for (const job of jobs) {
        if(['waiting','ready'].includes(job.status) && job.deadline<=Date.now()) {
          this.update(job.id,{status:'expired',requires_selection:1,message:'This Google Photos selection expired. Photos already imported are safe. Select the remaining photos again.'});
          this.scheduleTerminalCleanup(job.id);
          continue;
        }
        if (job.expires_at <= Date.now() && !job.cleanup_done && !['waiting', 'ready'].includes(job.status)) {
          const pending = this.state(job);
          if (pending.remaining || pending.failed) this.update(job.id, { status: 'expired', requires_selection: 1, message: 'The Google Picker session expired. Imported photos are safe. Select the remaining photos again; completed photos will be deduplicated.' });
          if(!job.cleanup_pending || job.cleanup_after<=Date.now()) this.scheduleTerminalCleanup(job.id);
          continue;
        }
        if (job.cleanup_pending && job.cleanup_after <= Date.now()) { void this.cleanup(job).catch(()=>{}); continue; }
        if (job.status !== 'importing') continue;
        if (!job.listing_complete && job.next_list_at <= Date.now() && job.rate_limited_until <= Date.now() && !this.listing.has(job.id)) {
          const abort = new AbortController();
          this.listingAbort.set(job.id,abort);
          const task = this.listPage(job,abort.signal).catch(() => {}).finally(() => { this.listing.delete(job.id); this.listingAbort.delete(job.id); void this.wake().catch(()=>{}); });
          this.listing.set(job.id, task);
        }
      }
      while (this.downloads.size < this.concurrency && !this.stopped && this.db.leaseOwned(this.workerId)) {
        const item = this.db.transaction(() => {
          const row = this.db.connection.prepare(`SELECT i.* FROM import_items i JOIN import_jobs j ON j.id=i.job_id
            WHERE j.status='importing' AND j.rate_limited_until<=? AND i.status IN ('pending','retry') AND i.next_attempt_at<=?
            ORDER BY i.url_expires_at ASC,i.created_at ASC,i.rowid ASC LIMIT 1`).get(Date.now(), Date.now()) as unknown as ItemRow | undefined;
          if (row) this.db.connection.prepare(`UPDATE import_items SET status='downloading',lease_owner=?,attempts=attempts+1,updated_at=? WHERE id=?`).run(this.workerId, Date.now(), row.id);
          return row ? { ...row, status: 'downloading', attempts: row.attempts + 1, lease_owner: this.workerId } : undefined;
        });
        if (!item) break;
        const abort = new AbortController();
        const promise = this.download(item, abort.signal).catch(() => {}).finally(() => { this.downloads.delete(item.id); void this.finish(item.job_id).catch(()=>{}); void this.wake().catch(()=>{}); });
        this.downloads.set(item.id, { promise, abort, jobId: item.job_id });
      }
      for (const job of jobs.filter(job => job.status === 'importing' && job.listing_complete)) void this.finish(job.id).catch(()=>{});
    } finally { this.ticking = false; }
  }

  private itemData(item: ItemRow): PickedMediaItem {
    const data = JSON.parse(item.metadata_json) as PickedMediaItem;
    data.mediaFile.baseUrl = item.base_url ? this.db.unseal(item.base_url) : '';
    return data;
  }

  private async listPage(snapshot: JobRow, signal:AbortSignal): Promise<void> {
    let job = this.job(snapshot.id)!;
    try {
      const session = await this.sessionFor(job);
      const page = this.google.listMediaItemsPage
        ? await this.google.listMediaItemsPage(session, job.contributor_id, job.google_session_id, job.next_page_token ?? undefined, signal)
        : { mediaItems: await this.google.listMediaItems(session, job.contributor_id, job.google_session_id, signal), nextPageToken: undefined };
      job = this.job(job.id)!;
      if (this.stopped || job.status !== 'importing' || job.url_refreshes!==snapshot.url_refreshes || !this.db.leaseOwned(this.workerId)) return;
      const now = Date.now();
      this.db.transaction(() => {
        const token = job.next_page_token ?? '__first_page__';
        this.db.connection.prepare('INSERT INTO import_pages(job_id,token) VALUES(?,?)').run(job.id, token);
        if (page.nextPageToken && this.db.connection.prepare('SELECT 1 FROM import_pages WHERE job_id=? AND token=?').get(job.id, page.nextPageToken)) throw new ApiError(502, 'INVALID_GOOGLE_RESPONSE', 'Google returned a repeated media page. Select your photos again.');
        for (let offset = 0; offset < page.mediaItems.length; offset += this.batchSize) {
          for (const item of page.mediaItems.slice(offset, offset + this.batchSize)) {
            const { baseUrl, ...mediaFile } = item.mediaFile;
            const metadata = JSON.stringify({ ...item, mediaFile });
            this.db.connection.prepare(`INSERT INTO import_items(id,job_id,google_media_id,metadata_json,base_url,url_expires_at,url_generation,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id,google_media_id) DO UPDATE SET
              base_url=excluded.base_url,url_expires_at=excluded.url_expires_at,url_generation=excluded.url_generation,next_attempt_at=0,updated_at=excluded.updated_at
              WHERE import_items.status NOT IN ('completed','skipped')`)
              .run(randomUUID(), job.id, item.id, metadata, this.db.seal(baseUrl), Math.min(job.expires_at, now + 59 * 60_000), job.url_refreshes, now, now);
          }
        }
        this.update(job.id, { next_page_token: page.nextPageToken ?? null, listing_complete: page.nextPageToken ? 0 : 1, listing_attempts: 0, next_list_at: 0, phase: job.phase==='refreshing' && page.nextPageToken ? 'refreshing' : 'downloading', message: 'Downloading selected photos. Each completed photo is saved as a checkpoint.' });
      });
      await this.finish(job.id);
    } catch (error) {
      const latest=this.job(snapshot.id);
      if (this.stopped || signal.aborted || !this.db.leaseOwned(this.workerId) || !latest || latest.status!=='importing' || latest.url_refreshes!==snapshot.url_refreshes) return;
      await this.jobError(latest, error, 'listing');
    }
  }

  private async download(item: ItemRow, signal: AbortSignal): Promise<void> {
    const job = this.job(item.job_id)!;
    const checkpoint = { jobId: job.id, itemId: item.id, workerId: this.workerId };
    try {
      signal.throwIfAborted();
      const data = this.itemData(item);
      if (data.type !== 'PHOTO' || !IMAGE_TYPES.has(data.mediaFile.mimeType)) {
        this.itemStatus(item, 'skipped', 'UNSUPPORTED_IMAGE', 'Unsupported format. Only JPEG, PNG, WebP, and GIF images are imported.');
        return;
      }
      if (await this.media.exists(job.owner_id, job.contributor_id, data.id)) {
        this.itemStatus(item, 'skipped', 'ALREADY_IMPORTED', 'This Google photo is already in the project.');
        return;
      }
      const recovered = await this.media.recoverImport(job.owner_id, job.contributor_id, data, checkpoint);
      if (recovered) return;
      if (item.url_expires_at <= Date.now() || !item.base_url) {
        await this.refreshUrls(job, item);
        return;
      }
      await this.media.preflight();
      const session = await this.sessionFor(job);
      signal.throwIfAborted();
      const response = await this.google.downloadMedia(session, job.contributor_id, data.mediaFile.baseUrl, signal);
      const result = await this.media.import(job.owner_id, job.contributor_id, data, response, { signal, onBytes: () => {}, checkpoint });
      // MediaStore normally commits bytes, provenance and checkpoint in one SQLite transaction.
      const row = this.db.connection.prepare('SELECT status FROM import_items WHERE id=?').get(item.id) as { status: string };
      if (row.status === 'downloading') this.db.connection.prepare(`UPDATE import_items SET status='completed',asset_id=?,duplicate=?,lease_owner=NULL,base_url=NULL,error_code=NULL,error_message=NULL,updated_at=? WHERE id=? AND lease_owner=?`).run(result.id, result.duplicate ? 1 : 0, Date.now(), item.id, this.workerId);
    } catch (error) {
      if(!this.db.leaseOwned(this.workerId)) return;
      if (this.stopped || signal.aborted) {
        this.itemStatus(item, 'pending');
        return;
      }
      if (error instanceof ApiError && error.code === 'WORKER_LEASE_LOST') {this.itemStatus(item,'pending');return;}
      if (error instanceof ApiError && (error.status === 401 || ['RECONNECT_REQUIRED','MISSING_PHOTOS_SCOPE','ACCOUNT_MISMATCH'].includes(error.code))) {
        this.itemStatus(item, 'pending');
        this.update(job.id, { status: 'paused', requires_auth: 1, message: error.message });
        this.abortJob(job.id);
      } else if(error instanceof ApiError && error.code==='PICKER_ACCOUNT_VERIFICATION_REQUIRED') {
        this.itemStatus(item,'pending');this.update(job.id,{status:'paused',requires_auth:0,requires_selection:1,message:error.message});this.abortJob(job.id);
      } else if (error instanceof ApiError && [403, 404, 410].includes(error.status) && ['DOWNLOAD_FAILED', 'PICKER_EXPIRED', 'GOOGLE_PERMISSION_DENIED', 'MEDIA_URL_EXPIRED'].includes(error.code)) {
        await this.refreshUrls(job, item, true);
      } else if (error instanceof ApiError && ['STORAGE_QUOTA_EXCEEDED', 'INSUFFICIENT_DISK_SPACE', 'DISK_SPACE_LOW', 'STORAGE_QUOTA'].includes(error.code)) {
        this.itemStatus(item, 'pending');
        this.update(job.id, { status: 'paused', message: error.message });
        this.abortJob(job.id);
      } else if (!(error instanceof ApiError) && ['ENOSPC','EDQUOT'].includes((error as NodeJS.ErrnoException)?.code ?? '')) {
        this.itemStatus(item, 'pending');
        this.update(job.id, {status:'paused',message:'Local storage is full. Free disk space or increase the storage quota, then resume from the saved checkpoint.'});
      } else if ((transient(error) || !(error instanceof ApiError)) && item.attempts < this.maxAttempts) {
        const delay = this.delay(item.attempts, error);
        this.itemStatus(item, 'retry', error instanceof ApiError ? error.code : 'DOWNLOAD_INTERRUPTED', error instanceof ApiError ? error.message : 'The download was interrupted. Retrying automatically.', Date.now() + delay);
        if (error instanceof ApiError && error.status === 429) this.update(job.id, { rate_limited_until: Date.now() + delay, message: 'Google rate limit reached. Downloads will resume automatically after the requested delay.' });
      } else this.itemStatus(item, 'failed', error instanceof ApiError ? error.code : 'DOWNLOAD_FAILED', error instanceof ApiError ? error.message : 'The photo download was interrupted. Retry failed items to try again.');
    }
  }

  private itemStatus(item: ItemRow, status: string, code?: string, message?: string, nextAttempt = 0) {
    this.db.connection.prepare(`UPDATE import_items SET status=?,lease_owner=NULL,error_code=?,error_message=?,next_attempt_at=?,updated_at=?
      WHERE id=? AND lease_owner=? AND status='downloading'`).run(status, code ?? null, message ?? null, nextAttempt, Date.now(), item.id, this.workerId);
  }

  private async refreshUrls(job: JobRow, item: ItemRow, failedRequest=false) {
    this.itemStatus(item, 'pending');
    const current = this.job(job.id)!;
    const currentItem = this.db.connection.prepare('SELECT * FROM import_items WHERE id=?').get(item.id) as unknown as ItemRow;
    // Other workers may be reporting failures from the previous generation of URLs.
    if(currentItem.url_generation > item.url_generation || current.phase==='refreshing') return;
    if (current.expires_at <= Date.now() || (failedRequest && currentItem.url_failures >= 1)) {
      this.update(job.id, { status: 'expired', requires_selection: 1, message: 'The temporary Google media links can no longer be refreshed. Select the remaining photos again; completed photos remain in your project.' });
      this.scheduleTerminalCleanup(job.id);
      return;
    }
    this.db.transaction(() => {
      if(failedRequest) this.db.connection.prepare('UPDATE import_items SET url_failures=url_failures+1 WHERE id=?').run(item.id);
      this.db.connection.prepare('DELETE FROM import_pages WHERE job_id=?').run(job.id);
      this.update(job.id, { phase:'refreshing',listing_complete: 0, next_page_token: null, next_list_at: 0, url_refreshes: current.url_refreshes + 1, message: 'Refreshing temporary Google media links before continuing.' });
      // Fresh pages clear this delay per item. Unrefreshed links remain held back.
      this.db.connection.prepare(`UPDATE import_items SET next_attempt_at=? WHERE job_id=? AND status IN ('pending','retry')`).run(Date.now() + 60_000, job.id);
    });
  }

  protected async jobError(job: JobRow, error: unknown, context: 'listing' | 'polling') {
    if (error instanceof ApiError && (error.status===401 || ['MISSING_PHOTOS_SCOPE','ACCOUNT_MISMATCH','GOOGLE_TEST_USER_REQUIRED','GOOGLE_PERMISSION_DENIED'].includes(error.code))) {
      this.update(job.id, { status: 'paused', requires_auth: 1, message: error.message });
      this.abortJob(job.id);
    } else if(error instanceof ApiError && error.code==='PICKER_ACCOUNT_VERIFICATION_REQUIRED') {
      this.update(job.id,{status:'paused',requires_auth:0,requires_selection:1,message:error.message});this.abortJob(job.id);
    } else if (error instanceof ApiError && error.code === 'PICKER_EXPIRED') {
      this.update(job.id, { status: 'expired', requires_selection: 1, message: 'This Google Picker session expired. Imported photos are safe. Select the remaining photos again.' });
      if(context==='polling') await this.cleanup(this.job(job.id)!);
      else this.scheduleTerminalCleanup(job.id);
    } else if (transient(error) && job.listing_attempts + 1 < this.maxAttempts) {
      const retry = this.delay(job.listing_attempts + 1, error);
      this.update(job.id, { listing_attempts: job.listing_attempts + 1, next_list_at: Date.now() + retry, next_poll_at: Date.now() + Math.max(job.poll_interval_ms, retry), rate_limited_until: error.status === 429 ? Date.now() + retry : job.rate_limited_until, message: 'Google is temporarily unavailable. Retrying automatically with backoff.' });
    } else {
      this.update(job.id, { status: 'error', message: error instanceof ApiError ? error.message : 'The import could not continue. Resume to retry from the saved checkpoint.' });
      if (context === 'polling') await this.cleanup(this.job(job.id)!);
    }
  }

  private async finish(id: string): Promise<void> {
    if(this.stopped || this.listing.has(id) || [...this.downloads.values()].some(task=>task.jobId===id)) return;
    const job = this.job(id);
    if (this.stopped || !job || job.status !== 'importing' || !job.listing_complete || !this.db.leaseOwned(this.workerId)) return;
    const progress = this.state(job);
    if (progress.remaining) return;
    this.update(id, { status: 'complete', phase: 'complete', message: progress.total ? `Import finished. ${progress.imported} saved, ${progress.skipped} skipped, ${progress.failed} failed.${progress.failed ? ' Retry failed items while this Google selection remains available.' : ''}` : 'No photos were selected. Open Google Photos again and select the photos you want to import.' });
    if (!progress.failed) await this.cleanup(this.job(id)!);
  }

  protected async cleanup(job: JobRow): Promise<void> {
    if (job.cleanup_done) return;
    const pending = this.cleanups.get(job.id);
    if (pending) return pending;
    const task = (async () => {
      try {
        await this.media.discardJobStaging(job.id);
        const session = await this.sessionFor(job);
        await this.google.deleteSession(session, job.contributor_id, job.google_session_id);
        this.update(job.id, { cleanup_done: 1, cleanup_pending: 0 });
        this.db.connection.prepare('UPDATE import_items SET base_url=NULL WHERE job_id=?').run(job.id);
      } catch (error) {
        if (error instanceof ApiError && [401, 403, 410].includes(error.status)) {
          this.update(job.id, { cleanup_done: 1, cleanup_pending: 0, message: `${this.job(job.id)?.message ?? ''} Google cleanup could not be authorized; the remote selection will expire automatically.`.trim() });
        } else this.update(job.id, { cleanup_pending: 1, cleanup_after: Date.now() + Math.max(30000, error instanceof ApiError ? error.retryAfterMs ?? 0 : 0) });
      }
    })().finally(() => { this.cleanups.delete(job.id); });
    this.cleanups.set(job.id, task);
    await task;
  }

  private scheduleTerminalCleanup(id:string) {
    if(this.stopped) return;
    this.abortJob(id);
    const task=this.settleJob(id).then(async()=>{
      if(this.stopped || !this.db.leaseOwned(this.workerId)) return;
      const job=this.job(id);
      if(job) await this.cleanup(job);
    }).catch(()=>{}).finally(()=>{this.terminalTasks.delete(task);});
    this.terminalTasks.add(task);
  }

  protected abortJob(id: string) { this.listingAbort.get(id)?.abort();for (const running of this.downloads.values()) if (running.jobId === id) running.abort.abort(); }

  protected async settleJob(id: string) {
    await Promise.allSettled([...this.downloads.values()].filter(task => task.jobId === id).map(task => task.promise));
    const listing = this.listing.get(id);
    if (listing) await listing;
  }

  async drain(): Promise<void> {
    await this.wake();
    await Promise.allSettled([...this.listing.values(), ...[...this.downloads.values()].map(task => task.promise)]);
    await this.wake();
  }

  async dispose(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    for (const abort of this.listingAbort.values()) abort.abort();
    for (const task of this.downloads.values()) task.abort.abort();
    await Promise.allSettled([...this.listing.values(), ...this.cleanups.values(), ...this.terminalTasks, ...[...this.downloads.values()].map(task => task.promise)]);
    this.db.connection.prepare(`UPDATE import_items SET status='pending',lease_owner=NULL WHERE status='downloading' AND lease_owner=?`).run(this.workerId);
    this.db.releaseLease(this.workerId);
  }
}
