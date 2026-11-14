import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionData } from 'express-session';
import { EncryptedSessionStore, loadStoredSession, saveGoogleCredential, saveSession } from '../src/session-store.js';
import { GoogleClient } from '../src/google.js';
import { loadConfig, PHOTOS_SCOPE } from '../src/config.js';

const directories:string[]=[];
afterEach(async()=>{await Promise.all(directories.splice(0).map((directory)=>rm(directory,{recursive:true,force:true})));});
function set(store:EncryptedSessionStore,id:string,data:SessionData) {return new Promise<void>((resolve,reject)=>store.set(id,data,(error)=>error?reject(error):resolve()));}
function get(store:EncryptedSessionStore,id:string) {return new Promise<SessionData|null|undefined>((resolve,reject)=>store.get(id,(error,data)=>error?reject(error):resolve(data)));}
function value():SessionData {return {cookie:{expires:new Date(Date.now()+60_000)} as SessionData['cookie'],workspaceId:'private-workspace',csrfToken:'private-csrf',credentials:{person1:{accessToken:'personal-access-token',refreshToken:'personal-refresh-token',expiresAt:Date.now()+3600_000}}};}
describe('private encrypted local sessions',()=>{
  it('persists ownership and credentials across process/store restarts without plaintext secrets',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'memories-sessions-'));directories.push(dir);
    const store=new EncryptedSessionStore(dir,'long-secret');
    await set(store,'opaque-id',value());
    const files=await readdir(dir);expect(files).toHaveLength(1);
    const payload=await readFile(join(dir,files[0]),'utf8');
    expect(payload).not.toContain('personal-access-token');expect(payload).not.toContain('private-workspace');
    expect((await stat(dir)).mode&0o777).toBe(0o700);expect((await stat(join(dir,files[0]))).mode&0o777).toBe(0o600);
    const restored=await get(new EncryptedSessionStore(dir,'long-secret'),'opaque-id');
    expect(restored?.credentials?.person1?.refreshToken).toBe('personal-refresh-token');
    expect(await get(new EncryptedSessionStore(dir,'different-secret'),'opaque-id')).toBeNull();
    expect(await get(store,'../../opaque-id')).toBeNull();
  });

  it('touches cookie expiry without overwriting refreshed credentials from a stale request',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'memories-sessions-'));directories.push(dir);
    const store=new EncryptedSessionStore(dir,'long-secret');const stale=value();
    await set(store,'id',stale);
    const refreshed=value();refreshed.credentials!.person1!.accessToken='new-access';
    await set(store,'id',refreshed);
    await new Promise<void>((resolve,reject)=>store.touch('id',stale,(error)=>error?reject(error):resolve()));
    expect((await get(store,'id'))?.credentials?.person1?.accessToken).toBe('new-access');
  });

  it('rejects expired sessions and destroys them',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'memories-sessions-'));directories.push(dir);
    const store=new EncryptedSessionStore(dir,'long-secret');const expired=value();expired.cookie.expires=new Date(0);
    await set(store,'id',expired);expect(await get(store,'id')).toBeNull();expect(await readdir(dir)).toEqual([]);
    await set(store,'id',value());
    await new Promise<void>((resolve,reject)=>store.destroy('id',(error)=>error?reject(error):resolve()));
    expect(await get(store,'id')).toBeNull();
  });

  it('merges only the changed contributor while preserving a concurrently connected second account',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'memories-session-slots-'));directories.push(dir);
    const store=new EncryptedSessionStore(dir,'long-secret');await set(store,'id',value());
    const first=await loadStoredSession(store,'id'),second=await loadStoredSession(store,'id');
    const secondGrant={accessToken:'second-account',refreshToken:'second-refresh',expiresAt:Date.now()+3600_000,authorizationId:'second-grant'};
    await saveGoogleCredential(second!,'person2',undefined,secondGrant);
    const original=first!.credentials!.person1!;
    await saveGoogleCredential(first!,'person1',original,{...original,accessToken:'first-refreshed'});
    // Express saves at response end, after the explicit credential patch has already committed.
    await saveSession(first!);
    second!.oauth={state:'new-oauth-state',verifier:'new-pkce-verifier',contributorId:'person2',createdAt:Date.now()};
    await saveSession(second!);await saveSession(first!);
    const restored=await get(store,'id');
    expect(restored?.credentials?.person1?.accessToken).toBe('first-refreshed');
    expect(restored?.credentials?.person2).toEqual(secondGrant);
    expect(restored?.oauth?.state).toBe('new-oauth-state');
  });

  it('rejects a stale refresh generation without replacing a newer authorization in the same slot',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'memories-session-generation-'));directories.push(dir);
    const store=new EncryptedSessionStore(dir,'long-secret');await set(store,'id',value());
    const old=await loadStoredSession(store,'id'),newer=await loadStoredSession(store,'id');
    const initial=old!.credentials!.person1!;
    const replacement={...initial,accessToken:'new-consented-token',refreshToken:'new-consented-refresh',authorizationId:'new-authorization'};
    await saveGoogleCredential(newer!,'person1',newer!.credentials!.person1!,replacement);
    await expect(saveGoogleCredential(old!,'person1',initial,{...initial,accessToken:'obsolete-refresh'})).rejects.toMatchObject({code:'AUTHORIZATION_REPLACED'});
    await saveSession(old!);
    expect((await get(store,'id'))?.credentials?.person1).toEqual(replacement);
  });

  it('does not resurrect a destroyed SID when an in-flight Google refresh completes after OAuth rotation',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'memories-session-rotation-'));directories.push(dir);
    const store=new EncryptedSessionStore(dir,'long-secret');const initial=value();
    initial.credentials!.person1={...initial.credentials!.person1!,expiresAt:0,scope:PHOTOS_SCOPE,clientId:'client',authorizationId:'old-grant'};
    await set(store,'old-sid',initial);
    const request=await loadStoredSession(store,'old-sid');
    let complete!:(response:Response)=>void;
    const fetcher=vi.fn<typeof fetch>().mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const client=new GoogleClient(loadConfig({SESSION_SECRET:'session-secret-longer-than-thirty-two-chars',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'client-secret'}),fetcher);
    const refreshing=client.accessToken(request!,'person1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve,reject)=>store.destroy('old-sid',error=>error?reject(error):resolve()));
    const newSession=value();newSession.credentials!.person1!.accessToken='new-session-token';await set(store,'new-sid',newSession);
    complete(new Response(JSON.stringify({access_token:'late-old-token',expires_in:3600,token_type:'Bearer'}),{headers:{'content-type':'application/json'}}));
    await expect(refreshing).rejects.toMatchObject({code:'AUTHORIZATION_REPLACED'});
    await expect(saveSession(request!)).rejects.toMatchObject({code:'AUTHORIZATION_REPLACED'});
    expect(await get(store,'old-sid')).toBeNull();expect((await get(store,'new-sid'))?.credentials?.person1?.accessToken).toBe('new-session-token');
    const restarted=new EncryptedSessionStore(dir,'long-secret');
    await expect(set(restarted,'old-sid',initial)).rejects.toMatchObject({code:'AUTHORIZATION_REPLACED'});
    expect(await get(restarted,'old-sid')).toBeNull();
  });

  it('keeps a later reauthorization flag when identical concurrent refreshes finish out of order',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'memories-session-rejection-'));directories.push(dir);
    const store=new EncryptedSessionStore(dir,'long-secret');await set(store,'id',value());
    const a=await loadStoredSession(store,'id'),b=await loadStoredSession(store,'id');const before=a!.credentials!.person1!;
    const refreshed={...before,accessToken:'refreshed-identical'};
    await saveGoogleCredential(a!,'person1',before,refreshed);
    await saveGoogleCredential(a!,'person1',refreshed,{...refreshed,requiresReauthorization:true,authorizationError:'MISSING_PHOTOS_SCOPE'});
    const canonical=await saveGoogleCredential(b!,'person1',b!.credentials!.person1!,refreshed);
    expect(canonical).toMatchObject({requiresReauthorization:true,authorizationError:'MISSING_PHOTOS_SCOPE'});
    await saveSession(b!);
    expect((await get(store,'id'))?.credentials?.person1).toMatchObject({requiresReauthorization:true,authorizationError:'MISSING_PHOTOS_SCOPE'});
  });

  it('does not let a concurrent verification clear a newly discovered missing-scope rejection',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'memories-session-rejected-scope-'));directories.push(dir);
    const store=new EncryptedSessionStore(dir,'long-secret');const initial=value();initial.credentials!.person1!.authorizationId='same-consent-grant';await set(store,'id',initial);
    const verifying=await loadStoredSession(store,'id'),rejecting=await loadStoredSession(store,'id');
    const original=verifying!.credentials!.person1!;
    await saveGoogleCredential(rejecting!,'person1',rejecting!.credentials!.person1!,{...original,requiresReauthorization:true,authorizationError:'MISSING_PHOTOS_SCOPE'});
    const result=await saveGoogleCredential(verifying!,'person1',original,{...original,scope:PHOTOS_SCOPE,scopeVerifiedAt:Date.now()});
    expect(result).toMatchObject({requiresReauthorization:true,authorizationError:'MISSING_PHOTOS_SCOPE'});
    await saveSession(verifying!);
    expect((await get(store,'id'))?.credentials?.person1?.requiresReauthorization).toBe(true);
    const replacement={...original,accessToken:'explicitly-reauthorized',authorizationId:'new-consent-grant'};
    await saveGoogleCredential(verifying!,'person1',result,replacement);
    expect((await get(store,'id'))?.credentials?.person1).toMatchObject({authorizationId:'new-consent-grant'});
    expect((await get(store,'id'))?.credentials?.person1?.requiresReauthorization).not.toBe(true);
  });
  it('allows one OAuth callback to save processing state and then consume it in the same request',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'memories-session-callback-'));directories.push(dir);
    const store=new EncryptedSessionStore(dir,'long-secret');const pending=value();
    pending.oauth={state:'pending-state',verifier:'pending-verifier',contributorId:'person1',createdAt:Date.now()};await set(store,'id',pending);
    const request=await loadStoredSession(store,'id');request!.oauth!.processing=true;await saveSession(request!);
    delete request!.oauth;await saveSession(request!);
    expect((await get(store,'id'))?.oauth).toBeUndefined();
    expect((await get(store,'id'))?.credentials?.person1?.accessToken).toBe('personal-access-token');
  });
});
