import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { MediaStore } from '../src/media-store.js';
import { VideoMedia, type VideoCommandRunner } from '../src/video-media.js';

const execute=promisify(execFile);
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const expected={durationSeconds:8,resolution:'720p',aspectRatio:'16:9',audio:true} as const;
const fakeMp4=()=>Buffer.concat([Buffer.from([0,0,0,24]),Buffer.from('ftypisom'),Buffer.alloc(52)]);
async function fixture(options:{quota?:number;limit?:number;freeReserve?:number;runner?:VideoCommandRunner}={}) {
  const root=await mkdtemp(path.join(tmpdir(),'memories-video-media-'));
  const media=new MediaStore(root,{storageQuotaBytes:options.quota,minFreeDiskBytes:options.freeReserve??0});
  const owner=randomUUID();await media.ensure(owner);
  const generated=new VideoMedia(media,{maxVideoBytes:options.limit,runner:options.runner});
  cleanups.push(async()=>{media.db.close();await rm(root,{recursive:true,force:true});});
  return {root,media,owner,generated};
}
async function realVideo(f:Awaited<ReturnType<typeof fixture>>) {
  const file=path.join(f.root,'synthetic-fixture.mp4');
  await execute(f.generated.ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=green:s=1280x720:r=24:d=8','-f','lavfi','-i','sine=frequency=440:sample_rate=44100:duration=8','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-c:a','aac','-b:a','64k','-shortest','-movflags','+faststart',file],{timeout:20000,maxBuffer:1024*1024});
  return file;
}
const response=(bytes:ConstructorParameters<typeof Response>[0]=fakeMp4(),mime='video/mp4')=>new Response(bytes,{headers:{'content-type':mime}});

describe('private generated media and real FFmpeg validation',()=>{
  it('streams a video privately, checkpoints it, validates actual codecs/audio/dimensions and creates representative frames',async()=>{
    const f=await fixture();const job=randomUUID();
    expect(await f.generated.detectTools()).toMatchObject({available:true,ffmpegAvailable:true,ffprobeAvailable:true});
    const source=await realVideo(f);
    const streamed=new Response(Readable.toWeb(createReadStream(source)) as ReadableStream<Uint8Array>,{headers:{'content-type':'video/mp4'}});
    const stored=await f.generated.streamVideo(f.owner,job,streamed,new AbortController().signal);
    expect(stored.storageName).toBe(`${job}.mp4`);expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(stored.bytes).toBe((await stat(source)).size);expect((await stat(stored.file)).mode&0o777).toBe(0o600);
    expect((await stat(f.generated.directory(f.owner))).mode&0o777).toBe(0o700);
    const inspection=await f.generated.validateVideo(stored.file,expected);
    expect(inspection).toMatchObject({width:1280,height:720,videoCodec:'h264',audioCodec:'aac',hasAudio:true,frameRate:24});
    expect(inspection.durationSeconds).toBeCloseTo(8,0);
    const previews=await f.generated.createPreviews(f.owner,job,stored.file,inspection);
    expect(previews.frameStorageNames).toHaveLength(3);
    for(const name of [previews.thumbnailStorageName,...previews.frameStorageNames]) {
      const content=await f.generated.content(f.owner,f.owner,name);expect(content.mimeType).toBe('image/jpeg');
      const decoded=await sharp(content.file).metadata();expect(Math.max(decoded.width!,decoded.height!)).toBeLessThanOrEqual(640);
    }
    const repeated=await f.generated.streamVideo(f.owner,job,response(),new AbortController().signal);
    expect(repeated.sha256).toBe(stored.sha256);
    expect(f.media.db.connection.prepare('SELECT COUNT(*) AS count FROM video_media_files').get()).toMatchObject({count:5});
    await expect(f.generated.content(randomUUID(),f.owner,stored.storageName)).rejects.toMatchObject({status:404});
    await expect(f.generated.validateVideo(stored.file,{...expected,durationSeconds:4})).rejects.toMatchObject({code:'VIDEO_OUTPUT_DURATION_MISMATCH'});
    await expect(f.generated.validateVideo(stored.file,{...expected,resolution:'1080p'})).rejects.toMatchObject({code:'VIDEO_OUTPUT_RESOLUTION_MISMATCH'});
    await expect(f.generated.validateVideo(stored.file,{...expected,audio:false})).rejects.toMatchObject({code:'VIDEO_OUTPUT_AUDIO_MISMATCH'});
  },30000);

  it('rejects forged, oversized or unsupported downloads and removes partial data on cancellation',async()=>{
    const f=await fixture({limit:80});
    await expect(f.generated.streamVideo(f.owner,randomUUID(),response('<html>private</html>','text/html'),new AbortController().signal)).rejects.toMatchObject({code:'UNSUPPORTED_VIDEO_TYPE'});
    await expect(f.generated.streamVideo(f.owner,randomUUID(),new Response(fakeMp4(),{headers:{'content-type':'video/mp4','content-length':'900'}}),new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_TOO_LARGE'});
    await expect(f.generated.streamVideo(f.owner,randomUUID(),response('<html>private</html>'),new AbortController().signal)).rejects.toMatchObject({code:'INVALID_VIDEO_FILE'});
    const chunks=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(fakeMp4());controller.enqueue(Buffer.alloc(100));controller.close();}});
    await expect(f.generated.streamVideo(f.owner,randomUUID(),new Response(chunks),new AbortController().signal)).rejects.toMatchObject({code:'VIDEO_TOO_LARGE'});
    const cancelled=new AbortController();cancelled.abort();
    await expect(f.generated.streamVideo(f.owner,randomUUID(),response(),cancelled.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(await readdir(f.generated.directory(f.owner))).toEqual([]);
    expect(f.media.db.connection.prepare('SELECT COUNT(*) AS count FROM video_media_reservations').get()).toMatchObject({count:0});
  });

  it('shares quota accounting with imported photos and active P2 import reservations',async()=>{
    const f=await fixture({quota:1024});
    f.media.db.connection.prepare('INSERT INTO assets(id,project_id,sha256,storage_name,bytes,selected,public_json) VALUES(?,?,?,?,?,1,?)').run(randomUUID(),f.owner,'synthetic',`${randomUUID()}.jpg`,600,'{}');
    f.media.db.connection.prepare('INSERT INTO storage_reservations(id,worker_id,bytes) VALUES(?,NULL,?)').run(randomUUID(),400);
    await expect(f.generated.streamVideo(f.owner,randomUUID(),new Response(fakeMp4(),{headers:{'content-length':'64'}}),new AbortController().signal)).rejects.toMatchObject({code:'STORAGE_QUOTA_EXCEEDED'});
    f.media.db.connection.prepare('DELETE FROM storage_reservations').run();
    await f.generated.streamVideo(f.owner,randomUUID(),response(),new AbortController().signal);
    expect(f.media.db.connection.prepare('SELECT SUM(bytes) AS bytes FROM video_media_files').get()).toMatchObject({bytes:64});
    await expect(f.generated.preflight(400)).rejects.toMatchObject({code:'STORAGE_QUOTA_EXCEEDED'});
  });
  it('stops a mid-stream download and cleans its partial file and reservation',async()=>{
    const f=await fixture();const controller=new AbortController();let cancelled=false;
    const stream=new ReadableStream<Uint8Array>({start(sink){sink.enqueue(fakeMp4());},cancel(){cancelled=true;}});
    const pending=f.generated.streamVideo(f.owner,randomUUID(),new Response(stream),controller.signal);
    const timer=setTimeout(()=>controller.abort(),20);
    try {await expect(pending).rejects.toMatchObject({name:'AbortError'});}finally {clearTimeout(timer);}
    expect(cancelled).toBe(true);expect(await readdir(f.generated.directory(f.owner))).toEqual([]);
    expect(f.media.db.connection.prepare('SELECT COUNT(*) AS count FROM video_media_reservations').get()).toMatchObject({count:0});
  });
  it('blocks downloads before disk reserve is exhausted',async()=>{
    const f=await fixture({freeReserve:Number.MAX_SAFE_INTEGER});
    await expect(f.generated.streamVideo(f.owner,randomUUID(),response(),new AbortController().signal)).rejects.toMatchObject({code:'DISK_SPACE_LOW'});
    expect(await readdir(f.generated.directory(f.owner))).toEqual([]);
  });

  it('keeps generated keyframes separate, private and idempotent while validating image bytes',async()=>{
    const f=await fixture();const job=randomUUID();
    const image=await sharp({create:{width:128,height:72,channels:3,background:'#729483'}}).png().toBuffer();
    const stored=await f.generated.saveKeyframe(f.owner,job,image,'image/png');
    expect(stored).toMatchObject({storageName:`${job}.keyframe.png`,mimeType:'image/png',width:128,height:72});
    const repeated=await f.generated.saveKeyframe(f.owner,job,image,'image/png');expect(repeated).toEqual(stored);
    await expect(f.generated.saveKeyframe(f.owner,randomUUID(),Buffer.from('<svg>'), 'image/svg+xml')).rejects.toMatchObject({code:'INVALID_KEYFRAME'});
    await expect(f.generated.saveKeyframe(f.owner,randomUUID(),image,'image/jpeg')).rejects.toMatchObject({code:'INVALID_KEYFRAME'});
    const content=await f.generated.content(f.owner,f.owner,stored.storageName);expect(await readFile(content.file)).toEqual(image);
    await expect(f.generated.content(randomUUID(),f.owner,stored.storageName)).rejects.toMatchObject({status:404});
    expect((await stat(stored.file)).mode&0o777).toBe(0o600);
  });

  it('recovers completed video/keyframe files after a crash before database checkpoint commit',async()=>{
    const f=await fixture();const job=randomUUID();await mkdir(f.generated.directory(f.owner),{recursive:true});
    await writeFile(f.generated.file(f.owner,`${job}.mp4`),fakeMp4(),{mode:0o600});
    const video=await f.generated.existingVideo(f.owner,job);expect(video?.bytes).toBe(64);
    const image=await sharp({create:{width:16,height:9,channels:3,background:'#729483'}}).jpeg().toBuffer();
    await writeFile(f.generated.file(f.owner,`${job}.keyframe.jpg`),image,{mode:0o600});
    expect(await f.generated.existingKeyframe(f.owner,job)).toMatchObject({width:16,height:9,mimeType:'image/jpeg'});
    expect(f.media.db.connection.prepare('SELECT COUNT(*) AS count FROM video_media_files').get()).toMatchObject({count:2});
    await writeFile(video!.file,Buffer.concat([fakeMp4(),Buffer.from('changed')]));
    await expect(f.generated.existingVideo(f.owner,job)).rejects.toMatchObject({code:'GENERATED_MEDIA_CHANGED'});
  });

  it('reports missing tools and decode failures without leaking command stderr or credentials',async()=>{
    const missing=await fixture({runner:async()=>{throw new Error('private-api-key and private media filename');}});
    const stored=await missing.generated.streamVideo(missing.owner,randomUUID(),response(),new AbortController().signal);
    expect(await missing.generated.detectTools()).toMatchObject({available:false});
    await expect(missing.generated.validateVideo(stored.file,expected)).rejects.toMatchObject({code:'VIDEO_TOOLS_UNAVAILABLE'});
    const runner:VideoCommandRunner=async(_binary,args)=>{
      if(args.includes('-version'))return {stdout:'version'};
      if(args.includes('-show_streams'))return {stdout:JSON.stringify({streams:[{codec_type:'video',codec_name:'h264',width:1280,height:720,avg_frame_rate:'24/1'},{codec_type:'audio',codec_name:'aac'}],format:{duration:'8',format_name:'mov,mp4'}})};
      throw new Error('private-api-key and private media filename');
    };
    const bad=await fixture({runner});const badFile=await bad.generated.streamVideo(bad.owner,randomUUID(),response(),new AbortController().signal);
    const error=await bad.generated.validateVideo(badFile.file,expected).catch(error=>error);
    expect(error.code).toBe('VIDEO_OUTPUT_UNREADABLE');expect(error.message).not.toMatch(/private-api-key|private media filename/);
  });

  it('rejects unreadable MP4 headers with real ffprobe and rejects path traversal before execution',async()=>{
    const f=await fixture();const stored=await f.generated.streamVideo(f.owner,randomUUID(),response(),new AbortController().signal);
    await expect(f.generated.validateVideo(stored.file,expected)).rejects.toMatchObject({code:'VIDEO_OUTPUT_UNREADABLE'});
    await expect(f.generated.validateVideo(path.join(f.root,'outside.mp4'),expected)).rejects.toMatchObject({status:404});
    expect(()=>f.generated.file(f.owner,'../../outside.mp4')).toThrow();
    await expect(f.generated.content(f.owner,f.owner,`${randomUUID()}.mp4`)).rejects.toMatchObject({status:404});
  });

  it('cleans only a fenced job’s abandoned reservations and staging files',async()=>{
    const f=await fixture();const job=randomUUID(),other=randomUUID();await mkdir(f.generated.directory(f.owner),{recursive:true});
    const stale=`${job}.${randomUUID()}.part`,retained=`${other}.${randomUUID()}.part`;
    await writeFile(path.join(f.generated.directory(f.owner),stale),'unfinished');await writeFile(path.join(f.generated.directory(f.owner),retained),'another job');
    f.media.db.connection.prepare('INSERT INTO video_media_reservations(id,project_id,storage_name,bytes,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),f.owner,`${job}.mp4`,10,Date.now());
    await f.generated.recoverJob(f.owner,job);
    expect(await readdir(f.generated.directory(f.owner))).toEqual([retained]);
    expect(f.media.db.connection.prepare('SELECT COUNT(*) AS count FROM video_media_reservations').get()).toMatchObject({count:0});
  });
});
