import {Router,type Request,type Response,type RequestHandler} from 'express';
import type session from 'express-session';
import {z} from 'zod';
import {productionQuoteInputSchema,productionCreateRunSchema,productionApproveSchema,productionSceneReviewSchema} from '@memories/shared';
import type {ProductionStore} from './production-store.js';
import type {ProductionQueue} from './production-queue.js';
const uuid=z.string().uuid();
type WorkspaceRequest=Request&{session:session.Session&session.SessionData&{workspaceId:string}};
const wrap=(fn:(req:WorkspaceRequest,res:Response)=>Promise<unknown>):RequestHandler=>(req,res,next)=>{void fn(req as WorkspaceRequest,res).catch(next);};
export function createProductionRouter(store:ProductionStore,queue:ProductionQueue){const router=Router();
 router.get('/',wrap(async(req,res)=>res.json(await store.state(req.session.workspaceId))));
 router.post('/quotes',wrap(async(req,res)=>{const {config}=productionQuoteInputSchema.parse(req.body);res.status(201).json(await store.quote(req.session.workspaceId,config));}));
 router.post('/runs',wrap(async(req,res)=>res.status(202).json(await store.create(req.session.workspaceId,productionCreateRunSchema.parse(req.body)))));
 router.get('/runs/:id',wrap(async(req,res)=>res.json(store.run(req.session.workspaceId,uuid.parse(req.params.id)))));
 router.post('/runs/:id/approve',wrap(async(req,res)=>{const run=await store.approve(req.session.workspaceId,uuid.parse(req.params.id),productionApproveSchema.parse(req.body));queue.wake();res.status(202).json(run);}));
 for(const action of ['pause','resume','cancel','retry'] as const)router.post(`/runs/:id/${action}`,wrap(async(req,res)=>{z.object({}).strict().parse(req.body);res.json(await queue[action](req.session.workspaceId,uuid.parse(req.params.id)));}));
 router.post('/runs/:id/scenes/:sceneId/review',wrap(async(req,res)=>{const body=productionSceneReviewSchema.parse(req.body);res.json(await queue.reviewScene(req.session.workspaceId,uuid.parse(req.params.id),uuid.parse(req.params.sceneId),body.decision,body.notes));}));
 return router;
}
