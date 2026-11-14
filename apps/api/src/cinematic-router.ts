import {Router,type Request,type Response,type NextFunction,type RequestHandler} from 'express';
import type session from 'express-session';
import {z} from 'zod';
import {sequenceSplitSchema} from '@memories/shared';
import type {CinematicStore} from './cinematic-store.js';
type WorkspaceRequest=Request & {session:session.Session & session.SessionData & {workspaceId:string}};
const wrap=(handler:(req:WorkspaceRequest,res:Response,next:NextFunction)=>Promise<unknown>):RequestHandler=>(req,res,next)=>{void handler(req as WorkspaceRequest,res,next).catch(next);};
/** Mount behind the existing workspace authentication, Origin and CSRF guards. */
export function createCinematicRouter(store:CinematicStore){const router=Router();router.use(wrap(async(req,_res,next)=>{await store.director.ensure(req.session.workspaceId);next();}));router.get('/',wrap(async(req,res)=>res.json(store.state(req.session.workspaceId))));router.post('/sequences/detect',wrap(async(req,res)=>{z.object({}).strict().parse(req.body);res.json(await store.detect(req.session.workspaceId));}));router.patch('/sequences/:id',wrap(async(req,res)=>res.json(await store.edit(req.session.workspaceId,z.string().uuid().parse(req.params.id),req.body))));router.post('/sequences/merge',wrap(async(req,res)=>res.json(await store.merge(req.session.workspaceId,req.body))));router.post('/sequences/:id/split',wrap(async(req,res)=>res.json(await store.split(req.session.workspaceId,z.string().uuid().parse(req.params.id),sequenceSplitSchema.parse(req.body).atIndex))));router.put('/preferences',wrap(async(req,res)=>res.json(await store.savePreferences(req.session.workspaceId,req.body))));return router;}
