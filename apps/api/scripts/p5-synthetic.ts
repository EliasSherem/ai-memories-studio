/** Completely local P5 validation. No app startup, API key, network or provider import. */
import {mkdir,writeFile,stat,chmod,rm} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {movieSettingsSchema,type MovieTimeline,type MovieTimelineSegment} from '@memories/shared';
import {MovieRenderer} from '../src/movie-renderer.js';
const execute=promisify(execFile);
const root=resolve('data/p5-validation');await mkdir(root,{recursive:true,mode:0o700});
const renderer=new MovieRenderer({threads:2,memoryLimitMb:1024,maxWorkspaceBytes:3*1024**3,timeoutMs:20*60*1000});
const settings=movieSettingsSchema.parse({resolution:'1080p',preset:'ultrafast',crf:24,musicVolume:.18,titles:{font:'sans',openingTitle:'Our Synthetic Story · יחד',closingCredits:'Local patterns and generated test tones only. No personal photos or paid AI.',includeDisclosure:true}});
const controller=new AbortController();process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
async function source(file:string,width:number,height:number,fps:string,audio:boolean){const args=['-hide_banner','-v','error','-f','lavfi','-i',`testsrc2=size=${width}x${height}:rate=${fps}:duration=8`];if(audio)args.push('-f','lavfi','-i','sine=frequency=660:sample_rate=44100:duration=8');args.push('-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2');if(audio)args.push('-c:a','aac','-shortest');args.push('-y',file);await execute(renderer.ffmpegPath,args,{signal:controller.signal,timeout:30000});await chmod(file,0o600);}
const a=join(root,'pattern-landscape-24fps.mp4'),b=join(root,'pattern-portrait-60fps.mp4'),c=join(root,'pattern-landscape-2997fps.mp4'),photo=join(root,'synthetic-photo.jpg'),music=join(root,'test-instrumental.wav');
await source(a,640,360,'24',true);await source(b,360,640,'60',false);await source(c,480,270,'30000/1001',true);
await sharp({create:{width:1024,height:768,channels:3,background:'#6f856d'}}).composite([{input:Buffer.from('<svg width="1024" height="768"><rect x="100" y="110" width="824" height="548" rx="60" fill="#cdb595"/><circle cx="512" cy="384" r="190" fill="#b96648"/><circle cx="512" cy="384" r="90" fill="#f7eee0"/></svg>')}]).jpeg({quality:90}).toFile(photo);
await execute(renderer.ffmpegPath,['-hide_banner','-v','error','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=17','-f','lavfi','-i','sine=frequency=330:sample_rate=48000:duration=17','-filter_complex','[0:a][1:a]amix=inputs=2,volume=0.5,afade=t=in:d=0.2,afade=t=out:st=16.8:d=0.2[a]','-map','[a]','-c:a','pcm_s16le','-ar','48000','-ac','2','-y',music],{signal:controller.signal,timeout:30000});
const soundtrack=await renderer.analyzeSoundtrack(music,controller.signal);
const overlapAt=new Set([1,2,4,5,7,8,10,11,13,14,16,18]);let cursor=0;
const segments:MovieTimelineSegment[]=Array.from({length:20},(_,index)=>{const type=index===0||index===19?'title':index%4===0?'photo':'video';const overlap=overlapAt.has(index)?.5:0;const transition=index===5||index===13?'fadeblack':index===18?'fadewhite':'crossfade';const startSeconds=cursor-overlap;cursor=startSeconds+7.8;return {id:`synthetic-segment-${index+1}`,sceneId:`synthetic-scene-${index+1}`,sceneType:type==='title'?'TITLE_SEQUENCE':type==='photo'?'PHOTO_MONTAGE':'ORIGINAL_ANIMATION',type,durationSeconds:7.8,startSeconds,isFictional:false,titleText:index===0?'Our Synthetic Story\nשלום · 日本 · México · Memories':index===19?'Created entirely from local test patterns and tones.\nNo personal media. No paid generation.':undefined,transition:{type:overlap?transition:'cut',durationSeconds:overlap}};});
const timeline:MovieTimeline={storyboardId:'synthetic-validation',targetDurationSeconds:150,durationSeconds:150,totalSourceDurationSeconds:156,transitionOverlapSeconds:6,segments,issues:[],warnings:[],ready:true,beatAlignedCuts:0};
const outputFile=join(root,'synthetic-150s.mp4'),started=Date.now();let previous=-1;
const result=await renderer.render({timeline,settings,segments:segments.map((item,index)=>({...item,file:item.type==='photo'?photo:item.type==='video'?[a,b,c][index%3]:undefined})),soundtrackFile:music,workspace:join(root,'work'),outputFile,signal:controller.signal,onProgress:progress=>{const bucket=Math.floor(progress.percent/10);if(bucket!==previous){previous=bucket;process.stdout.write(`${progress.phase} ${Math.round(progress.percent)}%\n`);}}});
const hash=createHash('sha256');for await(const chunk of createReadStream(outputFile))hash.update(chunk);
const report={schemaVersion:'1.0',completedAt:new Date().toISOString(),test:'Entirely synthetic local 150-second FFmpeg integration',paidGenerativeRequests:0,personalMediaUsed:false,status:'PASSED',elapsedSeconds:(Date.now()-started)/1000,settings,timeline:{segmentCount:20,totalSourceDurationSeconds:156,transitionOverlapSeconds:6,durationSeconds:150,sceneTypes:['TITLE_SEQUENCE','ORIGINAL_ANIMATION','PHOTO_MONTAGE'],transitionTypes:['cut','crossfade','fadeblack','fadewhite'],mixedInputResolutions:['640x360','360x640','480x270'],mixedInputFps:[24,60,29.97002997002997],silentVideoInput:true},soundtrackAnalysis:{onsetsDetected:soundtrack.onsets.length,durationSeconds:soundtrack.duration},inspection:result.inspection,diagnostics:result.diagnostics,bytes:(await stat(outputFile)).size,sha256:hash.digest('hex'),outputFile};
await chmod(outputFile,0o600);await chmod(result.thumbnailFile,0o600);await writeFile(join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});await rm(join(root,'work'),{recursive:true,force:true});process.stdout.write(JSON.stringify(report,null,2)+'\n');
