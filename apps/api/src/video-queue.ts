import {videoInputPlan} from './video-input-plan.js';
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {z} from 'zod';
import type {GeminiUsage,StoryboardScene,VideoGenerationJob,VideoGenerationQuote,VideoQualityResult,VideoSettings} from '@memories/shared';
import type {Config} from './config.js';
import {ApiError} from './errors.js';
import {VideoStore,type VideoJobRow,type VideoReference} from './video-store.js';
import {prepareAnalysisImage} from './photo-features.js';
import {safeVideoProviderError,VideoProviderError,type VideoGenerationProvider,type KeyframeGenerationProvider,type VideoQualityProvider,type ProviderVideoOperation,type ProviderVideoOutput,type ProviderImage} from './video-provider.js';
import type {StoredImageFile,StoredVideoFile,VideoInspection} from './video-media.js';

const TERMINAL=['COMPLETED','FAILED','CANCELLED'];
const ACTIVE="'VALIDATING','GENERATING_KEYFRAME','GENERATING_VIDEO','DOWNLOADING','VALIDATING_OUTPUT'";
const LEASE_MS=30_000;
const now=()=>new Date().toISOString();
type Phase='keyframe'|'video'|'quality'|`video:${number}`;
type Attempt={id:string;phase:Phase;status:string;estimated_usd:number;usage_estimate_usd:number|null};
type Checkpoint={sequenceIndex?:number;sequenceParts?:StoredVideoFile[];sequenceOperations?:string[];stored?:StoredVideoFile;inspection?:VideoInspection;previews?:{thumbnailStorageName:string;frameStorageNames:string[]};providerModel?:string};
const qualitySchema=z.object({status:z.literal('complete'),summary:z.string().min(1).max(1800),flags:z.array(z.string().max(350)).max(24),score:z.number().min(0).max(100).nullable(),identityAssessment:z.literal('advisory_not_identity_verification'),requiresHumanReview:z.literal(true),model:z.string().max(160).optional()}).strict();

/** Fenced, persistent paid-intent queue. An ambiguous submission is never retried. */
export class VideoGenerationQueue {
 private productionGuard?: (row:VideoJobRow)=>void;
 setProductionGuard(guard:(row:VideoJobRow)=>void){this.productionGuard=guard;}
 private readonly workerId=randomUUID();
 private readonly controllers=new Map<string,AbortController>();
 private readonly tasks=new Map<string,Promise<void>>();
 private timer?:ReturnType<typeof setTimeout>;
 private ticking=false;private disposed=false;private heartbeatAt=0;
 constructor(private readonly store:VideoStore,private readonly provider:VideoGenerationProvider,private readonly keyframes:KeyframeGenerationProvider,private readonly quality:VideoQualityProvider,private readonly config:Config){
  if(this.sql.prepare("SELECT 1 FROM video_generation_jobs WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED') LIMIT 1").get())this.wake();
 }
 private get sql(){return this.store.db.connection;}
 wake(){this.schedule(0);}
 private schedule(ms=100){if(this.disposed||this.timer)return;this.timer=setTimeout(()=>{this.timer=undefined;void this.tick().catch(()=>{
  // No request-bearing provider/SQLite exception is sent to application logs.
  try {for(const row of this.sql.prepare(`SELECT * FROM video_generation_jobs WHERE lease_owner LIKE ? AND state IN (${ACTIVE})`).all(`${this.workerId}:%`) as VideoJobRow[])this.fail(row,new ApiError(503,'VIDEO_WORKER_STOPPED','The video worker stopped unexpectedly. Restart the server to reconcile saved operation checkpoints.'));}catch{/* Owning app is closing. */}
 });},Math.max(0,ms));this.timer.unref();}
 private pending(){return Boolean(this.sql.prepare("SELECT 1 FROM video_generation_jobs WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED') LIMIT 1").get());}
 private lease():boolean {
  return this.store.db.transaction(()=>{
   const current=this.sql.prepare('SELECT owner,expires_at FROM video_worker_lease WHERE id=1').get() as {owner:string;expires_at:number}|undefined;const timestamp=Date.now();
   if(current&&current.owner!==this.workerId&&current.expires_at>timestamp)return false;
   if(!current||current.owner!==this.workerId||current.expires_at<=timestamp){
    for(const controller of this.controllers.values())controller.abort();
    this.sql.prepare('UPDATE video_generation_jobs SET lease_owner=NULL WHERE state NOT IN (\'COMPLETED\',\'FAILED\',\'CANCELLED\')').run();
    this.sql.prepare('INSERT INTO video_worker_lease(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at').run(this.workerId,timestamp+LEASE_MS);this.heartbeatAt=timestamp;
   }else if(timestamp-this.heartbeatAt>=LEASE_MS/3){this.sql.prepare('UPDATE video_worker_lease SET expires_at=? WHERE id=1 AND owner=?').run(timestamp+LEASE_MS,this.workerId);this.heartbeatAt=timestamp;}
   return true;
  });
 }
 private fenced(row:VideoJobRow):boolean {
  if(this.disposed||!row.lease_owner)return false;
  return Boolean(this.sql.prepare(`SELECT 1 FROM video_generation_jobs j JOIN video_worker_lease w ON w.id=1 WHERE j.id=? AND j.lease_owner=? AND j.state IN (${ACTIVE}) AND w.owner=? AND w.expires_at>?`).get(row.id,row.lease_owner,this.workerId,Date.now()));
 }
 private patch(row:VideoJobRow,values:Record<string,unknown>):boolean {
  if(!this.fenced(row))return false;
  const allowed=new Set(['state','operation_id','output_json','keyframe_id','asset_id','checkpoint_json','next_attempt_at','message','error_code','error_message','submission_unknown']);
  if(Object.keys(values).some(key=>!allowed.has(key)))throw new Error('Invalid queue update');
  const keys=Object.keys(values);const result=this.sql.prepare(`UPDATE video_generation_jobs SET ${keys.map(key=>`${key}=?`).join(',')},updated_at=? WHERE id=? AND lease_owner=? AND EXISTS(SELECT 1 FROM video_worker_lease WHERE id=1 AND owner=? AND expires_at>?)`).run(...keys.map(key=>values[key] as string|number|null),now(),row.id,row.lease_owner!,this.workerId,Date.now());return Boolean(result.changes);
 }
 private fresh(row:VideoJobRow){return this.store.row(row.project_id,row.id);}
 private quote(row:VideoJobRow){return JSON.parse(row.quote_json) as VideoGenerationQuote;}
 private checkpoint(row:VideoJobRow):Checkpoint{return row.checkpoint_json?JSON.parse(row.checkpoint_json):{};}
 private cooldown(){return (this.sql.prepare('SELECT until_at FROM video_rate_limits WHERE provider=?').get(this.provider.capabilities().provider) as {until_at:number}|undefined)?.until_at??0;}
 private operationExpired(row:VideoJobRow){const created=(this.sql.prepare("SELECT created_at FROM video_generation_attempts WHERE job_id=? AND phase=? AND status IN ('ACCEPTED','COMPLETED') ORDER BY created_at DESC LIMIT 1").get(row.id,this.videoPhase(row)) as {created_at:string}|undefined)?.created_at??row.created_at;return Date.now()-Date.parse(created)>24*60*60*1000;}
 private pollDelay(suggested=0){return Math.max(10,this.config.videoPollIntervalMs??0,this.provider.capabilities().pollIntervalMs,suggested);}
 private async tick(){
  if(this.disposed||this.ticking)return;this.ticking=true;
  try{
   if(!this.pending()&&!this.tasks.size){this.sql.prepare('DELETE FROM video_worker_lease WHERE id=1 AND owner=?').run(this.workerId);return;}
   if(!this.lease()){this.schedule(1000);return;}
   const cancelled=this.sql.prepare("SELECT * FROM video_generation_jobs WHERE state='CANCEL_REQUESTED' AND lease_owner IS NULL").all() as VideoJobRow[];
   for(const row of cancelled)this.finishCancellation(row);
   if(this.cooldown()<=Date.now()){
    const maximum=this.config.videoMaxConcurrentJobs??1;
    const rows=this.store.db.transaction(()=>{
     const selected=this.sql.prepare(`SELECT * FROM video_generation_jobs WHERE state IN (${ACTIVE}) AND lease_owner IS NULL AND next_attempt_at<=? ORDER BY created_at LIMIT ?`).all(Date.now(),Math.max(0,maximum-this.tasks.size)) as VideoJobRow[];
     const active=(this.sql.prepare(`SELECT COUNT(*) AS count FROM video_generation_jobs WHERE state IN (${ACTIVE})`).get() as {count:number}).count;
     const slots=Math.max(0,Math.min(maximum-active,maximum-this.tasks.size-selected.length));
     if(slots)selected.push(...this.sql.prepare("SELECT * FROM video_generation_jobs WHERE state='PENDING' AND lease_owner IS NULL AND next_attempt_at<=? ORDER BY created_at LIMIT ?").all(Date.now(),slots) as VideoJobRow[]);
     for(const row of selected){row.lease_owner=`${this.workerId}:${randomUUID()}`;this.sql.prepare("UPDATE video_generation_jobs SET lease_owner=?,state=CASE WHEN state='PENDING' THEN 'VALIDATING' ELSE state END,updated_at=? WHERE id=? AND lease_owner IS NULL").run(row.lease_owner,now(),row.id);if(row.state==='PENDING')row.state='VALIDATING';}
     return selected;
    });
    for(const row of rows){const task=this.process(row).catch(()=>{try {if(this.fenced(row))this.fail(row,new ApiError(503,'VIDEO_WORKER_STOPPED','The worker stopped while processing this job. Saved operation and local-media checkpoints are retained.'));}catch{/* App closed. */}}).finally(()=>{this.tasks.delete(row.id);this.schedule(0);});this.tasks.set(row.id,task);}
   }
   if(this.pending()||this.tasks.size)this.schedule(Math.min(1000,Math.max(50,this.cooldown()-Date.now())));
   else this.sql.prepare('DELETE FROM video_worker_lease WHERE id=1 AND owner=?').run(this.workerId);
  }finally{this.ticking=false;}
 }
 private videoPhase(row:VideoJobRow):Phase{return (this.quote(row).sequenceSegmentCount??1)>1?`video:${this.checkpoint(row).sequenceIndex??0}`:'video';}
 private segmentId(row:VideoJobRow){const h=createHash('sha256').update(`${row.id}:segment:${this.checkpoint(row).sequenceIndex??0}`).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;}
 private amount(row:VideoJobRow,phase:Phase){const kind=phase.startsWith('video')?'video':phase;const value=this.quote(row).costBreakdown[`${kind}Usd` as 'videoUsd'|'keyframeUsd'|'qualityUsd']/(phase.startsWith('video')?this.quote(row).sequenceSegmentCount??1:1);if(!Number.isFinite(value)||value<0)throw new ApiError(409,'VIDEO_BUDGET_INVALID','The approved generation cost is invalid. Review a new quote.');return value;}
 private begin(row:VideoJobRow,phase:Phase):Attempt {
  this.productionGuard?.(row);
  return this.store.db.transaction(()=>{
   if(!this.fenced(row))throw new ApiError(409,'VIDEO_LEASE_LOST','Another worker owns this generation.');this.productionGuard?.(row);
   if(this.sql.prepare("SELECT 1 FROM video_generation_attempts WHERE job_id=? AND phase=? AND status IN ('SUBMITTING','ACCEPTED','COMPLETED','UNKNOWN')").get(row.id,phase))throw new ApiError(409,'VIDEO_PHASE_ALREADY_SUBMITTED','This paid generation phase has already been submitted. Its saved status must be reconciled.');
   const estimated=this.amount(row,phase),current=this.fresh(row);
   if(current.reserved_usd+1e-6<estimated)throw new ApiError(402,'VIDEO_BUDGET_INSUFFICIENT','The approved budget reservation cannot cover the next generation step.');
   const budget=this.store.budget(row.project_id);if(budget.estimatedSpendUsd+budget.reservedUsd>budget.maximumSpendUsd+1e-6)throw new ApiError(402,'VIDEO_BUDGET_INSUFFICIENT','The project budget no longer covers its existing reservations.');
   const attempt={id:randomUUID(),phase,status:'SUBMITTING',estimated_usd:estimated,usage_estimate_usd:null};
   this.sql.prepare("INSERT INTO video_generation_attempts(id,job_id,phase,status,estimated_usd,created_at,updated_at) VALUES(?,?,?,'SUBMITTING',?,?,?)").run(attempt.id,row.id,phase,estimated,now(),now());
   this.sql.prepare('UPDATE video_generation_jobs SET attempts=attempts+1,updated_at=? WHERE id=?').run(now(),row.id);return attempt;
  });
 }
 private usageEstimate(phase:Phase,usage?:GeminiUsage):number|undefined {
  if(!usage||![usage.inputTokens,usage.outputTokens].every(value=>Number.isSafeInteger(value)&&value>=0))return;
  const caps=this.provider.capabilities();
  if(phase.startsWith('video'))return (usage.inputTokens*(caps.inputPricePerMillion??1.5)+usage.outputTokens*Math.max(caps.outputVideoPricePerMillion??17.5,caps.outputTextPricePerMillion??9))/1e6;
  if(phase==='quality')return (usage.inputTokens*0.30+usage.outputTokens*2.50)/1e6;
  return undefined; // Image token modality pricing stays a conservative quoted estimate.
 }
 private settle(attempt:Attempt,status:'ACCEPTED'|'UNKNOWN'|'REJECTED',usage?:GeminiUsage,error?:ApiError){
  this.store.db.transaction(()=>{
   const current=this.sql.prepare('SELECT * FROM video_generation_attempts WHERE id=?').get(attempt.id) as Attempt&{job_id:string}|undefined;
   if(!current||current.status!=='SUBMITTING')return;
   const usageEstimate=status==='ACCEPTED'?this.usageEstimate(attempt.phase,usage):undefined;
   const spent=status==='REJECTED'?0:usageEstimate??current.estimated_usd;
   this.sql.prepare('UPDATE video_generation_attempts SET status=?,usage_estimate_usd=?,input_tokens=?,output_tokens=?,error_code=?,safe_message=?,updated_at=? WHERE id=?').run(status,usageEstimate??null,usage?.inputTokens??null,usage?.outputTokens??null,error?.code??null,error?.message??null,now(),attempt.id);
   this.sql.prepare('UPDATE video_generation_jobs SET reserved_usd=MAX(0,reserved_usd-?),spent_usd=spent_usd+?,submission_unknown=MAX(submission_unknown,?),updated_at=? WHERE id=?').run(status==='REJECTED'?0:current.estimated_usd,spent,status==='UNKNOWN'?1:0,now(),current.job_id);
  });
 }
 private reconcileVideo(row:VideoJobRow,usage?:GeminiUsage){
  const estimate=this.usageEstimate('video',usage);if(estimate===undefined)return;
  this.store.db.transaction(()=>{const attempt=this.sql.prepare("SELECT * FROM video_generation_attempts WHERE job_id=? AND phase=? AND status IN ('ACCEPTED','COMPLETED') ORDER BY created_at DESC LIMIT 1").get(row.id,this.videoPhase(row)) as Attempt|undefined;if(!attempt)return;const previous=attempt.usage_estimate_usd??attempt.estimated_usd;this.sql.prepare('UPDATE video_generation_attempts SET usage_estimate_usd=?,input_tokens=?,output_tokens=?,updated_at=? WHERE id=?').run(estimate,usage!.inputTokens,usage!.outputTokens,now(),attempt.id);this.sql.prepare('UPDATE video_generation_jobs SET spent_usd=MAX(0,spent_usd+?) WHERE id=?').run(estimate-previous,row.id);});
 }
 private openAttempts(row:VideoJobRow){return this.sql.prepare("SELECT * FROM video_generation_attempts WHERE job_id=? AND status='SUBMITTING'").all(row.id) as Attempt[];}
 private unknown(row:VideoJobRow,attempt:Attempt,message:string){const error=new ApiError(409,'VIDEO_SUBMISSION_UNKNOWN',message);this.settle(attempt,'UNKNOWN',undefined,error);this.fail(row,error,true);}
 private fail(row:VideoJobRow,error:ApiError,unknown=false){
  this.store.db.transaction(()=>{if(!this.fenced(row))return;for(const attempt of this.openAttempts(row))this.settle(attempt,'UNKNOWN',undefined,error);this.sql.prepare('UPDATE video_generation_attempts SET error_code=?,safe_message=?,updated_at=? WHERE id=(SELECT id FROM video_generation_attempts WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1)').run(error.code,error.message,now(),row.id);this.sql.prepare("UPDATE video_generation_jobs SET state='FAILED',reserved_usd=0,submission_unknown=MAX(submission_unknown,?),lease_owner=NULL,error_code=?,error_message=?,message=?,updated_at=? WHERE id=? AND lease_owner=? AND state NOT IN ('COMPLETED','CANCELLED')").run(unknown?1:0,error.code,error.message,error.message,now(),row.id,row.lease_owner!);});
 }
 private knownRejection(error:VideoProviderError){return error.outcome==='rejected'&&[400,401,403,404,409,422,429].includes(error.status)&&!['KEYFRAME_OUTPUT_INVALID','KEYFRAME_SAFETY_REJECTED','QUALITY_OUTPUT_INVALID'].includes(error.code);}
 private retry(row:VideoJobRow,error:VideoProviderError,phase?:Phase):boolean {
  if(!error.transient)return false;
  this.sql.prepare('UPDATE video_generation_attempts SET error_code=?,safe_message=?,updated_at=? WHERE id=(SELECT id FROM video_generation_attempts WHERE job_id=? AND phase=? ORDER BY created_at DESC,rowid DESC LIMIT 1)').run(error.code,error.message,now(),row.id,phase??'video');
  const count=phase?(this.sql.prepare("SELECT COUNT(*) AS count FROM video_generation_attempts WHERE job_id=? AND phase=? AND status='REJECTED'").get(row.id,phase) as {count:number}).count:(this.checkpoint(row) as Checkpoint&{transientFailures?:number}).transientFailures??0;
  if(count>(this.config.videoMaxAutomaticRetries??1)||!phase&&count>=(this.config.videoMaxAutomaticRetries??1))return false;
  const backoff=Math.max(error.retryAfterMs??0,Math.min(60000,this.pollDelay()*2**Math.max(0,count-1)));
  const deadline=Date.now()+backoff;
  if(error.status===429)this.sql.prepare('INSERT INTO video_rate_limits(provider,until_at) VALUES(?,?) ON CONFLICT(provider) DO UPDATE SET until_at=MAX(video_rate_limits.until_at,excluded.until_at)').run(this.provider.capabilities().provider,deadline);
  this.patch(row,{next_attempt_at:deadline,message:error.message,...(!phase?{checkpoint_json:JSON.stringify({...this.checkpoint(row),transientFailures:count+1})}:{})});return true;
 }
 private async requestReady(row:VideoJobRow,signal:AbortSignal,bytes=0){
  if(!this.fenced(row)||signal.aborted)throw new ApiError(409,'VIDEO_CANCELLED','The generation was cancelled or another worker owns it.');
  await this.store.assertCurrent(this.fresh(row));
  if(!this.provider.capabilities().available)throw new ApiError(503,'VIDEO_NOT_CONFIGURED','The approved video provider is not currently configured. No paid request was submitted.');
  if(bytes)await this.store.media.preflight(bytes);
  if(this.cooldown()>Date.now()){this.patch(row,{next_attempt_at:this.cooldown(),message:'Waiting for the provider rate-limit cooldown.'});throw new ApiError(429,'VIDEO_COOLDOWN','Waiting for the provider rate-limit cooldown.');}
  if(!this.fenced(row)||signal.aborted)throw new ApiError(409,'VIDEO_CANCELLED','The generation was cancelled or another worker owns it.');
 }
 private attachKeyframe(row:VideoJobRow,stored:StoredImageFile,model:string){
  return this.store.db.transaction(()=>{
   if(!this.fenced(row))return;
   const existing=this.sql.prepare('SELECT id FROM generated_keyframes WHERE job_id=?').get(row.id) as {id:string}|undefined;const id=existing?.id??randomUUID();
   this.sql.prepare('INSERT OR IGNORE INTO generated_keyframes(id,job_id,project_id,storyboard_id,scene_id,version,storage_name,mime_type,bytes,model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,row.id,row.project_id,row.storyboard_id,row.scene_id,row.version,stored.storageName,stored.mimeType,stored.bytes,model,now());
   this.patch(row,{keyframe_id:id,state:'GENERATING_VIDEO',next_attempt_at:0,message:'Cinematic keyframe saved. Preparing its video.'});return id;
  });
 }
 private async image(row:VideoJobRow):Promise<ProviderImage>{
  if(row.keyframe_id){const keyframe=this.sql.prepare('SELECT storage_name FROM generated_keyframes WHERE id=? AND project_id=?').get(row.keyframe_id,row.project_id) as {storage_name:string}|undefined;if(!keyframe)throw new ApiError(404,'KEYFRAME_NOT_FOUND','The saved cinematic keyframe is missing.');const source=await this.store.media.content(row.project_id,row.project_id,keyframe.storage_name);return prepareAnalysisImage(source.file,1024);}
  if(!row.source_asset_id)throw new ApiError(409,'SOURCE_PHOTO_REQUIRED','This original animation has no approved source photograph.');
  const source=await this.store.directorStore.asset(row.project_id,row.source_asset_id);return prepareAnalysisImage(source.file,1024);
 }
 private async recover(row:VideoJobRow):Promise<boolean>{
  await this.store.media.recoverJob(row.project_id,row.id);
  for(const attempt of this.openAttempts(row)){
   if(attempt.phase==='keyframe'){
    const stored=await this.store.media.existingKeyframe(row.project_id,row.id);if(stored){this.settle(attempt,'ACCEPTED');this.attachKeyframe(row,stored,this.quote(row).keyframeModel??this.config.videoKeyframeModel??'gemini-3.1-flash-image');continue;}
   }
   if(attempt.phase.startsWith('video')&&row.operation_id){this.settle(attempt,'ACCEPTED');continue;}
   this.unknown(row,attempt,'A previous paid request was interrupted before its result was checkpointed. Its status and charge are unknown. No replacement request was submitted automatically.');return false;
  }
  return true;
 }
 private async submitKeyframe(row:VideoJobRow,signal:AbortSignal):Promise<boolean>{
  const cached=await this.store.media.existingKeyframe(row.project_id,row.id);if(cached){this.attachKeyframe(row,cached,this.quote(row).keyframeModel??'gemini-3.1-flash-image');return true;}
  const references=JSON.parse(row.references_json) as VideoReference[];
  const images=[];
  for(const reference of references){const source=await this.store.directorStore.asset(row.project_id,reference.assetId);images.push({...reference,image:await prepareAnalysisImage(source.file,1024)});}
  await this.requestReady(row,signal,32*1024*1024);const attempt=this.begin(row,'keyframe');
  try{
   const result=await this.keyframes.generate({scene:JSON.parse(row.scene_json),references:images,aspectRatio:(JSON.parse(row.settings_json) as VideoSettings).aspectRatio},signal);
   if(!this.fenced(row))return false;this.settle(attempt,'ACCEPTED',result.usage);
   const stored=await this.store.media.saveKeyframe(row.project_id,row.id,result.image.data,result.image.mimeType);if(!this.fenced(row))return false;
   this.attachKeyframe(row,stored,result.model);return true;
  }catch(error){if(!this.fenced(row))return false;const safe=safeVideoProviderError(error,'cinematic keyframe submission',true);
   const status=(this.sql.prepare('SELECT status FROM video_generation_attempts WHERE id=?').get(attempt.id) as {status:string}|undefined)?.status;
   if(status==='ACCEPTED'){this.fail(row,error instanceof ApiError?error:safe);return false;}
   if(this.knownRejection(safe)){this.settle(attempt,'REJECTED',undefined,safe);if(this.retry(row,safe,'keyframe'))return false;this.fail(row,safe);}
   else this.unknown(row,attempt,'The cinematic keyframe request may have been accepted, but no durable result is available. Its status and charge are unknown; another paid request requires a new explicit approval.');return false;
  }
 }
 private acceptOperation(row:VideoJobRow,operation:ProviderVideoOperation,attempt?:Attempt){
  this.store.db.transaction(()=>{
   if(!this.fenced(row))return;if(!operation.operationId||operation.operationId.length>1024)throw new VideoProviderError(502,'VIDEO_OPERATION_MISSING','The provider did not return a valid operation checkpoint.','unknown');
   const saved=row.operation_id?this.store.db.unseal(row.operation_id):undefined;if(saved&&saved!==operation.operationId)throw new ApiError(502,'VIDEO_OPERATION_MISMATCH','The provider returned a different operation than this job owns.');
   this.patch(row,{operation_id:this.store.db.seal(operation.operationId),checkpoint_json:JSON.stringify({...this.checkpoint(row),providerModel:operation.model??row.model,transientFailures:0}),...(operation.output?{output_json:this.store.db.seal(JSON.stringify(operation.output))}:{}),state:operation.done&&operation.output?'DOWNLOADING':'GENERATING_VIDEO',next_attempt_at:operation.done?0:Date.now()+this.pollDelay(operation.retryAfterMs),message:operation.done?'The provider finished. Saving the private output.':'Video generation is running at the provider.'});
   if(attempt)this.settle(attempt,'ACCEPTED',operation.done?operation.usage:undefined);else if(operation.done)this.reconcileVideo(row,operation.usage);
  });
  if(operation.error)this.fail(row,new ApiError(422,operation.error.code,operation.error.message));
  else if(operation.done&&!operation.output)this.fail(row,new ApiError(502,'VIDEO_OUTPUT_MISSING','The provider completed without a usable video output.'));
 }
 private async generateVideo(row:VideoJobRow,signal:AbortSignal):Promise<boolean>{
  if(row.operation_id){
   if(this.operationExpired(row))throw new ApiError(410,'VIDEO_OPERATION_EXPIRED','The saved video operation exceeded the 24-hour local polling window. Check its provider status before approving another paid generation.');
   await this.requestReady(row,signal);
   try {const operation=await this.provider.poll(this.store.db.unseal(row.operation_id),signal);if(!this.fenced(row))return false;this.acceptOperation(row,operation);return operation.done&&!operation.error;}
   catch(error){if(!this.fenced(row))return false;const safe=safeVideoProviderError(error,'video status');if(this.retry(row,safe))return false;this.fail(row,safe);return false;}
  }
  const image=await this.image(row),context=await this.store.assertCurrent(row);
  const group=context.inputPlan.groups[this.checkpoint(row).sequenceIndex??0],images:ProviderImage[]=[];
  for(const id of group??[]){const source=await this.store.directorStore.asset(row.project_id,id);images.push(await prepareAnalysisImage(source.file,1024));}
  await this.requestReady(row,signal,32*1024*1024);const phase=this.videoPhase(row),attempt=this.begin(row,phase);
  try{
   const quote=this.quote(row);
   const operation=await this.provider.submit({jobId:row.id,model:row.model,prompt:quote.prompt,image:images[0]??image,...(images.length?{images,inputMode:context.inputPlan.inputMode}:{}),settings:JSON.parse(row.settings_json),previousInteractionId:context.previousInteractionId},signal);
   if(!this.fenced(row))return false;this.acceptOperation(row,operation,attempt);return operation.done&&!operation.error;
  }catch(error){if(!this.fenced(row))return false;const safe=safeVideoProviderError(error,'video submission',true);
   if(this.knownRejection(safe)){this.settle(attempt,'REJECTED',undefined,safe);if(this.retry(row,safe,phase))return false;this.fail(row,safe);}
   else this.unknown(row,attempt,'The video submission may have been accepted without a saved operation ID. Its status and charge are unknown. No duplicate paid request will be submitted automatically.');return false;
  }
 }
 private async download(row:VideoJobRow,signal:AbortSignal):Promise<boolean>{
  const chained=(this.quote(row).sequenceSegmentCount??1)>1,storageJobId=chained?this.segmentId(row):row.id;
  if(chained)await this.store.media.recoverJob(row.project_id,storageJobId);
  let stored=await this.store.media.existingVideo(row.project_id,storageJobId);
  if(!stored){
   if(!row.output_json)throw new ApiError(409,'VIDEO_OUTPUT_MISSING','The job has no saved provider output capability.');await this.requestReady(row,signal);
   try {const output=JSON.parse(this.store.db.unseal(row.output_json)) as ProviderVideoOutput;const response=await this.provider.download(output,signal);if(!this.fenced(row)){await response.body?.cancel();return false;}stored=await this.store.media.streamVideo(row.project_id,storageJobId,response,signal);}
   catch(error){if(!this.fenced(row))return false;const safe=safeVideoProviderError(error,'video download');
    if(safe.code==='VIDEO_FILE_PROCESSING'&&!this.operationExpired(row)){this.patch(row,{next_attempt_at:Date.now()+this.pollDelay(safe.retryAfterMs),message:'Google is preparing the completed file. Waiting before downloading it.'});return false;}
    if(this.retry(row,safe))return false;throw safe;}
  }
  if(!this.fenced(row))return false;
  if(chained){
   const checkpoint=this.checkpoint(row),index=checkpoint.sequenceIndex??0;
   await this.store.media.validateVideo(stored.file,{...JSON.parse(row.settings_json),audio:true},signal);
   const parts=[...(checkpoint.sequenceParts??[]).slice(0,index),stored],operations=[...(checkpoint.sequenceOperations??[]).slice(0,index),row.operation_id??''];
   if(index+1<(this.quote(row).sequenceSegmentCount??1)){
    this.patch(row,{state:'GENERATING_VIDEO',operation_id:null,output_json:null,checkpoint_json:JSON.stringify({...checkpoint,sequenceParts:parts,sequenceOperations:operations,sequenceIndex:index+1,transientFailures:0}),next_attempt_at:0,message:`Saved sequence segment ${index+1}. Preparing the next approved adjacent frame pair.`});return true;
   }
   stored=await this.store.media.joinSequence(row.project_id,row.id,parts,signal);
   if(!this.fenced(row))return false;this.patch(row,{checkpoint_json:JSON.stringify({...checkpoint,sequenceParts:parts,sequenceOperations:operations,sequenceIndex:index,stored})});row=this.fresh(row);
  }
  this.patch(row,{state:'VALIDATING_OUTPUT',checkpoint_json:JSON.stringify({...this.checkpoint(row),stored,transientFailures:0}),next_attempt_at:0,message:'The private video is saved. Checking its duration, streams and preview frames.'});return true;
 }
 private createAsset(row:VideoJobRow,checkpoint:Required<Pick<Checkpoint,'stored'|'inspection'|'previews'>>):string|undefined {
  return this.store.db.transaction(()=>{
   if(!this.fenced(row))return;
   const existing=this.sql.prepare('SELECT id FROM generated_video_assets WHERE job_id=?').get(row.id) as {id:string}|undefined;const id=existing?.id??randomUUID();
   const actualModel=this.checkpoint(row).providerModel??row.model;
   this.sql.prepare('INSERT OR IGNORE INTO generated_video_assets(id,job_id,project_id,storyboard_id,scene_id,version,storage_name,thumbnail_name,frames_json,keyframe_id,source_asset_id,inspection_json,bytes,sha256,model,is_fictional,refine_asset_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,row.id,row.project_id,row.storyboard_id,row.scene_id,row.version,checkpoint.stored.storageName,checkpoint.previews.thumbnailStorageName,JSON.stringify(checkpoint.previews.frameStorageNames),row.keyframe_id,row.source_asset_id,JSON.stringify(checkpoint.inspection),checkpoint.stored.bytes,checkpoint.stored.sha256,actualModel,row.mode==='NEW_CINEMATIC_SCENE'?1:0,row.refine_asset_id,now());
   this.sql.prepare('INSERT OR IGNORE INTO video_quality_reviews(id,asset_id,project_id,quality_json,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),id,row.project_id,JSON.stringify(this.store.unavailableQuality()),now());this.patch(row,{asset_id:id});return id;
  });
 }
 private async validateOutput(row:VideoJobRow,signal:AbortSignal):Promise<boolean>{
  let checkpoint=this.checkpoint(row);const stored=checkpoint.stored??await this.store.media.existingVideo(row.project_id,row.id);if(!stored)throw new ApiError(404,'VIDEO_FILE_MISSING','The completed local video checkpoint is missing.');
  await this.store.assertCurrent(row);
  const settings=JSON.parse(row.settings_json) as VideoSettings;
  const inspection=checkpoint.inspection??await this.store.media.validateVideo(stored.file,{...settings,durationSeconds:settings.durationSeconds*(this.quote(row).sequenceSegmentCount??1),audio:settings.generateAudio},signal);if(!this.fenced(row))return false;
  this.patch(row,{checkpoint_json:JSON.stringify({...checkpoint,stored,inspection})});row=this.fresh(row);checkpoint=this.checkpoint(row);
  const previews=checkpoint.previews??await this.store.media.createPreviews(row.project_id,row.id,stored.file,inspection,signal);if(!this.fenced(row))return false;
  this.patch(row,{checkpoint_json:JSON.stringify({...checkpoint,stored,inspection,previews})});row=this.fresh(row);
  const assetId=this.createAsset(row,{stored,inspection,previews});if(!assetId)return false;row=this.fresh(row);
  const completedReview=this.sql.prepare("SELECT 1 FROM video_generation_attempts WHERE job_id=? AND phase='quality' AND status IN ('ACCEPTED','COMPLETED','UNKNOWN') LIMIT 1").get(row.id);
  if(completedReview){this.complete(row);return true;}
  const frames:ProviderImage[]=[];
  for(const storageName of previews.frameStorageNames){const file=await this.store.media.content(row.project_id,row.project_id,storageName);const bytes=await readFile(file.file);if(bytes.length>1024*1024)frames.push(await prepareAnalysisImage(file.file,640));else frames.push({data:bytes,mimeType:'image/jpeg'});}
  const references:ProviderImage[]=[];
  if(row.keyframe_id)references.push(await this.image(row));else if(row.source_asset_id)references.push(await this.image(row));
  for(const id of this.quote(row).sourcePhotoIds.filter(id=>id!==row.source_asset_id).slice(0,Math.max(0,4-references.length))){const source=await this.store.directorStore.asset(row.project_id,id);references.push(await prepareAnalysisImage(source.file,640));}
  for(const reference of (JSON.parse(row.references_json) as VideoReference[]).slice(0,Math.max(0,4-references.length))){const source=await this.store.directorStore.asset(row.project_id,reference.assetId);references.push(await prepareAnalysisImage(source.file,640));}
  await this.requestReady(row,signal,2*1024*1024);const attempt=this.begin(row,'quality');
  try{
   const result=await this.quality.review({scene:JSON.parse(row.scene_json),frames,references},signal);if(!this.fenced(row))return false;this.settle(attempt,'ACCEPTED',result.usage);
   const parsed=qualitySchema.safeParse(result.quality);const quality=parsed.success?parsed.data:this.store.unavailableQuality();
   this.sql.prepare('UPDATE video_quality_reviews SET quality_json=? WHERE asset_id=? AND project_id=?').run(JSON.stringify(quality),assetId,row.project_id);this.complete(row);return true;
  }catch(error){if(!this.fenced(row))return false;const safe=safeVideoProviderError(error,'advisory quality review',true);
   if(this.knownRejection(safe)){this.settle(attempt,'REJECTED',undefined,safe);if(this.retry(row,safe,'quality'))return false;this.complete(row,'The video passed local validation. AI quality review was unavailable; inspect the clip before accepting it.');return true;}
   this.unknown(row,attempt,'The clip is saved and locally validated, but its advisory quality request has unknown status and may incur charges. No duplicate review request was submitted. Human review is required.');return false;
  }
 }
 private complete(row:VideoJobRow,message='The private clip passed local validation. Review its appearance and audio before approving it.'){
  if(!this.fenced(row))return;this.sql.prepare("UPDATE video_generation_jobs SET state='COMPLETED',reserved_usd=0,lease_owner=NULL,message=?,error_code=NULL,error_message=NULL,updated_at=? WHERE id=? AND lease_owner=?").run(message,now(),row.id,row.lease_owner!);
  this.sql.prepare("UPDATE video_generation_attempts SET status='COMPLETED',updated_at=? WHERE job_id=? AND status='ACCEPTED'").run(now(),row.id);
 }
 private async process(initial:VideoJobRow){
  const controller=new AbortController();this.controllers.set(initial.id,controller);let row=initial;
  try{
   if(!this.fenced(row))return;if(!await this.recover(row))return;row=this.fresh(row);
   for(let step=0;step<10&&this.fenced(row);step++){
    if(controller.signal.aborted)return;this.productionGuard?.(row);
    if(row.state==='VALIDATING'){
     await this.store.assertCurrent(row);if(!(await this.store.media.detectTools()).available)throw new ApiError(503,'VIDEO_TOOLS_UNAVAILABLE','FFmpeg and ffprobe are required before paid generation.');await this.store.media.preflight(32*1024*1024);
     if(row.refine_asset_id){const parent=this.store.assetRow(row.project_id,row.refine_asset_id);this.patch(row,{keyframe_id:parent.keyframe_id??null,state:'GENERATING_VIDEO',message:'Preparing the approved clip refinement.'});}
     else this.patch(row,{state:row.mode==='NEW_CINEMATIC_SCENE'?'GENERATING_KEYFRAME':'GENERATING_VIDEO',message:row.mode==='NEW_CINEMATIC_SCENE'?'Preparing the consented cinematic keyframe.':'Preparing the original-photo animation.'});
    }else if(row.state==='GENERATING_KEYFRAME'){if(!await this.submitKeyframe(row,controller.signal))return;}
    else if(row.state==='GENERATING_VIDEO'){if(!await this.generateVideo(row,controller.signal))return;}
    else if(row.state==='DOWNLOADING'){if(!await this.download(row,controller.signal))return;}
    else if(row.state==='VALIDATING_OUTPUT'){await this.validateOutput(row,controller.signal);return;}
    else return;
    row=this.fresh(row);if(row.next_attempt_at>Date.now())return;
   }
  }catch(error){if(this.fenced(row)){if(error instanceof ApiError&&error.code==='VIDEO_COOLDOWN')return;if(error instanceof ApiError&&error.code==='PRODUCTION_PAUSED'){this.patch(row,{next_attempt_at:Date.now()+1000,message:'Automatic production is paused. The saved operation and approved budget remain checkpointed.'});return;}if(error instanceof ApiError&&error.code==='PRODUCTION_CANCELLED'){this.finishCancellation(row,'The parent movie production was cancelled. No further generation or polling will run.');return;}const safe=error instanceof ApiError?error:safeVideoProviderError(error,'local video processing');this.fail(row,safe);}}
  finally{if(this.controllers.get(initial.id)===controller)this.controllers.delete(initial.id);try{this.sql.prepare('UPDATE video_generation_jobs SET lease_owner=NULL WHERE id=? AND lease_owner=?').run(initial.id,initial.lease_owner);}catch{/* App closed. */}}
 }
 private finishCancellation(row:VideoJobRow,message?:string){
  this.store.db.transaction(()=>{for(const attempt of this.openAttempts(row))this.settle(attempt,'UNKNOWN');const current=this.fresh(row);this.sql.prepare("UPDATE video_generation_jobs SET state='CANCELLED',reserved_usd=0,lease_owner=NULL,message=?,updated_at=? WHERE id=? AND state NOT IN ('COMPLETED','FAILED','CANCELLED')").run(message??(current.operation_id||current.submission_unknown?'Local generation work and polling were cancelled. A submitted provider operation may still finish and incur charges; provider cancellation is not guaranteed.':'Cancelled before another paid generation request. Completed local outputs are retained.'),now(),row.id);});
 }
 async cancel(owner:string,id:string):Promise<VideoGenerationJob>{
  const row=this.store.row(owner,id);if(TERMINAL.includes(row.state))return this.store.job(owner,id);
  this.sql.prepare("UPDATE video_generation_jobs SET state='CANCEL_REQUESTED',updated_at=? WHERE id=? AND state NOT IN ('COMPLETED','FAILED','CANCELLED')").run(now(),id);this.controllers.get(id)?.abort();
  let message:string|undefined;
  if(row.operation_id&&this.provider.capabilities().supportsCancellation&&this.provider.cancel){
   try {await this.provider.cancel(this.store.db.unseal(row.operation_id),AbortSignal.timeout(Math.min(10000,this.config.videoRequestTimeoutMs??10000)));message='Local work and polling stopped, and provider cancellation was requested. Already submitted work may still incur charges. Completed local outputs are retained.';}
   catch {message='Local work and polling stopped. Provider cancellation could not be confirmed; submitted work may still finish and incur charges.';}
  }
  this.finishCancellation(row,message);return this.store.job(owner,id);
 }
 /** Resume retrieval/inspection of a known paid operation, never submit another video or keyframe. */
 async resume(owner:string,id:string):Promise<VideoGenerationJob>{
  const row=this.store.row(owner,id);
  if(row.state!=='FAILED'&&row.state!=='CANCELLED')return this.store.job(owner,id);
  if(row.submission_unknown||this.sql.prepare("SELECT 1 FROM video_generation_attempts WHERE job_id=? AND status IN ('SUBMITTING','UNKNOWN') LIMIT 1").get(row.id))throw new ApiError(409,'VIDEO_SUBMISSION_UNKNOWN','This request has an unresolved paid submission. It cannot be resumed or resubmitted automatically.');
  const checkpoint=this.checkpoint(row);
  if(!row.operation_id&&!row.output_json&&!checkpoint.stored&&!checkpoint.sequenceParts?.length)throw new ApiError(409,'VIDEO_CHECKPOINT_MISSING','There is no saved video operation or downloaded file to resume. A new paid generation requires a new approved quote.');
  await this.store.assertCurrent(row);
  return this.store.db.transaction(()=>{
   const current=this.store.row(owner,id);if(current.state!=='FAILED'&&current.state!=='CANCELLED')return this.store.job(owner,id);
   if(this.sql.prepare("SELECT 1 FROM video_generation_jobs WHERE project_id=? AND scene_id=? AND id<>? AND state NOT IN ('COMPLETED','FAILED','CANCELLED') LIMIT 1").get(owner,row.scene_id,id))throw new ApiError(409,'VIDEO_JOB_ACTIVE','Another generation for this scene is already pending.');
   const reviewed=this.sql.prepare("SELECT 1 FROM video_generation_attempts WHERE job_id=? AND phase='quality' AND status IN ('ACCEPTED','COMPLETED') LIMIT 1").get(id);
   const qualityReserve=(reviewed?0:this.amount(row,'quality'))+(!checkpoint.stored?Math.max(0,(this.quote(row).sequenceSegmentCount??1)-(checkpoint.sequenceIndex??0)-(row.operation_id?1:0))*this.amount(row,this.videoPhase(row)):0);
   if(this.store.budget(owner).remainingUsd+1e-6<qualityReserve)throw new ApiError(402,'VIDEO_BUDGET_INSUFFICIENT','The remaining budget cannot reserve the previously approved advisory review. Increase the budget to resume.');
   const state=checkpoint.stored?'VALIDATING_OUTPUT':row.output_json?'DOWNLOADING':'GENERATING_VIDEO';
   this.sql.prepare('UPDATE video_generation_jobs SET state=?,reserved_usd=?,lease_owner=NULL,next_attempt_at=0,error_code=NULL,error_message=NULL,message=?,checkpoint_json=?,updated_at=? WHERE id=?').run(state,qualityReserve,'Resuming the saved operation and private output. No replacement video or keyframe request will be submitted.',JSON.stringify({...checkpoint,transientFailures:0}),now(),id);
   this.wake();return this.store.job(owner,id);
  });
 }
 async drain(){while(!this.disposed){await this.tick();if(!this.pending()&&!this.tasks.size)return;await delay(10);}await Promise.allSettled([...this.tasks.values()]);}
 async dispose(){this.disposed=true;if(this.timer)clearTimeout(this.timer);this.timer=undefined;for(const controller of this.controllers.values())controller.abort();await Promise.allSettled([...this.tasks.values()]);this.sql.prepare('UPDATE video_generation_jobs SET lease_owner=NULL WHERE lease_owner LIKE ?').run(`${this.workerId}:%`);this.sql.prepare('DELETE FROM video_worker_lease WHERE id=1 AND owner=?').run(this.workerId);}
}
