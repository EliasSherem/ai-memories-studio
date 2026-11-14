import {constants,createWriteStream} from 'node:fs';
import {lstat,mkdir,open,rename,rm,statfs,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import sharp from 'sharp';
import {z} from 'zod';
import type {MediaStore} from './media-store.js';
import {ApiError} from './errors.js';
const uuid=z.string().uuid(),digest=z.string().regex(/^[a-f0-9]{64}$/);
const CACHE_VERSION='v1',MAXIMUM_CONCURRENCY=4,MAXIMUM_THUMBNAIL_BYTES=1024*1024;

/** Private derived images only. Ownership is checked on every hit, including cached hits. */
export class PhotoThumbnails {
 private active=0;private waiters:(()=>void)[]=[];private pending=new Map<string,Promise<{file:string;etag:string}>>();
 constructor(readonly media:MediaStore){media.db.connection.exec(`
  CREATE TABLE IF NOT EXISTS photo_thumbnail_files(project_id TEXT NOT NULL REFERENCES projects(id),asset_id TEXT NOT NULL,storage_name TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(project_id,storage_name));
  CREATE TABLE IF NOT EXISTS photo_thumbnail_reservations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),storage_name TEXT NOT NULL,temporary_name TEXT NOT NULL,bytes INTEGER NOT NULL,writer_pid INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(project_id,storage_name));
 `);}
 private bytes(table:string){return Number((this.media.db.connection.prepare(`SELECT COALESCE(SUM(bytes),0) bytes FROM ${table}`).get() as {bytes:number}).bytes);}
 private total(){let bytes=0;for(const table of ['assets','video_media_files','movie_media_files','storage_reservations','video_media_reservations','movie_media_reservations','photo_thumbnail_files','photo_thumbnail_reservations'])if(this.media.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))bytes+=this.bytes(table);return bytes;}
 private reserve(projectId:string,storageName:string,temporaryName:string){return this.media.db.transaction(()=>{if(this.total()+MAXIMUM_THUMBNAIL_BYTES>this.media.storageQuotaBytes)throw new ApiError(507,'STORAGE_QUOTA_EXCEEDED','The private storage quota cannot cover a local photo preview. Free space or increase STORAGE_QUOTA_BYTES.');if(this.media.db.connection.prepare('SELECT 1 FROM photo_thumbnail_reservations WHERE project_id=? AND storage_name=?').get(projectId,storageName))throw new ApiError(409,'THUMBNAIL_WRITE_ACTIVE','Another local worker is preparing this preview. Reload it after that write completes.');const id=randomUUID();this.media.db.connection.prepare('INSERT INTO photo_thumbnail_reservations(id,project_id,storage_name,temporary_name,bytes,writer_pid,created_at) VALUES(?,?,?,?,?,?,?)').run(id,projectId,storageName,temporaryName,MAXIMUM_THUMBNAIL_BYTES,process.pid,Date.now());return id;});}
 private record(projectId:string,assetId:string,name:string,sha:string,bytes:number,reservation?:string){this.media.db.transaction(()=>{const existing=this.media.db.connection.prepare('SELECT bytes FROM photo_thumbnail_files WHERE project_id=? AND storage_name=?').get(projectId,name) as {bytes:number}|undefined,held=reservation?(this.media.db.connection.prepare('SELECT bytes FROM photo_thumbnail_reservations WHERE id=?').get(reservation) as {bytes:number}|undefined)?.bytes??0:0;if(this.total()-(existing?.bytes??0)-held+bytes>this.media.storageQuotaBytes)throw new ApiError(507,'STORAGE_QUOTA_EXCEEDED','The private storage quota cannot cover this photo preview.');this.media.db.connection.prepare('INSERT INTO photo_thumbnail_files(project_id,asset_id,storage_name,bytes,sha256,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,storage_name) DO UPDATE SET bytes=excluded.bytes,sha256=excluded.sha256').run(projectId,assetId,name,bytes,sha,Date.now());if(reservation)this.media.db.connection.prepare('DELETE FROM photo_thumbnail_reservations WHERE id=?').run(reservation);});}
 private async recover(projectId:string,directory:string){for(const row of this.media.db.connection.prepare('SELECT id,temporary_name,writer_pid FROM photo_thumbnail_reservations WHERE project_id=?').all(projectId) as {id:string;temporary_name:string;writer_pid:number}[]){let alive=false;try{process.kill(row.writer_pid,0);alive=true;}catch(error){alive=(error as NodeJS.ErrnoException).code==='EPERM';}if(!alive){if(/^[a-f0-9-]{36}-[a-f0-9-]{36}\.part$/.test(row.temporary_name))await rm(join(directory,row.temporary_name),{force:true});this.media.db.connection.prepare('DELETE FROM photo_thumbnail_reservations WHERE id=?').run(row.id);}}}

 private async directory(projectId:string){
  for(const directory of [this.media.root,join(this.media.root,uuid.parse(projectId))]){const info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())throw new ApiError(404,'THUMBNAIL_SOURCE_UNAVAILABLE','The private photo directory is unavailable.');}
  const directory=join(this.media.root,projectId,'.thumbnails');
  try{await mkdir(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
  const info=await lstat(directory);if(info.isSymbolicLink()||!info.isDirectory())throw new ApiError(404,'THUMBNAIL_SOURCE_UNAVAILABLE','The private thumbnail directory is unavailable.');
  return directory;
 }
 private async exists(file:string){try{const info=await lstat(file);if(info.isSymbolicLink()||!info.isFile()||!info.size||info.size>MAXIMUM_THUMBNAIL_BYTES)throw new ApiError(404,'THUMBNAIL_SOURCE_UNAVAILABLE','The private thumbnail is unavailable.');return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}}
 private async acquire(){if(this.active<MAXIMUM_CONCURRENCY){this.active++;return;}await new Promise<void>(resolve=>this.waiters.push(resolve));}
 private release(){const next=this.waiters.shift();if(next)next();else this.active--;}
 private async render(source:string,temporary:string){
  const handle=await open(source,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   const info=await handle.stat();if(!info.isFile()||info.size>this.media.maxImageBytes)throw new ApiError(404,'THUMBNAIL_SOURCE_UNAVAILABLE','The private source photograph is unavailable.');
   await pipeline(handle.createReadStream({autoClose:false}),sharp({limitInputPixels:100_000_000,failOn:'error',sequentialRead:true}).rotate().resize({width:320,height:320,fit:'inside',withoutEnlargement:true}).flatten({background:'#f5f1e8'}).jpeg({quality:78}),createWriteStream(temporary,{flags:'wx',mode:0o600}));
  }finally{await handle.close();}
 }
 async content(ownerId:string,projectId:string,assetId:string):Promise<{file:string;etag:string}>{
  uuid.parse(ownerId);uuid.parse(projectId);uuid.parse(assetId);this.media.assertOwnership(ownerId,projectId);
  const source=await this.media.content(ownerId,projectId,assetId),sha=digest.parse(source.asset.sha256),directory=await this.directory(projectId);
  const sourceInfo=await lstat(source.file);if(sourceInfo.isSymbolicLink()||!sourceInfo.isFile())throw new ApiError(404,'THUMBNAIL_SOURCE_UNAVAILABLE','The private source photograph is unavailable.');
  await this.recover(projectId,directory);
  const storageName=`${assetId}-${sha}-${CACHE_VERSION}.jpg`,key=`${projectId}:${assetId}:${sha}:${CACHE_VERSION}`,file=join(directory,storageName),etag=`"${assetId}-${sha}-${CACHE_VERSION}"`;
  if(await this.exists(file)){this.record(projectId,assetId,storageName,sha,(await lstat(file)).size);return {file,etag};}
  this.media.db.connection.prepare('DELETE FROM photo_thumbnail_files WHERE project_id=? AND storage_name=?').run(projectId,storageName);
  const prior=this.pending.get(key);if(prior)return prior;
  const work=(async()=>{
   await this.acquire();const temporaryName=`${assetId}-${randomUUID()}.part`,temporary=join(directory,temporaryName);let reservation:string|undefined;
   try{
    if(await this.exists(file))return {file,etag};
    // Recheck the directory after waiting so queued work cannot follow a replaced symlink.
    await this.directory(projectId);const disk=await statfs(directory);if(Number(disk.bavail)*Number(disk.bsize)<this.media.minFreeDiskBytes+MAXIMUM_THUMBNAIL_BYTES)throw new ApiError(507,'DISK_SPACE_LOW','Free local disk space before creating photo previews.');
    reservation=this.reserve(projectId,storageName,temporaryName);
    await this.render(source.file,temporary);if(!await this.exists(temporary))throw new ApiError(422,'THUMBNAIL_INVALID','The photograph could not produce a usable preview.');
    const handle=await open(temporary,constants.O_RDWR|constants.O_NOFOLLOW);try{await handle.sync();}finally{await handle.close();}
    const bytes=(await lstat(temporary)).size;await rename(temporary,file);this.record(projectId,assetId,storageName,sha,bytes,reservation);return {file,etag};
   }catch(error){if(error instanceof ApiError)throw error;if((error as NodeJS.ErrnoException).code==='ENOSPC')throw new ApiError(507,'DISK_SPACE_LOW','Free local disk space before creating photo previews.');throw new ApiError(422,'THUMBNAIL_INVALID','This photograph could not be decoded for a local preview. The original has not been changed.');}
   finally{if(reservation)this.media.db.connection.prepare('DELETE FROM photo_thumbnail_reservations WHERE id=?').run(reservation);await rm(temporary,{force:true});this.release();}
  })();
  this.pending.set(key,work);try{return await work;}finally{if(this.pending.get(key)===work)this.pending.delete(key);}
 }
 /** Called after deleting an imported asset; only generated cache names for this asset match. */
 async remove(ownerId:string,projectId:string,assetId:string){uuid.parse(assetId);this.media.assertOwnership(ownerId,projectId);const directory=await this.directory(projectId),pattern=new RegExp(`^${assetId}-[a-f0-9]{64}-${CACHE_VERSION}\\.jpg$`);for(const name of await readdir(directory))if(pattern.test(name)){const file=join(directory,name),info=await lstat(file);if(!info.isSymbolicLink()&&info.isFile())await rm(file,{force:true});this.media.db.connection.prepare('DELETE FROM photo_thumbnail_files WHERE project_id=? AND storage_name=?').run(projectId,name);}}
}
