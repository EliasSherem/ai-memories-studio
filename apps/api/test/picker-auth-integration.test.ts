import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import session from 'express-session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ContributorId, PickerState } from '@memories/shared';
import { createApp } from '../src/app.js';
import { GoogleClient, type Tokens } from '../src/google.js';
import { loadConfig, PHOTOS_SCOPE } from '../src/config.js';

const API = 'https://photospicker.googleapis.com/v1';
const PRIVATE_CODE = 'private-authorization-code-do-not-log';
const SECRET = 'private-client-secret-do-not-log';
const ACCESS = { person1: 'private-access-person-one', person2: 'private-access-person-two' };
const REFRESH = { person1: 'private-refresh-person-one', person2: 'private-refresh-person-two' };
const response = (value:unknown,status=200,headers:Record<string,string>={}) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}});
const disposals:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});

class InspectableStore extends session.MemoryStore {
  currentId?:string;
  override set(id:string,data:session.SessionData,callback?:(error?:unknown)=>void) { this.currentId=id;super.set(id,data,callback); }
  async mutate(contributor:ContributorId,change:(tokens:Tokens)=>void) {
    const id=this.currentId!;
    const data=await new Promise<session.SessionData>((resolve,reject)=>this.get(id,(error,value)=>error?reject(error):resolve(value!)));
    change(data.credentials![contributor]!);
    await new Promise<void>((resolve,reject)=>this.set(id,data,error=>error?reject(error):resolve()));
  }
}

type Options={
  pickerError?:{status:number;body:unknown};
  unauthorizedOnce?:boolean;
  introspectedAudience?:string;
  introspectedAccount?:string;
  count?:number;
};
async function fixture(options:Options={}) {
  const directory=await mkdtemp(join(tmpdir(),'memories-picker-auth-'));
  const config=loadConfig({
    SESSION_SECRET:'test-session-secret-long-enough-for-private-storage',GOOGLE_CLIENT_ID:'123456789-test.apps.googleusercontent.com',GOOGLE_CLIENT_SECRET:SECRET,
    MEDIA_STORAGE_PATH:join(directory,'imports'),DATABASE_PATH:join(directory,'studio.sqlite'),NODE_ENV:'test',MIN_FREE_DISK_BYTES:'0',IMPORT_MAX_ATTEMPTS:'1',IMPORT_RETRY_BASE_MS:'10',
  });
  const store=new InspectableStore();const diagnostics:unknown[]=[];let sessionCount=0;let unauthorized=Boolean(options.unauthorizedOnce);let inspectionOverridesEnabled=false;
  const fetcher=vi.fn(async(input:string|URL|Request,init?:RequestInit):Promise<Response>=>{
    const url=String(input);const headers=new Headers(init?.headers);
    if(url==='https://oauth2.googleapis.com/token') {
      const form=new URLSearchParams(String(init?.body));
      const contributor:ContributorId=(form.get('code')?.includes('person2')||form.get('refresh_token')===REFRESH.person2)?'person2':'person1';
      const refreshing=form.get('grant_type')==='refresh_token';
      return response({access_token:refreshing?`${ACCESS[contributor]}-refreshed`:ACCESS[contributor],refresh_token:refreshing?undefined:REFRESH[contributor],expires_in:3600,token_type:'Bearer',...(refreshing?{}:{scope:PHOTOS_SCOPE})});
    }
    if(url.startsWith('https://oauth2.googleapis.com/tokeninfo')) {
      const token=headers.get('authorization')?.replace(/^Bearer /,'')??new URLSearchParams(String(init?.body)).get('access_token')??new URL(url).searchParams.get('access_token');
      return response({aud:(inspectionOverridesEnabled?options.introspectedAudience:undefined)??config.googleClientId,scope:PHOTOS_SCOPE,expires_in:3600,sub:(inspectionOverridesEnabled?options.introspectedAccount:undefined)??(token?.includes('person-two')?'account-two':'account-one')});
    }
    if(url===`${API}/sessions`&&init?.method==='POST') {
      if(unauthorized){unauthorized=false;return response({error:{code:401,status:'UNAUTHENTICATED',message:`Expired credential ${ACCESS.person1}`}},401);}
      if(options.pickerError)return response(options.pickerError.body,options.pickerError.status);
      sessionCount++;
      return response({id:`picker-${sessionCount}`,pickerUri:`https://photos.google.com/picker/${sessionCount}`,expireTime:new Date(Date.now()+3600_000).toISOString(),mediaItemsSet:true});
    }
    if(url.startsWith(`${API}/sessions/`)&&init?.method==='DELETE')return new Response(null,{status:204});
    if(url.startsWith(`${API}/sessions/`))return response({id:url.split('/').at(-1),expireTime:new Date(Date.now()+3600_000).toISOString(),mediaItemsSet:true});
    if(url.startsWith(`${API}/mediaItems?`)) {
      const parsed=new URL(url);const offset=Number(parsed.searchParams.get('pageToken')??0);const count=options.count??0;
      const mediaItems=Array.from({length:Math.min(100,count-offset)},(_,index)=>{
        const id=`photo-${offset+index}`;return{id,type:'PHOTO',createTime:'2024-01-01T00:00:00Z',mediaFile:{baseUrl:`https://lh3.googleusercontent.com/p/${id}`,mimeType:'image/jpeg',filename:`${id}.jpg`}};
      });
      return response({mediaItems,...(offset+mediaItems.length<count?{nextPageToken:String(offset+mediaItems.length)}:{})});
    }
    if(url.startsWith('https://lh3.googleusercontent.com/'))return new Response(Buffer.concat([Buffer.from([255,216,255,224]),Buffer.from(url)]),{headers:{'content-type':'image/jpeg'}});
    throw new Error('Unexpected mocked Google operation');
  });
  const google=new GoogleClient(config,fetcher as typeof fetch,{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
  const application=createApp(config,{google,store});
  disposals.push(async()=>{await application.picker.dispose();application.media.db.close();await rm(directory,{recursive:true,force:true});});
  const agent=request.agent(application.app);
  const authorize=async(contributor:ContributorId='person1')=>{
    await agent.get('/api/session').expect(200);
    const start=await agent.get('/auth/google').query({person:contributor,reconnect:'1'}).expect(302);
    const location=new URL(start.headers.location);
    expect(location.searchParams.get('scope')).toBe(PHOTOS_SCOPE);
    expect(location.searchParams.get('prompt')).toContain('consent');
    const callback=await agent.get('/auth/google/callback').query({state:location.searchParams.get('state'),code:`${PRIVATE_CODE}-${contributor}`}).expect(302);
    expect(callback.headers.location).toContain('auth=connected');
    return (await agent.get('/api/session').expect(200)).body;
  };
  const mutate=(method:'post'|'delete',path:string,csrf:string,body?:unknown)=>agent[method](path).set('Origin',config.webOrigin).set('X-CSRF-Token',csrf).send(body as object|undefined);
  const pickerCalls=()=>fetcher.mock.calls.filter(([url,init])=>String(url)===`${API}/sessions`&&init?.method==='POST');
  return{...application,agent,store,config,fetcher,diagnostics,authorize,mutate,pickerCalls,enableInspectionOverrides:()=>{inspectionOverridesEnabled=true;}};
}

function googleError(reason:string,message:string,metadata:Record<string,string>={}) {
  return {error:{code:403,status:'PERMISSION_DENIED',message,details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason,domain:'googleapis.com',metadata:{service:'photospicker.googleapis.com',...metadata}}]}};
}

describe('Picker OAuth and structured Google error classification',()=>{
  it('marks a stored token missing the Picker scope as requiring reconnect before calling the Picker',async()=>{
    const f=await fixture();await f.authorize();
    await f.store.mutate('person1',tokens=>{tokens.scope='https://www.googleapis.com/auth/photoslibrary.readonly';});
    const status=(await f.agent.get('/api/session').expect(200)).body;
    expect(status.contributors[0]).toMatchObject({connected:false,requiresReauthorization:true});
    const result=await f.mutate('post','/api/picker/sessions',status.csrfToken,{contributorId:'person1'});
    expect(result.status).toBeGreaterThanOrEqual(400);expect(result.body.error.code).toBe('MISSING_PHOTOS_SCOPE');expect(f.pickerCalls()).toHaveLength(0);
  });

  it('refreshes an expired token without losing its granted scope or the other account credentials',async()=>{
    const f=await fixture();await f.authorize();const info=await f.authorize('person2');
    await f.store.mutate('person1',tokens=>{tokens.expiresAt=0;});
    await f.mutate('post','/api/picker/sessions',info.csrfToken,{contributorId:'person1'}).expect(201);
    const call=f.pickerCalls()[0];expect(new Headers(call[1]?.headers).get('Authorization')).toBe(`Bearer ${ACCESS.person1}-refreshed`);
    const refresh=f.fetcher.mock.calls.find(([url,init])=>String(url)==='https://oauth2.googleapis.com/token'&&new URLSearchParams(String(init?.body)).get('grant_type')==='refresh_token');
    expect(new URLSearchParams(String(refresh?.[1]?.body)).get('refresh_token')).toBe(REFRESH.person1);
    const updated=(await f.agent.get('/api/session')).body;expect(updated.contributors.map((person:{connected:boolean})=>person.connected)).toEqual([true,true]);
  });

  it('retries a 401 exactly once with a refreshed access token and creates a Picker session',async()=>{
    const f=await fixture({unauthorizedOnce:true});const info=await f.authorize();
    await f.mutate('post','/api/picker/sessions',info.csrfToken,{contributorId:'person1'}).expect(201);
    expect(f.pickerCalls()).toHaveLength(2);
    expect(f.pickerCalls().map(([,init])=>new Headers(init?.headers).get('Authorization'))).toEqual([`Bearer ${ACCESS.person1}`,`Bearer ${ACCESS.person1}-refreshed`]);
  });

  it('uses SERVICE_DISABLED evidence and its consumer project rather than treating every 403 as disabled',async()=>{
    const f=await fixture({pickerError:{status:403,body:googleError('SERVICE_DISABLED',`API disabled. Bearer ${ACCESS.person1} code=${PRIVATE_CODE} secret=${SECRET} https://private.example/photo personal@example.com`,{consumer:'projects/987654321'})}});const info=await f.authorize();
    const result=await f.mutate('post','/api/picker/sessions',info.csrfToken,{contributorId:'person1'}).expect(403);
    expect(result.body.error.code).toBe('GOOGLE_API_DISABLED');expect(result.body.error.message).toMatch(/project|987654321/i);
    expect(result.body.error.diagnostic).toMatchObject({operation:'picker.sessions.create',httpStatus:403,reason:'SERVICE_DISABLED'});
    expect(result.body.error.diagnostic.consumerProject).toMatch(/(?:projects\/)?987654321/);
    const safe=JSON.stringify({response:result.body,diagnostics:f.diagnostics});
    for(const secret of [ACCESS.person1,REFRESH.person1,SECRET,PRIVATE_CODE,'personal@example.com','https://private.example/photo'])expect(safe).not.toContain(secret);
  });

  it('distinguishes an insufficient scope response from a disabled API and marks the connection stale',async()=>{
    const f=await fixture({pickerError:{status:403,body:googleError('ACCESS_TOKEN_SCOPE_INSUFFICIENT','Request had insufficient authentication scopes.')}});const info=await f.authorize();
    const result=await f.mutate('post','/api/picker/sessions',info.csrfToken,{contributorId:'person1'}).expect(403);
    expect(result.body.error.code).toBe('MISSING_PHOTOS_SCOPE');expect(result.body.error.message).not.toMatch(/enable.*api/i);
    expect((await f.agent.get('/api/session')).body.contributors[0]).toMatchObject({connected:false,requiresReauthorization:true});
  });

  it('does not invent an API-disabled explanation for an unclassified 403',async()=>{
    const f=await fixture({pickerError:{status:403,body:googleError('ORG_POLICY_VIOLATION','Organization policy blocked this request.')}});const info=await f.authorize();
    const result=await f.mutate('post','/api/picker/sessions',info.csrfToken,{contributorId:'person1'}).expect(403);
    expect(result.body.error.code).not.toBe('GOOGLE_API_DISABLED');expect(result.body.error.message).not.toMatch(/enable.*api/i);
    expect(result.body.error.diagnostic).toMatchObject({httpStatus:403,reason:'ORG_POLICY_VIOLATION'});
  });

  it('rejects a stored token issued to another OAuth client before sending it to the Picker',async()=>{
    const f=await fixture({introspectedAudience:'another-project-client.apps.googleusercontent.com'});await f.authorize();f.enableInspectionOverrides();
    await f.store.mutate('person1',tokens=>{tokens.scope=undefined;tokens.scopeVerifiedAt=undefined;tokens.clientId=undefined;});
    const status=(await f.agent.get('/api/session')).body;expect(status.contributors[0]).toMatchObject({connected:false,requiresReauthorization:true});
    const result=await f.mutate('post','/api/picker/sessions',status.csrfToken,{contributorId:'person1'});
    expect(result.body.error.code).toBe('WRONG_OAUTH_CLIENT');expect(f.pickerCalls()).toHaveLength(0);
  });

  it('rejects an introspected account mismatch instead of silently using another account token',async()=>{
    const f=await fixture({introspectedAccount:'different-account'});await f.authorize();f.enableInspectionOverrides();
    await f.store.mutate('person1',tokens=>{tokens.scope=undefined;tokens.scopeVerifiedAt=undefined;});
    const status=(await f.agent.get('/api/session')).body;
    const result=await f.mutate('post','/api/picker/sessions',status.csrfToken,{contributorId:'person1'});
    expect(result.body.error.code).toBe('ACCOUNT_MISMATCH');expect(f.pickerCalls()).toHaveLength(0);
  });

  it('creates every Picker session with its contributor token and never mixes the two accounts',async()=>{
    const f=await fixture();await f.authorize();const info=await f.authorize('person2');
    const first=await f.mutate('post','/api/picker/sessions',info.csrfToken,{contributorId:'person1'}).expect(201);
    await f.mutate('delete',`/api/picker/sessions/${first.body.id}`,info.csrfToken).expect(200);
    await f.mutate('post','/api/picker/sessions',info.csrfToken,{contributorId:'person2'}).expect(201);
    expect(f.pickerCalls().map(([,init])=>new Headers(init?.headers).get('Authorization'))).toEqual([`Bearer ${ACCESS.person1}`,`Bearer ${ACCESS.person2}`]);
    const serialized=JSON.stringify((await f.agent.get('/api/session')).body);
    for(const secret of [ACCESS.person1,ACCESS.person2,REFRESH.person1,REFRESH.person2,SECRET])expect(serialized).not.toContain(secret);
  });

  it('privately verifies the current client pair and actual Picker grant without exposing credentials',async()=>{
    const f=await fixture();const info=await f.authorize();
    await request(f.app).get('/api/connections/person1/diagnostics').expect(401);
    await f.agent.get('/api/connections/unknown/diagnostics').expect(400);
    await f.agent.post('/api/connections/person1/verify').set('Origin',f.config.webOrigin).send({}).expect(403);
    const verified=await f.mutate('post','/api/connections/person1/verify',info.csrfToken,{}).expect(200);
    expect(verified.body).toMatchObject({requiredScope:PHOTOS_SCOPE,clientPairVerified:true,connection:{connected:true,grantsVerified:true,grantedScopes:[PHOTOS_SCOPE],accountVerified:true}});
    expect(verified.body.clientFingerprint).toMatch(/^[a-f0-9]{12}$/);
    const refresh=f.fetcher.mock.calls.find(([url,init])=>String(url)==='https://oauth2.googleapis.com/token'&&new URLSearchParams(String(init?.body)).get('grant_type')==='refresh_token');
    const form=new URLSearchParams(String(refresh?.[1]?.body));
    expect(form.get('client_id')).toBe(f.config.googleClientId);expect(form.get('client_secret')).toBe(SECRET);expect(form.get('refresh_token')).toBe(REFRESH.person1);
    const infoCalls=f.fetcher.mock.calls.filter(([url])=>String(url)==='https://oauth2.googleapis.com/tokeninfo');
    expect(infoCalls).toHaveLength(2);expect(infoCalls.every(([,init])=>init?.method==='POST')).toBe(true);
    const status=await f.agent.get('/api/connections/person1/diagnostics').expect(200);
    expect(status.body.connection).toMatchObject({connected:true,grantedScopes:[PHOTOS_SCOPE]});
    const publicData=JSON.stringify({verification:verified.body,diagnostics:status.body});
    for(const secret of [ACCESS.person1,REFRESH.person1,SECRET,PRIVATE_CODE,'account-one'])expect(publicData).not.toContain(secret);
  });

  it('keeps recorded Picker diagnostics private and separated by contributor',async()=>{
    const f=await fixture({pickerError:{status:403,body:googleError('SERVICE_DISABLED','The Picker API is disabled for this consumer.',{consumer:'projects/987654321'})}});const info=await f.authorize();
    await f.mutate('post','/api/picker/sessions',info.csrfToken,{contributorId:'person1'}).expect(403);
    const diagnostic=await f.agent.get('/api/connections/person1/diagnostics').expect(200);
    expect(diagnostic.body.lastError).toMatchObject({operation:'picker.sessions.create',httpStatus:403,reason:'SERVICE_DISABLED',service:'photospicker.googleapis.com'});
    const other=await f.agent.get('/api/connections/person2/diagnostics').expect(200);expect(other.body.lastError).toBeUndefined();
    await request(f.app).get('/api/connections/person1/diagnostics').expect(401);
    const publicData=JSON.stringify(diagnostic.body);
    for(const secret of [ACCESS.person1,REFRESH.person1,SECRET,PRIVATE_CODE])expect(publicData).not.toContain(secret);
  });

  it('still retrieves all five pages and imports 500 selected photos after successful authorization',async()=>{
    const f=await fixture({count:500});const info=await f.authorize();
    const created=await f.mutate('post','/api/picker/sessions',info.csrfToken,{contributorId:'person1'}).expect(201);
    await f.mutate('post',`/api/picker/sessions/${created.body.id}/import`,info.csrfToken,{}).expect(202);
    let state:PickerState|undefined;
    for(let attempt=0;attempt<600;attempt++) {
      state=(await f.agent.get(`/api/picker/sessions/${created.body.id}`).expect(200)).body as PickerState;
      if(state.status==='complete')break;
      await delay(10);
    }
    expect(state).toMatchObject({status:'complete',total:500,completed:500,failed:0,remaining:0});
    const pages=f.fetcher.mock.calls.filter(([url])=>String(url).startsWith(`${API}/mediaItems?`));
    expect(pages.map(([url])=>new URL(String(url)).searchParams.get('pageToken'))).toEqual([null,'100','200','300','400']);
    expect((await f.agent.get('/api/project')).body.assets).toHaveLength(500);
  },30000);
});
