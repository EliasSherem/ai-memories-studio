import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import session from 'express-session';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../src/app.js';
import { GoogleClient, type PickedMediaItem } from '../src/google.js';
import { PHOTOS_SCOPE, type Config } from '../src/config.js';
import { MAX_IMAGE_BYTES } from '../src/media-store.js';
import type { PickerState } from '@memories/shared';

const API = 'https://photospicker.googleapis.com/v1';
const TOKEN = 'private-access-token-for-integration';
const REFRESH = 'private-refresh-token-for-integration';
const json = (value:unknown, status=200, headers:Record<string,string>={}) => new Response(JSON.stringify(value), {status,headers:{'content-type':'application/json',...headers}});
const image = (id:string, mimeType='image/jpeg'):PickedMediaItem => ({
  id,type:'PHOTO',createTime:'2024-05-06T12:00:00Z',mediaFile:{baseUrl:`https://lh3.googleusercontent.com/p/${id}`,mimeType,filename:`${id}.jpg`,mediaFileMetadata:{width:20,height:20}},
});
type Options = {
  items?:PickedMediaItem[];
  secondPage?:PickedMediaItem[];
  waiting?:boolean;
  timeoutIn?:string;
  tokenError?:boolean;
  pollError?:boolean;
  revokeDuringPoll?:boolean;
  cleanupFailures?:number;
  download?:(url:string)=>Response;
};
const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{await Promise.all(cleanups.splice(0).map(cleanup=>cleanup()));});

async function fixture(options:Options={}) {
  const directory=await mkdtemp(join(tmpdir(),'memories-integration-'));
  const config:Config={googleClientId:'integration-client',googleClientSecret:'integration-secret',googleRedirectUri:'http://localhost:3001/auth/google/callback',googlePhotosScope:PHOTOS_SCOPE,webOrigin:'http://localhost:5173',apiPort:3001,sessionSecret:'a-private-integration-session-secret-at-least-32-chars',mediaStoragePath:join(directory,'imports'),sessionStoragePath:join(directory,'sessions'),nodeEnv:'test',databasePath:join(directory,'studio.sqlite'),importMaxAttempts:options.pollError?5:1,importRetryBaseMs:10,maxImageBytes:1024*1024,minFreeDiskBytes:0};
  let counter=0;
  let cleanupFailures=options.cleanupFailures??0;
  const fetchMock=vi.fn(async(input:string|URL|Request,init?:RequestInit):Promise<Response>=>{
    const url=String(input);
    if(url==='https://oauth2.googleapis.com/token') {
      if(options.revokeDuringPoll&&new URLSearchParams(String(init?.body)).get('grant_type')==='refresh_token') return json({error:'invalid_grant'},400);
      return options.tokenError ? json({error:'invalid_client'},400) : json({access_token:TOKEN,refresh_token:REFRESH,expires_in:3600,token_type:'Bearer',scope:PHOTOS_SCOPE});
    }
    if(url==='https://oauth2.googleapis.com/tokeninfo') return json({scope:PHOTOS_SCOPE,aud:config.googleClientId,sub:'fixture-account-person1',expires_in:3600});
    if(url===`${API}/sessions` && init?.method==='POST') {
      counter++;
      return json({id:`google-session-${counter}`,pickerUri:`https://photos.google.com/picker/session-${counter}`,expireTime:new Date(Date.now()+3600_000).toISOString(),mediaItemsSet:!options.waiting,...(options.waiting?{pollingConfig:{pollInterval:'1s',timeoutIn:options.timeoutIn??'60s'}}:{})});
    }
    if(url.startsWith(`${API}/sessions/`) && init?.method==='DELETE') return cleanupFailures-->0 ? json({error:{status:'UNAVAILABLE'}},503) : new Response(null,{status:204});
    if(url.startsWith(`${API}/sessions/`)) {
      if(options.revokeDuringPoll) return json({error:{status:'UNAUTHENTICATED'}},401);
      if(options.pollError) return json({error:{status:'RESOURCE_EXHAUSTED'}},429,{'retry-after':'2'});
      return json({id:url.split('/').at(-1),expireTime:new Date(Date.now()+3600_000).toISOString(),mediaItemsSet:false,pollingConfig:{pollInterval:'1s',timeoutIn:'60s'}});
    }
    if(url.startsWith(`${API}/mediaItems?`)) {
      const parsed=new URL(url);
      const second=Boolean(parsed.searchParams.get('pageToken'));
      return json({mediaItems:second ? options.secondPage??[] : options.items??[],...(!second&&options.secondPage?{nextPageToken:'second-page-token'}:{})});
    }
    if(url.startsWith('https://lh3.googleusercontent.com/')) {
      if(options.download) return options.download(url);
      const png=url.includes('png-photo');
      return new Response(png ? new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]) : new Uint8Array([255,216,255,224,1,2,3,4]),{headers:{'content-type':png?'image/png':'image/jpeg'}});
    }
    throw new Error('Unexpected mock request');
  });
  const {app,picker,media}=createApp(config,{google:new GoogleClient(config,fetchMock as typeof fetch),store:new session.MemoryStore()});
  cleanups.push(async()=>{await picker.dispose();media.db.close();await rm(directory,{recursive:true,force:true});});
  const agent=request.agent(app);
  const authorize=async(client=agent)=>{
    await client.get('/api/session').expect(200);
    const start=await client.get('/auth/google?person=person1').expect(302);
    const target=new URL(start.headers.location);
    const state=target.searchParams.get('state');
    const callback=await client.get('/auth/google/callback').query({state,code:'private-authorization-code'}).expect(302);
    const info=await client.get('/api/session').expect(200);
    return {target,callback,info:info.body,csrf:String(info.body.csrfToken)};
  };
  const create=async(csrf:string)=>{
    const response=await agent.post('/api/picker/sessions').set('Origin',config.webOrigin).set('X-CSRF-Token',csrf).send({contributorId:'person1'}).expect(201);
    return response.body as PickerState;
  };
  const startImport=async(id:string,csrf:string)=>{
    await agent.post(`/api/picker/sessions/${id}/import`).set('Origin',config.webOrigin).set('X-CSRF-Token',csrf).send({}).expect(202);
    for(let attempt=0;attempt<100;attempt++) {
      const response=await agent.get(`/api/picker/sessions/${id}`).expect(200);
      if(!['waiting','ready','importing'].includes(response.body.status)) return response.body as PickerState;
      await delay(10);
    }
    throw new Error('Mock import did not finish');
  };
  return {app,agent,config,directory,fetchMock,authorize,create,startImport};
}

describe('private API integration using the real OAuth and Google client flow',()=>{
  it('starts locally and keeps project, Picker metadata, and media unavailable anonymously',async()=>{
    const f=await fixture();
    const health=await request(f.app).get('/health').expect(200);
    expect(health.body).toEqual({status:'ok',phase:'P6'});
    for(const path of ['/api/project','/api/picker/sessions/unknown','/api/projects/unknown/assets/unknown/content']) await request(f.app).get(path).expect(401);
    expect(f.fetchMock).not.toHaveBeenCalled();
  });

  it('uses PKCE, single-use state, private cookies, and safe account status',async()=>{
    const f=await fixture();
    const {target,callback,info}=await f.authorize();
    expect(target.origin).toBe('https://accounts.google.com');
    expect(target.searchParams.get('scope')).toBe(PHOTOS_SCOPE);
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(callback.headers.location).toBe(`${f.config.webOrigin}/?auth=connected`);
    expect(String(callback.headers['set-cookie'])).toMatch(/HttpOnly/);
    expect(String(callback.headers['set-cookie'])).toMatch(/SameSite=Lax/);
    expect(info.authenticated).toBe(true);
    expect(JSON.stringify(info)).not.toContain(TOKEN);
    expect(JSON.stringify(info)).not.toContain(REFRESH);
    const tokenCalls=()=>f.fetchMock.mock.calls.filter(([url])=>String(url)==='https://oauth2.googleapis.com/token').length;
    expect(tokenCalls()).toBe(1);
    const replay=await f.agent.get('/auth/google/callback').query({state:target.searchParams.get('state'),code:'private-authorization-code'}).expect(302);
    expect(replay.headers.location).toContain('auth=invalid_state');
    expect(tokenCalls()).toBe(1);
  });

  it('reports rejected client credentials without authenticating or exposing details',async()=>{
    const f=await fixture({tokenError:true});
    const result=await f.authorize();
    expect(result.callback.headers.location).toBe(`${f.config.webOrigin}/?auth=invalid_credentials`);
    expect(result.info.authenticated).toBe(false);
    await f.agent.get('/api/project').expect(401);
  });

  it('retrieves every selected page, securely imports images, and enforces ownership and CSRF',async()=>{
    const jpeg=image('jpeg-photo');
    jpeg.mediaFile.filename='../../my-memory.jpg';
    const video={...image('video'),type:'VIDEO',mediaFile:{...image('video').mediaFile,mimeType:'video/mp4'}};
    const f=await fixture({items:[jpeg,video],secondPage:[image('png-photo','image/png')]});
    const {csrf}=await f.authorize();
    await f.agent.post('/api/picker/sessions').set('Origin',f.config.webOrigin).send({contributorId:'person1'}).expect(403);
    await f.agent.post('/api/picker/sessions').set('Origin','https://untrusted.example').set('X-CSRF-Token',csrf).send({contributorId:'person1'}).expect(403);
    const created=await f.create(csrf);
    expect(created.pickerUri).toMatch(/^https:\/\/photos\.google\.com\//);
    const done=await f.startImport(created.id,csrf);
    expect(done).toMatchObject({status:'complete',total:3,processed:3,imported:2,skipped:1,failed:0});
    expect(done.issues[0].message).toContain('Unsupported');
    const selectedPages=f.fetchMock.mock.calls.filter(([url])=>String(url).startsWith(`${API}/mediaItems?`));
    expect(selectedPages).toHaveLength(2);
    expect(new URL(String(selectedPages[1][0])).searchParams.get('pageToken')).toBe('second-page-token');
    const downloads=f.fetchMock.mock.calls.filter(([url])=>String(url).startsWith('https://lh3.googleusercontent.com/'));
    expect(downloads).toHaveLength(2);
    for(const [url,init] of downloads) {
      expect(String(url)).toMatch(/=d$/);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
      expect(init?.redirect).toBe('error');
    }
    expect(f.fetchMock.mock.calls.some(([url,init])=>String(url).includes('/sessions/')&&init?.method==='DELETE')).toBe(true);
    const project=(await f.agent.get('/api/project').expect(200)).body;
    expect(project.assets).toHaveLength(2);
    const asset=project.assets.find((item:{mimeType:string})=>item.mimeType==='image/jpeg');
    expect(asset).toBeDefined();
    expect(asset.filename).toBe('my-memory.jpg');
    expect(asset.url).toMatch(/^\/api\/projects\//);
    const content=await f.agent.get(asset.url).expect(200);
    expect(content.headers['content-type']).toContain('image/jpeg');
    expect(content.headers['cache-control']).toContain('no-store');
    await request(f.app).get(asset.url).expect(401);
    const foreign=request.agent(f.app);
    await f.authorize(foreign);
    await foreign.get(asset.url).expect(404);
    await foreign.get(`/api/picker/sessions/${created.id}`).expect(404);
    const metadata=await readFile(join(f.config.mediaStoragePath,project.project.id,'metadata.json'),'utf8');
    expect(metadata).not.toContain('googleusercontent.com');
    expect(metadata).not.toContain('baseUrl');
    expect(metadata).not.toContain(TOKEN);
    const files=await readdir(join(f.config.mediaStoragePath,project.project.id));
    expect(files.filter(file=>file.endsWith('.jpg')||file.endsWith('.png'))).toHaveLength(2);
    expect(files.every(file=>file==='metadata.json'||/^[a-f0-9-]{36}\.(jpg|png|metadata\.json)$/.test(file))).toBe(true);
    const mutation=`/api/projects/${project.project.id}/assets/${asset.id}`;
    await f.agent.patch(mutation).set('Origin',f.config.webOrigin).set('X-CSRF-Token',csrf).send({selected:false}).expect(200,{...asset,selected:false});
    await f.agent.delete(mutation).set('Origin',f.config.webOrigin).set('X-CSRF-Token',csrf).expect(204);
    await f.agent.get(asset.url).expect(404);
  });

  it('shows empty selections and cleans the completed Picker session',async()=>{
    const f=await fixture();
    const {csrf}=await f.authorize();
    const picker=await f.create(csrf);
    const done=await f.startImport(picker.id,csrf);
    expect(done.status).toBe('complete');
    expect(done.imported).toBe(0);
    expect(done.message).toContain('No photos were selected');
    expect(f.fetchMock.mock.calls.some(([,init])=>init?.method==='DELETE')).toBe(true);
  });

  it('rejects unsafe media hosts, oversized files, and mismatched types without leaving files',async()=>{
    const unsafe=image('unsafe');
    unsafe.mediaFile.baseUrl='https://googleusercontent.com.attacker.example/private';
    const f=await fixture({items:[unsafe,image('oversize'),image('wrong-type')],download:url=>url.includes('oversize') ? new Response(new Uint8Array([255,216,255]),{headers:{'content-type':'image/jpeg','content-length':String(MAX_IMAGE_BYTES+1)}}) : new Response('<svg></svg>',{headers:{'content-type':'image/svg+xml'}})});
    const {csrf}=await f.authorize();
    const picker=await f.create(csrf);
    const done=await f.startImport(picker.id,csrf);
    expect(done).toMatchObject({status:'complete',imported:0,failed:3});
    expect(f.fetchMock.mock.calls.some(([url])=>String(url).includes('attacker.example'))).toBe(false);
    const project=(await f.agent.get('/api/project').expect(200)).body;
    expect(project.assets).toHaveLength(0);
    expect(await readdir(join(f.config.mediaStoragePath,project.project.id))).toEqual(['metadata.json']);
  });

  it('enforces the streaming byte limit even when Content-Length is absent',async()=>{
    const f=await fixture({items:[image('stream-limit')],download:()=>{
      let chunks=0;
      return new Response(new ReadableStream<Uint8Array>({pull(controller){
        if(chunks++===0) controller.enqueue(new Uint8Array([255,216,255,224]));
        else if(chunks<=27) controller.enqueue(new Uint8Array(1024*1024));
        else controller.close();
      }}),{headers:{'content-type':'image/jpeg'}});
    }});
    const {csrf}=await f.authorize();
    const picker=await f.create(csrf);
    const done=await f.startImport(picker.id,csrf);
    expect(done).toMatchObject({imported:0,failed:1});
    const project=(await f.agent.get('/api/project').expect(200)).body;
    expect(await readdir(join(f.config.mediaStoragePath,project.project.id))).toEqual(['metadata.json']);
  });

  it('honors initial polling intervals and Retry-After, and cancels explicitly',async()=>{
    const f=await fixture({waiting:true,pollError:true});
    const {csrf}=await f.authorize();
    const picker=await f.create(csrf);
    const pollCalls=()=>f.fetchMock.mock.calls.filter(([url,init])=>String(url).startsWith(`${API}/sessions/`)&&init?.method!=='DELETE').length;
    await f.agent.get(`/api/picker/sessions/${picker.id}`).expect(200);
    expect(pollCalls()).toBe(0);
    await delay(1050);
    const rateLimited=(await f.agent.get(`/api/picker/sessions/${picker.id}`).expect(200)).body;
    expect(pollCalls()).toBe(1);
    expect(rateLimited.status).toBe('waiting');
    expect(rateLimited.message).toMatch(/retry|rate|temporar/i);
    expect(rateLimited.nextPollAt-Date.now()).toBeGreaterThan(1800);
    await f.agent.get(`/api/picker/sessions/${picker.id}`).expect(200);
    expect(pollCalls()).toBe(1);
    const cancelled=await f.agent.delete(`/api/picker/sessions/${picker.id}`).set('Origin',f.config.webOrigin).set('X-CSRF-Token',csrf).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(f.fetchMock.mock.calls.some(([,init])=>init?.method==='DELETE')).toBe(true);
  });

  it('expires a Picker at timeoutIn zero and attempts cleanup',async()=>{
    const f=await fixture({waiting:true,timeoutIn:'0s'});
    const {csrf}=await f.authorize();
    const picker=await f.create(csrf);
    expect(picker.status).toBe('expired');
    expect(picker.message).toContain('expired');
    expect(f.fetchMock.mock.calls.some(([,init])=>init?.method==='DELETE')).toBe(true);
  });

  it('blocks replacement sessions and account switching until failed cleanup succeeds',async()=>{
    const f=await fixture({cleanupFailures:1});
    const {csrf}=await f.authorize();
    const picker=await f.create(csrf);
    const done=await f.startImport(picker.id,csrf);
    expect(done.cleanupPending).toBe(true);
    await f.agent.post('/api/picker/sessions').set('Origin',f.config.webOrigin).set('X-CSRF-Token',csrf).send({contributorId:'person1'}).expect(409);
    await f.agent.get('/auth/google?person=person2').expect(409);
    const future=Date.now()+31_000;
    const time=vi.spyOn(Date,'now').mockReturnValue(future);
    try {
      const cleaned=await f.agent.get(`/api/picker/sessions/${picker.id}`).expect(200);
      expect(cleaned.body.cleanupPending).toBe(false);
    } finally {time.mockRestore();}
    expect((await f.create(csrf)).status).toBe('ready');
  });

  it('lets a user reconnect after revoked credentials without losing local workspace access',async()=>{
    const f=await fixture({waiting:true,revokeDuringPoll:true});
    const {csrf}=await f.authorize();
    const picker=await f.create(csrf);
    await delay(1050);
    const failed=await f.agent.get(`/api/picker/sessions/${picker.id}`).expect(200);
    expect(failed.body.status).toBe('paused');
    expect(failed.body.requiresAuthorization).toBe(true);
    expect(failed.body.message).toMatch(/expired|revoked|reconnect/i);
    const info=(await f.agent.get('/api/session').expect(200)).body;
    expect(info.authenticated).toBe(true);
    expect(info.contributors[0].connected).toBe(false);
    await f.agent.get('/api/project').expect(200);
    await f.agent.get('/auth/google?person=person1').expect(302);
  });
});
