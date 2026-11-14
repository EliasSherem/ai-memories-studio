import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readdir,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {MovieRenderQueue} from '../src/movie-queue.js';
import {ApiError} from '../src/errors.js';
import {movieFixture} from './movie-fixture.js';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(options:Parameters<typeof movieFixture>[0]={}){const value=await movieFixture(options);cleanups.push(value.dispose);return value;}
function worker(f:Awaited<ReturnType<typeof movieFixture>>){const queue=new MovieRenderQueue(f.movieStore);cleanups.push(()=>queue.dispose());return queue;}
function assertNoPaid(f:Awaited<ReturnType<typeof movieFixture>>){expect(f.provider.submit).not.toHaveBeenCalled();expect(f.provider.poll).not.toHaveBeenCalled();expect(f.provider.download).not.toHaveBeenCalled();expect(f.keyframe.generate).not.toHaveBeenCalled();expect(f.qualityProvider.review).not.toHaveBeenCalled();}

describe('persistent local P5 render queue',()=>{
 it('renders and publishes a version from the immutable approved timeline with actual stage progress',async()=>{
  const f=await fixture(),job=await f.create(),queue=worker(f);await queue.drain();
  const completed=f.movieStore.job(f.owner,job.id),assets=f.movieStore.assets(f.owner);expect(completed).toMatchObject({state:'COMPLETED',progress:100,version:1});expect(assets).toHaveLength(1);expect(assets[0]).toMatchObject({jobId:job.id,durationSeconds:150,width:1920,height:1080,fps:30,isFictional:true});
  expect(f.render).toHaveBeenCalledTimes(1);const input=f.render.mock.calls[0][0];expect(input.timeline.durationSeconds).toBe(150);expect(input.segments.filter(value=>value.type==='video').every(value=>value.file&&value.generatedAssetId)).toBe(true);
  expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_reservations').get()).toMatchObject({count:0});expect(f.videoStore.assets(f.owner,f.board.id)).toHaveLength(2);assertNoPaid(f);
 });
 it('fences two workers so one pending project is rendered only once',async()=>{
  const f=await fixture(),job=await f.create(),first=worker(f),second=worker(f);await Promise.all([first.drain(),second.drain()]);
  expect(f.render).toHaveBeenCalledTimes(1);expect(f.movieStore.job(f.owner,job.id).state).toBe('COMPLETED');expect(f.movieStore.assets(f.owner)).toHaveLength(1);assertNoPaid(f);
 });
 it('discards incomplete restart output and re-renders rather than marking a partial MP4 successful',async()=>{
  const f=await fixture(),job=await f.create(),claim=randomUUID(),workspace=await f.movieMedia.workspace(f.owner,job.id,claim),partial=join(workspace,'movie.mp4');await writeFile(partial,'incomplete output');
  f.media.db.connection.prepare("UPDATE movie_render_jobs SET state='RENDERING',progress=85,lease_owner='dead-worker',workspace_claim=?,attempts=1 WHERE id=?").run(claim,job.id);
  f.media.db.connection.prepare("INSERT INTO movie_worker_lease(id,owner,expires_at) VALUES(1,'dead-worker',0)").run();
  const queue=worker(f);await queue.drain();expect(f.render).toHaveBeenCalledTimes(1);expect(f.movieStore.job(f.owner,job.id)).toMatchObject({state:'COMPLETED',progress:100});expect(f.movieStore.assets(f.owner)).toHaveLength(1);await expect(stat(workspace)).rejects.toMatchObject({code:'ENOENT'});assertNoPaid(f);
 });
 it('cancels an active process, cleans partial files and preserves original generated clips',async()=>{
  let announce!:()=>void;const started=new Promise<void>(resolve=>{announce=resolve;});let aborted=false;
  const f=await fixture({render:async input=>{await writeFile(input.outputFile,'incomplete local render');input.onProgress?.({phase:'RENDERING',percent:50,message:'Synthetic process running.'});announce();return await new Promise((_,reject)=>{input.signal.addEventListener('abort',()=>{aborted=true;reject(new ApiError(409,'MOVIE_CANCELLED','Synthetic process stopped.'));},{once:true});});}}),job=await f.create(),queue=worker(f);
  await started;const cancelled=await queue.cancel(f.owner,job.id);expect(cancelled.state).toBe('CANCELLED');expect(aborted).toBe(true);expect(f.movieStore.assets(f.owner)).toEqual([]);expect(f.videoStore.assets(f.owner,f.board.id)).toHaveLength(2);expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_reservations').get()).toMatchObject({count:0});assertNoPaid(f);
 });
 it('resumes safely after graceful shutdown without publishing an interrupted output',async()=>{
  const f=await fixture(),standard=f.render.getMockImplementation()!;let announce!:()=>void;const started=new Promise<void>(resolve=>{announce=resolve;});
  f.render.mockImplementationOnce(async input=>{await writeFile(input.outputFile,'partial');announce();return await new Promise((_,reject)=>{input.signal.addEventListener('abort',()=>reject(new ApiError(409,'MOVIE_CANCELLED','Server stopped.')),{once:true});});});
  const job=await f.create(),first=worker(f);await started;await first.dispose();expect(f.movieStore.job(f.owner,job.id).state).toBe('PENDING');expect(f.movieStore.assets(f.owner)).toEqual([]);
  f.render.mockImplementation(standard);const replacement=worker(f);await replacement.drain();expect(f.movieStore.job(f.owner,job.id).state).toBe('COMPLETED');expect(f.movieStore.assets(f.owner)).toHaveLength(1);expect(f.render).toHaveBeenCalledTimes(2);assertNoPaid(f);
 });
 it('records low disk failure and retries the same saved job without generating sources',async()=>{
  const f=await fixture(),job=await f.create(),reserve=vi.spyOn(f.movieMedia,'reserve').mockRejectedValueOnce(new ApiError(507,'DISK_SPACE_LOW','Synthetic low disk space.')),queue=worker(f);await queue.drain();
  expect(f.movieStore.job(f.owner,job.id)).toMatchObject({state:'FAILED',errorCode:'DISK_SPACE_LOW'});expect(f.render).not.toHaveBeenCalled();reserve.mockRestore();
  const retry=await queue.retry(f.owner,job.id);expect(retry.id).toBe(job.id);expect(retry.version).toBe(1);await queue.drain();expect(f.movieStore.job(f.owner,job.id).state).toBe('COMPLETED');expect(f.render).toHaveBeenCalledTimes(1);assertNoPaid(f);
 });
 it('blocks stale approvals before processing and never substitutes a photograph',async()=>{
  const f=await fixture(),job=await f.create();f.media.db.connection.prepare("UPDATE video_quality_reviews SET decision='rejected' WHERE asset_id=?").run(f.clipIds[0]);const queue=worker(f);await queue.drain();
  expect(f.movieStore.job(f.owner,job.id)).toMatchObject({state:'FAILED',errorCode:'MOVIE_SOURCES_CHANGED'});expect(f.render).not.toHaveBeenCalled();expect(f.movieStore.assets(f.owner)).toEqual([]);assertNoPaid(f);
 });
 it('rechecks approval after rendering and prevents publication when a source was revoked',async()=>{
  const f=await fixture(),standard=f.render.getMockImplementation()!,job=await f.create();f.render.mockImplementation(async input=>{const result=await standard(input);f.media.db.connection.prepare("UPDATE video_quality_reviews SET decision='rejected' WHERE asset_id=?").run(f.clipIds[1]);return result;});
  const queue=worker(f);await queue.drain();expect(f.movieStore.job(f.owner,job.id)).toMatchObject({state:'FAILED',errorCode:'MOVIE_SOURCES_CHANGED'});expect(f.movieStore.assets(f.owner)).toEqual([]);expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_files').get()).toMatchObject({count:0});assertNoPaid(f);
 });
 it('stops publication if protagonist likeness permission is revoked during rendering',async()=>{
  const f=await fixture(),standard=f.render.getMockImplementation()!,job=await f.create();f.render.mockImplementation(async input=>{const result=await standard(input);await f.directorStore.saveProtagonist(f.owner,'person1',{name:'Alex',referencePhotoIds:f.ids.slice(0,2),likenessPermissionConfirmed:false});return result;});
  const queue=worker(f);await queue.drain();expect(f.movieStore.job(f.owner,job.id)).toMatchObject({state:'FAILED',errorCode:'MOVIE_SOURCES_CHANGED'});expect(f.movieStore.assets(f.owner)).toEqual([]);expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_files').get()).toMatchObject({count:0});assertNoPaid(f);
 });
 it('catches an approval change during final file commit and removes unpublished exports',async()=>{
  const f=await fixture(),job=await f.create(),commit=f.movieMedia.commit.bind(f.movieMedia);let changed=false;
  vi.spyOn(f.movieMedia,'commit').mockImplementation(async(...args)=>{const saved=await commit(...args);if(!changed&&args[2].endsWith('.mp4')){changed=true;f.media.db.connection.prepare("UPDATE video_quality_reviews SET decision='rejected' WHERE asset_id=?").run(f.clipIds[0]);}return saved;});
  const queue=worker(f);await queue.drain();expect(changed).toBe(true);expect(f.movieStore.job(f.owner,job.id)).toMatchObject({state:'FAILED',errorCode:'MOVIE_SOURCES_CHANGED'});expect(f.movieStore.assets(f.owner)).toEqual([]);expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_files').get()).toMatchObject({count:0});expect((await readdir(f.movieMedia.directory(f.owner))).filter(name=>/\.(mp4|jpg)$/.test(name))).toEqual([]);expect(f.movieStore.row(f.owner,job.id).pending_asset_id).toBeNull();assertNoPaid(f);
 });
 it('recovers published-file rename checkpoints without exposing orphaned final files',async()=>{
  const f=await fixture(),job=await f.create(),claim=randomUUID(),pending=randomUUID(),workspace=await f.movieMedia.workspace(f.owner,job.id,claim),source=join(workspace,'pending.mp4');await writeFile(source,'unpublished render bytes');await f.movieMedia.commit(f.owner,source,`${pending}.mp4`,'video/mp4',1024*1024);await writeFile(f.movieMedia.file(f.owner,`${pending}.jpg`),'rename before ledger checkpoint');
  f.media.db.connection.prepare("UPDATE movie_render_jobs SET state='VALIDATING_OUTPUT',progress=99,lease_owner='dead-worker',workspace_claim=?,pending_asset_id=? WHERE id=?").run(claim,pending,job.id);f.media.db.connection.prepare("INSERT INTO movie_worker_lease(id,owner,expires_at) VALUES(1,'dead-worker',0)").run();
  const standard=f.render.getMockImplementation()!;f.render.mockImplementation(async input=>{await expect(stat(f.movieMedia.file(f.owner,`${pending}.mp4`))).rejects.toMatchObject({code:'ENOENT'});await expect(stat(f.movieMedia.file(f.owner,`${pending}.jpg`))).rejects.toMatchObject({code:'ENOENT'});expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_files').get()).toMatchObject({count:0});return await standard(input);});
  const queue=worker(f);await queue.drain();expect(f.movieStore.job(f.owner,job.id).state).toBe('COMPLETED');expect(f.render).toHaveBeenCalledTimes(1);expect(f.movieStore.assets(f.owner)).toHaveLength(1);expect(f.movieStore.assets(f.owner)[0].id).not.toBe(pending);expect(f.movieStore.row(f.owner,job.id).pending_asset_id).toBeNull();assertNoPaid(f);
 });
 it('cancels an abandoned publication checkpoint and deletes its unpublished final files',async()=>{
  const f=await fixture(),job=await f.create(),claim=randomUUID(),pending=randomUUID(),workspace=await f.movieMedia.workspace(f.owner,job.id,claim),source=join(workspace,'pending.mp4');await writeFile(source,'unpublished render bytes');await f.movieMedia.commit(f.owner,source,`${pending}.mp4`,'video/mp4',1024*1024);await writeFile(f.movieMedia.file(f.owner,`${pending}.jpg`),'rename before ledger checkpoint');
  f.media.db.connection.prepare("UPDATE movie_render_jobs SET state='VALIDATING_OUTPUT',progress=99,lease_owner='dead-worker',workspace_claim=?,pending_asset_id=? WHERE id=?").run(claim,pending,job.id);
  const cancelled=await f.movieQueue.cancel(f.owner,job.id);expect(cancelled.state).toBe('CANCELLED');await expect(stat(f.movieMedia.file(f.owner,`${pending}.mp4`))).rejects.toMatchObject({code:'ENOENT'});await expect(stat(f.movieMedia.file(f.owner,`${pending}.jpg`))).rejects.toMatchObject({code:'ENOENT'});await expect(stat(workspace)).rejects.toMatchObject({code:'ENOENT'});expect(f.movieStore.assets(f.owner)).toEqual([]);expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_files').get()).toMatchObject({count:0});expect(f.render).not.toHaveBeenCalled();assertNoPaid(f);
 });
 it('retains failed cleanup checkpoints through retry and removes them before rendering again',async()=>{
  const f=await fixture(),job=await f.create(),claim=randomUUID(),pending=randomUUID(),workspace=await f.movieMedia.workspace(f.owner,job.id,claim),source=join(workspace,'pending.mp4');await writeFile(source,'failed unpublished render');await f.movieMedia.reserve(f.owner,claim,1024);await f.movieMedia.commit(f.owner,source,`${pending}.mp4`,'video/mp4',1024*1024);
  f.media.db.connection.prepare("UPDATE movie_render_jobs SET state='FAILED',workspace_claim=?,pending_asset_id=?,error_code='MOVIE_RENDER_FAILED' WHERE id=?").run(claim,pending,job.id);
  await f.movieQueue.retry(f.owner,job.id);const standard=f.render.getMockImplementation()!;f.render.mockImplementation(async input=>{await expect(stat(workspace)).rejects.toMatchObject({code:'ENOENT'});await expect(stat(f.movieMedia.file(f.owner,`${pending}.mp4`))).rejects.toMatchObject({code:'ENOENT'});expect(f.media.db.connection.prepare('SELECT id FROM movie_media_reservations WHERE id=?').get(claim)).toBeUndefined();return await standard(input);});
  const queue=worker(f);await queue.drain();expect(f.movieStore.job(f.owner,job.id).state).toBe('COMPLETED');expect(f.movieStore.assets(f.owner)).toHaveLength(1);assertNoPaid(f);
 });
 it('preserves a cleanup checkpoint when shutdown cleanup fails so restart can remove the workspace',async()=>{
  const f=await fixture(),standard=f.render.getMockImplementation()!;let announce!:()=>void;const started=new Promise<void>(resolve=>{announce=resolve;});let workspace='';f.render.mockImplementationOnce(async input=>{workspace=input.workspace;await writeFile(input.outputFile,'interrupted output');announce();return await new Promise((_,reject)=>{input.signal.addEventListener('abort',()=>reject(new ApiError(409,'MOVIE_CANCELLED','Server stopped.')),{once:true});});});
  const job=await f.create(),queue=worker(f);await started;const cleanup=vi.spyOn(f.movieMedia,'cleanup').mockRejectedValue(new ApiError(507,'DISK_SPACE_LOW','Synthetic cleanup interruption.'));await queue.dispose();cleanup.mockRestore();
  expect(f.movieStore.job(f.owner,job.id).state).toBe('PENDING');expect(f.movieStore.row(f.owner,job.id).workspace_claim).not.toBeNull();f.render.mockImplementation(standard);const replacement=worker(f);await replacement.drain();expect(f.movieStore.job(f.owner,job.id).state).toBe('COMPLETED');await expect(stat(workspace)).rejects.toMatchObject({code:'ENOENT'});assertNoPaid(f);
 });
 it('rejects changed photo bytes even when the asset ID and metadata were retained',async()=>{
  const f=await fixture(),job=await f.create();await writeFile(join(f.config.mediaStoragePath,f.owner,`${f.ids[4]}.jpg`),'replacement bytes');const queue=worker(f);await queue.drain();
  expect(f.movieStore.job(f.owner,job.id).state).toBe('FAILED');expect(f.render).not.toHaveBeenCalled();expect(f.movieStore.assets(f.owner)).toEqual([]);assertNoPaid(f);
 });
 it('does not publish invalid or truncated output when the engine validation fails',async()=>{
  const f=await fixture();f.render.mockRejectedValue(new ApiError(422,'MOVIE_OUTPUT_INVALID','Synthetic duration and codec validation failure.'));const job=await f.create(),queue=worker(f);await queue.drain();
  expect(f.movieStore.job(f.owner,job.id)).toMatchObject({state:'FAILED',errorCode:'MOVIE_OUTPUT_INVALID'});expect(f.movieStore.assets(f.owner)).toEqual([]);expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_reservations').get()).toMatchObject({count:0});assertNoPaid(f);
 });
});
