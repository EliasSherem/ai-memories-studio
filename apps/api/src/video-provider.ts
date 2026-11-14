import type { StoryboardScene, ProtagonistId, GeminiUsage, VideoSettings, ProviderCapabilities, VideoQualityResult } from '@memories/shared';
export type { VideoSettings, ProviderCapabilities, VideoQualityResult } from '@memories/shared';
import { ApiError } from './errors.js';

export type VideoGenerationMode='ORIGINAL_ANIMATION'|'NEW_CINEMATIC_SCENE';
export type ProviderImage={data:Uint8Array;mimeType:string};
export type ProviderVideoOutput={uri?:string;videoBytes?:string;mimeType:'video/mp4'};
export type ProviderVideoOperation={operationId:string;done:boolean;output?:ProviderVideoOutput;usage?:GeminiUsage;model?:string;retryAfterMs?:number;error?:{code:string;message:string}};
export type VideoSubmission={jobId:string;model:string;prompt:string;image:ProviderImage;images?:ProviderImage[];inputMode?:import('@memories/shared').VideoInputMode;settings:VideoSettings;previousInteractionId?:string};
export interface VideoGenerationProvider {
  capabilities():ProviderCapabilities;
  submit(request:VideoSubmission,signal:AbortSignal):Promise<ProviderVideoOperation>;
  poll(operationId:string,signal:AbortSignal):Promise<ProviderVideoOperation>;
  download(output:ProviderVideoOutput,signal:AbortSignal):Promise<Response>;
  cancel?(operationId:string,signal:AbortSignal):Promise<void>;
}
export type KeyframeReference={assetId:string;protagonistId:ProtagonistId;name:string;image:ProviderImage};
export type KeyframeRequest={scene:StoryboardScene;references:KeyframeReference[];aspectRatio:VideoSettings['aspectRatio']};
export type KeyframeResult={image:ProviderImage;model:string;usage?:GeminiUsage;referenceAssetIds:string[];requiresHumanReview:true;identityVerified:false};
export interface KeyframeGenerationProvider {generate(request:KeyframeRequest,signal:AbortSignal):Promise<KeyframeResult>;}
export type VideoQualityRequest={scene:StoryboardScene;frames:ProviderImage[];references:ProviderImage[]};
export interface VideoQualityProvider {review(request:VideoQualityRequest,signal:AbortSignal):Promise<{quality:VideoQualityResult;model:string;usage?:GeminiUsage}>;}

/** An unknown billable submission is never safe to retry automatically. */
export class VideoProviderError extends ApiError {
  constructor(status:number,code:string,message:string,readonly outcome:'rejected'|'unknown',readonly transient=false,retryAfterMs?:number,readonly providerCode?:string) {super(status,code,message,retryAfterMs);}
}
const PROVIDER_CODES=new Set(['SAFETY','PROHIBITED_CONTENT','BLOCKLIST','IMAGE_SAFETY','IMAGE_PROHIBITED_CONTENT','PERSON_GENERATION','INVALID_ARGUMENT','PERMISSION_DENIED','UNAUTHENTICATED','NOT_FOUND','RESOURCE_EXHAUSTED','UNAVAILABLE','INTERNAL','DEADLINE_EXCEEDED','CANCELLED','FAILED_PRECONDITION']);
/** Retain a documented category, never arbitrary provider text or opaque codes. */
export function safeProviderCode(value:unknown):string|undefined {
  if(typeof value!=='string'||value.length>300)return;
  const code=value.split('/').at(-1)?.toUpperCase();return code&&PROVIDER_CODES.has(code)?code:undefined;
}
function structuredCode(value:Record<string,unknown>):string|undefined {
  const nested=value.error&&typeof value.error==='object'?value.error as Record<string,unknown>:undefined;
  return safeProviderCode(nested?.status)??safeProviderCode(nested?.code)??safeProviderCode(nested?.reason)??safeProviderCode(value.status)??safeProviderCode(value.code)??safeProviderCode(value.reason);
}
export function safeVideoProviderError(error:unknown,operation:string,submission=false):VideoProviderError {
  if(error instanceof VideoProviderError) return error;
  if(error instanceof ApiError) return new VideoProviderError(error.status,error.code,error.message,'rejected',false,error.retryAfterMs);
  const value=error&&typeof error==='object'?error as Record<string,unknown>:{};
  const status=Number(value.status??value.code);
  const headers=value.headers as {get?:(name:string)=>string|null}|undefined;
  const retry=headers?.get?.('retry-after');
  const retryAfterMs=retry&&Number.isFinite(Number(retry))?Math.min(3600_000,Math.max(0,Number(retry)*1000)):undefined;
  const providerCode=structuredCode(value);
  const known=[400,401,403,404,409,422,429].includes(status);
  const outcome=submission&&!known?'unknown':'rejected';
  const suffix=outcome==='unknown'?' Its submission status is unknown. Do not start another paid generation until the provider status has been reconciled.':'';
  if([400,403,422].includes(status)&&providerCode&&['SAFETY','PROHIBITED_CONTENT','BLOCKLIST','IMAGE_SAFETY','IMAGE_PROHIBITED_CONTENT','PERSON_GENERATION'].includes(providerCode))return new VideoProviderError(422,providerCode==='PERSON_GENERATION'?'VIDEO_PERSON_GENERATION_REJECTED':'VIDEO_SAFETY_REJECTED',providerCode==='PERSON_GENERATION'?'Google does not support generating this depiction of people for this input or account. Choose another consented reference or a different supported scene; the app does not bypass provider safeguards.':'Google blocked this input or scene under its safeguards. Choose another consented source or a different supported scene; the app does not bypass provider safeguards.','rejected',false,undefined,providerCode);
  if(status===401||status===403) return new VideoProviderError(status,'VIDEO_PROVIDER_AUTHORIZATION',`Google rejected ${operation} authorization. Check the server Gemini key, paid-tier access and project restrictions. Google Photos reconnection does not change this permission.`,'rejected',false,undefined,'PERMISSION_DENIED');
  if(status===404) return new VideoProviderError(400,'VIDEO_MODEL_UNAVAILABLE',`Google could not find the configured model or saved ${operation}. Check the configured model and account access; the retired Veo preview is unavailable.`,'rejected',false,undefined,'NOT_FOUND');
  if(status===400||status===422) return new VideoProviderError(400,'VIDEO_PROVIDER_INVALID_REQUEST',`Google rejected ${operation} (HTTP ${status}). Use supported image, duration, resolution and aspect-ratio settings, or choose a different consented source. No provider safeguards were bypassed.`,'rejected',false,undefined,'INVALID_ARGUMENT');
  if(status===429) return new VideoProviderError(429,'VIDEO_RATE_LIMIT',`Google rate limited ${operation}. Retry after the indicated delay; check paid-tier quota if this continues.`,'rejected',true,retryAfterMs,'RESOURCE_EXHAUSTED');
  if(value.name==='AbortError'||value.name==='TimeoutError') return new VideoProviderError(504,'VIDEO_REQUEST_INTERRUPTED',`${operation} was interrupted or timed out.${suffix}`,outcome,true);
  return new VideoProviderError(503,'VIDEO_PROVIDER_UNAVAILABLE',`Google could not complete ${operation}.${suffix}`,outcome,true,retryAfterMs,status>=500?'UNAVAILABLE':undefined);
}
export function assertProviderImage(image:ProviderImage,maxBytes=8*1024*1024):void {
  if(!['image/jpeg','image/png','image/webp'].includes(image.mimeType)||image.data.byteLength===0||image.data.byteLength>maxBytes) throw new VideoProviderError(400,'VIDEO_INPUT_INVALID','Use a bounded JPEG, PNG or WebP source image.','rejected');
}
