import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MediaStore } from '../src/media-store.js';
import type { PickedMediaItem } from '../src/google.js';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=','base64');
const disposals:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});
const image=(id:string):PickedMediaItem=>({id,type:'PHOTO',createTime:'2024-01-01T00:00:00Z',mediaFile:{baseUrl:'https://lh3.googleusercontent.com/temporary',filename:`${id}.png`,mimeType:'image/png',mediaFileMetadata:{width:1,height:1,cameraModel:'Original camera'}}});
async function fixture(options:ConstructorParameters<typeof MediaStore>[1]={}) {
  const root=await mkdtemp(path.join(tmpdir(),'memories-storage-recovery-'));
  const media=new MediaStore(root,{minFreeDiskBytes:0,...options});
  disposals.push(async()=>{media.db.close();await rm(root,{recursive:true,force:true});});
  const owner=randomUUID();await media.ensure(owner);return {root,owner,media};
}
const download=(body=png)=>new Response(body,{headers:{'content-type':'image/png'}});
const options=()=>({signal:new AbortController().signal,onBytes:()=>{}});
function checkpoint(media:MediaStore,owner:string,workerId:string,bytes=png) {
  const jobId=randomUUID(),itemId=randomUUID(),now=Date.now();
  media.db.connection.prepare(`INSERT INTO import_jobs(id,owner_id,project_id,contributor_id,google_session_id,session_id,status,poll_interval_ms,next_poll_at,deadline,expires_at,created_at,updated_at) VALUES(?,?,?,'person1','google-session',?,'importing',1000,?,?,?,?,?)`).run(jobId,owner,owner,media.db.seal('session-id'),now,now+60000,now+60000,now,now);
  const metadata=image('recovered-source');const {baseUrl:_url,...mediaFile}=metadata.mediaFile;
  media.db.connection.prepare(`INSERT INTO import_items(id,job_id,google_media_id,metadata_json,url_expires_at,status,lease_owner,created_at,updated_at) VALUES(?,?,?,?,?,'downloading',?,?,?)`).run(itemId,jobId,metadata.id,JSON.stringify({...metadata,mediaFile}),now+60000,workerId,now,now);
  const stored={id:itemId,projectId:owner,contributorId:'person1',filename:'recovered-source.png',mimeType:'image/png',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),selected:true,importedAt:new Date().toISOString(),storageName:`${itemId}.png`};
  media.db.connection.prepare('UPDATE import_items SET checkpoint_json=?,staging_worker=? WHERE id=?').run(JSON.stringify(stored),workerId,itemId);
  return {jobId,itemId,workerId,stored,metadata};
}

describe('storage checkpoints, quotas, and metadata preservation',()=>{
  it('recovers fully downloaded bytes after coordinator takeover without a network download',async()=>{
    const {root,owner,media}=await fixture();const oldWorker=randomUUID(),newWorker=randomUUID();
    expect(media.db.acquireLease(oldWorker)).toBe(true);
    const saved=checkpoint(media,owner,oldWorker);
    const staging=path.join(root,owner,`${saved.itemId}.${oldWorker}.part`);await writeFile(staging,png);
    media.db.releaseLease(oldWorker);media.db.acquireLease(newWorker);
    media.db.connection.prepare('UPDATE import_items SET lease_owner=? WHERE id=?').run(newWorker,saved.itemId);
    await expect(media.recoverImport(owner,'person1',saved.metadata,saved)).rejects.toMatchObject({code:'WORKER_LEASE_LOST'});
    expect(await readFile(staging)).toEqual(png);
    const result=await media.recoverImport(owner,'person1',saved.metadata,{...saved,workerId:newWorker});
    expect(result).toMatchObject({id:saved.itemId,duplicate:false});
    expect(media.db.connection.prepare('SELECT status,checkpoint_json FROM import_items WHERE id=?').get(saved.itemId)).toMatchObject({status:'completed',checkpoint_json:null});
    expect(await readFile(path.join(root,owner,`${saved.itemId}.png`))).toEqual(png);
  });
  it('keeps the first photo metadata when recovering identical bytes from a different source',async()=>{
    const {root,owner,media}=await fixture();const original=await media.import(owner,'person1',image('first-source'),download(),options());
    const metadataPath=path.join(root,owner,`${original.id}.metadata.json`);const before=await readFile(metadataPath,'utf8');
    const worker=randomUUID();media.db.acquireLease(worker);const saved=checkpoint(media,owner,worker);
    await writeFile(path.join(root,owner,`${saved.itemId}.${worker}.part`),png);
    const result=await media.recoverImport(owner,'person1',saved.metadata,saved);
    expect(result).toMatchObject({id:original.id,duplicate:true});expect(await readFile(metadataPath,'utf8')).toBe(before);
    const sources=media.db.connection.prepare('SELECT original_metadata_json FROM media_sources WHERE asset_id=?').all(original.id);
    expect(sources).toHaveLength(2);expect(JSON.stringify(sources)).toContain('Original camera');expect(JSON.stringify(sources)).not.toContain('baseUrl');
    expect((await media.project(owner)).assets).toHaveLength(1);
  });
  it('accounts for concurrent reservations without charging committed bytes twice',async()=>{
    const other=Buffer.concat([png,Buffer.from('unique-second')]);
    const {owner,media}=await fixture({storageQuotaBytes:png.length+other.length});
    const results=await Promise.allSettled([media.import(owner,'person1',image('one'),download(),options()),media.import(owner,'person1',image('two'),download(other),options())]);
    expect(results.every(result=>result.status==='fulfilled')).toBe(true);
    expect(media.db.connection.prepare('SELECT SUM(bytes) AS bytes FROM assets').get()).toMatchObject({bytes:png.length+other.length});
    expect(media.db.connection.prepare('SELECT COUNT(*) AS count FROM storage_reservations').get()).toMatchObject({count:0});
    await expect(media.preflight()).rejects.toMatchObject({status:507,code:'STORAGE_QUOTA_EXCEEDED'});
  });
  it('fails disk-space preflight with actionable feedback before a download starts',async()=>{
    const {media}=await fixture({minFreeDiskBytes:Number.MAX_SAFE_INTEGER});
    await expect(media.preflight()).rejects.toMatchObject({status:507,code:'DISK_SPACE_LOW'});
  });
  it('reaps stale incomplete worker files while preserving complete checkpoints',async()=>{
    const {root,owner,media}=await fixture();const oldWorker=randomUUID(),newWorker=randomUUID();media.db.acquireLease(oldWorker);
    const saved=checkpoint(media,owner,oldWorker);const complete=path.join(root,owner,`${saved.itemId}.${oldWorker}.part`);await writeFile(complete,png);
    const orphan=`${randomUUID()}.${oldWorker}.part`;await writeFile(path.join(root,owner,orphan),Buffer.from('partial'));
    media.db.releaseLease(oldWorker);media.db.acquireLease(newWorker);await media.recoverStaging(newWorker);
    const files=await readdir(path.join(root,owner));expect(files).toContain(path.basename(complete));expect(files).not.toContain(orphan);
  });
  it('discards unfinished staged bytes when a job is explicitly cancelled',async()=>{
    const {root,owner,media}=await fixture();const worker=randomUUID();media.db.acquireLease(worker);
    const saved=checkpoint(media,owner,worker);const staged=path.join(root,owner,`${saved.itemId}.${worker}.part`);
    await writeFile(staged,png);await media.discardJobStaging(saved.jobId);expect(await readFile(staged)).toEqual(png);
    media.db.connection.prepare("UPDATE import_jobs SET status='cancelled' WHERE id=?").run(saved.jobId);
    await media.discardJobStaging(saved.jobId);
    expect(await readdir(path.join(root,owner))).not.toContain(path.basename(staged));
    expect(media.db.connection.prepare('SELECT checkpoint_json,staging_worker FROM import_items WHERE id=?').get(saved.itemId)).toMatchObject({checkpoint_json:null,staging_worker:null});
  });
  it('resumes an interrupted migration of original P2 metadata without hiding remaining photos',async()=>{
    const root=await mkdtemp(path.join(tmpdir(),'memories-legacy-migration-'));
    const owner=randomUUID(),first=randomUUID(),second=randomUUID();
    const media=new MediaStore(root,{minFreeDiskBytes:0});
    disposals.push(async()=>{media.db.close();await rm(root,{recursive:true,force:true});});
    const {mkdir}=await import('node:fs/promises');await mkdir(path.join(root,owner));
    const common={projectId:owner,contributorId:'person1',filename:'legacy.png',mimeType:'image/png',bytes:png.length,selected:true,importedAt:new Date().toISOString()};
    const legacy={version:1,ownerId:owner,project:{id:owner,name:'Existing memories',createdAt:new Date().toISOString()},assets:[{...common,id:first,storageName:`${first}.png`,googleMediaId:'legacy-one'},{...common,id:second,storageName:'invalid-path',googleMediaId:'legacy-two'}]};
    await writeFile(path.join(root,owner,`${first}.png`),png);await writeFile(path.join(root,owner,`${second}.png`),Buffer.concat([png,Buffer.from('second')]));
    const descriptor=path.join(root,owner,'metadata.json');await writeFile(descriptor,JSON.stringify(legacy));
    await expect(media.ensure(owner)).rejects.toThrow();
    expect(media.db.connection.prepare('SELECT COUNT(*) AS count FROM assets').get()).toMatchObject({count:1});
    legacy.assets[1].storageName=`${second}.png`;await writeFile(descriptor,JSON.stringify(legacy));
    await media.ensure(owner);const restored=await media.project(owner);
    expect(restored.project.name).toBe('Existing memories');expect(restored.assets).toHaveLength(2);
    expect(media.db.connection.prepare('SELECT migration_complete FROM projects WHERE id=?').get(owner)).toMatchObject({migration_complete:1});
  });
});
