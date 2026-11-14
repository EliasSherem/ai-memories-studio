import { Router } from 'express';
import type { Request } from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { contributorIdSchema } from '@memories/shared';
import type { Config } from './config.js';
import type { GoogleClient } from './google.js';
import { ApiError } from './errors.js';
import { saveSession } from './session-store.js';
import type { WorkspaceSession } from './import-queue.js';

export function createAuthRouter(config:Config, google:Pick<GoogleClient,'authorizeUrl'|'exchangeCode'>, hooks:{hasPending?:(ownerId:string)=>boolean;onAuthorized?:(session:WorkspaceSession)=>Promise<void>}={}):Router {
  const router = Router();
  const consuming = new Set<string>();
  const redirect = (status:string) => `${config.webOrigin}/?auth=${status}`;
  const pickerActive=(req:Request)=>hooks.hasPending ? hooks.hasPending(req.session.workspaceId ?? '') : Boolean(req.session.pendingPicker);
  router.get('/auth/google', (req,res,next) => {
    void (async () => {
      const parsed = contributorIdSchema.safeParse(req.query.person ?? 'person1');
      if (!parsed.success) throw new ApiError(400,'INVALID_CONTRIBUTOR','Choose one of the two photo contributors.');
      if(req.query.reconnect !== undefined && req.query.reconnect !== '1' && req.query.reconnect !== '0') throw new ApiError(400,'INVALID_RECONNECT','Start reconnection from the Google Photos connection card.');
      if (pickerActive(req)) throw new ApiError(409,'PICKER_ACTIVE','Finish or cancel the current photo selection and wait for cleanup before connecting another account.');
      if (req.session.oauth?.processing && req.session.oauth.createdAt + 10*60*1000 > Date.now()) throw new ApiError(409,'OAUTH_ACTIVE','Google account authorization is already completing. Please wait a moment.');
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(64).toString('base64url');
      const url = google.authorizeUrl(state,verifier);
      req.session.oauth = {state,verifier,contributorId:parsed.data,createdAt:Date.now()};
      await saveSession(req.session);
      res.redirect(url);
    })().catch(next);
  });
  router.get('/auth/google/callback',(req,res,next) => {
    void (async () => {
      const pending = req.session.oauth;
      const state = req.query.state;
      const validState = typeof state === 'string' && pending && state.length <= 256 && Buffer.byteLength(state) === Buffer.byteLength(pending.state) && timingSafeEqual(Buffer.from(state),Buffer.from(pending.state));
      if (!pending || !validState || pending.processing || pending.createdAt + 10*60*1000 < Date.now() || consuming.has(pending.state)) {
        res.redirect(redirect('invalid_state'));
        return;
      }
      consuming.add(pending.state);
      try {
        if (req.query.error || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 16384 || pickerActive(req)) {
          delete req.session.oauth;
          await saveSession(req.session);
          res.redirect(redirect(pickerActive(req) ? 'picker_active' : oauthFailureStatus(req)));
          return;
        }
        // Persist consumption before exchange so a process restart cannot replay the code.
        // Picker creation refuses this pending record while credentials are changing.
        pending.processing = true;
        await saveSession(req.session);
        const tokens = await google.exchangeCode(req.query.code,pending.verifier);
        const snapshot = {workspaceId:req.session.workspaceId,authorizedAt:req.session.authorizedAt ?? Date.now(),csrfToken:randomBytes(32).toString('base64url'),credentials:{...req.session.credentials,[pending.contributorId]:tokens}};
        await regenerate(req);
        Object.assign(req.session,snapshot);
        await saveSession(req.session);
        await hooks.onAuthorized?.(req.session as WorkspaceSession);
        res.redirect(redirect('connected'));
      } catch (error) {
        // Callback URLs and exceptions never expose authorization codes or upstream details.
        if (error instanceof ApiError) {
          delete req.session.oauth;
          if(['MISSING_PHOTOS_SCOPE','WRONG_OAUTH_CLIENT','ACCOUNT_MISMATCH','RECONNECT_REQUIRED'].includes(error.code)) {
            const stale=req.session.credentials?.[pending.contributorId];
            if(stale) Object.assign(stale,{requiresReauthorization:true,authorizationError:error.code,authorizationMessage:reauthorizationMessage(error.code)});
          }
          await saveSession(req.session);
          const status=error.code==='INVALID_GOOGLE_CREDENTIALS'?'invalid_credentials':error.code==='MISSING_PHOTOS_SCOPE'?'missing_scope':error.code==='WRONG_OAUTH_CLIENT'?'wrong_oauth_client':error.code==='ACCOUNT_MISMATCH'?'account_mismatch':'failed';
          res.redirect(redirect(status));
        }
        else throw error;
      } finally { consuming.delete(pending.state); }
    })().catch(next);
  });
  return router;
}
function regenerate(req:Request):Promise<void> { return new Promise((resolve,reject)=>req.session.regenerate((error)=>error?reject(error):resolve())); }

/** Only fixed statuses leave the callback; untrusted Google error descriptions never do. */
function oauthFailureStatus(req:Request):string {
  const error=typeof req.query.error==='string'?req.query.error:'';
  const subtype=typeof req.query.error_subtype==='string'?req.query.error_subtype:'';
  const description=typeof req.query.error_description==='string'?req.query.error_description.slice(0,2048):'';
  if(error==='invalid_client'||error==='unauthorized_client') return 'invalid_credentials';
  if(error==='invalid_scope') return 'missing_scope';
  if(error==='org_internal') return 'oauth_org_restricted';
  if(error==='admin_policy_enforced') return 'oauth_admin_policy';
  if(error==='access_denied') {
    if(subtype==='test_user_required'||/test[ -]?users?|currently being tested|testing mode/i.test(description)) return 'oauth_testing_required';
    return 'denied';
  }
  return 'failed';
}
function reauthorizationMessage(code:string):string {
  if(code==='MISSING_PHOTOS_SCOPE') return 'Reconnect Google Photos and approve the Photos Picker permission.';
  if(code==='WRONG_OAUTH_CLIENT') return 'Reconnect Google Photos using this app’s current OAuth client.';
  if(code==='ACCOUNT_MISMATCH') return 'Reconnect the Google account that owns this photo selection.';
  return 'Reconnect Google Photos to renew authorization.';
}
