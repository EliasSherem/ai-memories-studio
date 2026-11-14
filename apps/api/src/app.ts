import {sequenceReasoningContext} from './photo-sequence-analyzer.js';
import {PhotoThumbnails} from './photo-thumbnails.js';
import {CinematicStore} from './cinematic-store.js';
import {createCinematicRouter} from './cinematic-router.js';
import express, { type RequestHandler, type ErrorRequestHandler } from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ZodError } from 'zod';
import { bulkSelectionSchema, contributorIdSchema, createPickerSchema, selectionSchema, contributors, type JsonGenerator } from '@memories/shared';
import type { Config } from './config.js';
import { ApiError } from './errors.js';
import { bindCredentialPersistence, EncryptedSessionStore, ensureSession, loadStoredSession, saveSession } from './session-store.js';
import { GoogleClient } from './google.js';
import { createAuthRouter } from './auth.js';
import { MediaStore } from './media-store.js';
import { PickerManager, type PickerGoogle } from './picker-manager.js';
import { DirectorStore } from './director-store.js';
import { GeminiClient } from './gemini.js';
import { AnalysisQueue } from './analysis-queue.js';
import { StoryboardDirector } from './storyboard.js';
import { createDirectorRouter } from './director-router.js';
import { VideoMedia } from './video-media.js';
import { VideoStore } from './video-store.js';
import { VideoGenerationQueue } from './video-queue.js';
import { OmniFlashProvider } from './omni-provider.js';
import { VeoProvider } from './veo-provider.js';
import { GeminiKeyframeProvider } from './video-keyframes.js';
import { GeminiVideoQualityProvider } from './video-quality.js';
import { createVideoRouter } from './video-router.js';
import type { VideoGenerationProvider,KeyframeGenerationProvider,VideoQualityProvider } from './video-provider.js';
import {MovieRenderer} from './movie-renderer.js';
import {MovieMedia} from './movie-media.js';
import {MovieStore} from './movie-store.js';
import {MovieRenderQueue} from './movie-queue.js';
import {createMovieRouter} from './movie-router.js';
import {ProductionStore} from './production-store.js';
import {ProductionBridge} from './production-bridge.js';
import {ProductionQueue} from './production-queue.js';
import {createProductionRouter} from './production-router.js';
import {deleteGeneratedVideo,deleteMovieExport} from './production-deletion.js';
import {z} from 'zod';

type GoogleService=PickerGoogle & Pick<GoogleClient,'authorizeUrl'|'exchangeCode'> & Partial<Pick<GoogleClient,'connectionStatus'|'accessToken'>>;
type WorkspaceRequest=express.Request & {session:session.Session & session.SessionData};
function wrap(handler:(req:WorkspaceRequest,res:express.Response)=>Promise<unknown>):RequestHandler {
  return (req,res,next)=>{void handler(req as WorkspaceRequest,res).catch(next);};
}
export function createApp(config:Config,dependencies:{google?:GoogleService;store?:session.Store;media?:MediaStore;gemini?:JsonGenerator;videoProvider?:VideoGenerationProvider;keyframeProvider?:KeyframeGenerationProvider;qualityProvider?:VideoQualityProvider;videoMedia?:VideoMedia;movieRenderer?:MovieRenderer;movieMedia?:MovieMedia}={}) {
  const app=express();
  app.disable('x-powered-by');
  const google=dependencies.google ?? new GoogleClient(config);
  const media=dependencies.media ?? new MediaStore(config.mediaStoragePath,{databasePath:config.databasePath,sessionSecret:config.sessionSecret,storageQuotaBytes:config.storageQuotaBytes,minFreeDiskBytes:config.minFreeDiskBytes,maxImageBytes:config.maxImageBytes});
  const sessionStore=dependencies.store ?? new EncryptedSessionStore(config.sessionStoragePath,config.sessionSecret);
  const picker=new PickerManager(google,media,{concurrency:config.importConcurrency,batchSize:config.importBatchSize,maxAttempts:config.importMaxAttempts,retryBaseMs:config.importRetryBaseMs,loadSession:sid=>loadStoredSession(sessionStore,sid)});
  const photoThumbnails=new PhotoThumbnails(media);
  const directorStore=new DirectorStore(media,config);
  const gemini=dependencies.gemini??new GeminiClient(config,directorStore);
  const analysis=new AnalysisQueue(gemini,directorStore,config);
  const director=new StoryboardDirector(directorStore,gemini,config);
  const videoMedia=dependencies.videoMedia??new VideoMedia(media,{ffmpegPath:config.ffmpegPath,ffprobePath:config.ffprobePath,maxVideoBytes:config.videoMaxBytes});
  const videoProvider=dependencies.videoProvider??(config.videoProvider==='veo'?new VeoProvider(config.veoModel):new OmniFlashProvider({geminiApiKey:config.geminiApiKey,omniModel:config.omniModel,videoTimeoutMs:config.videoRequestTimeoutMs}));
  const keyframeProvider=dependencies.keyframeProvider??new GeminiKeyframeProvider({geminiApiKey:config.geminiApiKey,keyframeModel:config.videoKeyframeModel,videoTimeoutMs:config.videoRequestTimeoutMs});
  const qualityProvider=dependencies.qualityProvider??new GeminiVideoQualityProvider({geminiApiKey:config.geminiApiKey,videoQualityModel:config.videoQualityModel,videoTimeoutMs:config.videoRequestTimeoutMs});
  const videoStore=new VideoStore(directorStore,director,videoProvider,videoMedia,config);
  const videoQueue=new VideoGenerationQueue(videoStore,videoProvider,keyframeProvider,qualityProvider,config);
  const movieRenderer=dependencies.movieRenderer??new MovieRenderer({ffmpegPath:config.ffmpegPath,ffprobePath:config.ffprobePath,threads:config.movieThreads,memoryLimitMb:config.movieMemoryLimitMb,maxWorkspaceBytes:config.movieMaxWorkspaceBytes,timeoutMs:config.movieRenderTimeoutMs,durationToleranceSeconds:config.movieDurationToleranceSeconds,fontFiles:{...(config.movieFontSerifPath?{serif:config.movieFontSerifPath}:{}),...(config.movieFontSansPath?{sans:config.movieFontSansPath}:{})}});
  const movieMedia=dependencies.movieMedia??new MovieMedia(media,config);
  const movieStore=new MovieStore(videoStore,movieMedia,movieRenderer,config);
  const movieQueue=new MovieRenderQueue(movieStore);
  const cinematicStore=new CinematicStore(directorStore);
  movieStore.setCinematicStore(cinematicStore);
  director.setStorytellingContext(owner=>{const preferences=cinematicStore.preferences(owner),sequences=cinematicStore.sequences(owner).filter(sequence=>!sequence.excluded);if(!preferences.enabled||!sequences.length)return;return {moments:sequenceReasoningContext(sequences),photoIds:[...new Set(sequences.filter(sequence=>sequence.orderedPhotoIds.length>1).slice(0,4).flatMap(sequence=>sequence.orderedPhotoIds.slice(0,3)))].slice(0,12),language:preferences.language,editingStyle:preferences.editingStyle};});
  const productionStore=new ProductionStore(videoStore,movieStore,config,Boolean(config.geminiApiKey||dependencies.gemini),cinematicStore);
  const productionBridge=new ProductionBridge({store:directorStore,analysis,director,videoStore,videoQueue,movieStore,movieQueue,generator:gemini,config,cinematic:cinematicStore},productionStore.ledger);
  const productionQueue=new ProductionQueue(productionStore,productionBridge);
  app.use(helmet({referrerPolicy:{policy:'no-referrer'},contentSecurityPolicy:{directives:{defaultSrc:["'none'"],frameAncestors:["'none'"]}}}));
  app.use(cors({origin:config.webOrigin,credentials:true}));
  app.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  app.get('/health',(_req,res)=>{res.json({status:'ok',phase:'P6'});});
  app.use(express.json({limit:'2mb'}));
  app.use(session({name:'memories.sid',secret:config.sessionSecret,store:sessionStore,resave:false,saveUninitialized:false,rolling:true,cookie:{httpOnly:true,sameSite:'lax',secure:config.nodeEnv==='production',maxAge:7*24*60*60*1000,path:'/'}}));
  app.use(ensureSession);
  app.use(bindCredentialPersistence(sessionStore));
  app.use((req,_res,next)=>{
    // Upgrade original P2 browser sessions. New jobs and checkpoints live in SQLite.
    if(req.session.credentials && Object.keys(req.session.credentials).length) req.session.authorizedAt ||= Date.now();
    const legacy=req.session.pendingPicker;
    if(legacy) {
      delete req.session.pendingPicker;
      void saveSession(req.session).then(()=>google.deleteSession(req.session,legacy.contributorId,legacy.googleId)).catch(()=>{});
    }
    next();
  });
  app.use((req,_res,next)=>{
    if(['POST','PUT','PATCH','DELETE'].includes(req.method)) {
      const token=req.get('X-CSRF-Token');
      const expected=req.session.csrfToken ?? '';
      if(req.get('origin')!==config.webOrigin || !token || token.length>256 || Buffer.byteLength(token)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(token),Buffer.from(expected))) {
        next(new ApiError(403,'CSRF_REJECTED','The request could not be verified. Refresh the page and try again.'));return;
      }
    }
    next();
  });
  app.get('/auth/google',(req,_res,next)=>{
    if(req.session.workspaceId && picker.hasPending(req.session.workspaceId)) {next(new ApiError(409,'PICKER_ACTIVE','Finish or cancel your current photo selection and wait for cleanup before connecting another account.'));return;}
    next();
  });
  app.use(createAuthRouter(config,google,{hasPending:ownerId=>picker.hasPending(ownerId),onAuthorized:value=>picker.authorized(value)}));
  const connection=async(value:session.Session & session.SessionData,id:'person1'|'person2',force=false)=>{
    const credential=value.credentials?.[id];
    const status=google.connectionStatus ? await google.connectionStatus(value,id,{force}) : {connected:Boolean(credential?.scope?.split(/\s+/).includes(config.googlePhotosScope)&&!credential?.requiresReauthorization),requiresReauthorization:Boolean(credential),grantedScopes:credential?.scope?.split(/\s+/)??[],verified:false};
    return {connected:status.connected,requiresReauthorization:status.requiresReauthorization,reauthorizationReason:'reason' in status?status.reason:undefined,reauthorizationMessage:'message' in status?status.message:undefined,grantedScopes:status.grantedScopes,grantsVerified:status.verified,accountVerified:Boolean(value.credentials?.[id]?.accountId)};
  };
  app.get('/api/session',wrap(async(req,res)=>{
    const people=await Promise.all(contributors.map(async person=>({...person,...await connection(req.session,person.id)})));
    res.json({authenticated:Boolean(req.session.authorizedAt),configured:Boolean(config.googleClientId&&config.googleClientSecret),csrfToken:req.session.csrfToken,contributors:people});
  }));
  const authenticated:RequestHandler=(req,_res,next)=>{
    if(!req.session.authorizedAt) {next(new ApiError(401,'AUTH_REQUIRED','Connect your Google account to open your private workspace.'));return;}
    next();
  };
  app.use('/api',authenticated);
  app.use('/api/director',createDirectorRouter(config,directorStore,analysis,director,Boolean(config.geminiApiKey||dependencies.gemini)));
  app.use('/api/video',createVideoRouter(videoStore,videoQueue));
  app.use('/api/movie',createMovieRouter(movieStore,movieQueue));
  app.use('/api/cinematic',createCinematicRouter(cinematicStore));
  app.use('/api/production',createProductionRouter(productionStore,productionQueue));
  app.delete('/api/video/assets/:id',wrap(async(req,res)=>{await deleteGeneratedVideo(productionStore,req.session.workspaceId,z.string().uuid().parse(req.params.id));res.sendStatus(204);}));
  app.delete('/api/movie/assets/:id',wrap(async(req,res)=>{await deleteMovieExport(productionStore,req.session.workspaceId,z.string().uuid().parse(req.params.id));res.sendStatus(204);}));
  const clientConfiguration=()=>({requiredScope:config.googlePhotosScope,clientFingerprint:createHash('sha256').update(config.googleClientId).digest('hex').slice(0,12),clientProjectNumberHint:/^(\d+)-/.exec(config.googleClientId)?.[1]??null});
  app.get('/api/connections/:contributorId/diagnostics',wrap(async(req,res)=>{
    const id=contributorIdSchema.parse(req.params.contributorId);
    res.json({...clientConfiguration(),connection:await connection(req.session,id),lastError:req.session.googleDiagnostics?.[id]});
  }));
  app.post('/api/connections/:contributorId/verify',wrap(async(req,res)=>{
    const id=contributorIdSchema.parse(req.params.contributorId);
    if(!google.accessToken) throw new ApiError(503,'VERIFICATION_UNAVAILABLE','Connection verification is unavailable.');
    // Refresh validates that the current client ID/secret pair can use this exact account grant.
    await google.accessToken(req.session,id,true);
    res.json({...clientConfiguration(),clientPairVerified:true,connection:await connection(req.session,id,true)});
  }));
  app.get('/api/project',wrap(async(req,res)=>{res.json({...await media.project(req.session.workspaceId),picker:picker.latest(req.session),jobs:picker.list(req.session)});}));
  app.get('/api/imports',wrap(async(req,res)=>{res.json({jobs:picker.list(req.session)});}));
  app.post('/api/picker/sessions',wrap(async(req,res)=>{
    const {contributorId}=createPickerSchema.parse(req.body);
    if(!req.session.credentials?.[contributorId]) throw new ApiError(401,'RECONNECT_REQUIRED','Connect this Google account before selecting photos.');
    res.status(201).json(await picker.create(req.session,contributorId));
  }));
  app.get('/api/picker/sessions/:id',wrap(async(req,res)=>{res.json(await picker.get(req.session,req.params.id));}));
  app.post('/api/picker/sessions/:id/import',wrap(async(req,res)=>{res.status(202).json(await picker.startImport(req.session,req.params.id));}));
  app.post('/api/picker/sessions/:id/resume',wrap(async(req,res)=>{res.status(202).json(await picker.resume(req.session,req.params.id));}));
  app.post('/api/picker/sessions/:id/retry',wrap(async(req,res)=>{res.status(202).json(await picker.retryFailed(req.session,req.params.id));}));
  app.delete('/api/picker/sessions/:id',wrap(async(req,res)=>{res.json(await picker.cancel(req.session,req.params.id));}));
  app.get('/api/projects/:projectId/assets/:assetId/thumbnail',wrap(async(req,res)=>{const result=await photoThumbnails.content(req.session.workspaceId,req.params.projectId,req.params.assetId);res.type('image/jpeg').set({'Cache-Control':'private, no-store','Cross-Origin-Resource-Policy':'same-origin','ETag':result.etag}).sendFile(result.file,{dotfiles:'allow'},error=>{if(error&&!res.headersSent)res.status(404).json({error:{code:'THUMBNAIL_NOT_FOUND',message:'Private photo preview unavailable.'}});});}));
  app.get('/api/projects/:projectId/assets/:assetId/content',wrap(async(req,res)=>{
    const {file,asset}=await media.content(req.session.workspaceId,req.params.projectId,req.params.assetId);
    res.type(asset.mimeType).set({'Content-Disposition':`inline; filename="${asset.id}"`,'Cross-Origin-Resource-Policy':'same-origin'}).sendFile(file,{dotfiles:'deny'},error=>{if(error&&!res.headersSent)res.status(404).json({error:{code:'NOT_FOUND',message:'Local photo not found.'}});});
  }));
  app.patch('/api/projects/:projectId/assets/selection',wrap(async(req,res)=>{const {selected,...options}=bulkSelectionSchema.parse(req.body);res.json({updated:await media.bulkSelect(req.session.workspaceId,req.params.projectId,selected,options)});}));
  app.patch('/api/projects/:projectId/assets/:assetId',wrap(async(req,res)=>{const {selected}=selectionSchema.parse(req.body);res.json(await media.select(req.session.workspaceId,req.params.projectId,req.params.assetId,selected));}));
  app.delete('/api/projects/:projectId/assets/:assetId',wrap(async(req,res)=>{await media.delete(req.session.workspaceId,req.params.projectId,req.params.assetId);await photoThumbnails.remove(req.session.workspaceId,req.params.projectId,req.params.assetId);res.sendStatus(204);}));
  app.use((_req,_res,next)=>{next(new ApiError(404,'NOT_FOUND','API endpoint not found.'));});
  const errors:ErrorRequestHandler=(error,req,res,_next)=>{
    if(res.headersSent) return;
    if(error instanceof ApiError) {
      if(error.code==='AUTHORIZATION_REPLACED') req.session=null as unknown as session.Session & session.SessionData;
      if(error.retryAfterMs) res.set('Retry-After',String(Math.ceil(error.retryAfterMs/1000)));
      if(error.diagnostic && req.session?.authorizedAt) {
        const person=contributorIdSchema.safeParse(req.body?.contributorId ?? req.params.contributorId);
        if(person.success) {req.session.googleDiagnostics ||= {};req.session.googleDiagnostics[person.data]=error.diagnostic;}
      }
      res.status(error.status).json({error:{code:error.code,message:error.message,...(error.retryAfterMs?{retryAfterMs:error.retryAfterMs}:{}),...(error.diagnostic?{diagnostic:error.diagnostic}:{})}});
    } else if(error instanceof ZodError || (error instanceof SyntaxError && 'body' in error)) res.status(400).json({error:{code:'INVALID_INPUT',message:'The request contains invalid data.'}});
    else if(error?.type==='entity.too.large') res.status(413).json({error:{code:'REQUEST_TOO_LARGE',message:'The request is too large.'}});
    else res.status(500).json({error:{code:'INTERNAL_ERROR',message:'The request could not be completed. Check local storage permissions and try again.'}});
  };
  app.use(errors);
  return {app,picker,media,directorStore,analysis,director,gemini,videoMedia,videoStore,videoQueue,videoProvider,movieStore,movieQueue,movieMedia,movieRenderer,productionStore,productionBridge,productionQueue,cinematicStore};
}
