import {afterEach,describe,expect,it,vi} from 'vitest';
import request from 'supertest';
import session from 'express-session';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import type {ProviderCapabilities,StoryboardContent,VideoGenerationJob,VideoGenerationQuote,VideoQualityResult} from '@memories/shared';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {MediaStore} from '../src/media-store.js';
import {VideoMedia,type VideoCommandRunner} from '../src/video-media.js';
import type {KeyframeGenerationProvider,VideoGenerationProvider,VideoQualityProvider} from '../src/video-provider.js';

class InspectableStore extends session.MemoryStore{
 latestId='';
 override set(id:string,data:session.SessionData,callback?:(error?:unknown)=>void){this.latestId=id;super.set(id,data,callback);}
 async authorize(){const id=this.latestId;const data=await new Promise<session.SessionData>((resolve,reject)=>this.get(id,(error,value)=>error?reject(error):resolve(value!)));data.authorizedAt=Date.now();await new Promise<void>((resolve,reject)=>this.set(id,data,error=>error?reject(error):resolve()));return data.workspaceId;}
}
const disposals:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});
const baseCaps:ProviderCapabilities={provider:'omni',backend:'gemini',model:'gemini-omni-1.1-flash',available:true,accountVerified:false,supportedModes:['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE'],durationsSeconds:[8],resolutions:['720p'],aspectRatios:['16:9'],audioModes:[true],supportsCancellation:false,supportsRefinement:true,pollIntervalMs:10000,pricePerSecondUsd:0.15,priceVerifiedAt:'2026-11-14',maximumInputTokens:1000,maximumOutputTokens:1000,inputPricePerMillion:1.5,outputVideoPricePerMillion:17.5,outputTextPricePerMillion:9};
const quality:VideoQualityResult={status:'complete',summary:'No obvious visual defect in the mock sampled frames.',flags:[],score:85,identityAssessment:'advisory_not_identity_verification',requiresHumanReview:true};
async function fixture(options:{realRetiredProvider?:boolean;toolsAvailable?:boolean}={}){
 const root=await mkdtemp(join(tmpdir(),'memories-video-api-'));
 const config=loadConfig({SESSION_SECRET:'test-only-long-private-video-api-secret',MEDIA_STORAGE_PATH:join(root,'imports'),DATABASE_PATH:join(root,'studio.sqlite'),NODE_ENV:'test',MIN_FREE_DISK_BYTES:'0',VIDEO_PROVIDER:options.realRetiredProvider?'veo':'omni',VEO_MODEL:'veo-3.1-fast-generate-preview',VIDEO_MAX_PROJECT_BUDGET_USD:'10'});
 const sessions=new InspectableStore();
 const media=new MediaStore(config.mediaStoragePath,{databasePath:config.databasePath,sessionSecret:config.sessionSecret,minFreeDiskBytes:0});
 const runner:VideoCommandRunner=vi.fn(async()=>{if(options.toolsAvailable===false)throw new Error('Synthetic missing tools');return {stdout:'ffmpeg/ffprobe mock version'};});
 const videoMedia=new VideoMedia(media,{runner});
 const provider:VideoGenerationProvider={capabilities:()=>({...baseCaps}),submit:vi.fn(async()=>{throw new Error('A paid submission must not run in API tests');}),poll:vi.fn(async()=>{throw new Error('Unexpected mock polling');}),download:vi.fn(async()=>{throw new Error('Unexpected mock download');})};
 const keyframeProvider:KeyframeGenerationProvider={generate:vi.fn(async()=>{throw new Error('Unexpected mock keyframe submission');})};
 const qualityProvider:VideoQualityProvider={review:vi.fn(async()=>({quality,model:'mock-quality'}))};
 const app=createApp(config,{store:sessions,media,videoMedia,...(!options.realRetiredProvider?{videoProvider:provider}:{}),keyframeProvider,qualityProvider});
 // The worker has its own integration suite. Route tests stop it before any approval.
 await app.videoQueue.dispose();
 disposals.push(async()=>{await Promise.all([app.videoQueue.dispose(),app.analysis.dispose(),app.picker.dispose()]);media.db.close();await rm(root,{recursive:true,force:true});});
 const agent=request.agent(app.app);const info=(await agent.get('/api/session').expect(200)).body;const owner=await sessions.authorize();await app.directorStore.ensure(owner);
 const ids:string[]=[];
 for(let index=0;index<4;index++){
  const id=randomUUID();ids.push(id);const bytes=await sharp({create:{width:16,height:16,channels:3,background:{r:40+index,g:80,b:110}}}).jpeg().toBuffer();
  await writeFile(join(config.mediaStoragePath,owner,`${id}.jpg`),bytes);
  const data={id,projectId:owner,contributorId:'person1',filename:`Fixture ${index}.jpg`,mimeType:'image/jpeg',bytes:bytes.length,sha256:`fixture-hash-${index}`,importedAt:new Date().toISOString(),selected:true,storageName:`${id}.jpg`};
  media.db.connection.prepare('INSERT INTO assets(id,project_id,sha256,storage_name,bytes,selected,public_json) VALUES(?,?,?,?,?,1,?)').run(id,owner,data.sha256,data.storageName,bytes.length,JSON.stringify(data));
 }
 for(const [index,id] of (['person1','person2'] as const).entries())await app.directorStore.saveProtagonist(owner,id,{name:index?'Sam':'Alex',referencePhotoIds:ids.slice(index*2,index*2+2),likenessPermissionConfirmed:true});
 const types=['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE','PHOTO_MONTAGE','TITLE_SEQUENCE','PHOTO_MONTAGE','TITLE_SEQUENCE'] as const;
 const durations=[30,60,15,15,15,15];
 const content:StoryboardContent={schemaVersion:'1.0',title:'Private storyboard fixture',synopsis:'A grounded mix of originals and fictional scenes.',targetDurationSeconds:150,scenes:types.map((type,index)=>({id:randomUUID(),sequenceNumber:index+1,type,title:type==='NEW_CINEMATIC_SCENE'?'Fictional cinematic scene':`Scene ${index+1}`,description:type==='NEW_CINEMATIC_SCENE'?'A clearly fictional moment with the consented protagonists.':'A faithful source composition.',durationSeconds:durations[index],sourcePhotoIds:type==='TITLE_SEQUENCE'?[]:[ids[0],ids[2]],protagonistIds:type==='TITLE_SEQUENCE'?[]:['person1','person2'],visualStyle:'Natural light',cameraDirection:'Slow camera drift',motionPrompt:'Gentle movement only',emotionalTone:'Warm',continuityNotes:'Thematic placement',generationInstructions:'Preserve the supplied original or confirmed references.',isFictional:type==='NEW_CINEMATIC_SCENE',requiresUserConfirmation:true,userConfirmed:true}))};
 const board=await app.director.save(owner,content);
 const mutate=(method:'post'|'patch'|'put',path:string,body:unknown,client=agent,csrf=info.csrfToken)=>client[method](path).set('Origin',config.webOrigin).set('X-CSRF-Token',csrf).send(body as object);
 const quote=async(sceneIndex=0,extra:Record<string,unknown>={})=>(await mutate('post','/api/video/quotes',{storyboardId:board.id,sceneId:content.scenes[sceneIndex].id,...extra}).expect(201)).body as VideoGenerationQuote;
 const create=async(value:VideoGenerationQuote,key=randomUUID())=>(await mutate('post','/api/video/jobs',{quoteId:value.id,approved:true,idempotencyKey:key}).expect(202)).body as VideoGenerationJob;
 const other=async()=>{const client=request.agent(app.app);const otherInfo=(await client.get('/api/session').expect(200)).body;const otherOwner=await sessions.authorize();return {client,owner:otherOwner,csrf:otherInfo.csrfToken};};
 const insert=(table:string,row:Record<string,unknown>)=>{const keys=Object.keys(row);media.db.connection.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row) as (string|number|null)[]);};
 const completedAsset=async(generation:VideoGenerationJob)=>{
  const bytes=Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(24)]);
  const file=await videoMedia.streamVideo(owner,generation.id,new Response(bytes,{headers:{'content-type':'video/mp4'}}),new AbortController().signal);
  const picture=await sharp({create:{width:16,height:16,channels:3,background:'#82946f'}}).jpeg().toBuffer();
  const image=await videoMedia.saveKeyframe(owner,generation.id,picture,'image/jpeg');
  const assetId=randomUUID(),keyframeId=randomUUID(),now=new Date().toISOString();
  if(generation.mode==='NEW_CINEMATIC_SCENE')insert('generated_keyframes',{id:keyframeId,job_id:generation.id,project_id:owner,storyboard_id:board.id,scene_id:generation.sceneId,version:generation.version,storage_name:image.storageName,mime_type:image.mimeType,bytes:image.bytes,model:'mock-keyframe',created_at:now});
  insert('generated_video_assets',{id:assetId,job_id:generation.id,project_id:owner,storyboard_id:board.id,scene_id:generation.sceneId,version:generation.version,storage_name:file.storageName,thumbnail_name:image.storageName,frames_json:JSON.stringify([image.storageName]),keyframe_id:generation.mode==='NEW_CINEMATIC_SCENE'?keyframeId:null,source_asset_id:generation.mode==='ORIGINAL_ANIMATION'?ids[0]:null,inspection_json:JSON.stringify({durationSeconds:8,width:1280,height:720,videoCodec:'h264',audioCodec:'aac',hasAudio:true,container:'mp4'}),bytes:file.bytes,sha256:file.sha256,model:baseCaps.model,is_fictional:generation.mode==='NEW_CINEMATIC_SCENE'?1:0,refine_asset_id:null,created_at:now});
  insert('video_quality_reviews',{id:randomUUID(),asset_id:assetId,project_id:owner,quality_json:JSON.stringify(quality),decision:'pending',notes:'',created_at:now});
  media.db.connection.prepare("UPDATE video_generation_jobs SET state='COMPLETED',asset_id=?,keyframe_id=?,operation_id=?,spent_usd=estimated_usd,reserved_usd=0 WHERE id=?").run(assetId,generation.mode==='NEW_CINEMATIC_SCENE'?keyframeId:null,media.db.seal('private-provider-operation-id'),generation.id);
  return {assetId,keyframeId,file,image,bytes};
 };
 return {...app,agent,config,owner,root,ids,board,content,mutate,quote,create,other,provider,keyframeProvider,qualityProvider,completedAsset};
}

describe('private P4 approval and generation API',()=>{
 it('requires authentication for metadata, jobs, budgets and all generated media',async()=>{
  const f=await fixture();
  for(const path of ['/api/video','/api/video/assets','/api/video/budget',`/api/video/jobs/${randomUUID()}`,`/api/video/assets/${randomUUID()}/content`,`/api/video/assets/${randomUUID()}/thumbnail`,`/api/video/assets/${randomUUID()}/frames/1`,`/api/video/keyframes/${randomUUID()}/content`])await request(f.app).get(path).expect(401);
  const state=(await f.agent.get('/api/video').query({storyboardId:f.board.id}).expect(200)).body;
  expect(state).toMatchObject({configured:true,jobs:[],assets:[],settings:{durationSeconds:8,resolution:'720p',aspectRatio:'16:9',generateAudio:true},budget:{maximumSpendUsd:10,observedCostUsd:null,estimatesOnly:true}});
  expect(state.readiness.requiredScenes).toBe(2);
  expect(f.provider.submit).not.toHaveBeenCalled();expect(f.keyframeProvider.generate).not.toHaveBeenCalled();expect(f.qualityProvider.review).not.toHaveBeenCalled();
 });
 it('requires Origin/CSRF and explicit approval; quote previews never submit paid requests',async()=>{
  const f=await fixture();const body={storyboardId:f.board.id,sceneId:f.content.scenes[0].id};
  await f.agent.post('/api/video/quotes').send(body).expect(403);
  await f.agent.post('/api/video/quotes').set('Origin','https://untrusted.example').set('X-CSRF-Token','wrong').send(body).expect(403);
  const cost=await f.quote();expect(cost).toMatchObject({model:baseCaps.model,settings:{durationSeconds:8,resolution:'720p'},operations:{video:1,keyframe:0,quality:1},remainingBudgetUsd:10});expect(cost.estimatedCostUsd).toBeGreaterThan(0);
  await f.mutate('post','/api/video/jobs',{quoteId:cost.id,idempotencyKey:randomUUID()}).expect(400);
  await f.mutate('post','/api/video/jobs',{quoteId:cost.id,approved:false,idempotencyKey:randomUUID()}).expect(400);
  expect(f.media.db.connection.prepare('SELECT COUNT(*) AS count FROM video_generation_jobs').get()).toMatchObject({count:0});expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('reserves budget once and returns the same job for a lost-response idempotency retry even after quote expiry',async()=>{
  const f=await fixture();const cost=await f.quote(),key=randomUUID();
  const first=await f.create(cost,key);
  f.media.db.connection.prepare('UPDATE video_generation_quotes SET expires_at=? WHERE id=?').run(Date.now()-1,cost.id);
  const duplicate=await f.create(cost,key);expect(duplicate.id).toBe(first.id);
  const budget=(await f.agent.get('/api/video/budget').expect(200)).body;
  expect(budget.reservedUsd).toBeCloseTo(cost.estimatedCostUsd);expect(budget.observedCostUsd).toBeNull();
  expect(f.media.db.connection.prepare('SELECT COUNT(*) AS count FROM video_generation_jobs').get()).toMatchObject({count:1});
  const metadata=(await f.agent.get(`/api/video/jobs/${first.id}`).expect(200)).body;expect(metadata).toMatchObject({id:first.id,state:'PENDING'});expect(JSON.stringify(metadata)).not.toMatch(/operation_id|approval_json|fingerprint|quote_json/);
 });
 it('quotes bounded input/output consumption and invalidates approval when pricing or token ceilings change',async()=>{
  const f=await fixture();const cost=await f.quote();
  const expectedVideo=(baseCaps.maximumInputTokens!*baseCaps.inputPricePerMillion!+baseCaps.maximumOutputTokens!*Math.max(baseCaps.outputVideoPricePerMillion!,baseCaps.outputTextPricePerMillion!))/1e6;
  expect(cost.costBreakdown.videoUsd).toBeCloseTo(expectedVideo,6);
  expect(cost.estimatedCostUsd).toBeCloseTo(cost.costBreakdown.videoUsd+cost.costBreakdown.keyframeUsd+cost.costBreakdown.qualityUsd,6);
  vi.spyOn(f.provider,'capabilities').mockReturnValue({...baseCaps,maximumOutputTokens:2000,outputVideoPricePerMillion:20});
  await f.mutate('post','/api/video/jobs',{quoteId:cost.id,approved:true,idempotencyKey:randomUUID()}).expect(409).then(result=>expect(result.body.error.code).toBe('VIDEO_QUOTE_CHANGED'));
  expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('invalidates a reviewed quote after the selected original source content hash changes',async()=>{
  const f=await fixture();const cost=await f.quote();
  f.media.db.connection.prepare('UPDATE assets SET sha256=? WHERE id=? AND project_id=?').run('replacement-source-hash',f.ids[0],f.owner);
  await f.mutate('post','/api/video/jobs',{quoteId:cost.id,approved:true,idempotencyKey:randomUUID()}).expect(409).then(result=>expect(result.body.error.code).toBe('VIDEO_QUOTE_CHANGED'));
  expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('rejects expired quotes and insufficient budgets without starting a job',async()=>{
  const f=await fixture();const cost=await f.quote();
  f.media.db.connection.prepare('UPDATE video_generation_quotes SET expires_at=? WHERE id=?').run(Date.now()-1,cost.id);
  await f.mutate('post','/api/video/jobs',{quoteId:cost.id,approved:true,idempotencyKey:randomUUID()}).expect(409).then(result=>expect(result.body.error.code).toBe('VIDEO_QUOTE_EXPIRED'));
  await f.mutate('patch','/api/video/budget',{maximumSpendUsd:0.001}).expect(200);
  await f.mutate('post','/api/video/quotes',{storyboardId:f.board.id,sceneId:f.content.scenes[0].id}).expect(402).then(result=>expect(result.body.error.code).toBe('VIDEO_BUDGET_INSUFFICIENT'));
  expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('cancels an unsubmitted approved job and releases its unused reservation',async()=>{
  const f=await fixture();const pending=await f.create(await f.quote());
  const cancelled=(await f.mutate('post',`/api/video/jobs/${pending.id}/cancel`,{}).expect(200)).body;
  expect(cancelled.state).toBe('CANCELLED');
  const budget=(await f.agent.get('/api/video/budget').expect(200)).body;expect(budget.reservedUsd).toBe(0);expect(budget.estimatedSpendUsd).toBe(0);
  expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('continues a known saved operation without a replacement generation and rejects unknown submissions',async()=>{
  const f=await fixture();const cost=await f.quote(),generation=await f.create(cost);
  f.media.db.connection.prepare("UPDATE video_generation_jobs SET state='FAILED',operation_id=?,spent_usd=?,reserved_usd=0 WHERE id=?").run(f.media.db.seal('private-known-operation'),cost.costBreakdown.videoUsd,generation.id);
  const resumed=(await f.mutate('post',`/api/video/jobs/${generation.id}/resume`,{}).expect(202)).body;
  expect(resumed).toMatchObject({id:generation.id,state:'GENERATING_VIDEO',providerOperationPending:true});expect(JSON.stringify(resumed)).not.toContain('private-known-operation');
  expect(f.media.db.connection.prepare('SELECT COUNT(*) AS count FROM video_generation_jobs').get()).toMatchObject({count:1});expect(f.provider.submit).not.toHaveBeenCalled();
  const other=await f.other();await f.mutate('post',`/api/video/jobs/${generation.id}/resume`,{},other.client,other.csrf).expect(404);
  f.media.db.connection.prepare("UPDATE video_generation_jobs SET state='FAILED',submission_unknown=1 WHERE id=?").run(generation.id);
  await f.mutate('post',`/api/video/jobs/${generation.id}/resume`,{}).expect(409).then(result=>expect(result.body.error.code).toBe('VIDEO_SUBMISSION_UNKNOWN'));
 });
 it('invalidates a quote when likeness consent changes and gates only the selected scene review',async()=>{
  const f=await fixture();const cost=await f.quote();
  await f.directorStore.saveProtagonist(f.owner,'person1',{name:'Alex',referencePhotoIds:f.ids.slice(0,2),likenessPermissionConfirmed:false});
  await f.mutate('post','/api/video/jobs',{quoteId:cost.id,approved:true,idempotencyKey:randomUUID()}).expect(409).then(result=>expect(result.body.error.code).toMatch(/CONSENT|QUOTE_CHANGED/));
  await f.directorStore.saveProtagonist(f.owner,'person1',{name:'Alex',referencePhotoIds:f.ids.slice(0,2),likenessPermissionConfirmed:true});
  const draft=structuredClone(f.content);draft.scenes[1].userConfirmed=false;const saved=await f.director.save(f.owner,draft);
  await f.mutate('post','/api/video/quotes',{storyboardId:saved.id,sceneId:draft.scenes[1].id}).expect(409).then(result=>expect(result.body.error.code).toBe('SCENE_REVIEW_REQUIRED'));
  await f.mutate('post','/api/video/quotes',{storyboardId:saved.id,sceneId:draft.scenes[0].id}).expect(201);
  expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('validates source selection and excludes montage/title scenes from paid generation',async()=>{
  const f=await fixture();
  for(const index of [2,3])await f.mutate('post','/api/video/quotes',{storyboardId:f.board.id,sceneId:f.content.scenes[index].id}).expect(400).then(result=>expect(result.body.error.code).toBe('SCENE_NOT_GENERATABLE'));
  await f.mutate('post','/api/video/quotes',{storyboardId:f.board.id,sceneId:f.content.scenes[0].id,sourceAssetId:f.ids[1]}).expect(400).then(result=>expect(result.body.error.code).toBe('SOURCE_PHOTO_REQUIRED'));
  const original=await f.quote(0,{sourceAssetId:f.ids[2]});expect(original.sourceAssetId).toBe(f.ids[2]);expect(original.prompt).toContain(f.content.scenes[0].generationInstructions);expect(original.prompt).toContain(f.content.scenes[0].motionPrompt);
  const cinematic=await f.quote(1);expect(cinematic.operations.keyframe).toBe(1);expect(cinematic.sourcePhotoIds).toHaveLength(4);expect(cinematic.mode).toBe('NEW_CINEMATIC_SCENE');
 });
 it('enforces workspace ownership on storyboards, quotes, jobs and cancellation',async()=>{
  const f=await fixture();const cost=await f.quote(),job=await f.create(cost),other=await f.other();
  await other.client.get('/api/video').query({storyboardId:f.board.id}).expect(404);
  await f.mutate('post','/api/video/quotes',{storyboardId:f.board.id,sceneId:f.content.scenes[0].id},other.client,other.csrf).expect(404);
  await f.mutate('post','/api/video/jobs',{quoteId:cost.id,approved:true,idempotencyKey:randomUUID()},other.client,other.csrf).expect(409);
  await other.client.get(`/api/video/jobs/${job.id}`).expect(404);
  await f.mutate('post',`/api/video/jobs/${job.id}/cancel`,{},other.client,other.csrf).expect(404);
 });
 it('protects private MP4 range responses, keyframes, thumbnails and sampled frames',async()=>{
  const f=await fixture();const generation=await f.create(await f.quote(1)),asset=await f.completedAsset(generation);
  const info=(await f.agent.get('/api/video').query({storyboardId:f.board.id}).expect(200)).body;
  expect(info.assets[0]).toMatchObject({id:asset.assetId,isFictional:true,decision:'pending',quality:{identityAssessment:'advisory_not_identity_verification'}});
  expect(JSON.stringify(info)).not.toMatch(/storage_name|private-provider-operation-id|operation_id|fingerprint/);
  await f.agent.get(`/api/video/assets/${asset.assetId}/content`).set('Range','bytes=0-11').expect(206).then(result=>{expect(result.headers['content-range']).toContain(`bytes 0-11/${asset.bytes.length}`);expect(result.headers['cache-control']).toContain('no-store');});
  for(const path of [`/api/video/assets/${asset.assetId}/thumbnail`,`/api/video/assets/${asset.assetId}/frames/1`,`/api/video/keyframes/${asset.keyframeId}/content`])await f.agent.get(path).expect(200).then(result=>expect(result.headers['content-type']).toContain('image/jpeg'));
  const other=await f.other();for(const path of [`/api/video/assets/${asset.assetId}/content`,`/api/video/assets/${asset.assetId}/thumbnail`,`/api/video/assets/${asset.assetId}/frames/1`,`/api/video/keyframes/${asset.keyframeId}/content`])await other.client.get(path).expect(404);
  await f.mutate('post',`/api/video/assets/${asset.assetId}/review`,{decision:'approved'},other.client,other.csrf).expect(404);
  await f.agent.get(`/api/video/assets/${asset.assetId}/frames/0`).expect(400);
 });
 it('retains versions, human acceptance and P5 readiness while revoking stale consent readiness',async()=>{
  const f=await fixture();const original=await f.completedAsset(await f.create(await f.quote(0))),cinematic=await f.completedAsset(await f.create(await f.quote(1)));
  await f.mutate('post',`/api/video/assets/${original.assetId}/review`,{decision:'approved',notes:'Original composition reviewed.'}).expect(200);
  await f.mutate('post',`/api/video/assets/${cinematic.assetId}/review`,{decision:'approved',notes:'Fictional likeness and movement reviewed.'}).expect(200);
  let state=(await f.agent.get('/api/video').query({storyboardId:f.board.id}).expect(200)).body;
  expect(state.readiness).toMatchObject({requiredScenes:2,approvedScenes:2,readyForP5:true,testAReviewed:true,testBReviewed:true});
  const second=await f.create(await f.quote(0));expect(second.version).toBe(2);
  state=(await f.agent.get('/api/video').query({storyboardId:f.board.id}).expect(200)).body;expect(state.assets).toHaveLength(2);
  await f.directorStore.saveProtagonist(f.owner,'person2',{name:'Sam',referencePhotoIds:f.ids.slice(2,4),likenessPermissionConfirmed:false});
  state=(await f.agent.get('/api/video').query({storyboardId:f.board.id}).expect(200)).body;expect(state.readiness.readyForP5).toBe(false);expect(state.readiness.approvedScenes).toBe(0);
  await f.mutate('post',`/api/video/assets/${original.assetId}/review`,{decision:'approved'}).expect(409);
 });
 it('quotes explicit same-scene refinements from private saved conversations without exposing provider identifiers',async()=>{
  const f=await fixture();const parent=await f.create(await f.quote(0)),asset=await f.completedAsset(parent);
  const cost=await f.quote(0,{refineAssetId:asset.assetId,refinementPrompt:'Keep the composition and slow the camera movement.'});
  expect(cost).toMatchObject({refineAssetId:asset.assetId,operations:{keyframe:0,video:1,quality:1}});expect(JSON.stringify(cost)).not.toContain('private-provider-operation-id');
  const next=await f.create(cost);expect(next).toMatchObject({version:2,refineAssetId:asset.assetId});
  await f.mutate('post','/api/video/quotes',{storyboardId:f.board.id,sceneId:f.content.scenes[1].id,refineAssetId:asset.assetId,refinementPrompt:'A different scene.'}).expect(409).then(result=>expect(result.body.error.code).toBe('REFINEMENT_MISMATCH'));
  expect(f.provider.submit).not.toHaveBeenCalled();
 });
 it('keeps clip history across saved storyboard versions without counting an older clip as current P5 approval',async()=>{
  const f=await fixture();const oldJob=await f.create(await f.quote(0)),oldClip=await f.completedAsset(oldJob);
  await f.mutate('post',`/api/video/assets/${oldClip.assetId}/review`,{decision:'approved',notes:'Reviewed the first saved storyboard.'}).expect(200);
  const changed=structuredClone(f.content);changed.scenes[0].motionPrompt='A slower camera drift for this saved version.';
  const current=await f.director.save(f.owner,changed);
  const state=(await f.agent.get('/api/video').query({storyboardId:current.id}).expect(200)).body;
  expect(state.assets.some((asset:{id:string;storyboardId:string})=>asset.id===oldClip.assetId&&asset.storyboardId===f.board.id)).toBe(true);
  expect(state.jobs.some((job:{id:string})=>job.id===oldJob.id)).toBe(true);
  expect(state.readiness).toMatchObject({approvedScenes:0,readyForP5:false});
  const cost=(await f.mutate('post','/api/video/quotes',{storyboardId:current.id,sceneId:changed.scenes[0].id}).expect(201)).body as VideoGenerationQuote;
  const newJob=await f.create(cost);expect(newJob.version).toBe(2);expect(newJob.storyboardId).toBe(current.id);
 });
 it('keeps ambiguous reservations and demands extra acknowledgement for a new paid request',async()=>{
  const f=await fixture();const first=await f.create(await f.quote());
  f.media.db.connection.prepare("UPDATE video_generation_jobs SET state='FAILED',submission_unknown=1 WHERE id=?").run(first.id);
  const newCost=await f.quote();expect(newCost.requiresUnknownChargeAcknowledgement).toBe(true);
  await f.mutate('post','/api/video/jobs',{quoteId:newCost.id,approved:true,idempotencyKey:randomUUID()}).expect(400).then(result=>expect(result.body.error.code).toBe('VIDEO_APPROVAL_REQUIRED'));
  await f.mutate('post','/api/video/jobs',{quoteId:newCost.id,approved:true,idempotencyKey:randomUUID(),acknowledgeUnknownCharge:true}).expect(202);
  const budget=(await f.agent.get('/api/video/budget').expect(200)).body;expect(budget.reservedUsd).toBeGreaterThan(newCost.estimatedCostUsd);
  await f.mutate('patch','/api/video/budget',{maximumSpendUsd:0.001}).expect(409);
 });
 it('blocks paid quoting when tools or the explicitly retired provider are unavailable',async()=>{
  const f=await fixture({toolsAvailable:false});
  await f.mutate('post','/api/video/quotes',{storyboardId:f.board.id,sceneId:f.content.scenes[0].id}).expect(503).then(result=>expect(result.body.error.code).toBe('VIDEO_TOOLS_UNAVAILABLE'));
  const retired=await fixture({realRetiredProvider:true});
  const state=(await retired.agent.get('/api/video').query({storyboardId:retired.board.id}).expect(200)).body;expect(state.capabilities.available).toBe(false);expect(state.configured).toBe(false);
  await retired.mutate('post','/api/video/quotes',{storyboardId:retired.board.id,sceneId:retired.content.scenes[0].id}).expect(503).then(result=>expect(result.body.error.code).toBe('VIDEO_NOT_CONFIGURED'));
 });
});
