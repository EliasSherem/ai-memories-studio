import {Router,type Request,type Response,type NextFunction,type RequestHandler} from 'express';
import type session from 'express-session';
import {z} from 'zod';
import {videoCreateJobSchema,videoBudgetInputSchema,videoReviewInputSchema} from '@memories/shared';
import type {VideoStore} from './video-store.js';
import type {VideoGenerationQueue} from './video-queue.js';
import {ApiError} from './errors.js';
const uuid=z.string().uuid();
type WorkspaceRequest=Request&{session:session.Session&session.SessionData&{workspaceId:string}};
const wrap=(fn:(req:WorkspaceRequest,res:Response,next:NextFunction)=>Promise<unknown>):RequestHandler=>(req,res,next)=>{void fn(req as WorkspaceRequest,res,next).catch(next);};
export function createVideoRouter(store:VideoStore,queue:VideoGenerationQueue){
 const router=Router();
 router.get('/',wrap(async(req,res)=>{res.json(await store.state(req.session.workspaceId,req.query.storyboardId===undefined?undefined:uuid.parse(req.query.storyboardId)));}));
 router.post('/quotes',wrap(async(req,res)=>{res.status(201).json(await store.quote(req.session.workspaceId,req.body));}));
 router.post('/jobs',wrap(async(req,res)=>{const body=videoCreateJobSchema.parse(req.body);const job=await store.create(req.session.workspaceId,body);queue.wake();res.status(202).json(job);}));
 router.get('/jobs/:id',wrap(async(req,res)=>{res.json(store.job(req.session.workspaceId,uuid.parse(req.params.id)));}));
 router.post('/jobs/:id/cancel',wrap(async(req,res)=>{z.object({}).strict().parse(req.body);res.json(await queue.cancel(req.session.workspaceId,uuid.parse(req.params.id)));}));
 router.post('/jobs/:id/resume',wrap(async(req,res)=>{z.object({}).strict().parse(req.body);res.status(202).json(await queue.resume(req.session.workspaceId,uuid.parse(req.params.id)));}));
 router.get('/assets',wrap(async(req,res)=>{await store.ensure(req.session.workspaceId);res.json({assets:store.assets(req.session.workspaceId,req.query.storyboardId===undefined?undefined:uuid.parse(req.query.storyboardId))});}));
 router.post('/assets/:id/review',wrap(async(req,res)=>{const body=videoReviewInputSchema.parse(req.body);res.json(await store.review(req.session.workspaceId,uuid.parse(req.params.id),body.decision,body.notes));}));
 router.get('/budget',wrap(async(req,res)=>{await store.ensure(req.session.workspaceId);res.json(store.budget(req.session.workspaceId));}));
 router.patch('/budget',wrap(async(req,res)=>{const body=videoBudgetInputSchema.parse(req.body);res.json(await store.setBudget(req.session.workspaceId,body.maximumSpendUsd));}));
 const send=async(req:WorkspaceRequest,res:Response,storageName:string)=>{const {file,mimeType}=await store.media.content(req.session.workspaceId,req.session.workspaceId,storageName);res.type(mimeType).set({'Content-Disposition':'inline','Cross-Origin-Resource-Policy':'same-origin','Accept-Ranges':'bytes'}).sendFile(file,{dotfiles:'deny'},error=>{if(error&&!res.headersSent)res.status(404).json({error:{code:'VIDEO_FILE_NOT_FOUND',message:'The private generated media file is missing.'}});});};
 router.get('/assets/:id/content',wrap(async(req,res)=>{const asset=store.assetRow(req.session.workspaceId,uuid.parse(req.params.id));await send(req,res,asset.storage_name);}));
 router.get('/assets/:id/thumbnail',wrap(async(req,res)=>{const asset=store.assetRow(req.session.workspaceId,uuid.parse(req.params.id));if(!asset.thumbnail_name)throw new ApiError(404,'THUMBNAIL_NOT_FOUND','No preview thumbnail is available.');await send(req,res,asset.thumbnail_name);}));
 router.get('/assets/:id/frames/:index',wrap(async(req,res)=>{const index=z.coerce.number().int().min(1).max(3).parse(req.params.index);const asset=store.assetRow(req.session.workspaceId,uuid.parse(req.params.id));const frames=JSON.parse(asset.frames_json) as string[];if(!frames[index-1])throw new ApiError(404,'FRAME_NOT_FOUND','Representative frame not found.');await send(req,res,frames[index-1]);}));
 router.get('/keyframes/:id/content',wrap(async(req,res)=>{const row=store.db.connection.prepare('SELECT storage_name FROM generated_keyframes WHERE project_id=? AND id=?').get(req.session.workspaceId,uuid.parse(req.params.id)) as {storage_name:string}|undefined;if(!row)throw new ApiError(404,'KEYFRAME_NOT_FOUND','Private keyframe not found.');await send(req,res,row.storage_name);}));
 return router;
}
