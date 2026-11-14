import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { assetSchema, type Asset, type ContributorId, type GalleryQuery, type ProjectState } from '@memories/shared';
import { ApiError } from './errors.js';
import { StudioDatabase } from './database.js';
import type { PickedMediaItem } from './google.js';

export const MAX_IMAGE_BYTES = 100 * 1024 * 1024;
export const IMAGE_TYPES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp'], ['image/gif', 'gif']]);
const uuid = z.string().uuid();
const storageNameSchema = z.string().regex(/^[a-f0-9-]{36}\.(jpg|png|webp|gif)$/);
const storedSchema = assetSchema.omit({ url: true }).extend({ storageName: storageNameSchema });
type StoredAsset = z.infer<typeof storedSchema>;
export type ImportCheckpoint = { jobId: string; itemId: string; workerId?: string };
export type ImportResult = Asset & { duplicate?: boolean };
export type MediaStoreOptions = { databasePath?: string; sessionSecret?: string; storageQuotaBytes?: number; minFreeDiskBytes?: number; maxImageBytes?: number };
export type ImportOptions = { remainingBytes?: number; signal: AbortSignal; onBytes: (count: number) => void; checkpoint?: ImportCheckpoint };
type AssetRow = { id: string; storage_name: string; public_json: string; sha256: string; bytes: number; selected: number; source_count?: number };

export function displayFilename(value: string): string {
  return path.basename(value.replaceAll('\\', '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'Untitled photo';
}
export function originalMetadata(item: PickedMediaItem): Record<string, unknown> {
  const { baseUrl: _temporaryUrl, ...mediaFile } = item.mediaFile;
  return { ...item, mediaFile };
}
function isImage(bytes: Buffer, mime: string): boolean {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  return mime === 'image/webp' && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
}
async function hashFile(file: string): Promise<{ sha256: string; bytes: number; head: Buffer }> {
  const hash = createHash('sha256'); let bytes = 0; let head = Buffer.alloc(0);
  for await (const chunk of createReadStream(file)) {
    const buffer = chunk as Buffer;
    hash.update(buffer); bytes += buffer.length;
    if (head.length < 16) head = Buffer.concat([head, buffer.subarray(0, 16 - head.length)]);
  }
  return { sha256: hash.digest('hex'), bytes, head };
}

/** SQLite is authoritative. Files and metadata stay underneath a private project directory. */
export class MediaStore {
  readonly root: string;
  readonly db: StudioDatabase;
  readonly maxImageBytes: number;
  readonly storageQuotaBytes: number;
  readonly minFreeDiskBytes: number;
  private ensuring = new Map<string, Promise<void>>();

  constructor(root: string, options: MediaStoreOptions = {}) {
    this.root = path.resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 }); chmodSync(this.root, 0o700);
    this.db = new StudioDatabase(options.databasePath ?? path.join(this.root, '.studio.sqlite'), options.sessionSecret ?? randomBytes(32).toString('hex'));
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
    this.storageQuotaBytes = options.storageQuotaBytes ?? 20 * 1024 ** 3;
    this.minFreeDiskBytes = options.minFreeDiskBytes ?? 128 * 1024 ** 2;
    this.db.connection.exec(`
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL, migration_complete INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), sha256 TEXT NOT NULL,
        storage_name TEXT NOT NULL, bytes INTEGER NOT NULL, selected INTEGER NOT NULL DEFAULT 1,
        public_json TEXT NOT NULL, UNIQUE(project_id, sha256)
      );
      CREATE INDEX IF NOT EXISTS assets_project ON assets(project_id);
      CREATE TABLE IF NOT EXISTS media_sources (
        id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id), contributor_id TEXT NOT NULL,
        google_media_id TEXT NOT NULL, original_metadata_json TEXT NOT NULL,
        UNIQUE(project_id, contributor_id, google_media_id)
      );
      CREATE INDEX IF NOT EXISTS media_sources_asset ON media_sources(asset_id);
      CREATE TABLE IF NOT EXISTS storage_reservations (id TEXT PRIMARY KEY, worker_id TEXT, bytes INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS media_analysis_jobs (
        id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        provider TEXT, model TEXT, pipeline_version TEXT, state TEXT NOT NULL DEFAULT 'not_requested',
        attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(asset_id, pipeline_version)
      );
      CREATE TABLE IF NOT EXISTS media_analysis_results (
        id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        provider TEXT NOT NULL, model TEXT NOT NULL, pipeline_version TEXT NOT NULL,
        sharpness REAL, composition REAL, visual_diversity REAL, storytelling_potential REAL,
        embedding_json TEXT, result_json TEXT, analyzed_at TEXT NOT NULL,
        UNIQUE(asset_id, provider, model, pipeline_version)
      );
    `);
    const projectColumns=this.db.connection.prepare('PRAGMA table_info(projects)').all() as {name:string}[];
    if(!projectColumns.some(column=>column.name==='migration_complete')) this.db.connection.exec('ALTER TABLE projects ADD COLUMN migration_complete INTEGER NOT NULL DEFAULT 0');
    const itemColumns=this.db.connection.prepare('PRAGMA table_info(import_items)').all() as {name:string}[];
    if(!itemColumns.some(column=>column.name==='checkpoint_json')) this.db.connection.exec('ALTER TABLE import_items ADD COLUMN checkpoint_json TEXT');
    if(!itemColumns.some(column=>column.name==='staging_worker')) this.db.connection.exec('ALTER TABLE import_items ADD COLUMN staging_worker TEXT');
  }
  private directory(ownerId: string): string { uuid.parse(ownerId); return path.join(this.root, ownerId); }
  private async durableJson(file: string, data: unknown): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
      const handle = await open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  async ensure(ownerId: string): Promise<void> {
    const pending = this.ensuring.get(ownerId);
    if (pending) return pending;
    const operation = (async () => {
      const directory = this.directory(ownerId);
      await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700);
      const exists = this.db.connection.prepare('SELECT id FROM projects WHERE id=? AND owner_id=? AND migration_complete=1').get(ownerId, ownerId);
      if (exists) return;
      let legacy: { version?: number; ownerId?: string; project?: { id: string; name: string; createdAt: string }; assets?: unknown[] } | undefined;
      try { legacy = JSON.parse(await readFile(path.join(directory, 'metadata.json'), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (legacy && (legacy.ownerId !== ownerId || legacy.project?.id !== ownerId)) throw new ApiError(403, 'FORBIDDEN', 'This project belongs to another workspace.');
      const project = legacy?.project ?? { id: ownerId, name: 'Our first story', createdAt: new Date().toISOString() };
      this.db.connection.prepare('INSERT OR IGNORE INTO projects(id,owner_id,name,created_at) VALUES(?,?,?,?)').run(ownerId, ownerId, project.name, project.createdAt);
      // Retain existing P2 imports; hash files with streaming reads, without contacting Google.
      if (legacy?.version === 1 && legacy.assets) {
        for (const input of legacy.assets) {
          const old = storedSchema.extend({ googleMediaId: z.string() }).parse(input);
          if (old.projectId !== ownerId) throw new ApiError(403, 'FORBIDDEN', 'Invalid local project metadata.');
          const file = path.join(directory, old.storageName);
          if (!existsSync(file)) continue;
          const digest = await hashFile(file);
          const mediaFile = { baseUrl: '', filename: old.filename, mimeType: old.mimeType, mediaFileMetadata: { width: old.width, height: old.height } };
          const item: PickedMediaItem = { id: old.googleMediaId, type: 'PHOTO', createTime: old.createdAt, mediaFile };
          const imported=this.commit(ownerId, old.contributorId, item, { ...old, sha256: digest.sha256, bytes: digest.bytes });
          if(imported.duplicate && imported.id!==old.id) await rm(file,{force:true});
        }
      }
      await this.durableJson(path.join(directory, 'metadata.json'), { version: 2, ownerId, project, metadataStore: 'SQLite', fileMetadata: '*.metadata.json' });
      this.db.connection.prepare('UPDATE projects SET migration_complete=1 WHERE id=?').run(ownerId);
    })();
    this.ensuring.set(ownerId, operation);
    try { await operation; } finally { this.ensuring.delete(ownerId); }
  }
  assertOwnership(ownerId: string, projectId: string): void {
    if (!uuid.safeParse(projectId).success || projectId !== ownerId) throw new ApiError(404, 'NOT_FOUND', 'Project not found.');
  }
  private publicAsset(row: AssetRow): Asset {
    const { storageName: _storage, ...asset } = storedSchema.parse(JSON.parse(row.public_json));
    return { ...asset, selected: Boolean(row.selected), sha256: row.sha256, sourceCount: row.source_count ?? 1, url: `/api/projects/${asset.projectId}/assets/${asset.id}/content` };
  }
  async project(ownerId: string): Promise<Omit<ProjectState, 'picker'>> {
    await this.ensure(ownerId);
    const project = this.db.connection.prepare('SELECT id,name,created_at AS createdAt FROM projects WHERE id=? AND owner_id=?').get(ownerId, ownerId) as { id: string; name: string; createdAt: string };
    const rows = this.db.connection.prepare('SELECT a.*, (SELECT COUNT(*) FROM media_sources s WHERE s.asset_id=a.id) AS source_count FROM assets a WHERE project_id=? ORDER BY rowid').all(ownerId) as AssetRow[];
    return { project, assets: rows.map(row => this.publicAsset(row)) };
  }
  existingAsset(ownerId: string, contributorId: ContributorId, googleMediaId: string): Asset | undefined {
    const row = this.db.connection.prepare('SELECT a.*,(SELECT COUNT(*) FROM media_sources s WHERE s.asset_id=a.id) AS source_count FROM assets a JOIN media_sources s ON s.asset_id=a.id WHERE s.project_id=? AND s.contributor_id=? AND s.google_media_id=?').get(ownerId, contributorId, googleMediaId) as AssetRow | undefined;
    return row && existsSync(path.join(this.directory(ownerId), row.storage_name)) ? this.publicAsset(row) : undefined;
  }
  async exists(ownerId: string, contributorId: ContributorId, googleMediaId: string): Promise<boolean> { return Boolean(this.existingAsset(ownerId, contributorId, googleMediaId)); }
  async content(ownerId: string, projectId: string, assetId: string): Promise<{ file: string; asset: Asset }> {
    this.assertOwnership(ownerId, projectId);
    const row = this.db.connection.prepare('SELECT * FROM assets WHERE id=? AND project_id=?').get(assetId, ownerId) as AssetRow | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Photo not found.');
    const file = path.join(this.directory(ownerId), storageNameSchema.parse(row.storage_name));
    try { if (!(await stat(file)).isFile()) throw new Error(); } catch { throw new ApiError(404, 'NOT_FOUND', 'The local photo file is missing.'); }
    return { file, asset: this.publicAsset(row) };
  }
  async select(ownerId: string, projectId: string, assetId: string, selected: boolean): Promise<Asset> {
    this.assertOwnership(ownerId, projectId);
    this.db.connection.prepare('UPDATE assets SET selected=? WHERE project_id=? AND id=?').run(selected ? 1 : 0, ownerId, assetId);
    const row = this.db.connection.prepare('SELECT * FROM assets WHERE project_id=? AND id=?').get(ownerId, assetId) as AssetRow | undefined;
    if (!row) throw new ApiError(404, 'NOT_FOUND', 'Photo not found.');
    return this.publicAsset(row);
  }
  async bulkSelect(ownerId: string, projectId: string, selected: boolean, options: { ids?: string[]; query?: GalleryQuery }): Promise<number> {
    this.assertOwnership(ownerId, projectId);
    const assets = (await this.project(ownerId)).assets;
    const ids = options.ids ? new Set(options.ids) : undefined;
    const query = options.query ?? {};
    const search = query.search?.toLocaleLowerCase().trim();
    const matches = assets.filter(asset => (!ids || ids.has(asset.id)) && (!search || `${asset.filename} ${asset.createdAt ?? ''} ${asset.importedAt}`.toLocaleLowerCase().includes(search)) && (!query.contributorId || asset.contributorId === query.contributorId) && (query.selected === undefined || asset.selected === query.selected) && (!query.mimeType || asset.mimeType === query.mimeType));
    this.db.transaction(() => {
      const update = this.db.connection.prepare('UPDATE assets SET selected=? WHERE id=? AND project_id=?');
      for (const asset of matches) update.run(selected ? 1 : 0, asset.id, ownerId);
    });
    return matches.length;
  }
  async delete(ownerId: string, projectId: string, assetId: string): Promise<void> {
    const { file } = await this.content(ownerId, projectId, assetId);
    this.db.connection.prepare('DELETE FROM assets WHERE project_id=? AND id=?').run(ownerId, assetId);
    await rm(file, { force: true });
    await rm(path.join(this.directory(ownerId), `${assetId}.metadata.json`), { force: true });
  }
  private thumbnailBytes(table:'photo_thumbnail_files'|'photo_thumbnail_reservations'):number {return this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?Number((this.db.connection.prepare(`SELECT COALESCE(SUM(bytes),0) bytes FROM ${table}`).get() as {bytes:number}).bytes):0;}
  private storageBytes(): number {
    const photos=Number((this.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM assets').get() as { bytes: number }).bytes);
    const p4=this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_media_files'").get();
    const p5=this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='movie_media_files'").get();
    return photos+this.thumbnailBytes('photo_thumbnail_files')+(p4?Number((this.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM video_media_files').get() as {bytes:number}).bytes):0)+(p5?Number((this.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM movie_media_files').get() as {bytes:number}).bytes):0);
  }
  private reservations(): number {
    const photos=Number((this.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM storage_reservations').get() as { bytes: number }).bytes);
    const p4=this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='video_media_reservations'").get();
    const p5=this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='movie_media_reservations'").get();
    return photos+this.thumbnailBytes('photo_thumbnail_reservations')+(p4?Number((this.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM video_media_reservations').get() as {bytes:number}).bytes):0)+(p5?Number((this.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM movie_media_reservations').get() as {bytes:number}).bytes):0);
  }
  async preflight(requiredBytes = 1): Promise<void> {
    for (const row of this.db.connection.prepare('SELECT id,worker_id FROM storage_reservations WHERE worker_id IS NOT NULL').all() as { id: string; worker_id: string }[]) {
      if (!this.db.leaseOwned(row.worker_id)) this.db.connection.prepare('DELETE FROM storage_reservations WHERE id=?').run(row.id);
    }
    if (this.storageBytes() + this.reservations() + requiredBytes > this.storageQuotaBytes) throw new ApiError(507, 'STORAGE_QUOTA_EXCEEDED', 'The local storage quota is full. Free space or increase STORAGE_QUOTA_BYTES, then resume this import.');
    const disk = await statfs(this.root);
    if (Number(disk.bavail) * Number(disk.bsize) < this.minFreeDiskBytes + this.reservations() + requiredBytes) throw new ApiError(507, 'DISK_SPACE_LOW', 'There is not enough free disk space for this import. Free disk space, then resume.');
  }
  /** Reap abandoned incomplete staging files only after a new coordinator holds the lease. */
  async recoverStaging(workerId:string):Promise<void> {
    if(!this.db.leaseOwned(workerId)) return;
    for(const entry of await readdir(this.root,{withFileTypes:true})) {
      if(!entry.isDirectory() || !uuid.safeParse(entry.name).success) continue;
      const directory=this.directory(entry.name);
      for(const filename of await readdir(directory)) {
        const match=/^([a-f0-9-]{36})\.([a-f0-9-]{36})\.part$/.exec(filename);
        if(!match || !uuid.safeParse(match[1]).success || !uuid.safeParse(match[2]).success || match[2]===workerId) continue;
        this.db.transaction(()=>{
          if(!this.db.leaseOwned(workerId) || this.db.leaseOwned(match[2])) return;
          const checkpoint=this.db.connection.prepare('SELECT checkpoint_json FROM import_items WHERE id=? AND staging_worker=?').get(match[1],match[2]) as {checkpoint_json:string|null}|undefined;
          if(checkpoint?.checkpoint_json) return;
          const file=path.join(directory,filename);
          if(existsSync(file))unlinkSync(file);
        });
      }
    }
  }
  async discardJobStaging(jobId:string):Promise<void> {
    this.db.transaction(()=>{
      const job=this.db.connection.prepare('SELECT owner_id,status FROM import_jobs WHERE id=?').get(jobId) as {owner_id:string;status:string}|undefined;
      if(!job || !['cancelled','expired'].includes(job.status)) return;
      const directory=this.directory(job.owner_id);
      const items=this.db.connection.prepare('SELECT id,checkpoint_json,staging_worker FROM import_items WHERE job_id=? AND staging_worker IS NOT NULL').all(jobId) as {id:string;checkpoint_json:string|null;staging_worker:string}[];
      for(const item of items) {
        uuid.parse(item.id);uuid.parse(item.staging_worker);
        const part=path.join(directory,`${item.id}.${item.staging_worker}.part`);
        if(existsSync(part))unlinkSync(part);
        if(item.checkpoint_json) {
          const stored=storedSchema.parse(JSON.parse(item.checkpoint_json));
          const referenced=this.db.connection.prepare('SELECT 1 FROM assets WHERE project_id=? AND storage_name=?').get(job.owner_id,stored.storageName);
          const finalPath=path.join(directory,stored.storageName);
          if(!referenced && existsSync(finalPath))unlinkSync(finalPath);
        }
        this.db.connection.prepare('DELETE FROM storage_reservations WHERE id=?').run(item.id);
      }
      this.db.connection.prepare('UPDATE import_items SET checkpoint_json=NULL,staging_worker=NULL WHERE job_id=?').run(jobId);
    });
  }
  private fence(checkpoint?: ImportCheckpoint): void {
    if (!checkpoint) return;
    const row = this.db.connection.prepare("SELECT i.id FROM import_items i JOIN import_jobs j ON j.id=i.job_id WHERE i.id=? AND i.job_id=? AND i.status='downloading' AND i.lease_owner=? AND j.status='importing'").get(checkpoint.itemId, checkpoint.jobId, checkpoint.workerId ?? '');
    if (!row || !checkpoint.workerId || !this.db.leaseOwned(checkpoint.workerId)) throw new ApiError(409, 'WORKER_LEASE_LOST', 'Another worker is resuming this import.');
  }
  private commit(ownerId: string, contributorId: ContributorId, item: PickedMediaItem, stored: StoredAsset, checkpoint?: ImportCheckpoint): ImportResult {
    return this.db.transaction(() => {
      this.fence(checkpoint);
      this.db.connection.prepare('DELETE FROM storage_reservations WHERE id=? AND worker_id IS ?').run(stored.id,checkpoint?.workerId ?? null);
      let existing = this.db.connection.prepare('SELECT * FROM assets WHERE project_id=? AND sha256=?').get(ownerId, stored.sha256!) as AssetRow | undefined;
      const duplicate = Boolean(existing);
      if (!existing) {
        this.db.connection.prepare('INSERT INTO assets(id,project_id,sha256,storage_name,bytes,selected,public_json) VALUES(?,?,?,?,?,?,?)').run(stored.id, ownerId, stored.sha256!, stored.storageName, stored.bytes, stored.selected ? 1 : 0, JSON.stringify(stored));
        existing = this.db.connection.prepare('SELECT * FROM assets WHERE id=?').get(stored.id) as AssetRow;
        const now = new Date().toISOString();
        this.db.connection.prepare("INSERT INTO media_analysis_jobs(id,asset_id,state,created_at,updated_at) VALUES(?,?,'not_requested',?,?)").run(randomUUID(), stored.id, now, now);
      }
      this.db.connection.prepare('INSERT OR IGNORE INTO media_sources(id,asset_id,project_id,contributor_id,google_media_id,original_metadata_json) VALUES(?,?,?,?,?,?)').run(randomUUID(), existing.id, ownerId, contributorId, item.id, JSON.stringify(originalMetadata(item)));
      if (checkpoint) this.db.connection.prepare("UPDATE import_items SET status='completed',asset_id=?,duplicate=?,base_url=NULL,checkpoint_json=NULL,staging_worker=NULL,lease_owner=NULL WHERE id=? AND job_id=? AND lease_owner=?").run(existing.id, duplicate ? 1 : 0, checkpoint.itemId, checkpoint.jobId, checkpoint.workerId!);
      return { ...this.publicAsset(existing), duplicate };
    });
  }
  /** Fsynced file bytes and their SQLite checkpoint survive a crash before final commit. */
  async recoverImport(ownerId: string, contributorId: ContributorId, item: PickedMediaItem, checkpoint: ImportCheckpoint): Promise<ImportResult | undefined> {
    this.fence(checkpoint);
    const id=uuid.parse(checkpoint.itemId);
    const row=this.db.connection.prepare('SELECT checkpoint_json,staging_worker FROM import_items WHERE id=?').get(id) as {checkpoint_json:string|null;staging_worker:string|null};
    if(!row.checkpoint_json || !row.staging_worker) {
      if(row.staging_worker && row.staging_worker!==checkpoint.workerId && !this.db.leaseOwned(row.staging_worker)) {
        const stale=path.join(this.directory(ownerId),`${id}.${uuid.parse(row.staging_worker)}.part`);
        this.db.transaction(()=>{this.fence(checkpoint);if(existsSync(stale))unlinkSync(stale);this.db.connection.prepare('UPDATE import_items SET staging_worker=NULL WHERE id=?').run(id);});
      }
      return undefined;
    }
    const stored=storedSchema.parse(JSON.parse(row.checkpoint_json));
    const oldWorker=uuid.parse(row.staging_worker);
    if(stored.id!==id || stored.projectId!==ownerId || stored.contributorId!==contributorId) throw new ApiError(422,'INVALID_CHECKPOINT','The local import checkpoint is damaged. Retry this photo.');
    const finalPath=path.join(this.directory(ownerId),stored.storageName);
    const staging=path.join(this.directory(ownerId),`${id}.${oldWorker}.part`);
    const file=existsSync(finalPath)?finalPath:staging;
    if(!existsSync(file)) {
      this.db.transaction(()=>{this.fence(checkpoint);this.db.connection.prepare('UPDATE import_items SET checkpoint_json=NULL,staging_worker=NULL WHERE id=?').run(id);});
      return undefined;
    }
    const digest=await hashFile(file);
    this.fence(checkpoint);
    if(digest.sha256!==stored.sha256 || digest.bytes!==stored.bytes || !isImage(digest.head,stored.mimeType)) {
      this.db.transaction(()=>{this.fence(checkpoint);this.db.connection.prepare('UPDATE import_items SET checkpoint_json=NULL,staging_worker=NULL WHERE id=?').run(id);if(existsSync(file))unlinkSync(file);});
      return undefined;
    }
    const result=this.db.transaction(()=>{
      this.fence(checkpoint);
      if(file!==finalPath) renameSync(file,finalPath);
      return this.commit(ownerId,contributorId,item,stored,checkpoint);
    });
    if(result.duplicate && result.id!==id) await rm(finalPath,{force:true});
    if(!result.duplicate) await this.durableJson(path.join(this.directory(ownerId),`${result.id}.metadata.json`),{asset:result,originalMetadata:originalMetadata(item)});
    return result;
  }
  async import(ownerId: string, contributorId: ContributorId, item: PickedMediaItem, response: Response, options: ImportOptions): Promise<ImportResult> {
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    const extension = IMAGE_TYPES.get(mime);
    if (!extension || mime !== item.mediaFile.mimeType) { await response.body?.cancel(); throw new ApiError(422, 'UNSUPPORTED_IMAGE', 'The downloaded file type does not match a supported image.'); }
    const length = response.headers.get('content-length');
    const limit = Math.min(this.maxImageBytes, options.remainingBytes ?? Number.MAX_SAFE_INTEGER);
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) { await response.body?.cancel(); throw new ApiError(413, 'IMAGE_TOO_LARGE', 'This photo exceeds the configured MAX_IMAGE_BYTES limit.'); }
    if (!response.body) throw new ApiError(502, 'EMPTY_DOWNLOAD', 'Google returned an empty photo.');
    try { await this.preflight(length ? Number(length) : 1); } catch (error) { await response.body.cancel(); throw error; }
    this.fence(options.checkpoint);
    const id = options.checkpoint ? uuid.parse(options.checkpoint.itemId) : randomUUID();
    const storageName = `${id}.${extension}`;
    const stagingWorker=options.checkpoint?.workerId;
    const temporary = path.join(this.directory(ownerId), `${id}${stagingWorker?`.${uuid.parse(stagingWorker)}`:''}.part`);
    const finalPath = path.join(this.directory(ownerId), storageName);
    await rm(temporary, { force: true });
    this.db.transaction(()=>{
      this.fence(options.checkpoint);
      this.db.connection.prepare('INSERT OR REPLACE INTO storage_reservations(id,worker_id,bytes) VALUES(?,?,0)').run(id,stagingWorker ?? null);
      if(options.checkpoint) this.db.connection.prepare('UPDATE import_items SET staging_worker=?,checkpoint_json=NULL WHERE id=?').run(stagingWorker!,id);
    });
    let bytes = 0; let head = Buffer.alloc(0); let committed = false; let recoverable = false;
    const hash = createHash('sha256');
    const check = new Transform({ transform: (chunk: Buffer, _encoding, callback) => {
      try {
        this.fence(options.checkpoint);
        bytes += chunk.length; options.onBytes(chunk.length);
        if (bytes > limit) throw new ApiError(413, 'IMAGE_TOO_LARGE', 'This photo exceeds the configured MAX_IMAGE_BYTES limit.');
        this.db.transaction(() => {
          if (this.storageBytes() + this.reservations() + chunk.length > this.storageQuotaBytes) throw new ApiError(507, 'STORAGE_QUOTA_EXCEEDED', 'The local storage quota is full. Free space or increase STORAGE_QUOTA_BYTES, then resume.');
          this.db.connection.prepare('UPDATE storage_reservations SET bytes=? WHERE id=?').run(bytes, id);
        });
        hash.update(chunk);
        if (head.length < 16) head = Buffer.concat([head, chunk.subarray(0, 16 - head.length)]);
        void statfs(this.root).then(disk=>{
          if(Number(disk.bavail)*Number(disk.bsize)<this.minFreeDiskBytes+this.reservations()) {callback(new ApiError(507,'DISK_SPACE_LOW','Disk space is low. Free space and resume this import.'));return;}
          try {this.fence(options.checkpoint);callback(null,chunk);} catch(error) {callback(error as Error);}
        },error=>callback(error));
      } catch (error) { callback(error as Error); }
    } });
    try {
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), check, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal: options.signal });
      if (!bytes || !isImage(head, mime)) throw new ApiError(422, 'INVALID_IMAGE', 'The downloaded file is not a valid supported image.');
      options.signal.throwIfAborted(); this.fence(options.checkpoint);
      const file = await open(temporary, 'r+'); try { await file.sync(); } finally { await file.close(); }
      const metadata = item.mediaFile.mediaFileMetadata;
      const stored: StoredAsset = { id, projectId: ownerId, contributorId, storageName, filename: displayFilename(item.mediaFile.filename), mimeType: mime, bytes, sha256: hash.digest('hex'), importedAt: new Date().toISOString(), createdAt: item.createTime, width: metadata?.width, height: metadata?.height, selected: true };
      if(options.checkpoint) {
        this.db.transaction(()=>{this.fence(options.checkpoint);this.db.connection.prepare('UPDATE import_items SET checkpoint_json=?,staging_worker=? WHERE id=?').run(JSON.stringify(stored),stagingWorker!,id);});
        recoverable=true;
      }
      const result=this.db.transaction(()=>{
        this.fence(options.checkpoint);options.signal.throwIfAborted();
        renameSync(temporary,finalPath);
        return this.commit(ownerId,contributorId,item,stored,options.checkpoint);
      });
      committed = true;
      if (result.duplicate && result.id !== id) await rm(finalPath, { force: true });
      // Never replace original metadata when another source has identical content.
      if (!result.duplicate) await this.durableJson(path.join(this.directory(ownerId), `${result.id}.metadata.json`), { asset: result, originalMetadata: originalMetadata(item) });
      return result;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOSPC') throw new ApiError(507, 'DISK_SPACE_LOW', 'Disk space ran out. Free space and resume the import.');
      throw error;
    } finally {
      this.db.connection.prepare('DELETE FROM storage_reservations WHERE id=? AND worker_id IS ?').run(id,stagingWorker ?? null);
      if(committed || !recoverable) await rm(temporary,{force:true});
      // Completed uncommitted files are retained for checkpoint recovery. An old worker
      // never removes a shared final path after losing its lease.
      if(!committed && !recoverable && !options.checkpoint) await rm(finalPath,{force:true});
    }
  }
}
