import type {CinematicStore} from './cinematic-store.js';
import {CinematicEditingDirector} from './cinematic-editing-director.js';
import {sequenceReasoningContext} from './photo-sequence-analyzer.js';
import {z} from 'zod';
import {productionConfigSchema,type AnalysisRun,type CuratedSelection,type GeminiUsage,type GeneratedVideoAsset,type JsonGenerationRequest,type JsonGenerator,type MovieRenderAsset,type ProductionConfig,type ProductionCurationSummary,type Storyboard,type StoryboardContent,type VideoGenerationJob,type VideoGenerationQuote} from '@memories/shared';
import type {Config} from './config.js';
import {AnalysisQueue} from './analysis-queue.js';
import {DirectorStore} from './director-store.js';
import {StoryboardDirector,type StoryboardProductionPolicy} from './storyboard.js';
import {curatePhotos,type CurationStore,type DirectorPhotoRow} from './curation.js';
import {VideoStore} from './video-store.js';
import {VideoGenerationQueue} from './video-queue.js';
import {MovieStore} from './movie-store.js';
import {MovieRenderQueue} from './movie-queue.js';
import {PRODUCTION_JSON_BOUNDS,shapeProductionStoryboard,prepareCinematicStoryboardTemplates} from './production-plan.js';
import {ApiError} from './errors.js';

export type ProductionJsonResult={json:unknown;usage:GeminiUsage};
/** The orchestrator owns this ledger; the bridge never creates a second budget. */
export interface ProductionPaidExecutor {
 assertDispatch?(runId:string):void;
 execute(input:{runId:string;key:string;phase:'analysis'|'planning';estimateUsd:number},dispatch:()=>Promise<ProductionJsonResult>):Promise<ProductionJsonResult>;
}
const roundCost=(amount:number)=>Math.ceil((amount-1e-12)*1e6)/1e6;
/** Durable result replay/unknown-submission protection is supplied by the run ledger. */
export class ProductionJsonGenerator implements JsonGenerator {
 constructor(readonly underlying:JsonGenerator,readonly executor:ProductionPaidExecutor,readonly config:Config){}
 checkModel(){return this.underlying.checkModel?.()??Promise.resolve();}
 async generateJson(request:JsonGenerationRequest,signal:AbortSignal):Promise<ProductionJsonResult>{
  if(!request.productionRunId||!request.operationKey)throw new ApiError(400,'PRODUCTION_OPERATION_REQUIRED','Automatic generation needs a durable production run and operation key.');
  z.string().uuid().parse(request.productionRunId);if(request.operationKey.length>500||!request.operationKey.trim())throw new ApiError(400,'PRODUCTION_OPERATION_REQUIRED','The durable production operation key is invalid.');
  if(signal.aborted)throw new ApiError(409,'PRODUCTION_PAUSED','Automatic production was paused before dispatch.');
  const limits=request.operation==='photo_analysis'?PRODUCTION_JSON_BOUNDS.photo:PRODUCTION_JSON_BOUNDS.storyboard;
  const maxOutputTokens=Math.min(limits.outputTokens,request.maxOutputTokens??limits.outputTokens,this.config.geminiMaxOutputTokens??12288);
  const estimateUsd=roundCost((limits.inputTokens*(this.config.geminiInputPricePerMillion??.30)+maxOutputTokens*(this.config.geminiOutputPricePerMillion??2.50))/1e6);
  return this.executor.execute({runId:request.productionRunId,key:request.operationKey,phase:request.operation==='photo_analysis'?'analysis':'planning',estimateUsd},()=>{
   if(signal.aborted)throw new ApiError(409,'PRODUCTION_PAUSED','Automatic production was paused before dispatch.');
   // Only this guarded callback authorizes P3 to record its own usage without
   // applying the unrelated legacy project cap a second time.
   return this.underlying.generateJson({...request,maxOutputTokens,maximumInputTokens:limits.inputTokens,productionBudgetAuthorized:true,beforePaidDispatch:()=>{this.executor.assertDispatch?.(request.productionRunId!);}},signal);
  });
 }
}
export type ProductionBridgeServices={store:DirectorStore;analysis:AnalysisQueue;director:StoryboardDirector;videoStore:VideoStore;videoQueue:VideoGenerationQueue;movieStore:MovieStore;movieQueue:MovieRenderQueue;generator:JsonGenerator;config:Config;cinematic?:CinematicStore};
/** Thin adapters reuse P3/P4/P5 workers, stores and their existing private URLs. */
export class ProductionBridge {
 readonly generator:ProductionJsonGenerator;
 private readonly selected:CurationStore;
 constructor(readonly services:ProductionBridgeServices,executor:ProductionPaidExecutor){
  this.generator=new ProductionJsonGenerator(services.generator,executor,services.config);services.analysis.setProductionGenerator(this.generator);
  this.selected=this.selectedStore();
 }
 private selectedStore(runId?:string):CurationStore {const services=this.services;return {ensure:owner=>services.store.ensure(owner),protagonists:owner=>services.store.protagonists(owner),rows:(owner,limit=100,afterId)=>{
   const result:DirectorPhotoRow[]=[];let after=afterId;while(result.length<limit){const page=runId?services.store.productionRows(owner,runId,Math.min(200,limit-result.length),after):services.store.rows(owner,Math.min(200,limit-result.length),after);if(!page.length)break;for(const row of page)if(row.asset.selected&&!row.curation.excluded)result.push(row);const next=page.at(-1)!.asset.id;if(next===after)throw new ApiError(500,'CURATION_PAGINATION_ERROR','Automatic curation could not advance through the project.');after=next;}return result;
  }};}

 private profiles(owner:string){const people=this.services.store.protagonists(owner);if(people.length!==2||people.some(person=>!person.ready||!person.likenessPermissionConfirmed))throw new ApiError(409,'PRODUCTION_PROTAGONISTS_REQUIRED','Both protagonists need names, two approved references and current likeness permission.');return people;}
 async startAnalysis(owner:string,runId:string):Promise<AnalysisRun>{this.profiles(owner);return this.services.analysis.start(owner,false,runId);}
 analysisStatus(owner:string,id:string){return this.services.analysis.get(owner,id);}
 pauseAnalysis(owner:string,id:string){return this.services.analysis.pause(owner,id);}
 resumeAnalysis(owner:string,id:string){this.profiles(owner);return this.services.analysis.resume(owner,id);}
 cancelAnalysis(owner:string,id:string){return this.services.analysis.cancel(owner,id);}
 async curate(owner:string,durationSeconds=150,runId?:string):Promise<CuratedSelection>{this.profiles(owner);return (await curatePhotos(runId?this.selectedStore(runId):this.selected,owner,durationSeconds,this.services.config.analysisNearDuplicateDistance??5)).selection;}
 private rows(owner:string,ids:readonly string[],runId?:string,referenceOnly=false){const wanted=new Set(ids),result:DirectorPhotoRow[]=[];let after:string|undefined;while(wanted.size){const page=runId?this.services.store.productionRows(owner,runId,200,after):this.services.store.rows(owner,200,after);if(!page.length)break;for(const row of page)if(wanted.has(row.asset.id)){if((!row.asset.selected||row.curation.excluded)&&!referenceOnly)throw new ApiError(409,'PRODUCTION_SOURCE_CHANGED','An automatic storyboard source is no longer selected or available.');result.push(row);wanted.delete(row.asset.id);}after=page.at(-1)!.asset.id;}if(wanted.size)throw new ApiError(409,'PRODUCTION_SOURCE_CHANGED','An automatic storyboard source was deleted.');return result;}
 private referenceRows(owner:string,ids:readonly string[]){const allowed=new Set(this.profiles(owner).flatMap(person=>person.referencePhotoIds));if(ids.some(id=>!allowed.has(id)))throw new ApiError(409,'PRODUCTION_REFERENCE_NOT_APPROVED','Choose current, explicitly approved protagonist references.');return this.rows(owner,ids,undefined,true);}
 async generateStoryboard(owner:string,runId:string,value:ProductionConfig,automaticSceneApproval:boolean,operationKey='storyboard',signal?:AbortSignal):Promise<{storyboard:Storyboard;summary:ProductionCurationSummary;warnings:string[]}>{
  const config=productionConfigSchema.parse(value);if(!automaticSceneApproval)throw new ApiError(409,'PRODUCTION_APPROVAL_REQUIRED','Approve the full-run spending cap and automatic fictional-scene workflow before planning.');
  this.profiles(owner);
  const previous=this.services.store.db.connection.prepare("SELECT storyboard_id,policy_json FROM p3_storyboard_policies WHERE project_id=? AND json_extract(policy_json,'$.productionRunId')=? ORDER BY rowid DESC LIMIT 1").get(owner,runId) as {storyboard_id:string;policy_json:string}|undefined;
  if(previous){const policy=JSON.parse(previous.policy_json) as StoryboardProductionPolicy,board=this.services.director.get(owner,previous.storyboard_id);if(!board?.readyForVideoGeneration)throw new ApiError(409,'PRODUCTION_STORYBOARD_CHANGED','The saved automatic storyboard or its sources changed. Review this run before creating another approved version.');if(policy.productionSummary)return {storyboard:board,summary:policy.productionSummary,warnings:policy.productionWarnings??[]};}
  const selected=this.selectedStore(runId);
  const sequences=config.cinematic?.enabled?this.services.cinematic?.snapshot(owner,runId):undefined;
  const moments=sequences?sequenceReasoningContext(sequences):undefined;
  const previewPhotoIds=[...new Set((sequences??[]).filter(sequence=>!sequence.excluded&&sequence.orderedPhotoIds.length>1).slice(0,4).flatMap(sequence=>sequence.orderedPhotoIds.slice(0,3)))].slice(0,12);
  const templateDuration=config.cinematic?.enabled?Math.min(config.durationSeconds,180):config.durationSeconds;
  const brief=`Final movie duration: ${config.durationSeconds} seconds. This request supplies a ${templateDuration}-second creative scaffold; the local cinematic director expands original still compositions to the final duration without adding paid generation requests. Movie title: ${config.title}. Cinematic style: ${config.cinematicStyle}. Emotional tone: ${config.emotionalTone}. This is an authorized automatic production plan. Invented cinematic scenes must remain clearly fictional. The subsequent local compiler will use ${config.aiSceneCount} short generated scenes and distinct original-photo montages without stretching video.`;
  const template=await this.services.director.generate(owner,{durationSeconds:templateDuration,brief:brief.slice(0,3000)},{runId,operationKey,generator:this.generator,curationStore:selected,signal,...(config.cinematic?.enabled?{cinematic:{moments,photoIds:previewPhotoIds,language:config.cinematic.language,editingStyle:config.cinematic.editingStyle}}:{})});
  const people=this.profiles(owner),curated=await curatePhotos(selected,owner,config.durationSeconds,this.services.config.analysisNearDuplicateDistance??5);
  const storyPhotos=config.cinematic?.enabled&&this.services.cinematic?this.services.cinematic.rows(owner,runId).filter(photo=>photo.asset.selected&&!photo.curation.excluded):this.rows(owner,curated.selection.assetIds,runId);
  const referencePhotos=this.referenceRows(owner,[...new Set(people.flatMap(person=>person.referencePhotoIds))]);
  const photos=[...new Map([...storyPhotos,...referencePhotos].map(photo=>[photo.asset.id,photo])).values()];
  let shaped=(config.cinematic?.enabled?prepareCinematicStoryboardTemplates:shapeProductionStoryboard)({config,storyboard:template,photos,protagonists:people,clipDurationSeconds:this.services.videoStore.settings().durationSeconds,automaticSceneApproval,seed:runId});
  if(config.cinematic?.enabled&&sequences){
   const caps=this.services.videoStore.provider.capabilities();
   const run=this.services.store.db.connection.prepare('SELECT quote_json FROM production_runs WHERE id=? AND project_id=?').get(runId,owner) as {quote_json:string}|undefined;
   const cinema=new CinematicEditingDirector().shape({content:shaped.content,proposals:template,photos:storyPhotos.map(photo=>({...photo,assetId:photo.asset.id})),sequences,config,seed:runId,automaticSceneApproval,capabilities:{supportsFirstLastFrame:Boolean(caps.supportsFirstLastFrame),supportsMultiReference:Boolean(caps.supportsMultiReference),maxReferenceImages:caps.maxReferenceImages??1,clipDurationSeconds:this.services.videoStore.settings().durationSeconds,maximumSegments:3},estimatedAiCostUsd:run?JSON.parse(run.quote_json).estimate.totalEstimatedUsd:0});
   for(const scene of cinema.content.scenes.filter(scene=>!scene.isFictional)){const ids=new Set(scene.sourcePhotoIds);scene.protagonistIds=people.filter(person=>person.referencePhotoIds.some(id=>ids.has(id))||photos.some(photo=>ids.has(photo.asset.id)&&photo.curation.associationsConfirmed&&photo.curation.protagonistIds.includes(person.id))).map(person=>person.id);}
   const generated=cinema.content.scenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION'||scene.type==='NEW_CINEMATIC_SCENE');
   if(generated.reduce((sum,scene)=>sum+Math.max(1,scene.sequenceSegments?.length??0),0)>config.aiSceneCount+2||generated.filter(scene=>scene.type==='NEW_CINEMATIC_SCENE').length>config.aiSceneCount-Math.round(config.aiSceneCount*config.originalRatio))throw new ApiError(409,'CINEMATIC_BUDGET_PLAN_CHANGED','The cinematic plan exceeds the approved operation allowance. Review a fresh quote.');
   shaped={content:cinema.content,summary:{...shaped.summary,selectedPhotoCount:cinema.summary.uniqueSourcePhotos,animationCount:cinema.summary.animatedScenes,montagePhotoCount:cinema.content.scenes.filter(scene=>scene.type==='PHOTO_MONTAGE').flatMap(scene=>scene.sourcePhotoIds).length,summary:`${cinema.summary.selectedMoments} meaningful moments represent ${cinema.summary.uniqueSourcePhotos} original photographs using ${cinema.summary.collageScenes} collages, ${cinema.summary.montageScenes} montages and ${cinema.summary.multiImageAnimatedScenes} multi-image animations.`,warnings:cinema.warnings,composition:cinema.summary},warnings:cinema.warnings};
  }
  const storyboard=await this.storeStoryboard(owner,shaped.content,config,runId,{summary:shaped.summary,warnings:shaped.warnings});
  if(config.cinematic?.enabled)this.services.cinematic?.saveStoryboardSuggestions(owner,shaped.content);
  return {storyboard,summary:shaped.summary,warnings:shaped.warnings};
 }
 async storeStoryboard(owner:string,content:StoryboardContent,config:Pick<ProductionConfig,'originalRatio'|'cinematic'>,runId?:string,result?:{summary:ProductionCurationSummary;warnings:string[]}){this.profiles(owner);const policy:StoryboardProductionPolicy={originalRatio:config.originalRatio,aiScenesOnly:true,...(config.cinematic?.enabled?{cinematic:true as const}:{}),...(runId?{productionRunId:runId}:{}),...(result?{productionSummary:result.summary,productionWarnings:result.warnings}:{})};return this.services.director.save(owner,content,policy);}
 getStoryboard(owner:string,id:string){return this.services.director.get(owner,id);}
 quoteVideo(owner:string,storyboardId:string,sceneId:string,options:{sourceAssetId?:string;refineAssetId?:string;refinementPrompt?:string}={}):Promise<VideoGenerationQuote>{
  const people=this.profiles(owner),scene=this.services.director.get(owner,storyboardId)?.scenes.find(scene=>scene.id===sceneId);let references:import('./video-store.js').VideoReference[]|undefined;
  if(scene?.type==='NEW_CINEMATIC_SCENE'){references=[];for(const id of scene.protagonistIds){const person=people.find(person=>person.id===id)!;const requested=scene.sourcePhotoIds.filter(id=>person.referencePhotoIds.includes(id)),ids=requested.length>=2?requested:person.referencePhotoIds;const rows=this.referenceRows(owner,ids);const score=(row:DirectorPhotoRow)=>row.analysis?(row.analysis.sharpness+row.analysis.composition+row.analysis.storytellingPotential)/3:0;rows.sort((a,b)=>score(b)-score(a)||a.asset.id.localeCompare(b.asset.id));for(const row of rows.slice(0,2))references.push({assetId:row.asset.id,protagonistId:id,name:person.name});}}
  return this.services.videoStore.quote(owner,{storyboardId,sceneId,...options},references);
 }
 async createVideo(owner:string,quote:VideoGenerationQuote,idempotencyKey:string,options:{deferWake?:boolean;acknowledgeUnknownCharge?:boolean}={}):Promise<VideoGenerationJob>{this.profiles(owner);const job=await this.services.videoStore.create(owner,{quoteId:quote.id,approved:true,idempotencyKey,acknowledgeUnknownCharge:options.acknowledgeUnknownCharge});if(!options.deferWake)this.services.videoQueue.wake();return job;}
 async reusableVideo(owner:string,storyboardId:string,sceneId:string,threshold:number){const scene=this.services.director.get(owner,storyboardId)?.scenes.find(scene=>scene.id===sceneId);if(!scene)return;const asset=await this.services.videoStore.reusable(owner,scene,storyboardId);if(asset?.quality.status==='complete'&&asset.quality.score!==null&&asset.quality.score>=threshold&&!asset.quality.flags.some(flag=>/^(critical:|\[blocking\])|missing protagonist|protagonist absent/i.test(flag)))return asset;}
 videoStatus(owner:string,id:string){return this.services.videoStore.job(owner,id);}
 cancelVideo(owner:string,id:string){return this.services.videoQueue.cancel(owner,id);}
 resumeVideo(owner:string,id:string){this.profiles(owner);return this.services.videoQueue.resume(owner,id);}
 getVideoAsset(owner:string,id:string):GeneratedVideoAsset{const asset=this.services.videoStore.assets(owner).find(asset=>asset.id===id);if(!asset)throw new ApiError(404,'VIDEO_ASSET_NOT_FOUND','Generated clip not found in this private project.');return asset;}
 reviewVideo(owner:string,id:string,decision:'approved'|'rejected',notes:string,beforeWrite?:()=>void){return this.services.videoStore.review(owner,id,decision,notes,beforeWrite);}
 async startRender(owner:string,storyboardId:string,value:ProductionConfig,idempotencyKey:string){const config=productionConfigSchema.parse(value);this.profiles(owner);const settings={...config.movieSettings,targetDurationSeconds:config.durationSeconds,titles:{...config.movieSettings.titles,openingTitle:config.movieSettings.titles.openingTitle||config.title}};await this.services.movieStore.saveSettings(owner,settings);const job=await this.services.movieStore.create(owner,{storyboardId,idempotencyKey});this.services.movieQueue.wake();return job;}
 renderStatus(owner:string,id:string){return this.services.movieStore.job(owner,id);}
 cancelRender(owner:string,id:string){return this.services.movieQueue.cancel(owner,id);}
 retryRender(owner:string,id:string){return this.services.movieQueue.retry(owner,id);}
 getMovie(owner:string,id:string):MovieRenderAsset{const asset=this.services.movieStore.assets(owner).find(asset=>asset.id===id);if(!asset)throw new ApiError(404,'MOVIE_ASSET_NOT_FOUND','Movie not found in this private project.');return asset;}
 async validateFinalMovie(owner:string,id:string,signal=new AbortController().signal){const asset=this.services.movieStore.assetRow(owner,id),file=await this.services.movieStore.files.content(owner,asset.storage_name),metadata=this.getMovie(owner,id);await this.services.movieStore.renderer.validate(file.file,{durationSeconds:metadata.durationSeconds,width:metadata.width,height:metadata.height,fps:30,audio:true},signal);return metadata;}
}
