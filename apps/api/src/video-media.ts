import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm, statfs, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { z } from 'zod';
import { ApiError } from './errors.js';
import { MediaStore } from './media-store.js';

const uuid=z.string().uuid();
const safeName=z.string().regex(/^[a-f0-9-]{36}\.(mp4|keyframe\.(jpg|png|webp)|thumbnail\.jpg|frame-[123]\.jpg)$/i).refine(value=>uuid.safeParse(value.split('.')[0]).success);
const execute=promisify(execFile);
const require=createRequire(import.meta.url);
export type StoredVideoFile={storageName:string;file:string;bytes:number;sha256:string;mimeType:'video/mp4'};
export type StoredImageFile={storageName:string;file:string;bytes:number;sha256:string;mimeType:'image/jpeg'|'image/png'|'image/webp';width:number;height:number};
export type VideoInspection={durationSeconds:number;width:number;height:number;videoCodec:string;audioCodec?:string;hasAudio:boolean;frameRate?:number;container:string};
export type VideoExpectation={durationSeconds:number;resolution:'720p'|'1080p'|'4k'|'2160p';aspectRatio:'16:9'|'9:16';audio?:boolean};
export type VideoToolStatus={available:boolean;ffmpegAvailable:boolean;ffprobeAvailable:boolean;message?:string};
export type VideoCommandRunner=(binary:string,args:readonly string[],options:{timeoutMs:number;maxBuffer:number;signal?:AbortSignal})=>Promise<{stdout:string;stderr?:string}>;
export type VideoMediaOptions={ffmpegPath?:string;ffprobePath?:string;maxVideoBytes?:number;maxKeyframeBytes?:number;commandTimeoutMs?:number;runner?:VideoCommandRunner};
type FileRow={storage_name:string;bytes:number;sha256:string;mime_type:string;metadata_json:string};
const defaultRunner:VideoCommandRunner=async(binary,args,options)=>{
  const result=await execute(binary,[...args],{timeout:options.timeoutMs,maxBuffer:options.maxBuffer,signal:options.signal,killSignal:'SIGKILL',encoding:'utf8'});
  return {stdout:result.stdout,stderr:result.stderr};
};
function bundled(name:string,fallback:string):string {
  try {const candidate=require(name) as {path?:unknown};if(typeof candidate.path==='string'&&existsSync(candidate.path))return candidate.path;}catch{/* Optional platform binary may not be installed. */}
  return fallback;
}
function frameRate(value:unknown):number|undefined {
  if(typeof value!=='string'||!/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?$/.test(value))return;
  const [numerator,denominator='1']=value.split('/');const rate=Number(numerator)/Number(denominator);
  return Number.isFinite(rate)&&rate>0&&rate<=240?rate:undefined;
}
const probeSchema=z.object({
  streams:z.array(z.object({codec_type:z.string(),codec_name:z.string().optional(),width:z.number().optional(),height:z.number().optional(),duration:z.union([z.string(),z.number()]).optional(),avg_frame_rate:z.string().optional(),r_frame_rate:z.string().optional()}).passthrough()).max(32),
  format:z.object({duration:z.union([z.string(),z.number()]).optional(),format_name:z.string().optional()}).passthrough(),
}).passthrough();

/** Private, project-organized P4 files. No URL fetching or public media links. */
export class VideoMedia {
  readonly ffmpegPath:string;
  readonly ffprobePath:string;
  readonly maxVideoBytes:number;
  readonly maxKeyframeBytes:number;
  private readonly run:VideoCommandRunner;
  private readonly timeoutMs:number;
  private toolCheck?:Promise<VideoToolStatus>;
  constructor(readonly media:MediaStore,options:VideoMediaOptions={}) {
    this.ffmpegPath=options.ffmpegPath||bundled('@ffmpeg-installer/ffmpeg','ffmpeg');
    this.ffprobePath=options.ffprobePath||bundled('@ffprobe-installer/ffprobe','ffprobe');
    this.maxVideoBytes=options.maxVideoBytes??512*1024*1024;
    this.maxKeyframeBytes=options.maxKeyframeBytes??32*1024*1024;
    this.timeoutMs=options.commandTimeoutMs??90_000;
    this.run=options.runner??defaultRunner;
    this.media.db.connection.exec(`
      CREATE TABLE IF NOT EXISTS video_media_files(
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,storage_name TEXT NOT NULL,
        job_id TEXT NOT NULL,bytes INTEGER NOT NULL,sha256 TEXT NOT NULL,mime_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,PRIMARY KEY(project_id,storage_name)
      );
      CREATE TABLE IF NOT EXISTS video_media_reservations(
        id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        storage_name TEXT NOT NULL,bytes INTEGER NOT NULL,created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS video_media_active_write ON video_media_reservations(project_id,storage_name);
    `);
  }
  directory(projectId:string):string {return path.join(this.media.root,uuid.parse(projectId),'generated');}
  file(projectId:string,storageName:string):string {return path.join(this.directory(projectId),safeName.parse(storageName));}
  private async ensure(projectId:string):Promise<void> {
    await this.media.ensure(projectId);
    const directory=this.directory(projectId);await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
  }
  private thumbnailBytes(table:'photo_thumbnail_files'|'photo_thumbnail_reservations'):number {return this.media.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)?Number((this.media.db.connection.prepare(`SELECT COALESCE(SUM(bytes),0) bytes FROM ${table}`).get() as {bytes:number}).bytes):0;}
  private storedBytes():number {
    const originals=(this.media.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM assets').get() as {bytes:number}).bytes;
    const generated=(this.media.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM video_media_files').get() as {bytes:number}).bytes;
    const p5=this.media.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='movie_media_files'").get();
    return Number(originals)+Number(generated)+this.thumbnailBytes('photo_thumbnail_files')+(p5?Number((this.media.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) bytes FROM movie_media_files').get() as {bytes:number}).bytes):0);
  }
  private reservedBytes():number {
    const originals=(this.media.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM storage_reservations').get() as {bytes:number}).bytes;
    const generated=(this.media.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM video_media_reservations').get() as {bytes:number}).bytes;
    const p5=this.media.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='movie_media_reservations'").get();
    return Number(originals)+Number(generated)+this.thumbnailBytes('photo_thumbnail_reservations')+(p5?Number((this.media.db.connection.prepare('SELECT COALESCE(SUM(bytes),0) bytes FROM movie_media_reservations').get() as {bytes:number}).bytes):0);
  }
  async preflight(requiredBytes=1):Promise<void> {
    if(!Number.isSafeInteger(requiredBytes)||requiredBytes<0)throw new ApiError(400,'INVALID_STORAGE_SIZE','The expected media size is invalid.');
    if(this.storedBytes()+this.reservedBytes()+requiredBytes>this.media.storageQuotaBytes)throw new ApiError(507,'STORAGE_QUOTA_EXCEEDED','The private media storage quota is full. Free space or increase STORAGE_QUOTA_BYTES before continuing.');
    const disk=await statfs(this.media.root);
    if(Number(disk.bavail)*Number(disk.bsize)<this.media.minFreeDiskBytes+requiredBytes+this.reservedBytes())throw new ApiError(507,'DISK_SPACE_LOW','There is not enough free disk space for generated media. Free space before continuing.');
  }
  private reserve(projectId:string,storageName:string,bytes=0):string {
    return this.media.db.transaction(()=>{
      if(this.media.db.connection.prepare('SELECT 1 FROM video_media_reservations WHERE project_id=? AND storage_name=?').get(projectId,storageName))throw new ApiError(409,'MEDIA_WRITE_ACTIVE','Another worker is saving this generated asset. Resume its checkpoint instead of downloading it again.');
      if(this.storedBytes()+this.reservedBytes()+bytes>this.media.storageQuotaBytes)throw new ApiError(507,'STORAGE_QUOTA_EXCEEDED','The private media storage quota is full.');
      const id=randomUUID();this.media.db.connection.prepare('INSERT INTO video_media_reservations(id,project_id,storage_name,bytes,created_at) VALUES(?,?,?,?,?)').run(id,projectId,storageName,bytes,Date.now());return id;
    });
  }
  private resizeReservation(id:string,bytes:number):void {
    this.media.db.transaction(()=>{
      const row=this.media.db.connection.prepare('SELECT bytes FROM video_media_reservations WHERE id=?').get(id) as {bytes:number}|undefined;
      if(!row)throw new ApiError(409,'MEDIA_RESERVATION_LOST','The media download no longer owns its storage reservation.');
      if(this.storedBytes()+this.reservedBytes()-row.bytes+bytes>this.media.storageQuotaBytes)throw new ApiError(507,'STORAGE_QUOTA_EXCEEDED','The private media storage quota is full.');
      this.media.db.connection.prepare('UPDATE video_media_reservations SET bytes=? WHERE id=?').run(bytes,id);
    });
  }
  private async sync(file:string):Promise<void> {const handle=await open(file,'r+');try {await handle.sync();}finally {await handle.close();}}
  private commit(projectId:string,jobId:string,stored:StoredVideoFile|StoredImageFile,reservation:string,metadata:unknown={}):void {
    this.media.db.transaction(()=>{
      this.media.db.connection.prepare('INSERT INTO video_media_files(project_id,storage_name,job_id,bytes,sha256,mime_type,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,storage_name) DO UPDATE SET bytes=excluded.bytes,sha256=excluded.sha256,mime_type=excluded.mime_type,metadata_json=excluded.metadata_json').run(projectId,stored.storageName,jobId,stored.bytes,stored.sha256,stored.mimeType,JSON.stringify(metadata),Date.now());
      this.media.db.connection.prepare('DELETE FROM video_media_reservations WHERE id=?').run(reservation);
    });
  }
  private async hash(file:string):Promise<{sha256:string;bytes:number;head:Buffer}> {
    const hash=createHash('sha256');let bytes=0;let head=Buffer.alloc(0);
    for await(const chunk of createReadStream(file)) {const buffer=chunk as Buffer;bytes+=buffer.length;hash.update(buffer);if(head.length<32)head=Buffer.concat([head,buffer.subarray(0,32-head.length)]);}
    return {sha256:hash.digest('hex'),bytes,head};
  }
  private assertMp4(head:Buffer):void {if(head.length<12||head.subarray(4,8).toString('ascii')!=='ftyp')throw new ApiError(422,'INVALID_VIDEO_FILE','The generated download is not a supported MP4 file.');}
  private async localFile(file:string):Promise<void> {
    const relative=path.relative(this.media.root,path.resolve(file));const parts=relative.split(path.sep);
    if(parts.length!==3||parts[1]!=='generated'||!uuid.safeParse(parts[0]).success||!safeName.safeParse(parts[2]).success)throw new ApiError(404,'NOT_FOUND','Generated media not found.');
    try {const metadata=await lstat(file);if(!metadata.isFile()||metadata.isSymbolicLink())throw new Error();
      const actual=path.relative(await realpath(this.media.root),await realpath(file));
      if(actual!==relative)throw new Error();
    }catch {throw new ApiError(404,'NOT_FOUND','The generated media file is missing.');}
  }
  async content(ownerId:string,projectId:string,storageName:string):Promise<{file:string;bytes:number;mimeType:string}> {
    this.media.assertOwnership(ownerId,projectId);const file=this.file(projectId,storageName);
    const row=this.media.db.connection.prepare('SELECT bytes,mime_type FROM video_media_files WHERE project_id=? AND storage_name=?').get(projectId,storageName) as {bytes:number;mime_type:string}|undefined;
    if(!row)throw new ApiError(404,'NOT_FOUND','Generated media not found.');await this.localFile(file);return {file,bytes:row.bytes,mimeType:row.mime_type};
  }
  /** A deterministic completed filename is a recoverable checkpoint after a crash. */
  async existingVideo(projectId:string,jobId:string):Promise<StoredVideoFile|undefined> {
    uuid.parse(jobId);const storageName=`${jobId}.mp4`,file=this.file(projectId,storageName);
    try {await this.localFile(file);}catch(error){if(error instanceof ApiError&&error.status===404){this.media.db.connection.prepare('DELETE FROM video_media_files WHERE project_id=? AND storage_name=?').run(projectId,storageName);return;}throw error;}
    const digest=await this.hash(file);if(!digest.bytes||digest.bytes>this.maxVideoBytes)return;this.assertMp4(digest.head);
    const stored:StoredVideoFile={storageName,file,bytes:digest.bytes,sha256:digest.sha256,mimeType:'video/mp4'};
    const recorded=this.media.db.connection.prepare('SELECT sha256,bytes FROM video_media_files WHERE project_id=? AND storage_name=?').get(projectId,storageName) as {sha256:string;bytes:number}|undefined;
    if(recorded){if(recorded.sha256!==digest.sha256||recorded.bytes!==digest.bytes)throw new ApiError(422,'GENERATED_MEDIA_CHANGED','The saved generated video no longer matches its checkpoint. Restore or remove the changed local file before retrying.');return stored;}
    await this.preflight(digest.bytes);const reservation=this.reserve(projectId,storageName,digest.bytes);this.commit(projectId,jobId,stored,reservation);return stored;
  }
  async existingKeyframe(projectId:string,jobId:string):Promise<StoredImageFile|undefined> {
    uuid.parse(jobId);
    for(const [extension,mimeType] of [['jpg','image/jpeg'],['png','image/png'],['webp','image/webp']] as const) {
      const storageName=`${jobId}.keyframe.${extension}`,file=this.file(projectId,storageName);
      try {await this.localFile(file);}catch(error){if(error instanceof ApiError&&error.status===404){this.media.db.connection.prepare('DELETE FROM video_media_files WHERE project_id=? AND storage_name=?').run(projectId,storageName);continue;}throw error;}
      const digest=await this.hash(file);if(!digest.bytes||digest.bytes>this.maxKeyframeBytes)throw new ApiError(422,'INVALID_KEYFRAME','The saved keyframe exceeds its supported size.');
      let width:number,height:number;
      try {const image=sharp(file,{limitInputPixels:16_777_216,failOn:'error'});const metadata=await image.metadata();if(!metadata.width||!metadata.height||metadata.format!==extension.replace('jpg','jpeg'))throw new Error();await image.clone().resize(1,1).raw().toBuffer();width=metadata.width;height=metadata.height;}
      catch {throw new ApiError(422,'INVALID_KEYFRAME','The saved keyframe could not be decoded safely.');}
      const stored:StoredImageFile={storageName,file,bytes:digest.bytes,sha256:digest.sha256,mimeType,width,height};
      const recorded=this.media.db.connection.prepare('SELECT sha256,bytes FROM video_media_files WHERE project_id=? AND storage_name=?').get(projectId,storageName) as {sha256:string;bytes:number}|undefined;
      if(recorded){if(recorded.sha256!==digest.sha256||recorded.bytes!==digest.bytes)throw new ApiError(422,'GENERATED_MEDIA_CHANGED','The saved keyframe no longer matches its checkpoint.');return stored;}
      await this.preflight(digest.bytes);const reservation=this.reserve(projectId,storageName,digest.bytes);this.commit(projectId,jobId,stored,reservation,{width,height});return stored;
    }
    return;
  }
  async streamVideo(projectId:string,jobId:string,response:Response,signal:AbortSignal):Promise<StoredVideoFile> {
    uuid.parse(jobId);await this.ensure(projectId);
    const existing=await this.existingVideo(projectId,jobId);
    if(existing){await response.body?.cancel();return existing;}
    const storageName=`${jobId}.mp4`,file=this.file(projectId,storageName),temporary=path.join(this.directory(projectId),`${jobId}.${randomUUID()}.part`);
    if(!response.ok){await response.body?.cancel();throw new ApiError(502,'VIDEO_DOWNLOAD_FAILED','The provider could not download the generated video. Retry the download without submitting another generation request.');}
    const mime=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if(mime&&!['video/mp4','application/octet-stream'].includes(mime)){await response.body?.cancel();throw new ApiError(422,'UNSUPPORTED_VIDEO_TYPE','The generated download is not an MP4 video.');}
    const rawLength=response.headers.get('content-length');
    if(rawLength&&(!/^\d+$/.test(rawLength)||!Number.isSafeInteger(Number(rawLength))||Number(rawLength)>this.maxVideoBytes)){await response.body?.cancel();throw new ApiError(413,'VIDEO_TOO_LARGE','The generated video exceeds VIDEO_MAX_FILE_BYTES.');}
    if(!response.body)throw new ApiError(502,'EMPTY_VIDEO_DOWNLOAD','The provider returned an empty video download.');
    try {await this.preflight(rawLength?Number(rawLength):1);}catch(error){await response.body.cancel();throw error;}
    let reservation:string;
    try {reservation=this.reserve(projectId,storageName);}catch(error){await response.body.cancel();throw error;}
    let bytes=0;let head=Buffer.alloc(0);const hash=createHash('sha256');let completed=false;
    const measure=new Transform({transform:(chunk:Buffer,_encoding,callback)=>{
      try {bytes+=chunk.length;if(bytes>this.maxVideoBytes)throw new ApiError(413,'VIDEO_TOO_LARGE','The generated video exceeds VIDEO_MAX_FILE_BYTES.');this.resizeReservation(reservation,bytes);hash.update(chunk);if(head.length<32)head=Buffer.concat([head,chunk.subarray(0,32-head.length)]);
        void this.preflight(0).then(()=>callback(null,chunk),error=>callback(error as Error));
      }catch(error){callback(error as Error);}
    }});
    try {
      await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),measure,createWriteStream(temporary,{flags:'wx',mode:0o600}),{signal});
      signal.throwIfAborted();this.assertMp4(head);if(!bytes)throw new ApiError(422,'EMPTY_VIDEO_DOWNLOAD','The provider returned an empty video.');
      await this.sync(temporary);await rename(temporary,file);completed=true;
      const stored:StoredVideoFile={storageName,file,bytes,sha256:hash.digest('hex'),mimeType:'video/mp4'};this.commit(projectId,jobId,stored,reservation);return stored;
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOSPC')throw new ApiError(507,'DISK_SPACE_LOW','Disk space ran out while saving generated media.');throw error;}
    finally {this.media.db.connection.prepare('DELETE FROM video_media_reservations WHERE id=?').run(reservation);if(!completed)await rm(temporary,{force:true});}
  }
  /** Join validated adjacent generated segments locally; original pair outputs remain private history. */
  async joinSequence(projectId:string,jobId:string,parts:StoredVideoFile[],signal:AbortSignal):Promise<StoredVideoFile>{
    const existing=await this.existingVideo(projectId,jobId);if(existing)return existing;
    if(parts.length<2||parts.length>3)throw new ApiError(400,'VIDEO_SEQUENCE_INVALID','A chained clip needs two or three saved segments.');
    await this.ensure(projectId);await this.preflight(parts.reduce((sum,p)=>sum+p.bytes,0));
    const workspace=await mkdtemp(path.join(this.directory(projectId),'.sequence-'));
    try{
      const files=[];for(const part of parts){const owned=await this.content(projectId,projectId,part.storageName);files.push(owned.file);}
      const args=['-nostdin','-hide_banner','-loglevel','error','-y',...files.flatMap(file=>['-i',file])];
      const graph=files.map((_,i)=>`[${i}:v]setpts=PTS-STARTPTS,fps=30[v${i}];[${i}:a]asetpts=PTS-STARTPTS[a${i}]`).join(';')+';'+files.map((_,i)=>`[v${i}][a${i}]`).join('')+`concat=n=${files.length}:v=1:a=1[v][a]`;
      const output=path.join(workspace,'joined.mp4');
      await this.run(this.ffmpegPath,[...args,'-filter_complex_threads','1','-filter_complex',graph,'-map','[v]','-map','[a]','-c:v','libx264','-preset','veryfast','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',output],{timeoutMs:this.timeoutMs*3,maxBuffer:1024*1024,signal});
      const bytes=(await lstat(output)).size;if(bytes>this.maxVideoBytes)throw new ApiError(413,'VIDEO_TOO_LARGE','The joined sequence exceeds the private clip size limit.');
      return await this.streamVideo(projectId,jobId,new Response(Readable.toWeb(createReadStream(output)) as ReadableStream<Uint8Array>,{headers:{'content-type':'video/mp4','content-length':String(bytes)}}),signal);
    }finally{await rm(workspace,{recursive:true,force:true});}
  }
  async saveKeyframe(projectId:string,jobId:string,bytes:Uint8Array,mime:string):Promise<StoredImageFile> {
    uuid.parse(jobId);await this.ensure(projectId);
    const cached=await this.existingKeyframe(projectId,jobId);if(cached)return cached;
    const extension=mime==='image/jpeg'?'jpg':mime==='image/png'?'png':mime==='image/webp'?'webp':undefined;
    if(!extension||!bytes.byteLength||bytes.byteLength>this.maxKeyframeBytes)throw new ApiError(422,'INVALID_KEYFRAME','The provider returned an unsupported or oversized keyframe image.');
    let width:number,height:number;
    try {const image=sharp(bytes,{limitInputPixels:16_777_216,failOn:'error'});const metadata=await image.metadata();if(metadata.format!==extension.replace('jpg','jpeg')||!metadata.width||!metadata.height)throw new Error();await image.clone().resize(1,1).raw().toBuffer();width=metadata.width;height=metadata.height;}
    catch {throw new ApiError(422,'INVALID_KEYFRAME','The provider keyframe could not be decoded safely.');}
    const storageName=`${jobId}.keyframe.${extension}`,file=this.file(projectId,storageName),temporary=path.join(this.directory(projectId),`${jobId}.${randomUUID()}.part`);
    const existing=this.media.db.connection.prepare('SELECT * FROM video_media_files WHERE project_id=? AND storage_name=?').get(projectId,storageName) as FileRow|undefined;
    if(existing){await this.localFile(file);const metadata=JSON.parse(existing.metadata_json) as {width:number;height:number};return {storageName,file,bytes:existing.bytes,sha256:existing.sha256,mimeType:existing.mime_type as StoredImageFile['mimeType'],...metadata};}
    await this.preflight(bytes.byteLength);const reservation=this.reserve(projectId,storageName,bytes.byteLength);
    try {await writeFile(temporary,bytes,{flag:'wx',mode:0o600});await this.sync(temporary);await rename(temporary,file);const stored:StoredImageFile={storageName,file,bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex'),mimeType:mime as StoredImageFile['mimeType'],width,height};this.commit(projectId,jobId,stored,reservation,{width,height});return stored;}
    finally {this.media.db.connection.prepare('DELETE FROM video_media_reservations WHERE id=?').run(reservation);await rm(temporary,{force:true});}
  }
  async detectTools():Promise<VideoToolStatus> {
    if(!this.toolCheck)this.toolCheck=(async()=>{
      const outcomes=await Promise.allSettled([this.run(this.ffmpegPath,['-version'],{timeoutMs:10_000,maxBuffer:64*1024}),this.run(this.ffprobePath,['-version'],{timeoutMs:10_000,maxBuffer:64*1024})]);
      const ffmpegAvailable=outcomes[0].status==='fulfilled',ffprobeAvailable=outcomes[1].status==='fulfilled',available=ffmpegAvailable&&ffprobeAvailable;
      return {available,ffmpegAvailable,ffprobeAvailable,...(!available?{message:'Install FFmpeg/ffprobe or configure FFMPEG_PATH and FFPROBE_PATH before generating videos.'}:{})};
    })();return this.toolCheck;
  }
  private async requireTools():Promise<void> {if(!(await this.detectTools()).available)throw new ApiError(503,'VIDEO_TOOLS_UNAVAILABLE','FFmpeg and ffprobe are required to validate generated videos. Install the tools or configure their executable paths.');}
  async validateVideo(file:string,expected:VideoExpectation,signal?:AbortSignal):Promise<VideoInspection> {
    await this.localFile(file);await this.requireTools();
    let parsed:z.infer<typeof probeSchema>;
    try {const result=await this.run(this.ffprobePath,['-v','error','-show_format','-show_streams','-of','json',file],{timeoutMs:this.timeoutMs,maxBuffer:2*1024*1024,signal});parsed=probeSchema.parse(JSON.parse(result.stdout));}
    catch(error){if(signal?.aborted)throw error;throw new ApiError(422,'VIDEO_OUTPUT_UNREADABLE','ffprobe could not read the generated video. The output has been retained for diagnosis.');}
    const video=parsed.streams.find(stream=>stream.codec_type==='video'),audio=parsed.streams.find(stream=>stream.codec_type==='audio');
    const durationSeconds=Number(parsed.format.duration??video?.duration),width=video?.width,height=video?.height,videoCodec=video?.codec_name;
    if(!video||!videoCodec||!width||!height||!Number.isFinite(durationSeconds)||durationSeconds<=0)throw new ApiError(422,'VIDEO_OUTPUT_INVALID','The generated file does not contain a readable video stream with valid duration and dimensions.');
    if(!['h264','hevc','av1','vp9'].includes(videoCodec))throw new ApiError(422,'VIDEO_OUTPUT_CODEC_UNSUPPORTED','The generated video uses an unsupported video codec.');
    const container=parsed.format.format_name??'';if(!container.split(',').some(name=>['mov','mp4'].includes(name)))throw new ApiError(422,'VIDEO_OUTPUT_CONTAINER_UNSUPPORTED','The generated file is not a readable MP4 container.');
    const edge=expected.resolution==='720p'?720:expected.resolution==='1080p'?1080:2160;
    const landscape=expected.aspectRatio==='16:9',expectedWidth=landscape?edge*16/9:edge,expectedHeight=landscape?edge:edge*16/9;
    if(!Number.isInteger(expected.durationSeconds)||expected.durationSeconds<=0||!['720p','1080p','4k','2160p'].includes(expected.resolution)||!['16:9','9:16'].includes(expected.aspectRatio))throw new ApiError(400,'INVALID_VIDEO_EXPECTATION','The requested video settings are invalid.');
    if(Math.abs(durationSeconds-expected.durationSeconds)>0.6)throw new ApiError(422,'VIDEO_OUTPUT_DURATION_MISMATCH','The generated video duration does not match the requested clip duration.');
    if(width!==Math.round(expectedWidth)||height!==Math.round(expectedHeight))throw new ApiError(422,'VIDEO_OUTPUT_RESOLUTION_MISMATCH','The generated video resolution or aspect ratio does not match the requested settings.');
    if(expected.audio!==undefined&&Boolean(audio)!==expected.audio)throw new ApiError(422,'VIDEO_OUTPUT_AUDIO_MISMATCH',expected.audio?'The generated video is missing the requested audio track.':'The generated video contains audio even though a silent clip was requested.');
    if(audio&&!audio.codec_name)throw new ApiError(422,'VIDEO_OUTPUT_AUDIO_INVALID','The generated audio track has no readable codec.');
    // Decode every frame/sample, rather than accepting a valid header on a truncated file.
    try {await this.run(this.ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-xerror','-i',file,'-map','0:v:0','-map','0:a?','-f','null','-'],{timeoutMs:this.timeoutMs,maxBuffer:2*1024*1024,signal});}
    catch(error){if(signal?.aborted)throw error;throw new ApiError(422,'VIDEO_OUTPUT_UNREADABLE','The generated video failed a complete decode check. It has not been approved.');}
    return {durationSeconds,width,height,videoCodec,...(audio?.codec_name?{audioCodec:audio.codec_name}:{}),hasAudio:Boolean(audio),frameRate:frameRate(video.avg_frame_rate??video.r_frame_rate),container};
  }
  private async preview(projectId:string,jobId:string,file:string,storageName:string,seconds:number,signal?:AbortSignal):Promise<string> {
    const existing=this.media.db.connection.prepare('SELECT 1 FROM video_media_files WHERE project_id=? AND storage_name=?').get(projectId,storageName);
    const target=this.file(projectId,storageName);if(existing){await this.localFile(target);return storageName;}
    await this.preflight(2*1024*1024);const reservation=this.reserve(projectId,storageName,2*1024*1024),temporary=path.join(this.directory(projectId),`${jobId}.${randomUUID()}.part`);
    try {
      await this.run(this.ffmpegPath,['-nostdin','-hide_banner','-loglevel','error','-ss',seconds.toFixed(3),'-i',file,'-frames:v','1','-vf','scale=640:640:force_original_aspect_ratio=decrease','-q:v','3','-f','image2','-vcodec','mjpeg','-update','1',temporary],{timeoutMs:this.timeoutMs,maxBuffer:2*1024*1024,signal});
      const digest=await this.hash(temporary);if(!digest.bytes||digest.bytes>2*1024*1024||digest.head[0]!==0xff||digest.head[1]!==0xd8)throw new ApiError(422,'VIDEO_PREVIEW_FAILED','A preview image could not be extracted from the generated video.');
      this.resizeReservation(reservation,digest.bytes);await chmod(temporary,0o600);await this.sync(temporary);await rename(temporary,target);
      const metadata=await sharp(target).metadata();const stored:StoredImageFile={storageName,file:target,bytes:digest.bytes,sha256:digest.sha256,mimeType:'image/jpeg',width:metadata.width??0,height:metadata.height??0};this.commit(projectId,jobId,stored,reservation,{width:stored.width,height:stored.height});return storageName;
    }catch(error){if(signal?.aborted)throw error;if(error instanceof ApiError)throw error;throw new ApiError(422,'VIDEO_PREVIEW_FAILED','Preview frames could not be extracted from the generated video.');}
    finally {this.media.db.connection.prepare('DELETE FROM video_media_reservations WHERE id=?').run(reservation);await rm(temporary,{force:true});}
  }
  async createPreviews(projectId:string,jobId:string,file:string,inspection:VideoInspection,signal?:AbortSignal):Promise<{thumbnailStorageName:string;frameStorageNames:string[]}> {
    uuid.parse(jobId);await this.ensure(projectId);await this.localFile(file);await this.requireTools();
    const frameStorageNames:string[]=[];
    for(const [index,fraction] of [0.1,0.5,0.9].entries())frameStorageNames.push(await this.preview(projectId,jobId,file,`${jobId}.frame-${index+1}.jpg`,Math.min(inspection.durationSeconds-0.01,inspection.durationSeconds*fraction),signal));
    const thumbnailStorageName=await this.preview(projectId,jobId,file,`${jobId}.thumbnail.jpg`,inspection.durationSeconds*0.5,signal);
    return {thumbnailStorageName,frameStorageNames};
  }
  /** Only the queue may discard known abandoned staging reservations after lease recovery. */
  async recoverJob(projectId:string,jobId:string):Promise<void> {
    uuid.parse(jobId);await this.ensure(projectId);
    const rows=this.media.db.connection.prepare('SELECT id,storage_name FROM video_media_reservations WHERE project_id=?').all(projectId) as {id:string;storage_name:string}[];
    for(const row of rows)if(row.storage_name.startsWith(`${jobId}.`))this.media.db.connection.prepare('DELETE FROM video_media_reservations WHERE id=?').run(row.id);
    for(const name of await readdir(this.directory(projectId)))if(name.startsWith(`${jobId}.`)&&/^[a-f0-9-]{36}\.[a-f0-9-]{36}\.part$/i.test(name))await rm(path.join(this.directory(projectId),name),{force:true});
  }
}
