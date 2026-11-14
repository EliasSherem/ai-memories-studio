import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { createAuthRouter } from '../src/auth.js';
import { ensureSession } from '../src/session-store.js';
import { GoogleClient } from '../src/google.js';
import { loadConfig } from '../src/config.js';
import { ApiError } from '../src/errors.js';

const config=loadConfig({SESSION_SECRET:'test-secret-that-is-longer-than-32-characters',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'});
function appFixture() {
  const app=express();
  const store=new session.MemoryStore();
  app.use(session({store,secret:config.sessionSecret,resave:false,saveUninitialized:false,cookie:{httpOnly:true,sameSite:'lax',secure:false,maxAge:3600_000}}));
  app.use(ensureSession);
  const google=new GoogleClient(config);
  const exchange=vi.spyOn(google,'exchangeCode').mockResolvedValue({accessToken:'never-send-to-client',refreshToken:'private-refresh',expiresAt:Date.now()+3600_000,scope:config.googlePhotosScope});
  app.get('/status',(req,res)=>res.json({workspaceId:req.session.workspaceId,connected:!!req.session.credentials?.person1,connected2:!!req.session.credentials?.person2,csrfToken:req.session.csrfToken}));
  app.get('/expire',(req,res)=>{if(req.session.oauth)req.session.oauth.createdAt=0;res.json({});});
  app.get('/pending-picker',(req,res)=>{req.session.pendingPicker={id:'local-picker',googleId:'google-picker',contributorId:'person1',deadline:Date.now()+60_000,nextPollAt:Date.now()+3000,pollIntervalMs:3000,status:'complete'};res.json({});});
  app.use(createAuthRouter(config,google));
  app.use((error:ApiError,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??500).json({code:error.code}));
  return {app,exchange,store};
}
async function storedSession(store:session.MemoryStore):Promise<session.SessionData> {
  return new Promise((resolve,reject)=>store.all((error,sessions)=>{
    if(error)reject(error);else resolve(Object.values(sessions ?? {})[0] as session.SessionData);
  }));
}
describe('Google OAuth authorization code flow',()=>{
  it('uses S256 PKCE, scope and a single-use state; rotates session while retaining workspace',async()=>{
    const {app,exchange}=appFixture();const agent=request.agent(app);
    const before=await agent.get('/status');
    const start=await agent.get('/auth/google?person=person1').expect(302);
    const auth=new URL(start.headers.location);
    expect(auth.origin).toBe('https://accounts.google.com');
    expect(auth.searchParams.get('scope')).toBe(config.googlePhotosScope);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('prompt')).toContain('select_account');
    expect(auth.searchParams.get('access_type')).toBe('offline');
    const state=auth.searchParams.get('state')!;
    expect(state.length).toBeGreaterThanOrEqual(32);
    const callback=await agent.get('/auth/google/callback').query({state,code:'private-code'}).expect(302);
    expect(callback.headers.location).toBe(`${config.webOrigin}/?auth=connected`);
    expect(JSON.stringify(callback.headers)).not.toContain('never-send-to-client');
    expect(exchange).toHaveBeenCalledTimes(1);
    const verifier=exchange.mock.calls[0][1];
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(auth.searchParams.get('code_challenge'));
    const after=await agent.get('/status');
    expect(after.body.workspaceId).toBe(before.body.workspaceId);expect(after.body.connected).toBe(true);expect(after.body.csrfToken).not.toBe(before.body.csrfToken);
    expect(callback.headers['set-cookie'][0].split(';')[0]).not.toBe(before.headers['set-cookie'][0].split(';')[0]);
    expect(callback.headers['set-cookie'][0]).toContain('HttpOnly');expect(callback.headers['set-cookie'][0]).toContain('SameSite=Lax');
    const replay=await agent.get('/auth/google/callback').query({state,code:'private-code'}).expect(302);
    expect(replay.headers.location).toBe(`${config.webOrigin}/?auth=invalid_state`);expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('requires browser-bound state even for denied authorization and never follows returnTo',async()=>{
    const {app,exchange}=appFixture();const agent=request.agent(app);
    const start=await agent.get('/auth/google?person=person2&returnTo=https://evil.test').expect(302);
    const state=new URL(start.headers.location).searchParams.get('state');
    const forged=await agent.get('/auth/google/callback?error=access_denied&state=forged').expect(302);
    expect(forged.headers.location).toBe(`${config.webOrigin}/?auth=invalid_state`);
    const denied=await agent.get('/auth/google/callback').query({state,error:'access_denied'}).expect(302);
    expect(denied.headers.location).toBe(`${config.webOrigin}/?auth=denied`);expect(exchange).not.toHaveBeenCalled();
    const otherBrowser=await request(app).get('/auth/google/callback').query({state,code:'code'}).expect(302);
    expect(otherBrowser.headers.location).toBe(`${config.webOrigin}/?auth=invalid_state`);
  });

  it('rejects expired state and invalid contributors',async()=>{
    const {app,exchange}=appFixture();const agent=request.agent(app);
    await agent.get('/auth/google?person=someone').expect(400);
    const start=await agent.get('/auth/google').expect(302);const state=new URL(start.headers.location).searchParams.get('state');
    await agent.get('/expire');
    const result=await agent.get('/auth/google/callback').query({state,code:'code'}).expect(302);
    expect(result.headers.location).toBe(`${config.webOrigin}/?auth=invalid_state`);expect(exchange).not.toHaveBeenCalled();
  });

  it('shows invalid credential feedback without exposing upstream failure details',async()=>{
    const {app,exchange}=appFixture();exchange.mockRejectedValue(new ApiError(503,'INVALID_GOOGLE_CREDENTIALS','sensitive-upstream-description'));
    const agent=request.agent(app);const start=await agent.get('/auth/google').expect(302);const state=new URL(start.headers.location).searchParams.get('state');
    const callback=await agent.get('/auth/google/callback').query({state,code:'private-code'}).expect(302);
    expect(callback.headers.location).toBe(`${config.webOrigin}/?auth=invalid_credentials`);
    expect(JSON.stringify(callback.headers)).not.toContain('sensitive-upstream-description');
  });

  it('blocks account changes until Picker cleanup finishes, including late OAuth callbacks',async()=>{
    const {app,exchange}=appFixture();const agent=request.agent(app);
    const start=await agent.get('/auth/google').expect(302);const state=new URL(start.headers.location).searchParams.get('state');
    await agent.get('/pending-picker');
    await agent.get('/auth/google').expect(409);
    const callback=await agent.get('/auth/google/callback').query({state,code:'private-code'}).expect(302);
    expect(callback.headers.location).toBe(`${config.webOrigin}/?auth=picker_active`);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('consumes state persistently before exchange and rejects simultaneous callback replay',async()=>{
    const {app,exchange}=appFixture();const agent=request.agent(app);
    let entered!:()=>void;
    const exchangeStarted=new Promise<void>((resolve)=>{entered=resolve;});
    let finish!:(tokens:{accessToken:string;expiresAt:number})=>void;
    exchange.mockImplementation(()=>{entered();return new Promise((resolve)=>{finish=resolve;});});
    const start=await agent.get('/auth/google').expect(302);const state=new URL(start.headers.location).searchParams.get('state');
    const first=agent.get('/auth/google/callback').query({state,code:'private-code'}).then((result)=>result);
    await exchangeStarted;
    await agent.get('/auth/google').expect(409);
    const replay=await agent.get('/auth/google/callback').query({state,code:'private-code'}).expect(302);
    expect(replay.headers.location).toBe(`${config.webOrigin}/?auth=invalid_state`);
    finish({accessToken:'private-token',expiresAt:Date.now()+3600_000});
    expect((await first).headers.location).toBe(`${config.webOrigin}/?auth=connected`);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('reconnects only the requested contributor and replaces stale refresh credentials securely',async()=>{
    const {app,exchange,store}=appFixture();const agent=request.agent(app);
    async function authorize(person:'person1'|'person2',reconnect=false) {
      const start=await agent.get(`/auth/google?person=${person}${reconnect?'&reconnect=1':''}`).expect(302);
      const target=new URL(start.headers.location);
      expect(target.searchParams.get('scope')).toBe(config.googlePhotosScope);
      expect(target.searchParams.get('prompt')).toContain('consent');expect(target.searchParams.get('prompt')).toContain('select_account');
      await agent.get('/auth/google/callback').query({state:target.searchParams.get('state'),code:'mock-code'}).expect(302);
    }
    exchange.mockResolvedValueOnce({accessToken:'first-account-old-access',refreshToken:'first-account-old-refresh',expiresAt:Date.now()+3600_000,scope:config.googlePhotosScope});
    await authorize('person1');
    exchange.mockResolvedValueOnce({accessToken:'second-account-access',refreshToken:'second-account-refresh',expiresAt:Date.now()+3600_000,scope:config.googlePhotosScope});
    await authorize('person2');
    const before=await storedSession(store);
    exchange.mockResolvedValueOnce({accessToken:'first-account-new-access',expiresAt:Date.now()+3600_000,scope:config.googlePhotosScope});
    await authorize('person1',true);
    const after=await storedSession(store);
    expect(after.workspaceId).toBe(before.workspaceId);expect(after.authorizedAt).toBe(before.authorizedAt);
    expect(after.credentials?.person2).toEqual(before.credentials?.person2);
    expect(after.credentials?.person1).toMatchObject({accessToken:'first-account-new-access',scope:config.googlePhotosScope});
    expect(after.credentials?.person1?.refreshToken).toBeUndefined();
    expect(after.csrfToken).not.toBe(before.csrfToken);
    const publicStatus=await agent.get('/status');expect(JSON.stringify(publicStatus.body)).not.toContain('first-account');
    await agent.get('/auth/google?person=person1&reconnect=unsafe').expect(400);
  });

  it('marks only the stale contributor as requiring reauthorization when the new grant lacks Picker scope',async()=>{
    const {app,exchange,store}=appFixture();const agent=request.agent(app);
    for(const person of ['person1','person2']) {
      const start=await agent.get('/auth/google').query({person}).expect(302);
      await agent.get('/auth/google/callback').query({state:new URL(start.headers.location).searchParams.get('state'),code:'mock-code'}).expect(302);
    }
    const before=await storedSession(store);
    exchange.mockRejectedValueOnce(new ApiError(403,'MISSING_PHOTOS_SCOPE','Do not copy upstream secrets or account details.'));
    const start=await agent.get('/auth/google?person=person1&reconnect=1').expect(302);
    const callback=await agent.get('/auth/google/callback').query({state:new URL(start.headers.location).searchParams.get('state'),code:'mock-code'}).expect(302);
    expect(callback.headers.location).toBe(`${config.webOrigin}/?auth=missing_scope`);
    const after=await storedSession(store);
    expect(after.credentials?.person1).toMatchObject({requiresReauthorization:true,authorizationError:'MISSING_PHOTOS_SCOPE'});
    expect(after.credentials?.person2).toEqual(before.credentials?.person2);
    expect(JSON.stringify(after)).not.toContain('upstream secrets');
    expect(JSON.stringify(callback.headers)).not.toContain('upstream secrets');
  });

  it('distinguishes explicit OAuth testing restrictions from a generic consent denial',async()=>{
    const {app,exchange}=appFixture();const agent=request.agent(app);
    const start=await agent.get('/auth/google?person=person2').expect(302);
    const result=await agent.get('/auth/google/callback').query({state:new URL(start.headers.location).searchParams.get('state'),error:'access_denied',error_description:'This app is in testing mode. Only test users can access it. private-account@example.test'}).expect(302);
    expect(result.headers.location).toBe(`${config.webOrigin}/?auth=oauth_testing_required`);
    expect(JSON.stringify(result.headers)).not.toContain('private-account');expect(exchange).not.toHaveBeenCalled();
    const retry=await agent.get('/auth/google').expect(302);
    const denied=await agent.get('/auth/google/callback').query({state:new URL(retry.headers.location).searchParams.get('state'),error:'access_denied'}).expect(302);
    expect(denied.headers.location).toBe(`${config.webOrigin}/?auth=denied`);
  });
});
