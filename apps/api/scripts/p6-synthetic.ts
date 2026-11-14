/** Full P6 orchestration with MOCK AI providers and REAL local media validation/FFmpeg. */
import {mkdir,writeFile,copyFile,stat,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {productionConfigSchema,type ProductionRun} from '@memories/shared';
import {MovieRenderer} from '../src/movie-renderer.js';
import {productionFixture} from '../test/production-fixture.js';
const execute=promisify(execFile),root=resolve('data/p6-validation');await mkdir(root,{recursive:true,mode:0o700});
const directory=join(root,`run-${randomUUID()}`);await mkdir(directory,{recursive:true,mode:0o700});
const renderer=new MovieRenderer({threads:2,memoryLimitMb:1024,maxWorkspaceBytes:3*1024**3,timeoutMs:20*60*1000});
const source=join(directory,'synthetic-8s-720p.mp4'),music=join(directory,'licensed-synthetic-tones.wav');
await execute(renderer.ffmpegPath,['-hide_banner','-v','error','-f','lavfi','-i','testsrc2=size=1280x720:rate=24:duration=8','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-shortest','-movflags','+faststart','-y',source],{timeout:30000});await chmod(source,0o600);
await execute(renderer.ffmpegPath,['-hide_banner','-v','error','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=17','-af','volume=0.3,afade=t=in:d=0.3,afade=t=out:st=16.7:d=0.3','-c:a','pcm_s16le','-ac','2','-y',music],{timeout:30000});await chmod(music,0o600);
const picture=await sharp({create:{width:640,height:360,channels:3,background:'#788e76'}}).composite([{input:Buffer.from('<svg width="640" height="360"><rect x="60" y="50" width="520" height="260" rx="30" fill="#d7c5a7"/><circle cx="320" cy="180" r="100" fill="#b86748"/><circle cx="320" cy="180" r="45" fill="#f7eee0"/></svg>')}]).jpeg().toBuffer();
const fixture=await productionFixture({root:directory,keepFiles:true,realMedia:true,photoCount:100,videoFile:source,photoBytes:picture,renderer});
const originalRender=renderer.render.bind(renderer);renderer.render=async input=>{fixture.counters.render++;return originalRender(input);};
let final:ProductionRun|undefined;const history:{state:string;progress:number}[]=[],started=Date.now();
try{
 const upload=await fixture.agent.post('/api/movie/soundtracks').set('Origin',fixture.config.webOrigin).set('X-CSRF-Token',fixture.csrfToken).set('X-License-Confirmed','true').set('X-Instrumental','true').set('X-Upload-Name',encodeURIComponent('Owned synthetic test tones.wav')).set('Content-Type','audio/wav').send(await import('node:fs/promises').then(fs=>fs.readFile(music))).expect(201);
 const base=productionConfigSchema.parse({title:'Synthetic P6 production · יחד',maxSpendUsd:60,movieSettings:{resolution:'1080p',preset:'ultrafast',crf:24,soundtrackId:upload.body.id,musicVolume:.18,titles:{font:'sans',openingTitle:'Automatic Synthetic Production · שלום',closingCredits:'Local test patterns and synthetic tones only.\nAI providers were mocked. No personal media or paid generation.'}}});
 const quote=await fixture.quote(base),run=await fixture.create(quote);history.push({state:run.state,progress:run.overallProgress});
 if(Object.values(fixture.counters).some(value=>value!==0))throw new Error('A synthetic provider was called before explicit run approval.');
 await fixture.approve(run,60);
 const deadline=Date.now()+15*60*1000;
 while(Date.now()<deadline){
  final=(await fixture.agent.get(`/api/production/runs/${run.id}`).expect(200)).body as ProductionRun;
  const previous=history.at(-1);if(previous?.state!==final.state||Math.floor((previous?.progress??0)/10)!==Math.floor(final.overallProgress/10)){history.push({state:final.state,progress:final.overallProgress});process.stdout.write(`${final.state} ${Math.round(final.overallProgress)}%\n`);}
  if(['COMPLETED','PAUSED','FAILED','CANCELLED'].includes(final.state))break;
  await new Promise(resolve=>setTimeout(resolve,200));
 }
 if(final?.state!=='COMPLETED'||!final.finalMovie)throw new Error(`Synthetic P6 did not complete: ${final?.state}; ${final?.message}; ${final?.errors.map(error=>error.code).join(',')}`);
 const row=fixture.movieStore.assetRow(fixture.owner,final.finalMovie.id),content=await fixture.movieMedia.content(fixture.owner,row.storage_name),output=join(root,'synthetic-production-150s.mp4');await copyFile(content.file,output);await chmod(output,0o600);
 const inspection=await renderer.validate(output,{durationSeconds:150,width:1920,height:1080,fps:30,audio:true});const hash=createHash('sha256');for await(const chunk of createReadStream(output))hash.update(chunk);
 const report={schemaVersion:'1.0',completedAt:new Date().toISOString(),status:'PASSED',test:'P6 end-to-end orchestration with mocked AI and real P3/P4/P5 local workers',paidGenerativeRequests:0,personalMediaUsed:false,aiProvidersMocked:true,realFfmpegRendering:true,importedPhotos:100,runId:final.id,configuration:final.config,requestedModelsAreMocked:final.quote.estimate.models,counters:fixture.counters,history,scenes:final.scenes.map(scene=>({type:scene.type,state:scene.state,attempts:scene.attempts,advisoryScore:scene.score})),curation:final.curation,budget:{...final.budget,note:'Synthetic estimates only; no provider charges occurred.'},inspection,elapsedSeconds:(Date.now()-started)/1000,bytes:(await stat(output)).size,sha256:hash.digest('hex'),outputFile:output,privateTestDatabase:join(directory,'studio.sqlite')};await writeFile(join(root,'report.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});process.stdout.write(JSON.stringify(report,null,2)+'\n');
}finally{await fixture.dispose();}
