import session from 'express-session';
import request from 'supertest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {vi} from 'vitest';
import type {ProviderCapabilities,StoryboardContent,VideoGenerationJob,VideoQualityResult,MovieRenderJob} from '@memories/shared';
import {createApp} from '../src/app.js';
import {loadConfig} from '../src/config.js';
import {MediaStore} from '../src/media-store.js';
import {VideoMedia,type VideoCommandRunner} from '../src/video-media.js';
import type {MovieRenderer,MovieRenderInput,MovieInspection} from '../src/movie-renderer.js';
import type {VideoGenerationProvider,KeyframeGenerationProvider,VideoQualityProvider} from '../src/video-provider.js';

class Sessions extends session.MemoryStore {
 latestId='';
 override set(id:string,data:session.SessionData,callback?:(error?:unknown)=>void){this.latestId=id;super.set(id,data,callback);}
 async authorize(){const id=this.latestId;const data=await new Promise<session.SessionData>((resolve,reject)=>this.get(id,(error,value)=>error?reject(error):resolve(value!)));data.authorizedAt=Date.now();await new Promise<void>((resolve,reject)=>this.set(id,data,error=>error?reject(error):resolve()));return data.workspaceId;}
}
const capabilities:ProviderCapabilities={provider:'omni',backend:'gemini',model:'gemini-omni-1.1-flash',available:true,accountVerified:false,supportedModes:['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE'],durationsSeconds:[8],resolutions:['720p'],aspectRatios:['16:9'],audioModes:[true],supportsCancellation:true,supportsRefinement:true,pollIntervalMs:1000,pricePerSecondUsd:0.15,priceVerifiedAt:'2026-11-14',maximumInputTokens:1000,maximumOutputTokens:1000,inputPricePerMillion:1.5,outputVideoPricePerMillion:17.5,outputTextPricePerMillion:9};
const quality:VideoQualityResult={status:'complete',summary:'Synthetic visual review.',flags:[],score:80,identityAssessment:'advisory_not_identity_verification',requiresHumanReview:true};
export const mp4Fixture=()=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(40)]);
export const movieInspection:MovieInspection={durationSeconds:150,width:1920,height:1080,fps:30,videoCodec:'h264',audioCodec:'aac',hasAudio:true,container:'mov,mp4,m4a,3gp,3g2,mj2',faststart:true};
export async function movieFixture(options:{keepQueue?:boolean;render?:(input:MovieRenderInput)=>Promise<any>}={}){
 const root=await mkdtemp(join(tmpdir(),'memories-movie-'));
 const config=loadConfig({SESSION_SECRET:'test-only-long-private-movie-fixture-secret',MEDIA_STORAGE_PATH:join(root,'imports'),DATABASE_PATH:join(root,'studio.sqlite'),NODE_ENV:'test',MIN_FREE_DISK_BYTES:'0',MOVIE_MAX_WORKSPACE_BYTES:String(64*1024**2),MOVIE_MAX_SOUNDTRACK_BYTES:String(1024*1024)});
 const sessions=new Sessions(),media=new MediaStore(config.mediaStoragePath,{databasePath:config.databasePath,sessionSecret:config.sessionSecret,minFreeDiskBytes:0});
 const command:VideoCommandRunner=vi.fn(async()=>({stdout:'Synthetic ffmpeg version'}));
 const videoMedia=new VideoMedia(media,{runner:command});
 const provider:VideoGenerationProvider={capabilities:()=>({...capabilities}),submit:vi.fn(async()=>{throw new Error('Paid video submission forbidden in P5');}),poll:vi.fn(async()=>{throw new Error('Paid provider polling forbidden in P5');}),download:vi.fn(async()=>{throw new Error('Paid provider download forbidden in P5');})};
 const keyframe:KeyframeGenerationProvider={generate:vi.fn(async()=>{throw new Error('Paid keyframe submission forbidden in P5');})};
 const qualityProvider:VideoQualityProvider={review:vi.fn(async()=>{throw new Error('Paid quality submission forbidden in P5');})};
 const render=vi.fn(options.render??(async(input:MovieRenderInput)=>{input.onProgress?.({phase:'PREPARING_MEDIA',percent:25,message:'Preparing synthetic media.'});await writeFile(input.outputFile,mp4Fixture());const thumbnailFile=input.outputFile.replace(/\.mp4$/i,'.thumbnail.jpg');await writeFile(thumbnailFile,await sharp({create:{width:16,height:16,channels:3,background:'#667766'}}).jpeg().toBuffer());input.onProgress?.({phase:'VALIDATING_OUTPUT',percent:99,message:'Synthetic output validated.'});return {file:input.outputFile,thumbnailFile,inspection:movieInspection,diagnostics:{musicAdded:Boolean(input.soundtrackFile),sceneAudioRetained:true,onsetsAnalyzed:0,warnings:[],audioTruePeakDb:-2,audioIntegratedLufs:-18}};}));
 const renderer={detectTools:vi.fn(async()=>({available:true})),render,inspect:vi.fn(async()=>movieInspection),validate:vi.fn(async()=>movieInspection),probeSoundtrack:vi.fn(async()=>({durationSeconds:10,codec:'mp3',sampleRate:48000,channels:2})),analyzeSoundtrack:vi.fn(async()=>({duration:10,onsets:[1,2,3]})),dimensions:vi.fn((settings:{resolution:string;aspectRatio:string})=>settings.aspectRatio==='9:16'?{width:settings.resolution==='720p'?720:1080,height:settings.resolution==='720p'?1280:1920}:{width:settings.resolution==='720p'?1280:1920,height:settings.resolution==='720p'?720:1080})} as unknown as MovieRenderer;
 const app=createApp(config,{store:sessions,media,videoMedia,videoProvider:provider,keyframeProvider:keyframe,qualityProvider,movieRenderer:renderer});
 await app.videoQueue.dispose();await app.analysis.dispose();if(!options.keepQueue)await app.movieQueue.dispose();
 const agent=request.agent(app.app),sessionInfo=(await agent.get('/api/session').expect(200)).body,owner=await sessions.authorize();await app.directorStore.ensure(owner);
 const ids:string[]=[];
 for(let index=0;index<28;index++){
  const id=randomUUID(),bytes=await sharp({create:{width:16,height:16,channels:3,background:{r:(40+index*7)%256,g:(80+index*11)%256,b:(110+index*13)%256}}}).jpeg().toBuffer();ids.push(id);await writeFile(join(config.mediaStoragePath,owner,`${id}.jpg`),bytes);
  const data={id,projectId:owner,contributorId:'person1',filename:`Synthetic ${index}.jpg`,mimeType:'image/jpeg',bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),importedAt:new Date().toISOString(),selected:true,storageName:`${id}.jpg`};
  media.db.connection.prepare('INSERT INTO assets(id,project_id,sha256,storage_name,bytes,selected,public_json) VALUES(?,?,?,?,?,1,?)').run(id,owner,data.sha256,data.storageName,bytes.length,JSON.stringify(data));
 }
 for(const [index,id]of(['person1','person2'] as const).entries())await app.directorStore.saveProtagonist(owner,id,{name:index?'Sam':'Alex',referencePhotoIds:ids.slice(index*2,index*2+2),likenessPermissionConfirmed:true});
 const types=['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE','PHOTO_MONTAGE','TITLE_SEQUENCE','PHOTO_MONTAGE','TITLE_SEQUENCE'] as const,durations=[30,60,15,15,15,15];
 const content:StoryboardContent={schemaVersion:'1.0',title:'Synthetic private movie',synopsis:'Only synthetic fixture media.',targetDurationSeconds:150,scenes:types.map((type,index)=>({id:randomUUID(),sequenceNumber:index+1,type,title:`Synthetic scene ${index+1}`,description:type==='NEW_CINEMATIC_SCENE'?'A clearly fictional scene with the consented protagonists.':'A faithful supplied scene.',durationSeconds:durations[index],sourcePhotoIds:type==='TITLE_SEQUENCE'?[]:type==='PHOTO_MONTAGE'?ids.slice(index===2?4:16,index===2?16:28):[ids[0],ids[2]],protagonistIds:type==='TITLE_SEQUENCE'||type==='PHOTO_MONTAGE'?[]:['person1','person2'],visualStyle:'Natural light',cameraDirection:'Slow drift',motionPrompt:'Gentle movement only',emotionalTone:'Warm',continuityNotes:'Thematic',generationInstructions:'Preserve supplied references.',isFictional:type==='NEW_CINEMATIC_SCENE',requiresUserConfirmation:true,userConfirmed:true}))};
 const board=await app.director.save(owner,content);
 const insert=(table:string,row:Record<string,unknown>)=>{const keys=Object.keys(row);media.db.connection.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row) as (string|number|null)[]);};
 const clipIds:string[]=[];
 for(const index of[0,1]){
  const quote=await app.videoStore.quote(owner,{storyboardId:board.id,sceneId:content.scenes[index].id}),job=await app.videoStore.create(owner,{quoteId:quote.id,approved:true,idempotencyKey:randomUUID()});
  const file=await videoMedia.streamVideo(owner,job.id,new Response(mp4Fixture(),{headers:{'content-type':'video/mp4'}}),new AbortController().signal),id=randomUUID(),createdAt=new Date().toISOString();clipIds.push(id);
  insert('generated_video_assets',{id,job_id:job.id,project_id:owner,storyboard_id:board.id,scene_id:job.sceneId,version:job.version,storage_name:file.storageName,thumbnail_name:null,frames_json:'[]',keyframe_id:null,source_asset_id:index===0?ids[0]:null,inspection_json:JSON.stringify({durationSeconds:8,width:1280,height:720,videoCodec:'h264',audioCodec:'aac',hasAudio:true,container:'mp4'}),bytes:file.bytes,sha256:file.sha256,model:capabilities.model,is_fictional:index===1?1:0,refine_asset_id:null,created_at:createdAt});
  insert('video_quality_reviews',{id:randomUUID(),asset_id:id,project_id:owner,quality_json:JSON.stringify(quality),decision:'approved',notes:'Synthetic acceptance',created_at:createdAt});
  media.db.connection.prepare("UPDATE video_generation_jobs SET state='COMPLETED',asset_id=?,operation_id=?,spent_usd=estimated_usd,reserved_usd=0 WHERE id=?").run(id,media.db.seal('synthetic-private-operation'),job.id);
 }
 const mutate=(method:'post'|'patch'|'delete',path:string,body:unknown={},client=agent,csrf=sessionInfo.csrfToken)=>client[method](path).set('Origin',config.webOrigin).set('X-CSRF-Token',csrf).send(body as object);
 const create=async(key=randomUUID())=>(await mutate('post','/api/movie/jobs',{storyboardId:board.id,idempotencyKey:key}).expect(202)).body as MovieRenderJob;
 const other=async()=>{const client=request.agent(app.app);const info=(await client.get('/api/session').expect(200)).body,otherOwner=await sessions.authorize();return {client,owner:otherOwner,csrf:info.csrfToken};};
 const dispose=async()=>{await Promise.allSettled([app.movieQueue.dispose(),app.videoQueue.dispose(),app.analysis.dispose(),app.picker.dispose()]);media.db.close();await rm(root,{recursive:true,force:true});};
 return {...app,agent,config,owner,root,ids,board,content,clipIds,mutate,create,other,insert,provider,keyframe,qualityProvider,renderer,render,dispose};
}
