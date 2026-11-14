import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import sharp from 'sharp';
import type {ProviderCapabilities,StoryboardContent,VideoGenerationQuote,VideoQualityResult} from '@memories/shared';
import {MediaStore} from '../src/media-store.js';
import {VideoMedia} from '../src/video-media.js';
import {DirectorStore} from '../src/director-store.js';
import {StoryboardDirector} from '../src/storyboard.js';
import {VideoStore} from '../src/video-store.js';
import {VideoGenerationQueue} from '../src/video-queue.js';
import {loadConfig} from '../src/config.js';
import {ApiError} from '../src/errors.js';
import {VideoProviderError,type KeyframeGenerationProvider,type VideoGenerationProvider,type VideoQualityProvider,type ProviderVideoOperation,type KeyframeRequest,type KeyframeResult} from '../src/video-provider.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const caps:ProviderCapabilities={provider:'mock-video',backend:'gemini',model:'mock-video',available:true,supportedModes:['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE'],durationsSeconds:[8],resolutions:['720p'],aspectRatios:['16:9'],audioModes:[true],supportsCancellation:true,supportsRefinement:true,pollIntervalMs:10,pricePerSecondUsd:0.15,priceVerifiedAt:'2026-11-14',maximumInputTokens:1000,maximumOutputTokens:1000,inputPricePerMillion:1.5,outputVideoPricePerMillion:17.5,outputTextPricePerMillion:9};
const quality:VideoQualityResult={status:'complete',summary:'Synthetic frames require human visual review.',flags:[],score:85,identityAssessment:'advisory_not_identity_verification',requiresHumanReview:true};
const fakeVideo=()=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(52)]);
async function until(check:()=>boolean,maximum=5000){const deadline=Date.now()+maximum;while(!check()){if(Date.now()>deadline)throw new Error('Video queue checkpoint timed out');await delay(5);}}
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'memories-video-queue-'));
 const config=loadConfig({SESSION_SECRET:'private-long-test-video-queue-secret',MEDIA_STORAGE_PATH:join(root,'imports'),DATABASE_PATH:join(root,'studio.sqlite'),NODE_ENV:'test',MIN_FREE_DISK_BYTES:'0',VIDEO_MAX_AUTOMATIC_RETRIES:'1'});
 config.videoPollIntervalMs=10;
 const media=new MediaStore(config.mediaStoragePath,{databasePath:config.databasePath,sessionSecret:config.sessionSecret,minFreeDiskBytes:0});
 const directorStore=new DirectorStore(media,config),owner=randomUUID();await directorStore.ensure(owner);
 const images:string[]=[];
 const jpeg=await sharp({create:{width:32,height:18,channels:3,background:'#94aa82'}}).jpeg().toBuffer();
 for(let index=0;index<4;index++){const id=randomUUID();images.push(id);const bytes=Buffer.concat([jpeg,Buffer.from(String(index))]);await writeFile(join(media.root,owner,`${id}.jpg`),bytes);const sha256=createHash('sha256').update(bytes).digest('hex');const asset={id,projectId:owner,contributorId:'person1',filename:`Synthetic ${index}.jpg`,mimeType:'image/jpeg',bytes:bytes.length,sha256,importedAt:new Date().toISOString(),selected:true,storageName:`${id}.jpg`};media.db.connection.prepare('INSERT INTO assets(id,project_id,sha256,storage_name,bytes,selected,public_json) VALUES(?,?,?,?,?,1,?)').run(id,owner,sha256,asset.storageName,bytes.length,JSON.stringify(asset));}
 for(const [index,id] of (['person1','person2'] as const).entries())await directorStore.saveProtagonist(owner,id,{name:index?'Sam':'Alex',referencePhotoIds:images.slice(index*2,index*2+2),likenessPermissionConfirmed:true});
 const director=new StoryboardDirector(directorStore,{generateJson:async()=>{throw new Error('No storyboard generation in queue tests');}},config);
 const types=['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE','PHOTO_MONTAGE','TITLE_SEQUENCE','PHOTO_MONTAGE','TITLE_SEQUENCE'] as const;
 const durations=[30,60,15,15,15,15];
 const content:StoryboardContent={schemaVersion:'1.0',title:'Synthetic scene queue',synopsis:'Private test data.',targetDurationSeconds:150,scenes:types.map((type,index)=>({id:randomUUID(),sequenceNumber:index+1,type,title:type==='NEW_CINEMATIC_SCENE'?'Fictional scene':`Scene ${index+1}`,description:type==='NEW_CINEMATIC_SCENE'?'A fictional cinematic moment.':'An original photographic composition.',durationSeconds:durations[index],sourcePhotoIds:type==='TITLE_SEQUENCE'?[]:[images[0],images[2]],protagonistIds:type==='TITLE_SEQUENCE'?[]:['person1','person2'],visualStyle:'Natural light',cameraDirection:'Slow camera drift',motionPrompt:'Subtle realistic movement',emotionalTone:'Warm',continuityNotes:'Thematic placement',generationInstructions:'Preserve the supplied original or consented fictional references.',isFictional:type==='NEW_CINEMATIC_SCENE',requiresUserConfirmation:true,userConfirmed:true}))};
 const board=await director.save(owner,content);
 const videoMedia=new VideoMedia(media,{runner:async()=>({stdout:'synthetic tool version'})});
 vi.spyOn(videoMedia,'validateVideo').mockResolvedValue({durationSeconds:8,width:1280,height:720,videoCodec:'h264',audioCodec:'aac',hasAudio:true,frameRate:24,container:'mp4'});
 vi.spyOn(videoMedia,'createPreviews').mockImplementation(async(project,job)=>{
  const names=[`${job}.thumbnail.jpg`,`${job}.frame-1.jpg`,`${job}.frame-2.jpg`,`${job}.frame-3.jpg`];
  for(const name of names){await writeFile(videoMedia.file(project,name),jpeg,{mode:0o600});media.db.connection.prepare('INSERT OR IGNORE INTO video_media_files(project_id,storage_name,job_id,bytes,sha256,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)').run(project,name,job,jpeg.length,createHash('sha256').update(jpeg).digest('hex'),'image/jpeg','{}',Date.now());}
  return {thumbnailStorageName:names[0],frameStorageNames:names.slice(1)};
 });
 let operations=0;
 const provider:VideoGenerationProvider={capabilities:()=>({...caps}),submit:vi.fn(async()=>({operationId:`private-operation-${++operations}`,done:false,usage:{inputTokens:7,outputTokens:0}})),poll:vi.fn(async(id:string):Promise<ProviderVideoOperation>=>({operationId:id,done:true,model:'mock-video-resolved',output:{uri:'files/private-output',mimeType:'video/mp4'},usage:{inputTokens:100,outputTokens:200}})),download:vi.fn(async()=>new Response(fakeVideo(),{headers:{'content-type':'video/mp4'}})),cancel:vi.fn(async()=>{})};
 const keyframes:KeyframeGenerationProvider={generate:vi.fn(async(request:KeyframeRequest):Promise<KeyframeResult>=>({image:{data:jpeg,mimeType:'image/jpeg'},model:'mock-keyframe',usage:{inputTokens:300,outputTokens:100},referenceAssetIds:request.references.map(reference=>reference.assetId),requiresHumanReview:true,identityVerified:false}))};
 const qualityProvider:VideoQualityProvider={review:vi.fn(async()=>({quality,model:'mock-quality',usage:{inputTokens:100,outputTokens:50}}))};
 const store=new VideoStore(directorStore,director,provider,videoMedia,config);
 const queues:VideoGenerationQueue[]=[];
 const newQueue=()=>{const queue=new VideoGenerationQueue(store,provider,keyframes,qualityProvider,config);queues.push(queue);return queue;};
 const queue=newQueue();
 const quote=(index=0,extra:Record<string,unknown>={})=>store.quote(owner,{storyboardId:board.id,sceneId:content.scenes[index].id,...extra});
 const create=async(index=0,extra:Record<string,unknown>={})=>{const cost=await quote(index,extra);const job=await store.create(owner,{quoteId:cost.id,approved:true,idempotencyKey:randomUUID()});return {job,cost};};
 cleanups.push(async()=>{await Promise.all(queues.map(queue=>queue.dispose()));media.db.close();await rm(root,{recursive:true,force:true});});
 return {root,config,media,videoMedia,directorStore,director,owner,images,content,board,store,provider,keyframes,qualityProvider,queue,newQueue,quote,create,jpeg};
}

describe('persistent approved video queue',()=>{
 it('completes original-image animation with the exact approved prompt, private media, inspection and advisory review',async()=>{
  const f=await fixture();const {job,cost}=await f.create();expect(f.provider.submit).not.toHaveBeenCalled();await f.queue.drain();
  expect(f.store.job(f.owner,job.id)).toMatchObject({state:'COMPLETED',submissionUnknown:false});
  expect(f.provider.submit).toHaveBeenCalledTimes(1);expect(f.keyframes.generate).not.toHaveBeenCalled();expect(f.provider.poll).toHaveBeenCalledTimes(1);expect(f.qualityProvider.review).toHaveBeenCalledTimes(1);
  expect(vi.mocked(f.provider.submit).mock.calls[0][0]).toMatchObject({jobId:job.id,prompt:cost.prompt,settings:{durationSeconds:8,resolution:'720p',aspectRatio:'16:9',generateAudio:true},image:{mimeType:'image/jpeg'}});
  const asset=f.store.assets(f.owner)[0];expect(asset).toMatchObject({model:'mock-video-resolved',durationSeconds:8,width:1280,height:720,hasAudio:true,isFictional:false,decision:'pending',sourceAssetId:f.images[0],quality:{identityAssessment:'advisory_not_identity_verification'}});
  expect(f.store.budget(f.owner)).toMatchObject({reservedUsd:0,observedCostUsd:null});
  expect(f.media.db.connection.prepare('SELECT phase,status,observed_cost_usd FROM video_generation_attempts ORDER BY created_at').all()).toEqual([{phase:'video',status:'COMPLETED',observed_cost_usd:null},{phase:'quality',status:'COMPLETED',observed_cost_usd:null}]);
 });
 it('creates one consented keyframe before a fictional video and retains separate versioned assets',async()=>{
  const f=await fixture();const {job}=await f.create(1);await f.queue.drain();
  expect(f.store.job(f.owner,job.id).state).toBe('COMPLETED');expect(f.keyframes.generate).toHaveBeenCalledTimes(1);
  const references=vi.mocked(f.keyframes.generate).mock.calls[0][0].references;expect(references).toHaveLength(4);expect(references.filter(reference=>reference.protagonistId==='person1')).toHaveLength(2);expect(references.filter(reference=>reference.protagonistId==='person2')).toHaveLength(2);
  expect(f.store.keyframes(f.owner)).toHaveLength(1);expect(f.store.assets(f.owner)[0]).toMatchObject({isFictional:true,version:1,keyframeId:expect.any(String)});
  expect(f.media.db.connection.prepare('SELECT COUNT(*) AS count FROM video_generation_attempts').get()).toMatchObject({count:3});
 });
 it('keeps the full video ceiling reserved as estimated spending while partial usage reports zero output',async()=>{
  const f=await fixture();vi.mocked(f.provider.poll).mockImplementation(async id=>({operationId:id,done:false,usage:{inputTokens:7,outputTokens:0}}));
  const {job,cost}=await f.create();f.queue.wake();await until(()=>Boolean(f.store.row(f.owner,job.id).operation_id));
  expect(f.store.row(f.owner,job.id).spent_usd).toBeCloseTo(cost.costBreakdown.videoUsd);
  expect(f.store.budget(f.owner).estimatedSpendUsd+f.store.budget(f.owner).reservedUsd).toBeCloseTo(cost.estimatedCostUsd);
  await f.store.setBudget(f.owner,cost.estimatedCostUsd+0.001);await expect(f.quote(1)).rejects.toMatchObject({code:'VIDEO_BUDGET_INSUFFICIENT'});
  await f.queue.cancel(f.owner,job.id);
 });
 it('records ambiguous submissions before calling the provider and never repeats them after restart',async()=>{
  const f=await fixture();vi.mocked(f.provider.submit).mockImplementation(async()=>{expect(f.media.db.connection.prepare("SELECT status FROM video_generation_attempts WHERE phase='video'").get()).toMatchObject({status:'SUBMITTING'});throw new VideoProviderError(503,'VIDEO_NETWORK_UNKNOWN','Submission status unknown.','unknown',true);});
  const {job,cost}=await f.create();await f.queue.drain();expect(f.store.job(f.owner,job.id)).toMatchObject({state:'FAILED',submissionUnknown:true,errorCode:'VIDEO_SUBMISSION_UNKNOWN'});
  expect(f.store.row(f.owner,job.id).spent_usd).toBeCloseTo(cost.costBreakdown.videoUsd);expect(f.store.budget(f.owner).reservedUsd).toBe(0);
  await f.queue.dispose();await f.newQueue().drain();expect(f.provider.submit).toHaveBeenCalledTimes(1);await expect(f.queue.resume(f.owner,job.id)).rejects.toMatchObject({code:'VIDEO_SUBMISSION_UNKNOWN'});
 });
 it('recovers an interrupted SUBMITTING intent without issuing a replacement paid request',async()=>{
  const f=await fixture();await f.queue.dispose();const {job,cost}=await f.create();
  f.media.db.connection.prepare("UPDATE video_generation_jobs SET state='GENERATING_VIDEO' WHERE id=?").run(job.id);
  const timestamp=new Date().toISOString();f.media.db.connection.prepare("INSERT INTO video_generation_attempts(id,job_id,phase,status,estimated_usd,created_at,updated_at) VALUES(?,?,'video','SUBMITTING',?,?,?)").run(randomUUID(),job.id,cost.costBreakdown.videoUsd,timestamp,timestamp);
  await f.newQueue().drain();expect(f.provider.submit).not.toHaveBeenCalled();expect(f.store.job(f.owner,job.id)).toMatchObject({state:'FAILED',submissionUnknown:true});expect(f.store.row(f.owner,job.id).spent_usd).toBeCloseTo(cost.costBreakdown.videoUsd);
 });
 it('recovers a durable keyframe even when its job checkpoint commit was interrupted',async()=>{
  const f=await fixture();await f.queue.dispose();const {job,cost}=await f.create(1);
  f.media.db.connection.prepare("UPDATE video_generation_jobs SET state='GENERATING_KEYFRAME' WHERE id=?").run(job.id);
  const timestamp=new Date().toISOString();f.media.db.connection.prepare("INSERT INTO video_generation_attempts(id,job_id,phase,status,estimated_usd,created_at,updated_at) VALUES(?,?,'keyframe','SUBMITTING',?,?,?)").run(randomUUID(),job.id,cost.costBreakdown.keyframeUsd,timestamp,timestamp);
  await f.videoMedia.saveKeyframe(f.owner,job.id,f.jpeg,'image/jpeg');
  await f.newQueue().drain();expect(f.keyframes.generate).not.toHaveBeenCalled();expect(f.provider.submit).toHaveBeenCalledTimes(1);expect(f.store.job(f.owner,job.id)).toMatchObject({state:'COMPLETED',submissionUnknown:false});
 });
 it('resumes polling a saved provider operation without submitting another generation',async()=>{
  const f=await fixture();const {job}=await f.create();f.queue.wake();await until(()=>Boolean(f.store.row(f.owner,job.id).operation_id));await f.queue.dispose();
  const encrypted=f.store.row(f.owner,job.id).operation_id!;expect(encrypted).not.toContain('private-operation');
  await f.newQueue().drain();expect(f.provider.submit).toHaveBeenCalledTimes(1);expect(f.store.job(f.owner,job.id).state).toBe('COMPLETED');
 });
 it('honors shared rate limiting and retries only known rejected submissions',async()=>{
  const f=await fixture();const original=vi.mocked(f.provider.submit).getMockImplementation()!;let first=true;
  vi.mocked(f.provider.submit).mockImplementation(async(request,signal)=>{if(first){first=false;throw new VideoProviderError(429,'VIDEO_RATE_LIMIT','Rate limited.','rejected',true,80);}return original(request,signal);});
  const {job}=await f.create();f.queue.wake();await until(()=>vi.mocked(f.provider.submit).mock.calls.length===1);await delay(30);expect(f.provider.submit).toHaveBeenCalledTimes(1);
  await f.queue.drain();expect(f.provider.submit).toHaveBeenCalledTimes(2);expect(f.store.job(f.owner,job.id).state).toBe('COMPLETED');
  expect(f.media.db.connection.prepare("SELECT COUNT(*) AS count FROM video_generation_attempts WHERE phase='video' AND status='REJECTED'").get()).toMatchObject({count:1});
  expect(f.media.db.connection.prepare("SELECT error_code,safe_message FROM video_generation_attempts WHERE phase='video' AND status='REJECTED'").get()).toMatchObject({error_code:'VIDEO_RATE_LIMIT',safe_message:'Rate limited.'});
 });
 it('waits through normal file activation beyond the transient retry allowance',async()=>{
  const f=await fixture();let calls=0;vi.mocked(f.provider.download).mockImplementation(async()=>{if(calls++<3)throw new VideoProviderError(503,'VIDEO_FILE_PROCESSING','File activation pending.','rejected',true,10);return new Response(fakeVideo(),{headers:{'content-type':'video/mp4'}});});
  const {job}=await f.create();await f.queue.drain();expect(f.provider.download).toHaveBeenCalledTimes(4);expect(f.provider.submit).toHaveBeenCalledTimes(1);expect(f.store.job(f.owner,job.id).state).toBe('COMPLETED');
 });
 it('resumes failed output retrieval using its original operation and approved remaining review budget',async()=>{
  const f=await fixture();vi.mocked(f.provider.download).mockRejectedValue(new VideoProviderError(503,'VIDEO_DOWNLOAD_UNAVAILABLE','Temporary download error.','rejected',true,10));
  const {job}=await f.create();await f.queue.drain();expect(f.store.job(f.owner,job.id).state).toBe('FAILED');expect(f.provider.submit).toHaveBeenCalledTimes(1);
  vi.mocked(f.provider.download).mockResolvedValue(new Response(fakeVideo(),{headers:{'content-type':'video/mp4'}}));
  await f.queue.resume(f.owner,job.id);await f.queue.drain();expect(f.store.job(f.owner,job.id).state).toBe('COMPLETED');expect(f.provider.submit).toHaveBeenCalledTimes(1);
 });
 it('cancels a pending job for its owner without spending or crossing workspace ownership',async()=>{
  const f=await fixture();const {job}=await f.create();await expect(f.queue.cancel(randomUUID(),job.id)).rejects.toMatchObject({status:404});
  expect(await f.queue.cancel(f.owner,job.id)).toMatchObject({state:'CANCELLED',submissionUnknown:false});expect(f.provider.submit).not.toHaveBeenCalled();expect(f.store.budget(f.owner)).toMatchObject({reservedUsd:0,estimatedSpendUsd:0});
 });
 it('fences a late paid response after cancellation and conservatively retains its possible charge',async()=>{
  const f=await fixture();let finish!:(operation:ProviderVideoOperation)=>void;
  vi.mocked(f.provider.submit).mockImplementation(async()=>new Promise(resolve=>{finish=resolve;}));
  const {job,cost}=await f.create();f.queue.wake();await until(()=>Boolean(finish));
  const cancelled=await f.queue.cancel(f.owner,job.id);expect(cancelled).toMatchObject({state:'CANCELLED',submissionUnknown:true});
  finish({operationId:'late-private-operation',done:false});await f.queue.drain();
  expect(f.store.row(f.owner,job.id)).toMatchObject({state:'CANCELLED',operation_id:null});expect(f.store.row(f.owner,job.id).spent_usd).toBeCloseTo(cost.costBreakdown.videoUsd);expect(f.store.budget(f.owner).reservedUsd).toBe(0);
  expect(f.provider.submit).toHaveBeenCalledTimes(1);expect(f.provider.poll).not.toHaveBeenCalled();
 });
 it('allows only one coordinator to submit a paid request for the same approved job',async()=>{
  const f=await fixture();const {job}=await f.create();const second=f.newQueue();f.queue.wake();await Promise.all([f.queue.drain(),second.drain()]);
  expect(f.store.job(f.owner,job.id).state).toBe('COMPLETED');expect(f.provider.submit).toHaveBeenCalledTimes(1);expect(f.qualityProvider.review).toHaveBeenCalledTimes(1);
 });
 it('cancels a known provider operation even after protagonist permission is revoked',async()=>{
  const f=await fixture();const {job}=await f.create();f.queue.wake();await until(()=>Boolean(f.store.row(f.owner,job.id).operation_id));
  await f.directorStore.saveProtagonist(f.owner,'person1',{name:'Alex',referencePhotoIds:f.images.slice(0,2),likenessPermissionConfirmed:false});
  const cancelled=await f.queue.cancel(f.owner,job.id);expect(cancelled.state).toBe('CANCELLED');expect(cancelled.message).toMatch(/incur charges/);expect(f.provider.cancel).toHaveBeenCalledTimes(1);
 });
 it('stops before a paid request when permission or the budget reservation is invalid',async()=>{
  const f=await fixture();const {job}=await f.create();await f.directorStore.saveProtagonist(f.owner,'person1',{name:'Alex',referencePhotoIds:f.images.slice(0,2),likenessPermissionConfirmed:false});await f.queue.drain();
  expect(f.store.job(f.owner,job.id).state).toBe('FAILED');expect(f.provider.submit).not.toHaveBeenCalled();expect(f.store.budget(f.owner).estimatedSpendUsd).toBe(0);
  const second=await fixture();const next=await second.create();second.media.db.connection.prepare('UPDATE project_generation_budgets SET maximum_spend_usd=0.001 WHERE project_id=?').run(second.owner);await second.queue.drain();expect(second.provider.submit).not.toHaveBeenCalled();expect(second.store.job(second.owner,next.job.id).state).toBe('FAILED');
 });
 it('retains the paid generation charge when local output validation fails and creates no approved asset',async()=>{
  const f=await fixture();vi.mocked(f.videoMedia.validateVideo).mockRejectedValue(new ApiError(422,'VIDEO_OUTPUT_UNREADABLE','Synthetic decode failure.'));
  const {job}=await f.create();await f.queue.drain();expect(f.store.job(f.owner,job.id)).toMatchObject({state:'FAILED',errorCode:'VIDEO_OUTPUT_UNREADABLE'});expect(f.store.assets(f.owner)).toHaveLength(0);expect(f.store.row(f.owner,job.id).spent_usd).toBeGreaterThan(0);
 });
 it('forwards approved refinement instructions, reuses the previous keyframe and keeps version history',async()=>{
  const f=await fixture();const first=await f.create(1);await f.queue.drain();const asset=f.store.assets(f.owner)[0];
  const refined=await f.create(1,{refineAssetId:asset.id,refinementPrompt:'Keep the same framing and use gentler movement.'});await f.queue.drain();
  expect(f.store.job(f.owner,refined.job.id)).toMatchObject({state:'COMPLETED',version:2,refineAssetId:asset.id});expect(f.keyframes.generate).toHaveBeenCalledTimes(1);
  const request=vi.mocked(f.provider.submit).mock.calls[1][0];expect(request.prompt).toBe(refined.cost.prompt);expect(request.prompt).toContain('gentler movement');expect(request.previousInteractionId).toBe(f.store.db.unseal(f.store.row(f.owner,first.job.id).operation_id!));expect(f.store.assets(f.owner)).toHaveLength(2);
 });
});

describe('P6.1 persistent ordered sequence generation',()=>{
 async function sequenceFixture(chain=false){
  const f=await fixture();vi.mocked(f.provider.capabilities??(()=>caps));
  f.provider.capabilities=()=>({...caps,supportsFirstLastFrame:true,supportsMultiReference:true,maxReferenceImages:3});
  const content=structuredClone(f.content),scene=content.scenes[0];scene.presentationType=chain?'CHAINED_KEYFRAME_ANIMATION':'FIRST_LAST_FRAME_INTERPOLATION';scene.animationStrategy=chain?'CHAINED_PAIRS':'FIRST_LAST_FRAME';scene.sourcePhotoIds=chain?[f.images[0],f.images[1],f.images[2]]:[f.images[0],f.images[2]];scene.firstFramePhotoId=scene.sourcePhotoIds[0];scene.lastFramePhotoId=scene.sourcePhotoIds.at(-1);scene.sequenceSegments=chain?[{id:randomUUID(),firstFramePhotoId:f.images[0],lastFramePhotoId:f.images[1],sourcePhotoIds:[f.images[0],f.images[1]],durationSeconds:8},{id:randomUUID(),firstFramePhotoId:f.images[1],lastFramePhotoId:f.images[2],sourcePhotoIds:[f.images[1],f.images[2]],durationSeconds:8}]:[];
  const board=await f.director.save(f.owner,content),quote=await f.store.quote(f.owner,{storyboardId:board.id,sceneId:scene.id}),job=await f.store.create(f.owner,{quoteId:quote.id,approved:true,idempotencyKey:randomUUID()});return {...f,quote,job};
 }
 it('retains both source hashes in the quote and sends both ordered frames to the worker provider',async()=>{
  const f=await sequenceFixture();expect(f.quote.sourcePhotoIds).toEqual([f.images[0],f.images[2]]);await f.queue.drain();expect(f.store.job(f.owner,f.job.id).state).toBe('COMPLETED');const sent=vi.mocked(f.provider.submit).mock.calls[0][0];expect(sent.inputMode).toBe('first_last_frame');expect(sent.images).toHaveLength(2);expect(f.provider.submit).toHaveBeenCalledTimes(1);
 });
 it('checkpoints each adjacent pair separately, joins locally, and does not redispatch after restart',async()=>{
  const f=await sequenceFixture(true);vi.spyOn(f.videoMedia,'joinSequence').mockImplementation(async(owner,job,parts)=>{expect(parts).toHaveLength(2);return f.videoMedia.streamVideo(owner,job,new Response(fakeVideo(),{headers:{'content-type':'video/mp4'}}),new AbortController().signal);});
  vi.mocked(f.videoMedia.validateVideo).mockImplementation(async(_file,expected)=>({durationSeconds:expected.durationSeconds,width:1280,height:720,videoCodec:'h264',audioCodec:'aac',hasAudio:true,frameRate:30,container:'mp4'}));
  await f.queue.drain();expect(f.store.job(f.owner,f.job.id).state).toBe('COMPLETED');expect(f.quote.operations.video).toBe(2);expect(f.provider.submit).toHaveBeenCalledTimes(2);
  expect(f.media.db.connection.prepare("SELECT phase,status FROM video_generation_attempts WHERE job_id=? AND phase LIKE 'video%' ORDER BY phase").all(f.job.id)).toEqual([{phase:'video:0',status:'COMPLETED'},{phase:'video:1',status:'COMPLETED'}]);
  const checkpoint=JSON.parse(f.store.row(f.owner,f.job.id).checkpoint_json!);expect(checkpoint.sequenceParts).toHaveLength(2);expect(checkpoint.sequenceOperations.every((id:string)=>!id.includes('private-operation'))).toBe(true);expect(f.store.assets(f.owner)[0].durationSeconds).toBe(16);await f.queue.dispose();await f.newQueue().drain();expect(f.provider.submit).toHaveBeenCalledTimes(2);
 });
 it('holds a second-pair unknown submission instead of purchasing a replacement on restart',async()=>{
  const f=await sequenceFixture(true),original=vi.mocked(f.provider.submit).getMockImplementation()!;let calls=0;vi.mocked(f.provider.submit).mockImplementation(async(req,signal)=>{if(++calls===2)throw new VideoProviderError(504,'VIDEO_REQUEST_INTERRUPTED','Unknown second pair','unknown',true);return original(req,signal);});
  await f.queue.drain();expect(f.store.job(f.owner,f.job.id)).toMatchObject({state:'FAILED',submissionUnknown:true});expect(JSON.parse(f.store.row(f.owner,f.job.id).checkpoint_json!).sequenceParts).toHaveLength(1);await f.queue.dispose();await f.newQueue().drain();expect(calls).toBe(2);await expect(f.queue.resume(f.owner,f.job.id)).rejects.toMatchObject({code:'VIDEO_SUBMISSION_UNKNOWN'});
 });
 it('re-reserves future unsubmitted pairs when resuming a known first operation',async()=>{
  const f=await sequenceFixture(true);vi.mocked(f.provider.poll).mockImplementation(async id=>({operationId:id,done:false}));
  f.queue.wake();await until(()=>Boolean(f.store.row(f.owner,f.job.id).operation_id));await f.queue.cancel(f.owner,f.job.id);
  await f.queue.resume(f.owner,f.job.id);const row=f.store.row(f.owner,f.job.id);
  expect(row.reserved_usd).toBeCloseTo(f.quote.costBreakdown.videoUsd/2+f.quote.costBreakdown.qualityUsd);
  await f.queue.cancel(f.owner,f.job.id);
 });

});
