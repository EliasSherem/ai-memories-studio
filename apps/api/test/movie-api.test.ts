import {afterEach,describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {writeFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import sharp from 'sharp';
import {movieSettingsSchema} from '@memories/shared';
import {ApiError} from '../src/errors.js';
import {movieFixture,mp4Fixture,movieInspection} from './movie-fixture.js';
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(){const value=await movieFixture();cleanups.push(value.dispose);return value;}
async function completedMovie(f:Awaited<ReturnType<typeof movieFixture>>){
 const job=await f.create(),id=randomUUID(),work=await f.movieMedia.workspace(f.owner,job.id,randomUUID()),source=join(work,'finished.mp4'),thumbnail=join(work,'finished.jpg');
 await writeFile(source,mp4Fixture());await writeFile(thumbnail,await sharp({create:{width:16,height:16,channels:3,background:'#667766'}}).jpeg().toBuffer());
 const video=await f.movieMedia.commit(f.owner,source,`${job.id}.mp4`,'video/mp4',1024*1024),picture=await f.movieMedia.commit(f.owner,thumbnail,`${job.id}.jpg`,'image/jpeg',1024*1024);
 f.insert('movie_render_assets',{id,job_id:job.id,project_id:f.owner,storyboard_id:f.board.id,version:job.version,storage_name:video.storageName,thumbnail_name:picture.storageName,inspection_json:JSON.stringify(movieInspection),bytes:video.bytes,sha256:video.sha256,fictional_json:JSON.stringify([f.content.scenes[1].id]),diagnostics_json:JSON.stringify({musicAdded:false}),created_at:new Date().toISOString()});
 f.media.db.connection.prepare("UPDATE movie_render_jobs SET state='COMPLETED',progress=100,asset_id=? WHERE id=?").run(id,job.id);return {job,id,video,picture};
}

describe('private P5 movie assembly API',()=>{
 it('requires authentication for movie state, jobs, exports, thumbnails and soundtrack access',async()=>{
  const f=await fixture();for(const path of ['/api/movie',`/api/movie/jobs/${randomUUID()}`,`/api/movie/assets/${randomUUID()}/content`,`/api/movie/assets/${randomUUID()}/thumbnail`,`/api/movie/soundtracks/${randomUUID()}/content`])await request(f.app).get(path).expect(401);
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;
  expect(state.readiness.ready).toBe(true);expect(state.timeline.durationSeconds).toBe(150);expect(state.jobs).toEqual([]);expect(state.assets).toEqual([]);
  expect(state.timeline.segments.filter((segment:{type:string})=>segment.type==='video')).toHaveLength(2);
  expect(f.provider.submit).not.toHaveBeenCalled();expect(f.keyframe.generate).not.toHaveBeenCalled();expect(f.qualityProvider.review).not.toHaveBeenCalled();
 });
 it('requires Origin and CSRF for movie creation, settings and soundtrack mutations',async()=>{
  const f=await fixture();await f.agent.post('/api/movie/jobs').send({storyboardId:f.board.id,idempotencyKey:randomUUID()}).expect(403);
  await f.agent.patch('/api/movie/settings').set('Origin','https://untrusted.example').set('X-CSRF-Token','invalid').send({settings:{}}).expect(403);
  await f.agent.post('/api/movie/soundtracks').set('Content-Type','audio/mpeg').send(Buffer.from('synthetic audio')).expect(403);
  expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_render_jobs').get()).toMatchObject({count:0});
 });
 it('creates an immutable timeline and only one pending render for lost-response retries',async()=>{
  const f=await fixture(),key=randomUUID(),first=await f.create(key),again=await f.create(key);
  expect(again.id).toBe(first.id);expect(first).toMatchObject({state:'PENDING',progress:0,version:1});
  const timeline=f.movieStore.timeline(f.owner,first.timelineId!);expect(timeline.ready).toBe(true);expect(timeline.durationSeconds).toBe(150);
  const next=await f.mutate('post','/api/movie/jobs',{storyboardId:f.board.id,idempotencyKey:randomUUID()}).expect(409);expect(next.body.error.code).toBe('MOVIE_RENDER_ACTIVE');
  const serialized=JSON.stringify((await f.agent.get(`/api/movie/jobs/${first.id}`).expect(200)).body);expect(serialized).not.toMatch(/fingerprint|workspace_claim|settings_json|storage_name|private-operation/);
  expect(f.render).not.toHaveBeenCalled();expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('returns exact blocked scene IDs instead of substituting rejected or failed clips',async()=>{
  const f=await fixture();f.media.db.connection.prepare("UPDATE video_quality_reviews SET decision='rejected' WHERE asset_id=?").run(f.clipIds[1]);
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;
  expect(state.readiness.ready).toBe(false);expect(state.readiness.issues).toContainEqual(expect.objectContaining({code:'APPROVED_CLIP_REQUIRED',sceneId:f.content.scenes[1].id}));
  const creation=await f.mutate('post','/api/movie/jobs',{storyboardId:f.board.id,idempotencyKey:randomUUID()}).expect(409);expect(creation.body.error.message).toContain(f.content.scenes[1].id);
  expect(f.render).not.toHaveBeenCalled();expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('validates output settings and private soundtrack ownership without accepting paths',async()=>{
  const f=await fixture();await f.mutate('patch','/api/movie/settings',{settings:{targetDurationSeconds:90}}).expect(400);
  await f.mutate('patch','/api/movie/settings',{settings:{resolution:'4k'}}).expect(400);
  await f.mutate('patch','/api/movie/settings',{settings:{titles:{font:'/etc/passwd'}}}).expect(400);
  await f.mutate('patch','/api/movie/settings',{settings:{outputFile:'/tmp/public.mp4'}}).expect(400);
  await f.mutate('patch','/api/movie/settings',{settings:{soundtrackId:randomUUID()}}).expect(404);
  const settings=movieSettingsSchema.parse({resolution:'720p',aspectRatio:'9:16',titles:{openingTitle:'זיכרונות — Élodie',names:'Alex & Sam',dates:'2024–2026',closingCredits:'撮影: 私たち'},musicVolume:0.3,retainSceneAudio:false});
  await f.mutate('patch','/api/movie/settings',{settings}).expect(200);
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;expect(state.settings).toMatchObject(settings);expect(state.timeline.segments.some((segment:{titleText?:string})=>segment.titleText?.includes('זיכרונות'))).toBe(true);
 });
 it('enforces project ownership on storyboards, jobs, settings, cancellation and retries',async()=>{
  const f=await fixture(),job=await f.create(),other=await f.other();
  await other.client.get('/api/movie').query({storyboardId:f.board.id}).expect(404);
  await other.client.get(`/api/movie/jobs/${job.id}`).expect(404);
  await f.mutate('post',`/api/movie/jobs/${job.id}/cancel`,{},other.client,other.csrf).expect(404);
  await f.mutate('post',`/api/movie/jobs/${job.id}/retry`,{},other.client,other.csrf).expect(404);
  await f.mutate('post','/api/movie/jobs',{storyboardId:f.board.id,idempotencyKey:randomUUID()},other.client,other.csrf).expect(404);
 });
 it('serves private range-enabled MP4, attachment exports and thumbnails without exposing disk paths',async()=>{
  const f=await fixture(),asset=await completedMovie(f);
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;
  expect(state.assets[0]).toMatchObject({id:asset.id,width:1920,height:1080,durationSeconds:150,fps:30,isFictional:true,fictionalSceneIds:[f.content.scenes[1].id]});expect(JSON.stringify(state)).not.toContain(f.root);
  await f.agent.get(`/api/movie/assets/${asset.id}/content`).set('Range','bytes=0-11').expect(206).then(result=>{expect(result.headers['content-range']).toContain(`bytes 0-11/${asset.video.bytes}`);expect(result.headers['cache-control']).toContain('no-store');});
  await f.agent.get(`/api/movie/assets/${asset.id}/content?download=1`).expect(200).then(result=>expect(result.headers['content-disposition']).toContain('attachment'));
  await f.agent.get(`/api/movie/assets/${asset.id}/thumbnail`).expect(200).then(result=>expect(result.headers['content-type']).toContain('image/jpeg'));
  const other=await f.other();for(const suffix of ['content','thumbnail'])await other.client.get(`/api/movie/assets/${asset.id}/${suffix}`).expect(404);
 });
 it('retains earlier private exports and increments render version history',async()=>{
  const f=await fixture(),first=await completedMovie(f),next=await f.create();expect(next.version).toBe(2);expect(next.id).not.toBe(first.job.id);
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;expect(state.jobs.map((job:{version:number})=>job.version)).toEqual([2,1]);expect(state.assets).toHaveLength(1);expect(state.assets[0]).toMatchObject({id:first.id,version:1});await f.agent.get(state.assets[0].url).expect(200);expect(f.videoStore.assets(f.owner,f.board.id)).toHaveLength(2);expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('cancels queued work without generating or removing approved source clips',async()=>{
  const f=await fixture(),job=await f.create();const result=(await f.mutate('post',`/api/movie/jobs/${job.id}/cancel`,{}).expect(200)).body;expect(result.state).toBe('CANCELLED');
  expect(f.videoStore.assets(f.owner,f.board.id)).toHaveLength(2);expect(f.render).not.toHaveBeenCalled();expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('blocks low disk/quota preflight before adding a render',async()=>{
  const f=await fixture();vi.spyOn(f.movieMedia,'preflight').mockRejectedValue(new ApiError(507,'DISK_SPACE_LOW','Synthetic low disk space.'));
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;expect(state.readiness.ready).toBe(false);expect(state.readiness.issues).toContainEqual(expect.objectContaining({code:'DISK_SPACE_LOW'}));
  await f.mutate('post','/api/movie/jobs',{storyboardId:f.board.id,idempotencyKey:randomUUID()}).expect(507);
  expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_render_jobs').get()).toMatchObject({count:0});
 });
 it('blocks movie creation when the local encoder tools are unavailable',async()=>{
  const f=await fixture();vi.spyOn(f.renderer,'detectTools').mockResolvedValue({available:false,message:'Synthetic missing FFmpeg.'});
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;expect(state.readiness.issues).toContainEqual(expect.objectContaining({code:'MOVIE_TOOLS_UNAVAILABLE'}));
  await f.mutate('post','/api/movie/jobs',{storyboardId:f.board.id,idempotencyKey:randomUUID()}).expect(503);expect(f.render).not.toHaveBeenCalled();expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('uploads and auto-selects a licensed vocal track independently of a rejected unsaved settings draft',async()=>{
  const f=await fixture(),saved=movieSettingsSchema.parse({resolution:'720p',aspectRatio:'9:16',titles:{openingTitle:'Saved title · זיכרונות'},musicVolume:.31});await f.mutate('patch','/api/movie/settings',{settings:saved}).expect(200);
  await f.mutate('patch','/api/movie/settings',{settings:{...saved,targetDurationSeconds:90,titles:{...saved.titles,openingTitle:'Invalid unsaved draft'}}}).expect(400);
  const bytes=Buffer.concat([Buffer.from('ID3'),Buffer.alloc(48)]),upload=await f.mutate('post','/api/movie/soundtracks',bytes).set('Content-Type','audio/mpeg').set('X-Upload-Name',encodeURIComponent('Licensed vocal canción.mp3')).set('X-Instrumental','false').set('X-License-Confirmed','true').expect(201);
  expect(upload.body).toMatchObject({name:'Licensed vocal canción.mp3',instrumental:false,licensed:true,durationSeconds:10});
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;expect(state.soundtracks).toHaveLength(1);expect(state.soundtracks[0]).toMatchObject({id:upload.body.id,instrumental:false});expect(state.settings).toEqual({...saved,soundtrackId:upload.body.id});
  await request(f.app).get(upload.body.url).expect(401);await f.agent.get(upload.body.url).expect(200).then(response=>{expect(response.headers['cache-control']).toContain('no-store');expect(response.headers['content-type']).toContain('audio/mpeg');expect(response.body).toEqual(bytes);});const other=await f.other();await other.client.get(upload.body.url).expect(404);
  expect(f.movieStore.jobs(f.owner)).toEqual([]);expect(f.render).not.toHaveBeenCalled();expect(f.provider.submit).not.toHaveBeenCalled();expect(f.keyframe.generate).not.toHaveBeenCalled();expect(f.qualityProvider.review).not.toHaveBeenCalled();
 });
 it('saves a six-and-a-half-minute target and uploads music independently of a different unsaved duration',async()=>{
  const f=await fixture();await f.mutate('patch','/api/movie/settings',{settings:{targetDurationSeconds:390,resolution:'720p',titles:{openingTitle:'A longer story'}}}).expect(200);const saved=f.movieStore.settings(f.owner),unsavedDraft={...saved,targetDurationSeconds:391};expect(unsavedDraft.targetDurationSeconds).toBe(391);
  const upload=await f.mutate('post','/api/movie/soundtracks',Buffer.concat([Buffer.from('ID3'),Buffer.alloc(48)])).set('Content-Type','audio/mpeg').set('X-Upload-Name','Longer%20movie%20song.mp3').set('X-Instrumental','false').set('X-License-Confirmed','true').expect(201);const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;expect(state.settings).toMatchObject({targetDurationSeconds:390,soundtrackId:upload.body.id,titles:{openingTitle:'A longer story'}});expect(state.soundtracks).toHaveLength(1);
  await f.mutate('patch','/api/movie/settings',{settings:{...saved,targetDurationSeconds:901}}).expect(400);expect(f.movieStore.settings(f.owner).targetDurationSeconds).toBe(390);expect(f.movieStore.jobs(f.owner)).toEqual([]);expect(f.provider.submit).not.toHaveBeenCalled();expect(f.render).not.toHaveBeenCalled();
 });
 it('registers uploads while an export is pending without altering its frozen soundtrack settings',async()=>{
  const f=await fixture(),job=await f.create(),before=f.movieStore.row(f.owner,job.id).settings_json,bytes=Buffer.concat([Buffer.from('ID3'),Buffer.alloc(48)]),upload=await f.mutate('post','/api/movie/soundtracks',bytes).set('Content-Type','audio/mpeg').set('X-Upload-Name','Vocal%20track.mp3').set('X-Instrumental','false').set('X-License-Confirmed','true').expect(201);
  expect(f.movieStore.settings(f.owner).soundtrackId).toBe(upload.body.id);expect(f.movieStore.row(f.owner,job.id).settings_json).toBe(before);expect(JSON.parse(before).soundtrackId).toBeUndefined();expect((await f.movieStore.resolve(f.movieStore.row(f.owner,job.id))).settings.soundtrackId).toBeUndefined();expect(f.movieStore.job(f.owner,job.id).state).toBe('PENDING');
  const another=await f.mutate('post','/api/movie/soundtracks',bytes).set('Content-Type','audio/mpeg').set('X-Upload-Name','Another%20licensed%20song.mp3').set('X-Instrumental','false').set('X-License-Confirmed','true').expect(201);expect(f.movieStore.soundtracks(f.owner)).toHaveLength(2);expect(f.movieStore.settings(f.owner).soundtrackId).toBe(upload.body.id);expect(another.body.id).not.toBe(upload.body.id);
  await f.mutate('delete',`/api/movie/soundtracks/${upload.body.id}`,{}).expect(409);await f.mutate('post',`/api/movie/jobs/${job.id}/cancel`,{}).expect(200);await f.mutate('delete',`/api/movie/soundtracks/${upload.body.id}`,{}).expect(204);expect(f.render).not.toHaveBeenCalled();expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it.each(['probeSoundtrack','analyzeSoundtrack'] as const)('cleans a failed %s upload without ghost tracks, files, reservations, or settings changes',async(stage)=>{
  const f=await fixture(),saved=f.movieStore.settings(f.owner);vi.spyOn(f.renderer,stage).mockRejectedValueOnce(new ApiError(422,'SOUNDTRACK_INVALID','Synthetic invalid audio.'));
  await f.mutate('post','/api/movie/soundtracks',Buffer.concat([Buffer.from('ID3'),Buffer.alloc(48)])).set('Content-Type','audio/mpeg').set('X-Upload-Name','Broken%20track.mp3').set('X-Instrumental','false').set('X-License-Confirmed','true').expect(422);
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;expect(state.soundtracks).toEqual([]);expect(state.settings).toEqual(saved);expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_files WHERE project_id=?').get(f.owner)).toMatchObject({count:0});expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_reservations WHERE project_id=?').get(f.owner)).toMatchObject({count:0});expect((await readdir(f.movieMedia.directory(f.owner))).filter(name=>/^\.upload-|\.(mp3|wav|m4a)$/i.test(name))).toEqual([]);expect(f.movieStore.jobs(f.owner)).toEqual([]);expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('rolls back soundtrack registration and removes committed audio when default-selection persistence fails',async()=>{
  const f=await fixture(),saved=f.movieStore.settings(f.owner);f.media.db.connection.exec("CREATE TEMP TRIGGER reject_soundtrack_default BEFORE UPDATE ON movie_render_settings BEGIN SELECT RAISE(ABORT,'Synthetic settings persistence failure'); END;");
  await f.mutate('post','/api/movie/soundtracks',Buffer.concat([Buffer.from('ID3'),Buffer.alloc(48)])).set('Content-Type','audio/mpeg').set('X-Upload-Name','Licensed.mp3').set('X-Instrumental','false').set('X-License-Confirmed','true').expect(500);
  expect(f.movieStore.soundtracks(f.owner)).toEqual([]);expect(f.movieStore.settings(f.owner)).toEqual(saved);expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_files WHERE project_id=?').get(f.owner)).toMatchObject({count:0});expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_reservations').get()).toMatchObject({count:0});expect((await readdir(f.movieMedia.directory(f.owner))).filter(name=>/^\.upload-|\.(mp3|wav|m4a)$/i.test(name))).toEqual([]);expect(f.movieStore.jobs(f.owner)).toEqual([]);expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('rejects a soundtrack quota preflight without registering a track or reserving storage',async()=>{
  const f=await fixture();vi.spyOn(f.movieMedia,'preflight').mockRejectedValue(new ApiError(507,'STORAGE_QUOTA_EXCEEDED','Synthetic soundtrack storage quota.'));
  await f.mutate('post','/api/movie/soundtracks',Buffer.concat([Buffer.from('ID3'),Buffer.alloc(48)])).set('Content-Type','audio/mpeg').set('X-Upload-Name','Licensed.mp3').set('X-Instrumental','false').set('X-License-Confirmed','true').expect(507);
  expect(f.movieStore.soundtracks(f.owner)).toEqual([]);expect(f.media.db.connection.prepare('SELECT COUNT(*) count FROM movie_media_reservations').get()).toMatchObject({count:0});expect(f.movieStore.settings(f.owner).soundtrackId).toBeUndefined();expect(f.renderer.probeSoundtrack).not.toHaveBeenCalled();expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('requires soundtrack license confirmation and accepts only supported bounded audio uploads',async()=>{
  const f=await fixture();
  // Use the fixture's CSRF-bearing request and override only its raw body/header.
  const make=(mime:string,license?:string)=>{let value=f.mutate('post','/api/movie/soundtracks',Buffer.concat([Buffer.from('ID3'),Buffer.alloc(32)])).set('Content-Type',mime).set('X-Upload-Name',encodeURIComponent('Licensed étude.mp3')).set('X-Instrumental','true');if(license)value=value.set('X-License-Confirmed',license);return value;};
  await make('audio/mpeg').expect(400);await make('image/jpeg','true').expect(415);
  await f.mutate('post','/api/movie/soundtracks',Buffer.from('not an audio header')).set('Content-Type','audio/mpeg').set('X-Upload-Name','wrong.mp3').set('X-Instrumental','true').set('X-License-Confirmed','true').expect(422);
  await f.mutate('post','/api/movie/soundtracks',Buffer.alloc((f.config.movieMaxSoundtrackBytes??1024*1024)+1)).set('Content-Type','audio/mpeg').set('X-Upload-Name','oversized.mp3').set('X-Instrumental','true').set('X-License-Confirmed','true').expect(413);expect(f.renderer.probeSoundtrack).not.toHaveBeenCalled();
  const result=await make('audio/mpeg','true').expect(201);expect(result.body).toMatchObject({name:'Licensed étude.mp3',licensed:true,instrumental:true,durationSeconds:10});
  const state=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;expect(state.soundtracks).toHaveLength(1);expect(state.settings.soundtrackId).toBe(result.body.id);
  expect(f.renderer.probeSoundtrack).toHaveBeenCalled();expect(f.renderer.analyzeSoundtrack).toHaveBeenCalled();
  const other=await f.other();await other.client.get(`/api/movie/soundtracks/${result.body.id}/content`).expect(404);await f.mutate('delete',`/api/movie/soundtracks/${result.body.id}`,{},other.client,other.csrf).expect(404);
  await f.mutate('delete',`/api/movie/soundtracks/${result.body.id}`,{}).expect(204);
  const after=(await f.agent.get('/api/movie').query({storyboardId:f.board.id}).expect(200)).body;expect(after.soundtracks).toEqual([]);expect(after.settings.soundtrackId).toBeUndefined();
  expect(f.provider.submit).not.toHaveBeenCalled();expect(f.keyframe.generate).not.toHaveBeenCalled();
 });
});
