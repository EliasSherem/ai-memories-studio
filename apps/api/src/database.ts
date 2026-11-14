import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/** Private local SQLite state. Temporary Google capabilities are encrypted separately. */
export class StudioDatabase {
  readonly connection: DatabaseSync;
  private readonly key: Buffer;
  private transactionDepth = 0;
  private closed = false;

  constructor(readonly path: string, secret: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      chmodSync(dirname(path), 0o700);
    }
    this.key = createHash('sha256').update('ai-memories-studio:queue:').update(secret).digest();
    this.connection = new DatabaseSync(path);
    this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.connection.exec(`
      CREATE TABLE IF NOT EXISTS import_jobs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        contributor_id TEXT NOT NULL CHECK(contributor_id IN ('person1','person2')),
        google_session_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        picker_uri TEXT,
        status TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'waiting',
        poll_interval_ms INTEGER NOT NULL,
        next_poll_at INTEGER NOT NULL,
        deadline INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        message TEXT,
        listing_complete INTEGER NOT NULL DEFAULT 0,
        next_page_token TEXT,
        listing_attempts INTEGER NOT NULL DEFAULT 0,
        next_list_at INTEGER NOT NULL DEFAULT 0,
        rate_limited_until INTEGER NOT NULL DEFAULT 0,
        requires_auth INTEGER NOT NULL DEFAULT 0,
        requires_selection INTEGER NOT NULL DEFAULT 0,
        cleanup_pending INTEGER NOT NULL DEFAULT 0,
        cleanup_done INTEGER NOT NULL DEFAULT 0,
        cleanup_after INTEGER NOT NULL DEFAULT 0,
        url_refreshes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS import_jobs_owner ON import_jobs(owner_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS import_items (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
        google_media_id TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        base_url TEXT,
        url_expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL DEFAULT 0,
        lease_owner TEXT,
        asset_id TEXT,
        duplicate INTEGER NOT NULL DEFAULT 0,
        url_failures INTEGER NOT NULL DEFAULT 0,
        url_generation INTEGER NOT NULL DEFAULT 0,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(job_id,google_media_id)
      );
      CREATE INDEX IF NOT EXISTS import_items_ready ON import_items(status,next_attempt_at,url_expires_at);
      CREATE INDEX IF NOT EXISTS import_items_job ON import_items(job_id,status);
      CREATE TABLE IF NOT EXISTS import_pages (
        job_id TEXT NOT NULL REFERENCES import_jobs(id) ON DELETE CASCADE,
        token TEXT NOT NULL,
        PRIMARY KEY(job_id,token)
      );
      CREATE TABLE IF NOT EXISTS worker_lease (
        id INTEGER PRIMARY KEY CHECK(id=1),
        owner TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    const version=this.connection.prepare('PRAGMA user_version').get() as {user_version:number};
    if(version.user_version<2) this.connection.exec('PRAGMA user_version=2');
    const itemColumns = this.connection.prepare('PRAGMA table_info(import_items)').all() as {name:string}[];
    if(!itemColumns.some(column=>column.name==='url_failures')) this.connection.exec('ALTER TABLE import_items ADD COLUMN url_failures INTEGER NOT NULL DEFAULT 0');
    if(!itemColumns.some(column=>column.name==='url_generation')) this.connection.exec('ALTER TABLE import_items ADD COLUMN url_generation INTEGER NOT NULL DEFAULT 0');
    const jobColumns=this.connection.prepare('PRAGMA table_info(import_jobs)').all() as {name:string}[];
    if(!jobColumns.some(column=>column.name==='account_id')) this.connection.exec('ALTER TABLE import_jobs ADD COLUMN account_id TEXT');
    if(!jobColumns.some(column=>column.name==='credential_fingerprint')) this.connection.exec('ALTER TABLE import_jobs ADD COLUMN credential_fingerprint TEXT');
  }

  transaction<T>(operation: () => T): T {
    if (this.transactionDepth) return operation();
    this.connection.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try {
      const result = operation();
      this.connection.exec('COMMIT');
      return result;
    } catch (error) {
      this.connection.exec('ROLLBACK');
      throw error;
    } finally { this.transactionDepth--; }
  }

  seal(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  unseal(value: string): string {
    const bytes = Buffer.from(value, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }

  acquireLease(owner: string, now = Date.now()): boolean {
    this.connection.prepare(`INSERT INTO worker_lease(id,owner,expires_at) VALUES(1,?,?)
      ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
      WHERE worker_lease.owner=excluded.owner OR worker_lease.expires_at<=?`).run(owner, now + 10000, now);
    return this.leaseOwned(owner, now);
  }

  leaseOwned(owner: string, now = Date.now()): boolean {
    return Boolean(this.connection.prepare('SELECT 1 FROM worker_lease WHERE id=1 AND owner=? AND expires_at>?').get(owner, now));
  }

  releaseLease(owner: string) { this.connection.prepare('DELETE FROM worker_lease WHERE id=1 AND owner=?').run(owner); }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.connection.close();
  }
}
