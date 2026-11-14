import { randomUUID } from 'node:crypto';
import type { ContributorId, PickerState, PickerStatus } from '@memories/shared';
import { parseDurationMs, type GooglePickingSession } from './google.js';
import { ApiError } from './errors.js';
import { ImportQueue, type JobRow, type QueueGoogle, type QueueOptions, type WorkspaceSession } from './import-queue.js';
import type { MediaStore } from './media-store.js';

// Read compatibility for sessions saved by the original P2 release. SQLite owns new jobs.
type PendingPicker = { id:string;googleId:string;contributorId:ContributorId;deadline:number;nextPollAt:number;pollIntervalMs:number;pickerUri?:string;status:PickerStatus };
declare module 'express-session' { interface SessionData { pendingPicker?: PendingPicker } }
export type PickerGoogle = QueueGoogle;

export class PickerManager extends ImportQueue {
  private readonly creating = new Set<string>();
  private readonly polling = new Map<string, Promise<void>>();
  private readonly pollAbort = new Map<string, AbortController>();

  constructor(google: QueueGoogle, media: MediaStore, options: QueueOptions = {}) { super(google, media, options); }

  latest(session: WorkspaceSession): PickerState | undefined {
    this.remember(session);
    const row = this.db.connection.prepare('SELECT * FROM import_jobs WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(session.workspaceId) as unknown as JobRow | undefined;
    return row ? this.state(row) : undefined;
  }

  list(session: WorkspaceSession): PickerState[] {
    this.remember(session);
    const rows = this.db.connection.prepare('SELECT * FROM import_jobs WHERE owner_id=? ORDER BY created_at DESC,rowid DESC').all(session.workspaceId) as unknown as JobRow[];
    return rows.map(row => this.state(row));
  }

  hasPending(ownerId: string): boolean {
    return this.creating.has(ownerId) || Boolean(this.db.connection.prepare(`SELECT 1 FROM import_jobs WHERE owner_id=?
      AND (status IN ('waiting','ready','importing') OR cleanup_pending=1) LIMIT 1`).get(ownerId));
  }

  private configure(job: JobRow, google: GooglePickingSession) {
    const now = Date.now();
    const expires = Date.parse(google.expireTime);
    if (google.mediaItemsSet) {
      this.update(job.id, { status: 'ready', phase: 'ready', deadline: expires, expires_at: expires, message: 'Selection received. Your photos are ready to import.' });
      return;
    }
    if (!google.pollingConfig) throw new ApiError(502, 'INVALID_GOOGLE_RESPONSE', 'Google did not return polling information. Please select your photos again.');
    const interval = Math.max(1000, parseDurationMs(google.pollingConfig.pollInterval));
    this.update(job.id, {
      status: 'waiting', phase: 'waiting', poll_interval_ms: interval, next_poll_at: now + interval,
      deadline: Math.min(job.deadline, expires, now + parseDurationMs(google.pollingConfig.timeoutIn)), expires_at: expires,
      message: 'Choose your photos in the Google Photos tab, then select Done.',
    });
  }

  async create(session: WorkspaceSession, contributorId: ContributorId): Promise<PickerState> {
    if (session.oauth && session.oauth.createdAt + 10 * 60_000 > Date.now()) throw new ApiError(409, 'OAUTH_ACTIVE', 'Finish connecting your Google account before choosing photos.');
    if (this.hasPending(session.workspaceId)) throw new ApiError(409, 'PICKER_ACTIVE', 'Finish or cancel your current photo selection and wait for cleanup first.');
    this.creating.add(session.workspaceId);
    this.remember(session);
    let id: string | undefined;
    let remote:GooglePickingSession|undefined;
    try {
      await this.media.ensure(session.workspaceId);
      await this.media.preflight();
      const google = await this.google.createSession(session, contributorId); remote=google;
      const now = Date.now(); id = randomUUID();
      this.db.connection.prepare(`INSERT INTO import_jobs(id,owner_id,project_id,contributor_id,google_session_id,session_id,picker_uri,status,phase,poll_interval_ms,next_poll_at,deadline,expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'waiting','waiting',5000,?,?,?,?,?)`).run(id, session.workspaceId, session.workspaceId, contributorId, google.id, this.db.seal(session.id ?? session.workspaceId), google.pickerUri ? this.db.seal(google.pickerUri) : null, now + 5000, Date.parse(google.expireTime), Date.parse(google.expireTime), now, now);
      this.bindJobAccount(this.job(id)!,session);
      this.configure(this.job(id)!, google);
      if (this.job(id)!.deadline <= Date.now()) await this.expire(this.job(id)!);
      return this.state(this.job(id)!);
    } catch (error) {
      if (id && this.job(id)) { this.update(id, { status: 'error', message: error instanceof ApiError ? error.message : 'The selection could not be created.' }); await this.cleanup(this.job(id)!); }
      else if(remote) {try{await this.google.deleteSession(session,contributorId,remote.id);}catch{/* Google expires an unreachable selection automatically. */}}
      throw error;
    } finally { this.creating.delete(session.workspaceId); }
  }

  async get(session: WorkspaceSession, id: string): Promise<PickerState> {
    this.remember(session);
    let job = this.ownerJob(session.workspaceId, id);
    if (['waiting', 'ready'].includes(job.status) && job.deadline <= Date.now()) await this.expire(job);
    job = this.job(id)!;
    const existing = this.polling.get(id);
    if (existing) await existing;
    else if (job.status === 'waiting' && job.next_poll_at <= Date.now()) {
      const task = this.poll(job).finally(() => { this.polling.delete(id); });
      this.polling.set(id, task); await task;
    }
    job = this.job(id)!;
    if (job.cleanup_pending && job.cleanup_after <= Date.now()) await this.cleanup(job);
    await this.wake();
    return this.state(this.job(id)!);
  }

  private async poll(job: JobRow) {
    const abort = new AbortController(); this.pollAbort.set(job.id,abort);
    this.update(job.id, { next_poll_at: Date.now() + job.poll_interval_ms });
    try {
      const session = await this.sessionFor(job);
      const google = await this.google.getSession(session, job.contributor_id, job.google_session_id, abort.signal);
      const current = this.job(job.id)!;
      if (current.status !== 'waiting') return;
      this.configure(current, google);
      if (this.job(job.id)!.deadline <= Date.now()) await this.expire(this.job(job.id)!);
    } catch (error) { if (!abort.signal.aborted && this.job(job.id)?.status === 'waiting') await this.jobError(job, error, 'polling'); }
    finally {this.pollAbort.delete(job.id);}
  }

  async startImport(session: WorkspaceSession, id: string): Promise<PickerState> {
    this.remember(session);
    const job = this.ownerJob(session.workspaceId, id);
    if (job.status === 'importing' || job.status === 'complete') return this.state(job);
    if (job.deadline <= Date.now()) { await this.expire(job); return this.state(this.job(id)!); }
    if (job.status !== 'ready') throw new ApiError(409, 'PICKER_NOT_READY', 'Finish selecting photos in Google Photos and choose Done before importing.');
    try{await this.media.preflight();}catch(error){
      if(error instanceof ApiError && error.status===507) {this.update(id,{status:'paused',message:error.message});return this.state(this.job(id)!);}
      throw error;
    }
    this.update(id, { status: 'importing', phase: 'listing', session_id: this.db.seal(session.id ?? session.workspaceId), message: 'Retrieving your selected photos and starting the download queue…' });
    await this.wake();
    return this.state(this.job(id)!);
  }

  async retryFailed(session: WorkspaceSession, id: string): Promise<PickerState> { return this.resumeJob(session, id, true); }
  async resume(session: WorkspaceSession, id: string): Promise<PickerState> { return this.resumeJob(session, id, false); }

  private async resumeJob(session: WorkspaceSession, id: string, retryFailed: boolean): Promise<PickerState> {
    this.remember(session);
    let job = this.ownerJob(session.workspaceId, id);
    if (job.requires_selection || job.cleanup_done) throw new ApiError(409, 'RENEW_SELECTION_REQUIRED', 'This Google selection is no longer available. Choose the remaining photos again. Completed photos and duplicate detection are preserved.');
    if (!session.credentials?.[job.contributor_id]) throw new ApiError(401, 'RECONNECT_REQUIRED', 'Reconnect this Google account before resuming the import.');
    if (job.expires_at <= Date.now()) { await this.expire(job); return this.state(this.job(id)!); }
    await this.media.preflight();
    await this.authorized(session);
    job=this.ownerJob(session.workspaceId,id);
    try {
      this.assertAccountBinding(job,session);
      const google = await this.google.getSession(session, job.contributor_id, job.google_session_id);
      if (!google.mediaItemsSet) { this.configure(job, google); return this.state(this.job(id)!); }
    } catch (error) { await this.jobError(job, error, 'listing'); return this.state(this.job(id)!); }
    this.db.transaction(() => {
      if (retryFailed) this.db.connection.prepare(`UPDATE import_items SET status='pending',attempts=0,next_attempt_at=0,error_code=NULL,error_message=NULL WHERE job_id=? AND status='failed'`).run(id);
      const expiredLinks = Boolean(this.db.connection.prepare(`SELECT 1 FROM import_items WHERE job_id=? AND status IN ('pending','retry') AND (url_expires_at<=? OR base_url IS NULL) LIMIT 1`).get(id, Date.now()));
      if (expiredLinks) {
        this.db.connection.prepare('DELETE FROM import_pages WHERE job_id=?').run(id);
        this.update(id, { listing_complete: 0, next_page_token: null, next_list_at: 0, url_refreshes: 0 });
      }
      this.update(id, { status: 'importing', phase: 'downloading', requires_auth: 0, requires_selection: 0, listing_attempts: 0, next_list_at: 0, rate_limited_until: 0, message: 'Resuming from saved checkpoints. Completed photos will not be downloaded again.' });
    });
    await this.wake(); job = this.job(id)!;
    return this.state(job);
  }

  async cancel(session: WorkspaceSession, id: string): Promise<PickerState> {
    this.remember(session);
    const job = this.ownerJob(session.workspaceId, id);
    if (!job.cleanup_done && job.status!=='cancelled') {
      this.update(id, { status: 'cancelled', message: 'Import cancelled. Completed photos remain in your project. Start a new selection for unfinished photos.' });
      this.abortJob(id);
      this.pollAbort.get(id)?.abort();
      const polling = this.polling.get(id);
      if (polling) await polling;
      await this.settleJob(id);
      const progress = this.state(this.job(id)!);
      if (progress.remaining || progress.failed) this.update(id, { requires_selection: 1 });
      await this.cleanup(this.job(id)!);
    }
    return this.state(this.job(id)!);
  }

  private async expire(job: JobRow) {
    this.update(job.id, { status: 'expired', requires_selection: 1, message: 'This Google Photos selection expired. Photos already imported are safe. Select the remaining photos again.' });
    this.abortJob(job.id);
    await this.settleJob(job.id);
    await this.cleanup(this.job(job.id)!);
  }

  override async dispose() {
    for(const abort of this.pollAbort.values()) abort.abort();
    await super.dispose();
    await Promise.allSettled([...this.polling.values()]);
  }
}
