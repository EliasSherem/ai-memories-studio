import { GoogleGenAI, type GoogleGenAIInteraction, type GoogleGenAIRequestOptions } from '@google/genai';
import type { ProviderCapabilities, VideoSettings } from '@memories/shared';
import { assertProviderImage, safeProviderCode, safeVideoProviderError, VideoProviderError, type VideoGenerationProvider, type VideoSubmission, type ProviderVideoOperation, type ProviderVideoOutput } from './video-provider.js';

export type OmniSdk={interactions:Pick<GoogleGenAI['interactions'],'create'|'get'|'cancel'>;files:Pick<GoogleGenAI['files'],'get'>};
export type OmniConfig={geminiApiKey?:string;omniModel?:string;videoTimeoutMs?:number;videoMaxOutputTokens?:number};
const MODELS=new Set(['gemini-omni-1.1-flash','gemini-omni-1.2-flash']);
const ID=/^[a-zA-Z0-9_-]{1,256}$/;
const MAX_VIDEO_BYTES=256*1024*1024;
const safeId=(value:string)=>{if(!ID.test(value))throw new VideoProviderError(400,'VIDEO_OPERATION_INVALID','The saved Google operation identifier is invalid.','rejected');return value;};

/** Validate only Google File API capability URLs; never fetch arbitrary source URLs. */
export function googleVideoFileName(value:string):string {
  if(/^files\/[a-zA-Z0-9_-]{1,256}$/.test(value))return value;
  let url:URL;try{url=new URL(value);}catch{throw new VideoProviderError(502,'VIDEO_DOWNLOAD_INVALID','Google returned an invalid video file reference.','rejected');}
  const match=/^\/v1(?:beta)?\/files\/([a-zA-Z0-9_-]{1,256})(?::download)?$/.exec(url.pathname);
  if(url.protocol!=='https:'||url.hostname!=='generativelanguage.googleapis.com'||url.port||url.username||url.password||url.hash||!match||[...url.searchParams.keys()].some(key=>key!=='alt'))throw new VideoProviderError(502,'VIDEO_DOWNLOAD_INVALID','Google returned an unsupported video file reference.','rejected');
  return `files/${match[1]}`;
}
function usage(value:GoogleGenAIInteraction) {
  const input=value.usage?.total_input_tokens,output=value.usage?.total_output_tokens,thinking=value.usage?.total_thought_tokens??0;
  return [input,output,thinking].every(tokens=>typeof tokens==='number'&&Number.isSafeInteger(tokens)&&tokens>=0)&&Number.isSafeInteger(output!+thinking)?{inputTokens:input!,outputTokens:output!+thinking}:undefined;
}

/** Gemini Interactions API only. It never sends Veo generateVideos parameters. */
export class OmniFlashProvider implements VideoGenerationProvider {
  readonly model:string;
  private readonly sdk?:OmniSdk;
  private readonly fetcher:typeof fetch;
  constructor(private readonly config:OmniConfig,options:{sdk?:OmniSdk;fetch?:typeof fetch}={}) {
    this.model=config.omniModel??'gemini-omni-1.1-flash';
    this.sdk=options.sdk??(config.geminiApiKey?new GoogleGenAI({apiKey:config.geminiApiKey,vertexai:false,apiVersion:'v1beta',httpOptions:{timeout:config.videoTimeoutMs??120000,retryOptions:{attempts:1}}}):undefined);
    this.fetcher=options.fetch??fetch;
  }
  capabilities():ProviderCapabilities {
    const supported=MODELS.has(this.model),newer=this.model==='gemini-omni-1.2-flash';
    return {provider:'gemini-omni',backend:'gemini',model:this.model,available:Boolean(this.sdk)&&supported,accountVerified:false,
      ...(!supported?{unavailabilityReason:'Configure a documented stable Gemini Omni Flash model. Veo request formats are not compatible.'}:!this.sdk?{unavailabilityReason:'Configure the server GEMINI_API_KEY and Gemini paid-tier access before approving video generation.'}:{}),
      // Broader model durations/upsampling are documented, but billing tokens for
      // 15s/1080p can exceed the documented 65,536 generation-token limit. Keep
      // the initial app contract within a bounded 720p request until verified.
      supportsFirstLastFrame:true,supportsMultiReference:true,maxReferenceImages:newer?6:3,supportedModes:['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE'],durationsSeconds:Array.from({length:8},(_,index)=>index+3).filter(seconds=>seconds*5792+4096<=Math.min(this.config.videoMaxOutputTokens??65536,65536)),resolutions:['720p'],aspectRatios:['16:9','9:16'],audioModes:[true],supportsCancellation:true,supportsRefinement:true,pollIntervalMs:5000,pricePerSecondUsd:5792*(newer?12:17.5)/1e6,priceVerifiedAt:'2026-11-14',videoTokensPerSecond720p:5792,maximumInputTokens:131072,maximumOutputTokens:Math.min(this.config.videoMaxOutputTokens??65536,65536),inputPricePerMillion:1.5,outputTextPricePerMillion:9,outputVideoPricePerMillion:newer?12:17.5};
  }
  private client():OmniSdk {
    const capabilities=this.capabilities();
    if(!capabilities.available)throw new VideoProviderError(503,'VIDEO_PROVIDER_NOT_CONFIGURED',capabilities.unavailabilityReason??'Video generation is unavailable.','rejected');
    return this.sdk!;
  }
  private options(signal:AbortSignal):GoogleGenAIRequestOptions {
    return {timeout_ms:this.config.videoTimeoutMs??120000,retries:{strategy:'none'},maxRetries:0,signal:AbortSignal.any([signal,AbortSignal.timeout(this.config.videoTimeoutMs??120000)])};
  }
  private validate(settings:VideoSettings):void {
    const c=this.capabilities();
    if(!Number.isInteger(settings.durationSeconds)||!c.durationsSeconds.includes(settings.durationSeconds)||!c.resolutions.includes(settings.resolution)||!c.aspectRatios.includes(settings.aspectRatio)||settings.generateAudio!==true)throw new VideoProviderError(400,'VIDEO_SETTINGS_UNSUPPORTED','This phase supports 3–10 whole seconds at 720p within the configured output-token budget, 16:9 or 9:16 framing, and native audio. Longer or upsampled video needs separate capability and budget verification.','rejected');
  }
  async submit(request:VideoSubmission,signal:AbortSignal):Promise<ProviderVideoOperation> {
    const sdk=this.client();this.validate(request.settings);assertProviderImage(request.image);
    const images=request.images?.length?request.images:[request.image],mode=request.inputMode??'single_image';
    for(const image of images)assertProviderImage(image);
    const maximum=mode==='first_last_frame'?2:mode==='multi_reference'?(this.capabilities().maxReferenceImages??1):1;
    if(images.length>maximum||mode==='first_last_frame'&&(images.length!==2||request.settings.durationSeconds>10))throw new VideoProviderError(400,'VIDEO_INPUT_MODE_UNSUPPORTED','The selected image mode exceeds the documented provider image or duration limit. Use an ordered local montage instead.','rejected');
    if(request.model!==this.model||!request.prompt.trim()||request.prompt.length>32000)throw new VideoProviderError(400,'VIDEO_REQUEST_INVALID','The approved generation model or prompt is invalid.','rejected');
    if(signal.aborted)throw new VideoProviderError(409,'VIDEO_CANCELLED','Video generation was cancelled before submission.','rejected');
    if(request.previousInteractionId)safeId(request.previousInteractionId);
    try {
      const response=await sdk.interactions.create({model:this.model,api_version:'v1beta',
        input:[...images.map(image=>({type:'image' as const,data:Buffer.from(image.data).toString('base64'),mime_type:image.mimeType})),{type:'text',text:request.prompt}],
        response_format:{type:'video',duration:`${request.settings.durationSeconds}s`,resolution:request.settings.resolution,aspect_ratio:request.settings.aspectRatio,delivery:'uri'},
        generation_config:{video_config:{task:request.previousInteractionId?'edit':mode==='multi_reference'?'reference_to_video':'image_to_video'},max_output_tokens:Math.min(this.config.videoMaxOutputTokens??65536,65536)},
        ...(request.previousInteractionId?{previous_interaction_id:request.previousInteractionId}:{}),
        // SDK 3.3 disables client continuation for background execution itself;
        // explicitly setting automatic_continuation:false with background:true
        // is rejected locally before any HTTP request.
        background:true,store:true,stream:false,
      },this.options(signal));
      return await this.operation(response,signal);
    }catch(error){throw safeVideoProviderError(error,'video submission',true);}
  }
  async poll(operationId:string,signal:AbortSignal):Promise<ProviderVideoOperation> {
    safeId(operationId);
    try{return await this.operation(await this.client().interactions.get(operationId,{stream:false,api_version:'v1beta'},this.options(signal)),signal);}
    catch(error){throw safeVideoProviderError(error,'video status');}
  }
  private async operation(value:GoogleGenAIInteraction,signal:AbortSignal):Promise<ProviderVideoOperation> {
    if(!value.id||!ID.test(value.id))throw new VideoProviderError(502,'VIDEO_OPERATION_MISSING','Google did not return a durable interaction ID. The generation submission may have been accepted; do not automatically resubmit it.','unknown');
    const base={operationId:value.id,model:typeof value.model==='string'?value.model:this.model,usage:usage(value)};
    if(['failed','cancelled','incomplete','budget_exceeded','requires_action','requires_continuation'].includes(value.status)) {
      const providerCode=value.errors?.map(error=>safeProviderCode(error.code)).find(Boolean);
      const personRejected=providerCode==='PERSON_GENERATION';
      const blocked=value.errors?.some(error=>/safety|rai|prohibited|blocked/i.test(`${error.code??''} ${error.message??''}`));
      return {...base,done:true,error:{code:personRejected?'VIDEO_PERSON_GENERATION_REJECTED':blocked?'VIDEO_SAFETY_REJECTED':providerCode??'VIDEO_GENERATION_FAILED',message:personRejected?'Google does not support this depiction of people for the supplied input or account. Choose another consented reference or a different supported scene; safeguards are not bypassed.':blocked?'Google blocked this generation under its safeguards. Choose another consented source photo or a different fictional scene. The app does not bypass provider safeguards.':`Google returned video status ${value.status}. No usable clip was supplied; review account restrictions and the scene before approving another generation.`}};
    }
    if(value.status!=='completed')return {...base,done:false,retryAfterMs:5000};
    const video=value.output_video;
    if(video?.uri) {
      const name=googleVideoFileName(video.uri);
      // Persist this capability immediately. File activation belongs to the
      // download phase, avoiding an interaction GET that returns inline bytes.
      return {...base,done:true,output:{uri:name,mimeType:'video/mp4'}};
    }
    if(video?.data) {
      if(video.data.length>Math.ceil(MAX_VIDEO_BYTES*4/3)+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(video.data))throw new VideoProviderError(502,'VIDEO_OUTPUT_INVALID','Google returned an invalid or oversized video payload.','rejected');
      return {...base,done:true,output:{videoBytes:video.data,mimeType:'video/mp4'}};
    }
    return {...base,done:true,error:{code:'VIDEO_OUTPUT_MISSING',message:'Google completed the interaction without a usable video. It may have been blocked; choose another supported, consented scene.'}};
  }
  async download(output:ProviderVideoOutput,signal:AbortSignal):Promise<Response> {
    if(output.videoBytes) {
      if(output.videoBytes.length>Math.ceil(MAX_VIDEO_BYTES*4/3)+4||!/^[A-Za-z0-9+/]*={0,2}$/.test(output.videoBytes))throw new VideoProviderError(502,'VIDEO_OUTPUT_INVALID','The generated video payload is invalid or oversized.','rejected');
      return new Response(Buffer.from(output.videoBytes,'base64'),{headers:{'content-type':'video/mp4'}});
    }
    if(!output.uri)throw new VideoProviderError(502,'VIDEO_OUTPUT_MISSING','The generated video reference is missing.','rejected');
    const name=googleVideoFileName(output.uri);
    if(!this.config.geminiApiKey)throw new VideoProviderError(503,'VIDEO_PROVIDER_NOT_CONFIGURED','The server Gemini key is required to download this private generated video.','rejected');
    try {
      const downloadSignal=AbortSignal.any([signal,AbortSignal.timeout(this.config.videoTimeoutMs??120000)]);
      const file=await this.client().files.get({name,config:{abortSignal:downloadSignal,httpOptions:{apiVersion:'v1beta',timeout:this.config.videoTimeoutMs??120000,retryOptions:{attempts:1}}}});
      if(file.state==='FAILED')throw new VideoProviderError(502,'VIDEO_FILE_FAILED','Google could not process the generated video file.','rejected');
      if(file.state!=='ACTIVE')throw new VideoProviderError(503,'VIDEO_FILE_PROCESSING','Google is still preparing the generated video for download.','rejected',true,5000);
      const response=await this.fetcher(`https://generativelanguage.googleapis.com/v1beta/${name}:download?alt=media`,{headers:{'x-goog-api-key':this.config.geminiApiKey},signal:downloadSignal,redirect:'error'});
      if(!response.ok) {await response.body?.cancel();throw {status:response.status,headers:response.headers};}
      const mime=response.headers.get('content-type')?.split(';')[0].trim();
      const length=response.headers.get('content-length');
      if(mime!=='video/mp4'||length&&(!/^\d+$/.test(length)||Number(length)>MAX_VIDEO_BYTES)) {await response.body?.cancel();throw new VideoProviderError(502,'VIDEO_OUTPUT_INVALID','Google returned an unsupported or oversized video download.','rejected');}
      return response;
    }catch(error){throw safeVideoProviderError(error,'video download');}
  }
  async cancel(operationId:string,signal:AbortSignal):Promise<void> {
    safeId(operationId);
    try{await this.client().interactions.cancel(operationId,{api_version:'v1beta'},this.options(signal));}
    catch(error){throw safeVideoProviderError(error,'video cancellation');}
  }
}
