import {describe,it,expect,vi} from 'vitest';
import sharp from 'sharp';
import {GoogleGenAI,type GoogleGenAIInteraction,type GenerateContentResponse} from '@google/genai';
import type {StoryboardScene} from '@memories/shared';
import {OmniFlashProvider,googleVideoFileName,type OmniSdk} from '../src/omni-provider.js';
import {VeoProvider} from '../src/veo-provider.js';
import {VideoProviderError,safeVideoProviderError,type VideoSubmission,type KeyframeRequest} from '../src/video-provider.js';
import {GeminiKeyframeProvider,type KeyframeSdk} from '../src/video-keyframes.js';
import {GeminiVideoQualityProvider,type QualitySdk} from '../src/video-quality.js';

const PRIVATE_KEY='private-gemini-key-never-log';
const image={data:new Uint8Array([1,2,3]),mimeType:'image/jpeg'};
const submission:VideoSubmission={jobId:'app-job',model:'gemini-omni-1.1-flash',prompt:'Animate the original with subtle ambient movement.',image,settings:{durationSeconds:8,resolution:'720p',aspectRatio:'16:9',generateAudio:true}};
const interaction=(overrides:Partial<GoogleGenAIInteraction>={}):GoogleGenAIInteraction=>({id:'interaction_123',status:'in_progress',model:'gemini-omni-1.1-flash',...overrides} as GoogleGenAIInteraction);
function fixture(response=interaction()) {
  const create=vi.fn(async()=>response),get=vi.fn(async()=>response),cancel=vi.fn(async()=>interaction({status:'cancelled'}));
  const fileGet=vi.fn(async()=>({state:'ACTIVE'}));
  const sdk={interactions:{create,get,cancel},files:{get:fileGet}} as unknown as OmniSdk;
  const fetcher=vi.fn(async()=>new Response(new Uint8Array([0,0,0,16,102,116,121,112]),{headers:{'content-type':'video/mp4'}}));
  return {provider:new OmniFlashProvider({geminiApiKey:PRIVATE_KEY},{sdk,fetch:fetcher as typeof fetch}),create,get,cancel,fileGet,fetcher,sdk};
}
const scene:StoryboardScene={id:'00000000-0000-4000-8000-000000000001',sequenceNumber:1,type:'NEW_CINEMATIC_SCENE',title:'A fictional walk',description:'An imagined scene under warm evening light.',durationSeconds:15,sourcePhotoIds:[],protagonistIds:['person1','person2'],visualStyle:'Warm natural light',cameraDirection:'Slow camera drift',motionPrompt:'A gentle walk',emotionalTone:'Reflective',continuityNotes:'Fictional moment.',generationInstructions:'Use only consented references.',isFictional:true,requiresUserConfirmation:true,userConfirmed:true};
function references():KeyframeRequest['references'] {return (['person1','person2'] as const).flatMap((person,index)=>Array.from({length:5},(_,number)=>({assetId:`asset-${index}-${number}`,protagonistId:person,name:index?'Sam':'Alex',image})));}

describe('Google video provider SDK boundary',()=>{
  it('serializes the real official SDK Interactions request through a mocked HTTP transport',async()=>{
    const transport=vi.fn(async(_input:unknown,_init?:RequestInit)=>Response.json({id:'interaction_123',object:'interaction',status:'in_progress',model:'gemini-omni-1.1-flash',steps:[]}));
    const sdk=new GoogleGenAI({apiKey:PRIVATE_KEY,vertexai:false,httpOptions:{fetch:transport as typeof fetch,retryOptions:{attempts:1}}});
    const provider=new OmniFlashProvider({geminiApiKey:PRIVATE_KEY},{sdk});
    const result=await provider.submit(submission,new AbortController().signal);
    expect(result).toMatchObject({operationId:'interaction_123',done:false});expect(transport).toHaveBeenCalledTimes(1);
    const [url,init]=transport.mock.calls[0];const sent=url instanceof Request?url:new Request(String(url),init);expect(sent.url).toContain('/v1beta/interactions');const body=await sent.json();
    expect(body).toMatchObject({model:submission.model,background:true,store:true,generation_config:{video_config:{task:'image_to_video'},max_output_tokens:65536},response_format:{type:'video',duration:'8s',delivery:'uri'}});
    expect(body).not.toHaveProperty('config');expect(body).not.toHaveProperty('generateVideos');
  });
  it('does not let the real SDK retry a failed paid HTTP submission',async()=>{
    const transport=vi.fn(async()=>Response.json({error:{code:503,status:'UNAVAILABLE',message:'Synthetic server failure'}},{status:503}));
    const sdk=new GoogleGenAI({apiKey:PRIVATE_KEY,vertexai:false,httpOptions:{fetch:transport as typeof fetch,retryOptions:{attempts:1}}});
    const provider=new OmniFlashProvider({geminiApiKey:PRIVATE_KEY},{sdk});
    await expect(provider.submit(submission,new AbortController().signal)).rejects.toMatchObject({outcome:'unknown',transient:true});expect(transport).toHaveBeenCalledTimes(1);
  });
  it('uses Interactions image-to-video fields with a durable background ID, native audio, and no hidden retries',async()=>{
    const f=fixture();const operation=await f.provider.submit(submission,new AbortController().signal);
    expect(operation).toMatchObject({operationId:'interaction_123',done:false});
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({model:'gemini-omni-1.1-flash',input:[{type:'image',data:'AQID',mime_type:'image/jpeg'},{type:'text',text:submission.prompt}],background:true,store:true,stream:false,generation_config:{video_config:{task:'image_to_video'},max_output_tokens:65536},response_format:{type:'video',duration:'8s',resolution:'720p',aspect_ratio:'16:9',delivery:'uri'}}),expect.objectContaining({retries:{strategy:'none'},maxRetries:0}));
    expect(JSON.stringify(f.create.mock.calls)).not.toMatch(/generateAudio|durationSeconds|referenceImages/);
  });
  it('keeps the previous interaction for conversational refinement without mixing Veo request formats',async()=>{
    const f=fixture();await f.provider.submit({...submission,previousInteractionId:'previous_123'},new AbortController().signal);
    expect(f.create).toHaveBeenCalledWith(expect.objectContaining({previous_interaction_id:'previous_123',generation_config:{video_config:{task:'edit'},max_output_tokens:65536}}),expect.anything());
  });
  it('validates model capabilities and rejects settings outside the bounded P4 token budget before any paid request',async()=>{
    const f=fixture();
    for(const request of [{...submission,settings:{...submission.settings,durationSeconds:15}},{...submission,settings:{...submission.settings,generateAudio:false}},{...submission,model:'veo-3.1-fast-generate-preview'}])await expect(f.provider.submit(request,new AbortController().signal)).rejects.toBeInstanceOf(VideoProviderError);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.provider.capabilities().durationsSeconds).not.toContain(15);
    const newer=new OmniFlashProvider({geminiApiKey:PRIVATE_KEY,omniModel:'gemini-omni-1.2-flash'},{sdk:f.sdk});expect(newer.capabilities().durationsSeconds).toEqual([3,4,5,6,7,8,9,10]);
    await expect(newer.submit({...submission,model:newer.model,settings:{...submission.settings,resolution:'1080p'}},new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_SETTINGS_UNSUPPORTED'});
    await expect(newer.submit({...submission,model:newer.model,settings:{...submission.settings,durationSeconds:15}},new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_SETTINGS_UNSUPPORTED'});
    expect(new OmniFlashProvider({geminiApiKey:PRIVATE_KEY,videoMaxOutputTokens:32768},{sdk:f.sdk}).capabilities().durationsSeconds).not.toContain(8);
    expect(f.provider.capabilities().accountVerified).toBe(false);
  });
  it('never submits the retired Gemini Veo preview or a missing-key provider',async()=>{
    const retired=new VeoProvider();expect(retired.capabilities().available).toBe(false);
    await expect(retired.submit(submission,new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_PROVIDER_RETIRED',outcome:'rejected'});
    await expect(new OmniFlashProvider({}).submit(submission,new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_PROVIDER_NOT_CONFIGURED'});
  });
  it('marks uncertain paid submissions unknown and never automatically resends them',async()=>{
    const f=fixture();f.create.mockRejectedValue(new Error('private image body and API key'));
    await expect(f.provider.submit(submission,new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_PROVIDER_UNAVAILABLE',outcome:'unknown',transient:true});
    expect(f.create).toHaveBeenCalledTimes(1);
    const safe=safeVideoProviderError({status:503,message:PRIVATE_KEY},'video submission',true);
    expect(safe.message).not.toContain(PRIVATE_KEY);expect(safe.outcome).toBe('unknown');
    expect(safeVideoProviderError({status:429,headers:new Headers({'retry-after':'12'})},'video submission',true)).toMatchObject({outcome:'rejected',retryAfterMs:12000});
  });
  it('classifies explicit safeguard categories and never echoes arbitrary error codes',async()=>{
    expect(safeVideoProviderError({status:403,error:{code:'PERSON_GENERATION',message:PRIVATE_KEY}},'video submission',true)).toMatchObject({code:'VIDEO_PERSON_GENERATION_REJECTED',providerCode:'PERSON_GENERATION',outcome:'rejected'});
    expect(safeVideoProviderError({status:400,error:{status:'INVALID_ARGUMENT',message:PRIVATE_KEY}},'video submission',true)).toMatchObject({code:'VIDEO_PROVIDER_INVALID_REQUEST',providerCode:'INVALID_ARGUMENT'});
    const f=fixture(interaction({status:'failed',errors:[{code:PRIVATE_KEY,message:'Provider failed.'}]}));
    const operation=await f.provider.poll('interaction_123',new AbortController().signal);expect(operation.error?.code).toBe('VIDEO_GENERATION_FAILED');expect(JSON.stringify(operation)).not.toContain(PRIVATE_KEY);
  });
  it('keeps a timed-out paid submission unknown without retrying',async()=>{
    const f=fixture();f.create.mockRejectedValue(new DOMException('unsafe provider timeout details','TimeoutError'));
    await expect(f.provider.submit(submission,new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_REQUEST_INTERRUPTED',outcome:'unknown',transient:true});expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('requires a durable ID and treats its absence as an unknown accepted submission',async()=>{
    const f=fixture(interaction({id:undefined as unknown as string}));
    await expect(f.provider.submit(submission,new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_OPERATION_MISSING',outcome:'unknown'});
  });
  it('resumes a saved ID, reports policy failure safely, and can request cancellation',async()=>{
    const f=fixture(interaction({status:'failed',errors:[{code:'https://google.example/SAFETY',message:`Private ${PRIVATE_KEY} safety rejection`}]}));
    const operation=await f.provider.poll('interaction_123',new AbortController().signal);
    expect(operation).toMatchObject({done:true,error:{code:'VIDEO_SAFETY_REJECTED'}});expect(JSON.stringify(operation)).not.toContain(PRIVATE_KEY);
    expect(f.get).toHaveBeenCalledWith('interaction_123',{stream:false,api_version:'v1beta'},expect.objectContaining({maxRetries:0}));
    await f.provider.cancel('interaction_123',new AbortController().signal);expect(f.cancel).toHaveBeenCalledTimes(1);
  });
  it('returns URI delivery promptly, waits for file activation in the download phase, and streams authenticated content',async()=>{
    const f=fixture(interaction({status:'completed',output_video:{type:'video',uri:'https://generativelanguage.googleapis.com/v1beta/files/video123',mime_type:'video/mp4'},usage:{total_input_tokens:100,total_output_tokens:46336,total_thought_tokens:100}}));
    const operation=await f.provider.submit(submission,new AbortController().signal);
    expect(operation).toMatchObject({done:true,output:{uri:'files/video123'},usage:{inputTokens:100,outputTokens:46436}});expect(f.fileGet).not.toHaveBeenCalled();
    f.fileGet.mockResolvedValueOnce({state:'PROCESSING'});
    await expect(f.provider.download(operation.output!,new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_FILE_PROCESSING',transient:true,retryAfterMs:5000});expect(f.fetcher).not.toHaveBeenCalled();
    const response=await f.provider.download(operation.output!,new AbortController().signal);expect(response.body).toBeTruthy();
    expect(f.fetcher).toHaveBeenCalledWith('https://generativelanguage.googleapis.com/v1beta/files/video123:download?alt=media',expect.objectContaining({redirect:'error',headers:{'x-goog-api-key':PRIVATE_KEY}}));
  });
  it('rejects arbitrary or credential-bearing download URLs and unsafe operation IDs',async()=>{
    for(const url of ['https://attacker.example/file','http://generativelanguage.googleapis.com/v1beta/files/video123','https://generativelanguage.googleapis.com.attacker.example/v1beta/files/video123','https://generativelanguage.googleapis.com/v1beta/files/video123?key=private','files/../../secret'])expect(()=>googleVideoFileName(url)).toThrow();
    const f=fixture();await expect(f.provider.poll('../secret',new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_OPERATION_INVALID'});
    expect(f.fetcher).not.toHaveBeenCalled();expect(f.get).not.toHaveBeenCalled();
  });
  it('supports documented inline retrieval fallback without fetching another host',async()=>{
    const bytes=Buffer.from('synthetic mp4 bytes');const f=fixture(interaction({status:'completed',output_video:{type:'video',data:bytes.toString('base64'),mime_type:'video/mp4'}}));
    const operation=await f.provider.poll('interaction_123',new AbortController().signal);const response=await f.provider.download(operation.output!,new AbortController().signal);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('does not make any paid request after client cancellation',async()=>{
    const f=fixture();const controller=new AbortController();controller.abort();
    await expect(f.provider.submit(submission,controller.signal)).rejects.toMatchObject({code:'VIDEO_CANCELLED',outcome:'rejected'});expect(f.create).not.toHaveBeenCalled();
  });
});

describe('separate Gemini keyframe and advisory quality requests',()=>{
  it('serializes verified keyframe options through the official Generate Content SDK without network access',async()=>{
    const png=await sharp({create:{width:32,height:18,channels:3,background:'#778899'}}).png().toBuffer();
    const transport=vi.fn(async(_input:unknown,_init?:RequestInit)=>Response.json({candidates:[{content:{parts:[{inlineData:{data:png.toString('base64'),mimeType:'image/png'}}]}}]}));
    const sdk=new GoogleGenAI({apiKey:PRIVATE_KEY,vertexai:false,httpOptions:{fetch:transport as typeof fetch,retryOptions:{attempts:1}}});
    const provider=new GeminiKeyframeProvider({geminiApiKey:PRIVATE_KEY},{sdk});
    await provider.generate({scene,references:references(),aspectRatio:'16:9'},new AbortController().signal);
    expect(transport).toHaveBeenCalledTimes(1);const [url,init]=transport.mock.calls[0];expect(String(url)).toContain('/models/gemini-3.1-flash-image:generateContent');
    const body=JSON.parse(String(init?.body));expect(body.generationConfig).toMatchObject({imageConfig:{aspectRatio:'16:9',imageSize:'1K'},responseModalities:['TEXT','IMAGE'],maxOutputTokens:2048});expect(body).not.toHaveProperty('response_format');
  });
  it('creates a fictional keyframe using two authorized references per requested protagonist and a supported image model',async()=>{
    const png=await sharp({create:{width:32,height:18,channels:3,background:'#778899'}}).png().toBuffer();
    const generateContent=vi.fn(async(_request:unknown)=>({modelVersion:'gemini-3.1-flash-image',candidates:[{content:{parts:[{inlineData:{data:png.toString('base64'),mimeType:'image/png'}}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:1120,thoughtsTokenCount:20}} as GenerateContentResponse));
    const provider=new GeminiKeyframeProvider({geminiApiKey:PRIVATE_KEY},{sdk:{models:{generateContent}} as unknown as KeyframeSdk});
    const result=await provider.generate({scene,references:references(),aspectRatio:'16:9'},new AbortController().signal);
    expect(result).toMatchObject({model:'gemini-3.1-flash-image',requiresHumanReview:true,identityVerified:false,usage:{inputTokens:100,outputTokens:1140},referenceAssetIds:['asset-0-0','asset-0-1','asset-1-0','asset-1-1']});
    const request=generateContent.mock.calls[0][0] as any;
    expect(request.contents[0].parts.filter((part:any)=>part.inlineData)).toHaveLength(4);
    expect(request.contents[0].parts[0].text).toContain(scene.generationInstructions);
    expect(request.config).toMatchObject({imageConfig:{aspectRatio:'16:9',imageSize:'1K'},maxOutputTokens:2048,automaticContinuation:false,httpOptions:{retryOptions:{attempts:1}}});
    expect(request).not.toHaveProperty('response_format');
  });
  it('rejects missing references and unverified models before keyframe submission',async()=>{
    const generateContent=vi.fn();const provider=new GeminiKeyframeProvider({geminiApiKey:PRIVATE_KEY},{sdk:{models:{generateContent}} as unknown as KeyframeSdk});
    await expect(provider.generate({scene,references:references().filter(reference=>reference.protagonistId==='person1'),aspectRatio:'16:9'},new AbortController().signal)).rejects.toMatchObject({code:'KEYFRAME_REFERENCES_REQUIRED'});expect(generateContent).not.toHaveBeenCalled();
    await expect(new GeminiKeyframeProvider({geminiApiKey:PRIVATE_KEY,keyframeModel:'unverified-model'},{sdk:{models:{generateContent}} as unknown as KeyframeSdk}).generate({scene,references:references(),aspectRatio:'16:9'},new AbortController().signal)).rejects.toMatchObject({code:'KEYFRAME_MODEL_UNVERIFIED'});
  });
  it('supports a solo scene with exactly two distinct authorized character inputs',async()=>{
    const png=await sharp({create:{width:32,height:18,channels:3,background:'#778899'}}).png().toBuffer();
    const generateContent=vi.fn(async(_request:unknown)=>({candidates:[{content:{parts:[{inlineData:{data:png.toString('base64'),mimeType:'image/png'}}]}}]} as GenerateContentResponse));
    const provider=new GeminiKeyframeProvider({geminiApiKey:PRIVATE_KEY},{sdk:{models:{generateContent}} as unknown as KeyframeSdk});
    const result=await provider.generate({scene:{...scene,protagonistIds:['person1']},references:references(),aspectRatio:'9:16'},new AbortController().signal);
    expect(result.referenceAssetIds).toEqual(['asset-0-0','asset-0-1']);expect((generateContent.mock.calls[0][0] as any).contents[0].parts.filter((part:any)=>part.inlineData)).toHaveLength(2);
  });
  it('rejects keyframe bytes whose decoded format disagrees with the declared MIME type',async()=>{
    const svg=Buffer.from('<svg width="32" height="18" xmlns="http://www.w3.org/2000/svg"><rect width="32" height="18" fill="red"/></svg>');
    const generateContent=vi.fn(async()=>({candidates:[{content:{parts:[{inlineData:{data:svg.toString('base64'),mimeType:'image/png'}}]}}]} as GenerateContentResponse));
    const provider=new GeminiKeyframeProvider({geminiApiKey:PRIVATE_KEY},{sdk:{models:{generateContent}} as unknown as KeyframeSdk});
    await expect(provider.generate({scene,references:references(),aspectRatio:'16:9'},new AbortController().signal)).rejects.toMatchObject({code:'KEYFRAME_OUTPUT_INVALID'});
  });
  it('does not fabricate keyframes when Google blocks generation and never bypasses safeguards',async()=>{
    const generateContent=vi.fn(async()=>({promptFeedback:{blockReason:'SAFETY'}} as GenerateContentResponse));
    const provider=new GeminiKeyframeProvider({geminiApiKey:PRIVATE_KEY},{sdk:{models:{generateContent}} as unknown as KeyframeSdk});
    await expect(provider.generate({scene,references:references(),aspectRatio:'16:9'},new AbortController().signal)).rejects.toMatchObject({code:'KEYFRAME_SAFETY_REJECTED',providerCode:'SAFETY'});expect(generateContent).toHaveBeenCalledTimes(1);
  });
  it('reviews representative frames as advisory observations without claiming identity verification',async()=>{
    const output={summary:'The visible frames appear consistent, with limited motion evidence.',visualDefects:['Possible hand distortion.'],sceneDeviations:[],potentialIdentityIssues:['Apparent facial consistency is uncertain.'],score:70};
    const generateContent=vi.fn(async(_request:unknown)=>({candidates:[{content:{parts:[{text:JSON.stringify(output)}]}}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:100}} as GenerateContentResponse));
    const provider=new GeminiVideoQualityProvider({geminiApiKey:PRIVATE_KEY},{sdk:{models:{generateContent}} as unknown as QualitySdk});
    const result=await provider.review({scene,frames:[image,image,image],references:[image,image]},new AbortController().signal);
    expect(result.quality).toMatchObject({status:'complete',identityAssessment:'advisory_not_identity_verification',requiresHumanReview:true,score:70,flags:output.visualDefects.concat(output.potentialIdentityIssues)});
    expect((generateContent.mock.calls[0][0] as any).config.maxOutputTokens).toBe(1024);
  });
  it('rejects malformed advisory output and unverified quality-model pricing',async()=>{
    const generateContent=vi.fn(async()=>({candidates:[{content:{parts:[{text:'not json'}]}}]} as GenerateContentResponse));
    const sdk={models:{generateContent}} as unknown as QualitySdk;
    await expect(new GeminiVideoQualityProvider({geminiApiKey:PRIVATE_KEY},{sdk}).review({scene,frames:[image],references:[]},new AbortController().signal)).rejects.toMatchObject({code:'QUALITY_OUTPUT_INVALID'});
    await expect(new GeminiVideoQualityProvider({geminiApiKey:PRIVATE_KEY,videoQualityModel:'unverified'},{sdk}).review({scene,frames:[image],references:[]},new AbortController().signal)).rejects.toMatchObject({code:'QUALITY_MODEL_UNVERIFIED'});
  });
});

describe('P6.1 documented multi-image Interactions modes',()=>{
 it('serializes two ordered images as actual first/last frames through the installed SDK',async()=>{
  const transport=vi.fn(async()=>Response.json({id:'pair_operation',status:'in_progress',steps:[]}));
  const sdk=new GoogleGenAI({apiKey:PRIVATE_KEY,httpOptions:{fetch:transport as typeof fetch,retryOptions:{attempts:1}}});
  const provider=new OmniFlashProvider({geminiApiKey:PRIVATE_KEY},{sdk});
  await provider.submit({...submission,inputMode:'first_last_frame',images:[image,{...image,data:new Uint8Array([4,5,6])}]},new AbortController().signal);
  const [input,init]=transport.mock.calls[0] as unknown as [Request|string,RequestInit];const body=await (input instanceof Request?input:new Request(String(input),init)).json() as {input:{type:string;data:string}[];generation_config:{video_config:{task:string}}};
  expect(body.input.filter((x:{type:string})=>x.type==='image').map((x:{data:string})=>x.data)).toEqual(['AQID','BAUG']);
  expect(body.generation_config.video_config.task).toBe('image_to_video');
 });
 it('keeps unordered references distinct and rejects exceeding the model limit before dispatch',async()=>{
  const f=fixture();await f.provider.submit({...submission,inputMode:'multi_reference',images:[image,image,image]},new AbortController().signal);
  expect(f.create).toHaveBeenCalledWith(expect.objectContaining({generation_config:{video_config:{task:'reference_to_video'},max_output_tokens:65536},input:expect.arrayContaining([{type:'image',data:'AQID',mime_type:'image/jpeg'}])}),expect.anything());
  expect((f.create.mock.calls as unknown as [{input:{type:string}[]} ][])[0][0].input.filter((x:{type:string})=>x.type==='image')).toHaveLength(3);
  await expect(f.provider.submit({...submission,inputMode:'multi_reference',images:[image,image,image,image]},new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_INPUT_MODE_UNSUPPORTED'});expect(f.create).toHaveBeenCalledTimes(1);
 });
});
