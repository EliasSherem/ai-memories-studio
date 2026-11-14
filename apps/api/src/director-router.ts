import {MIN_MOVIE_DURATION_SECONDS,MAX_MOVIE_DURATION_SECONDS} from '@memories/shared';
import { Router, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import type session from 'express-session';
import { z } from 'zod';
import { protagonistIdSchema, protagonistInputSchema, storyboardContentSchema, storyboardRequestSchema, type DirectorState } from '@memories/shared';
import type { Config } from './config.js';
import type { DirectorStore } from './director-store.js';
import type { AnalysisQueue } from './analysis-queue.js';
import type { StoryboardDirector } from './storyboard.js';
import { ApiError } from './errors.js';

const pageSchema=z.object({limit:z.coerce.number().int().min(1).max(200).default(100),afterId:z.string().uuid().optional(),analyzedOnly:z.enum(['true','false']).default('false').transform(value=>value==='true')});
type WorkspaceRequest=Request & {session:session.Session & session.SessionData & {workspaceId:string}};
const wrap=(handler:(req:WorkspaceRequest,res:Response,next:NextFunction)=>Promise<unknown>):RequestHandler => (req,res,next)=>{void handler(req as WorkspaceRequest,res,next).catch(next);};

/** Mounted after workspace authentication and the existing Origin/CSRF guard. */
export function createDirectorRouter(config:Config,store:DirectorStore,analysis:AnalysisQueue,director:StoryboardDirector,configured=Boolean(config.geminiApiKey)) {
  const router=Router();
  router.use(wrap(async(req,_res,next)=>{await store.ensure(req.session.workspaceId);next();}));
  router.get('/',wrap(async(req,res)=>{
    const owner=req.session.workspaceId;
    const total=(store.db.connection.prepare('SELECT COUNT(*) AS count FROM assets WHERE project_id=?').get(owner) as {count:number}).count;
    const analyzed=(store.db.connection.prepare('SELECT COUNT(*) AS count FROM p3_photo_analysis r JOIN assets a ON a.id=r.asset_id WHERE a.project_id=? AND r.sha256=a.sha256 AND r.model=? AND r.pipeline_version=?').get(owner,config.geminiModel??'gemini-3.5-flash-lite',config.analysisPipelineVersion??'photo-v1') as {count:number}).count;
    const duplicateCandidates=(store.db.connection.prepare('SELECT COUNT(*) AS count FROM p3_local_features WHERE project_id=? AND duplicate_of IS NOT NULL').get(owner) as {count:number}).count;
    const state:DirectorState={configured,model:config.geminiModel??'gemini-3.5-flash-lite',pipelineVersion:config.analysisPipelineVersion??'photo-v1',totalImported:total,analyzed,pending:Math.max(0,total-analyzed),duplicateCandidates,run:analysis.latest(owner),usage:store.usage(owner),protagonists:store.protagonists(owner),storyboard:director.get(owner)};
    res.json(state);
  }));
  router.get('/photos',wrap(async(req,res)=>{
    const {limit,afterId,analyzedOnly}=pageSchema.parse(req.query);
    const photos=store.rows(req.session.workspaceId,limit,afterId,analyzedOnly);
    res.json({photos,...(photos.length===limit?{nextCursor:photos[photos.length-1].asset.id}:{})});
  }));
  router.get('/protagonists',wrap(async(req,res)=>{res.json({protagonists:store.protagonists(req.session.workspaceId)});}));
  router.put('/protagonists/:id',wrap(async(req,res)=>{res.json(await store.saveProtagonist(req.session.workspaceId,protagonistIdSchema.parse(req.params.id),protagonistInputSchema.parse(req.body)));}));
  router.patch('/photos/:assetId',wrap(async(req,res)=>{res.json(await store.setCuration(req.session.workspaceId,z.string().uuid().parse(req.params.assetId),req.body));}));
  const requireGemini=()=>{if(!configured) throw new ApiError(503,'GEMINI_NOT_CONFIGURED','Set GEMINI_API_KEY in the server environment to enable AI analysis and storyboard creation.');};
  router.post('/analysis',wrap(async(req,res)=>{requireGemini();z.object({}).strict().parse(req.body);res.status(202).json(await analysis.start(req.session.workspaceId));}));
  router.post('/analysis/:id/cancel',wrap(async(req,res)=>{res.json(analysis.cancel(req.session.workspaceId,z.string().uuid().parse(req.params.id)));}));
  router.post('/analysis/:id/resume',wrap(async(req,res)=>{requireGemini();res.status(202).json(analysis.resume(req.session.workspaceId,z.string().uuid().parse(req.params.id)));}));
  router.post('/analysis/:id/retry',wrap(async(req,res)=>{requireGemini();res.status(202).json(analysis.retryFailed(req.session.workspaceId,z.string().uuid().parse(req.params.id)));}));
  router.get('/curation',wrap(async(req,res)=>{const duration=z.coerce.number().int().min(MIN_MOVIE_DURATION_SECONDS).max(MAX_MOVIE_DURATION_SECONDS).default(150).parse(req.query.durationSeconds);res.json(await director.curate(req.session.workspaceId,duration));}));
  router.post('/storyboards',wrap(async(req,res)=>{requireGemini();res.status(201).json(await director.generate(req.session.workspaceId,storyboardRequestSchema.parse(req.body)));}));
  router.put('/storyboards/:id',wrap(async(req,res)=>{
    const owner=req.session.workspaceId;
    if(!store.getStoryboard(owner,z.string().uuid().parse(req.params.id))) throw new ApiError(404,'NOT_FOUND','Storyboard not found.');
    res.json(await director.save(owner,storyboardContentSchema.parse(req.body),store.storyboardPolicy(owner,z.string().uuid().parse(req.params.id))));
  }));
  router.get('/storyboards/:id/export',wrap(async(req,res)=>{
    const board=director.get(req.session.workspaceId,z.string().uuid().parse(req.params.id));
    if(!board) throw new ApiError(404,'NOT_FOUND','Storyboard not found.');
    res.set('Content-Disposition',`attachment; filename="storyboard-v${board.version}.json"`).json(board);
  }));
  return router;
}
