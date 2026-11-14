import {Router,type Request,type Response,type RequestHandler} from 'express';
import type session from 'express-session';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {movieCreateJobSchema,movieSettingsInputSchema} from '@memories/shared';
import {MovieStore} from './movie-store.js';
import {MovieRenderQueue} from './movie-queue.js';
import {ApiError} from './errors.js';
const uuid=z.string().uuid();
type WorkspaceRequest=Request&{session:session.Session&session.SessionData&{workspaceId:string}};
const wrap=(handler:(req:WorkspaceRequest,res:Response)=>Promise<unknown>):RequestHandler=>(req,res,next)=>{void handler(req as WorkspaceRequest,res).catch(next);};
/** All routes inherit workspace authentication, Origin/CSRF checks and no-store. */
export function createMovieRouter(store:MovieStore,queue:MovieRenderQueue){const router=Router();
 router.get('/',wrap(async(req,res)=>res.json(await store.state(req.session.workspaceId,req.query.storyboardId===undefined?undefined:uuid.parse(req.query.storyboardId)))));
 router.patch('/settings',wrap(async(req,res)=>{const {settings}=movieSettingsInputSchema.parse(req.body);res.json(await store.saveSettings(req.session.workspaceId,settings));}));
 router.post('/jobs',wrap(async(req,res)=>{const job=await store.create(req.session.workspaceId,movieCreateJobSchema.parse(req.body));queue.wake();res.status(202).json(job);}));
 router.get('/jobs/:id',wrap(async(req,res)=>res.json(store.job(req.session.workspaceId,uuid.parse(req.params.id)))));
 router.post('/jobs/:id/cancel',wrap(async(req,res)=>{z.object({}).strict().parse(req.body);res.json(await queue.cancel(req.session.workspaceId,uuid.parse(req.params.id)));}));
 router.post('/jobs/:id/retry',wrap(async(req,res)=>{z.object({}).strict().parse(req.body);res.status(202).json(await queue.retry(req.session.workspaceId,uuid.parse(req.params.id)));}));
 const send=async(req:WorkspaceRequest,res:Response,name:string,download=false)=>{const file=await store.files.content(req.session.workspaceId,name);res.type(file.mimeType).set({'Content-Disposition':`${download?'attachment':'inline'}; filename="${name}"`,'Cross-Origin-Resource-Policy':'same-origin','Accept-Ranges':'bytes'}).sendFile(file.file,{dotfiles:'deny'},error=>{if(error&&!res.headersSent)res.status(404).json({error:{code:'MOVIE_FILE_NOT_FOUND',message:'The private movie media file is missing.'}});});};
 router.get('/assets/:id/content',wrap(async(req,res)=>{const asset=store.assetRow(req.session.workspaceId,uuid.parse(req.params.id));if(req.query.download!==undefined&&req.query.download!=='1')throw new ApiError(400,'INVALID_DOWNLOAD','Use the movie download link.');await send(req,res,asset.storage_name,req.query.download==='1');}));
 router.get('/assets/:id/thumbnail',wrap(async(req,res)=>{const asset=store.assetRow(req.session.workspaceId,uuid.parse(req.params.id));if(!asset.thumbnail_name)throw new ApiError(404,'MOVIE_THUMBNAIL_NOT_FOUND','Movie thumbnail not available.');await send(req,res,asset.thumbnail_name);}));
 router.get('/timelines/:id',wrap(async(req,res)=>res.json(store.timeline(req.session.workspaceId,uuid.parse(req.params.id)))));
 router.get('/soundtracks/:id/content',wrap(async(req,res)=>{await send(req,res,store.soundtrackRow(req.session.workspaceId,uuid.parse(req.params.id)).storage_name);}));
 router.delete('/soundtracks/:id',wrap(async(req,res)=>{await store.removeSoundtrack(req.session.workspaceId,uuid.parse(req.params.id));res.sendStatus(204);}));
 router.post('/soundtracks',wrap(async(req,res)=>{
  if(req.get('X-License-Confirmed')!=='true')throw new ApiError(400,'SOUNDTRACK_LICENSE_REQUIRED','Confirm that you own or have a license to use this soundtrack.');
  const instrumental=req.get('X-Instrumental')==='true';if(!['true','false'].includes(req.get('X-Instrumental')??''))throw new ApiError(400,'INVALID_SOUNDTRACK_METADATA','Declare whether your licensed track is instrumental.');
  let name:string;try{name=decodeURIComponent(req.get('X-Upload-Name')??'');}catch{throw new ApiError(400,'INVALID_SOUNDTRACK_NAME','The soundtrack name is invalid.');}name=z.string().trim().min(1).max(200).refine(value=>!/[\x00-\x1f\x7f]/.test(value)).parse(name);
  const mime=req.get('Content-Type')?.split(';')[0].trim()??'',limit=store.config.movieMaxSoundtrackBytes??100*1024**2;const length=req.get('Content-Length');if(length&&(!/^\d+$/.test(length)||Number(length)>limit))throw new ApiError(413,'SOUNDTRACK_TOO_LARGE','The soundtrack exceeds MOVIE_MAX_SOUNDTRACK_BYTES.');
  await store.ensure(req.session.workspaceId);const controller=new AbortController(),aborted=()=>controller.abort();req.once('aborted',aborted);let saved:string|undefined;
  try{const file=await store.files.upload(req.session.workspaceId,req,mime,controller.signal);saved=file.storageName;const probe=await store.renderer.probeSoundtrack(file.file,controller.signal);const analysis=await store.renderer.analyzeSoundtrack(file.file,controller.signal);const id=randomUUID();store.db.transaction(()=>{store.db.connection.prepare('INSERT INTO movie_soundtracks(id,project_id,storage_name,name,mime_type,bytes,sha256,duration_seconds,instrumental,licensed,onsets_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,1,?,?)').run(id,req.session.workspaceId,file.storageName,name,file.mimeType,file.bytes,file.sha256,probe.durationSeconds,instrumental?1:0,JSON.stringify(analysis.onsets.slice(0,4000)),new Date().toISOString());
   const settings=store.settings(req.session.workspaceId);if(!settings.soundtrackId)store.db.connection.prepare('UPDATE movie_render_settings SET settings_json=?,updated_at=? WHERE project_id=?').run(JSON.stringify({...settings,soundtrackId:id}),new Date().toISOString(),req.session.workspaceId);});saved=undefined;res.status(201).json(store.soundtracks(req.session.workspaceId).find(track=>track.id===id));
  }finally{req.off('aborted',aborted);if(saved)await store.files.remove(req.session.workspaceId,saved).catch(()=>{});}
 }));return router;
}
