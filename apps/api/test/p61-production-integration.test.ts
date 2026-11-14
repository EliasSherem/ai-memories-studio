import {afterEach,describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import {createHash,randomUUID} from 'node:crypto';
import {cinematicPreferencesSchema,type PhotoSequence,type MovieTimeline} from '@memories/shared';
import type {VideoSubmission} from '../src/video-provider.js';
import {VideoProviderError} from '../src/video-provider.js';
import {productionFixture,waitForProduction,tinyMp4} from './production-fixture.js';
const fixtures:Awaited<ReturnType<typeof productionFixture>>[]=[];
afterEach(async()=>{for(const fixture of fixtures.splice(0).reverse())await fixture.dispose();vi.restoreAllMocks();});
async function fixture(options:Parameters<typeof productionFixture>[0]={}){const f=await productionFixture({photoCount:140,cachedAnalysis:true,...options});fixtures.push(f);return f;}
function seedActionMoments(f:Awaited<ReturnType<typeof productionFixture>>){
 for(const [index,id]of f.ids.entries()){
  const row=f.media.db.connection.prepare('SELECT features_json FROM p3_local_features WHERE asset_id=?').get(id) as {features_json:string};
  const group=Math.floor(index/4),offset=index%4,features=JSON.parse(row.features_json);
  features.perceptualHash=createHash('sha256').update(`group:${group}`).digest('hex').slice(0,14)+['00','03','0c','3f'][offset];
  features.exif={...features.exif,dateSource:'EXIF',dateTimeOriginal:new Date(Date.UTC(2024,0,1)+group*86400000+offset*2000).toISOString(),cameraMake:'Synthetic',cameraModel:'Synthetic camera'};
  f.media.db.connection.prepare('UPDATE p3_local_features SET features_json=?,phash=? WHERE asset_id=?').run(JSON.stringify(features),features.perceptualHash,id);
 }
}
const settled=(state:string)=>['COMPLETED','FAILED','PAUSED','CANCELLED'].includes(state);

describe('P6.1 production integration and frozen cinematic choices',()=>{
 it('carries 140 photographs through meaningful moments, multi-image provider requests, layered local compositions and a verified mocked final movie',async()=>{
  const submissions:VideoSubmission[]=[],timelines:MovieTimeline[]=[];
  const f=await fixture({capabilities:{supportsFirstLastFrame:true,supportsMultiReference:true,maxReferenceImages:6},video:async(input,_signal,standard)=>{submissions.push(input);return standard();},render:async(input,standard)=>{timelines.push(input.timeline);return standard();}});seedActionMoments(f);
  // This test mocks local clip inspection/joining just like the fixture mocks FFmpeg.
  // The standalone synthetic validation exercises the real local media renderer.
  vi.spyOn(f.videoMedia,'joinSequence').mockImplementation((projectId,jobId,_parts,signal)=>f.videoMedia.streamVideo(projectId,jobId,new Response(tinyMp4(),{headers:{'content-type':'video/mp4'}}),signal));
  vi.spyOn(f.videoMedia,'validateVideo').mockImplementation(async(_file,expected)=>({durationSeconds:expected.durationSeconds,width:1280,height:720,videoCodec:'h264',audioCodec:'aac',hasAudio:true,frameRate:30,container:'mov,mp4'}));
  const detected=(await f.mutate('post','/api/cinematic/sequences/detect').expect(200)).body;
  expect(detected.sequences).toHaveLength(35);
  const quote=await f.quote({aiSceneCount:4,totalRetryAllowance:0,cinematic:cinematicPreferencesSchema.parse({})});
  expect(f.counters.analysis+f.counters.storyboard+f.counters.video).toBe(0);
  const run=await f.create(quote);await f.approve(run);const final=await waitForProduction(f,run.id,value=>settled(value.state),60000);
  expect(final.state,`${final.message};${final.errors.map(error=>error.code).join(',')}`).toBe('COMPLETED');
  expect(final.curation?.composition).toMatchObject({importedPhotos:140,recognizedSequences:35,multiImageAnimatedScenes:2,newFictionalScenes:2,plannedDurationSeconds:150});
  expect(final.curation!.composition!.uniqueSourcePhotos).toBeGreaterThan(20);
  expect(submissions.filter(input=>input.inputMode==='first_last_frame').length).toBeGreaterThanOrEqual(2);
  expect(submissions.filter(input=>input.inputMode==='first_last_frame').every(input=>input.images?.length===2)).toBe(true);
  const storyboard=f.director.get(f.owner,final.storyboardId!)!;
  const multiScenes=storyboard.scenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION'&&scene.sourcePhotoIds.length>1);
  expect(multiScenes).toHaveLength(2);expect(multiScenes.every(scene=>scene.sourcePhotoIds.length===4)).toBe(true);
  expect(timelines).toHaveLength(1);expect(timelines[0].ready).toBe(true);expect(timelines[0].durationSeconds).toBe(150);
  const compositions=timelines[0].segments.filter(segment=>segment.type==='composition');
  expect(compositions.length).toBeGreaterThanOrEqual(2);
  expect(compositions.every(segment=>(segment.sourcePhotoIds?.length??0)>1&&segment.compositionLayers?.filter(layer=>layer.kind==='photo').length===segment.sourcePhotoIds?.length)).toBe(true);
  expect(timelines[0].segments.reduce((sum,segment)=>sum+(segment.textOverlays?.length??0),0)).toBeGreaterThanOrEqual(3);
  expect(final.budget.estimatedSpendUsd+final.budget.reservedUsd).toBeLessThanOrEqual(final.approval!.maximumSpendUsd);
  await request(f.app).get(final.finalMovie!.url).expect(401);const other=await f.other();await other.client.get(final.finalMovie!.url).expect(404);
 },60000);
 it('invalidates a free cinematic quote after persistent moment edits without dispatching paid work',async()=>{
  const f=await fixture();await f.mutate('post','/api/cinematic/sequences/detect').expect(200);const quote=await f.quote({cinematic:cinematicPreferencesSchema.parse({})});
  const sequence=f.cinematicStore.sequences(f.owner)[0];await f.mutate('patch',`/api/cinematic/sequences/${sequence.id}`,{pinned:true}).expect(200);
  const rejected=await f.mutate('post','/api/production/runs',{quoteId:quote.id,idempotencyKey:randomUUID()}).expect(409);
  expect(rejected.body.error.code).toBe('PRODUCTION_QUOTE_CHANGED');expect(f.counters.analysis+f.counters.storyboard+f.counters.video).toBe(0);
  expect((await f.agent.get('/api/cinematic').expect(200)).body.sequences.find((value:PhotoSequence)=>value.id===sequence.id).pinned).toBe(true);
 });
 it('prevents another workspace from editing or adding its photographs to a moment',async()=>{
  const f=await fixture();const state=(await f.mutate('post','/api/cinematic/sequences/detect').expect(200)).body,sequence=state.sequences[0] as PhotoSequence,other=await f.other();
  await f.mutate('patch',`/api/cinematic/sequences/${sequence.id}`,{pinned:true},other.client,other.csrf).expect(404);
  await f.mutate('patch',`/api/cinematic/sequences/${sequence.id}`,{orderedPhotoIds:[randomUUID()]}).expect(400);
  expect((await other.client.get('/api/cinematic').expect(200)).body.sequences).toEqual([]);expect(f.counters.video).toBe(0);
 });
 it('keeps an unknown multi-image paid submission paused and reserved without retrying it',async()=>{
  const f=await fixture({capabilities:{supportsFirstLastFrame:false,supportsMultiReference:true,maxReferenceImages:6},video:async()=>{throw new VideoProviderError(504,'VIDEO_REQUEST_INTERRUPTED','Synthetic ambiguous multi-image outcome.','unknown',true);}});seedActionMoments(f);await f.mutate('post','/api/cinematic/sequences/detect').expect(200);
  for(const sequence of f.cinematicStore.sequences(f.owner))await f.mutate('patch',`/api/cinematic/sequences/${sequence.id}`,{recommendedPresentationType:'MULTI_REFERENCE_VIDEO'}).expect(200);
  const run=await f.create(await f.quote({aiSceneCount:4,totalRetryAllowance:0,cinematic:cinematicPreferencesSchema.parse({})}));await f.approve(run);
  const paused=await waitForProduction(f,run.id,value=>settled(value.state),30000);expect(paused.state).toBe('PAUSED');expect(f.counters.video).toBe(1);
  expect(paused.errors.some(error=>/UNKNOWN/.test(error.code))).toBe(true);expect(paused.budget.estimatedSpendUsd+paused.budget.reservedUsd).toBeGreaterThan(0);
  await f.mutate('post',`/api/production/runs/${run.id}/resume`,{}).expect(409);await f.mutate('post',`/api/production/runs/${run.id}/retry`,{}).expect(409);expect(f.counters.video).toBe(1);
 },30000);
});
