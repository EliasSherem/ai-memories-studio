import { describe, expect, it, vi } from 'vitest';
import type { Session, SessionData } from 'express-session';
import { GoogleClient, imageDownloadUrl, parseDurationMs, type Tokens } from '../src/google.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({SESSION_SECRET:'test-secret-that-is-longer-than-32-characters',GOOGLE_CLIENT_ID:'client',GOOGLE_CLIENT_SECRET:'secret'});
const goodSession = {id:'google-session',pickerUri:'https://photos.google.com/picker/session',expireTime:'2099-01-01T00:00:00Z',pollingConfig:{pollInterval:'3.5s',timeoutIn:'600s'},mediaItemsSet:false};
const photo = {id:'photo',type:'PHOTO',mediaFile:{baseUrl:'https://lh3.googleusercontent.com/p/one',mimeType:'image/jpeg',filename:'memory.jpg'}};
function response(value:unknown, status=200, headers:Record<string,string>={}) { return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}}); }
function owner(tokens:Partial<Tokens>={}) {
  const value = {id:'opaque-session',workspaceId:'workspace',csrfToken:'csrf',credentials:{person1:{accessToken:'access',refreshToken:'refresh',expiresAt:Date.now()+3600_000,scope:config.googlePhotosScope,clientId:config.googleClientId,scopeVerifiedAt:Date.now(),...tokens}},save:vi.fn((cb:(error?:Error)=>void)=>cb())};
  return value as unknown as Session & Partial<SessionData>;
}

describe('documented Picker API client',()=>{
  it('creates and polls the Picker service with bearer credentials and validates output',async()=>{
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(goodSession)).mockResolvedValueOnce(response({...goodSession,mediaItemsSet:true,pollingConfig:undefined}));
    const google = new GoogleClient(config,fetcher);
    const session = owner();
    expect(await google.createSession(session,'person1')).toEqual(goodSession);
    expect((await google.getSession(session,'person1',goodSession.id)).mediaItemsSet).toBe(true);
    expect(fetcher.mock.calls[0][0]).toBe('https://photospicker.googleapis.com/v1/sessions');
    expect(fetcher.mock.calls[0][1]).toMatchObject({method:'POST',headers:{Authorization:'Bearer access'},redirect:'error'});
    expect(fetcher.mock.calls[1][0]).toBe('https://photospicker.googleapis.com/v1/sessions/google-session');
  });

  it('reads every page including an empty intermediate page',async()=>{
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({mediaItems:[photo],nextPageToken:'page2'})).mockResolvedValueOnce(response({nextPageToken:'page3'})).mockResolvedValueOnce(response({mediaItems:[{...photo,id:'photo2'}]}));
    const result = await new GoogleClient(config,fetcher).listMediaItems(owner(),'person1','session with spaces');
    expect(result).toHaveLength(2);
    expect(new URL(fetcher.mock.calls[0][0] as string).searchParams.get('sessionId')).toBe('session with spaces');
    expect(new URL(fetcher.mock.calls[1][0] as string).searchParams.get('pageToken')).toBe('page2');
    expect(new URL(fetcher.mock.calls[2][0] as string).searchParams.get('pageToken')).toBe('page3');
  });

  it('rejects repeated page tokens and malformed Google data',async()=>{
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({nextPageToken:'loop'}));
    await expect(new GoogleClient(config,fetcher).listMediaItems(owner(),'person1','id')).rejects.toMatchObject({code:'INVALID_GOOGLE_RESPONSE'});
    fetcher.mockReset().mockResolvedValue(response({id:'missing-fields'}));
    await expect(new GoogleClient(config,fetcher).createSession(owner(),'person1')).rejects.toMatchObject({code:'INVALID_GOOGLE_RESPONSE'});
  });

  it('downloads documented =d content with bearer auth, never a browser media URL',async()=>{
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array([255,216,255]),{headers:{'content-type':'image/jpeg'}}));
    await new GoogleClient(config,fetcher).downloadMedia(owner(),'person1',photo.mediaFile.baseUrl);
    expect(fetcher.mock.calls[0]).toEqual(['https://lh3.googleusercontent.com/p/one=d',expect.objectContaining({headers:{Authorization:'Bearer access'},redirect:'error'})]);
    for (const url of ['http://lh3.googleusercontent.com/x','https://googleusercontent.com.evil.test/x','https://evilgoogleusercontent.com/x','http://127.0.0.1/x','https://user:pass@lh3.googleusercontent.com/x','https://lh3.googleusercontent.com:444/x','https://lh3.googleusercontent.com/x?redirect=http://localhost','file:///etc/passwd']) {
      expect(()=>imageDownloadUrl(url)).toThrow('unsupported media download URL');
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('cleans up a known new session if its pickerUri is unsafe',async()=>{
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({...goodSession,pickerUri:'https://evil.test/'})).mockResolvedValueOnce(response({}));
    await expect(new GoogleClient(config,fetcher).createSession(owner(),'person1')).rejects.toMatchObject({code:'INVALID_GOOGLE_RESPONSE'});
    expect(fetcher.mock.calls[1]).toEqual(['https://photospicker.googleapis.com/v1/sessions/google-session',expect.objectContaining({method:'DELETE'})]);
  });

  it('honors rate-limit feedback and sanitizes upstream messages',async()=>{
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({error:{message:'secret-token-and-private-url'}},429,{'retry-after':'17'}));
    await expect(new GoogleClient(config,fetcher).createSession(owner(),'person1')).rejects.toMatchObject({status:429,code:'GOOGLE_RATE_LIMIT',retryAfterMs:17_000});
    fetcher.mockResolvedValue(response({error:{message:'secret-token-and-private-url'}},403));
    await expect(new GoogleClient(config,fetcher).createSession(owner(),'person1')).rejects.toMatchObject({code:'GOOGLE_PERMISSION_DENIED',message:expect.not.stringContaining('secret-token')});
  });

  it('serializes refresh across concurrent cloned session snapshots',async()=>{
    let resolveRefresh!:(value:Response)=>void;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(()=>new Promise((resolve)=>{resolveRefresh=resolve;}));
    const google = new GoogleClient(config,fetcher);
    const first=owner({expiresAt:0}), second=owner({expiresAt:0});
    const a=google.accessToken(first,'person1'), b=google.accessToken(second,'person1');
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveRefresh(response({access_token:'new-access',expires_in:3600,token_type:'Bearer'}));
    expect(await Promise.all([a,b])).toEqual(['new-access','new-access']);
    expect(first.credentials?.person1).toMatchObject({accessToken:'new-access',refreshToken:'refresh'});
    expect(second.credentials?.person1).toEqual(first.credentials?.person1);
    expect(first.save).toHaveBeenCalled(); expect(second.save).toHaveBeenCalled();
  });

  it('marks revoked refresh credentials for reconnection without losing the reason',async()=>{
    const session=owner({expiresAt:0});
    const fetcher=vi.fn<typeof fetch>().mockResolvedValue(response({error:'invalid_grant',error_description:'do not leak'},400));
    await expect(new GoogleClient(config,fetcher).accessToken(session,'person1')).rejects.toMatchObject({status:401,code:'RECONNECT_REQUIRED'});
    expect(session.credentials?.person1).toMatchObject({requiresReauthorization:true,authorizationError:'RECONNECT_REQUIRED'}); expect(session.save).toHaveBeenCalled();
  });

  it('stops pagination and downloads promptly when the user cancels',async()=>{
    const controller=new AbortController();
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>{
      controller.abort();
      return response({mediaItems:[photo],nextPageToken:'next'});
    });
    const google=new GoogleClient(config,fetcher);
    await expect(google.listMediaItems(owner(),'person1','session',controller.signal)).rejects.toMatchObject({code:'IMPORT_CANCELLED'});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(google.downloadMedia(owner(),'person1',photo.mediaFile.baseUrl,controller.signal)).rejects.toMatchObject({code:'IMPORT_CANCELLED'});
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refreshes once on 401 and requires reconnection if Google still rejects the token',async()=>{
    const session=owner();
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(response({},401)).mockResolvedValueOnce(response({access_token:'new-access',expires_in:3600,token_type:'Bearer'})).mockResolvedValueOnce(response({},401));
    await expect(new GoogleClient(config,fetcher).createSession(session,'person1')).rejects.toMatchObject({code:'RECONNECT_REQUIRED'});
    expect(fetcher).toHaveBeenCalledTimes(3); expect(session.credentials?.person1).toMatchObject({requiresReauthorization:true,authorizationError:'RECONNECT_REQUIRED'});
  });

  it('parses fractional protobuf durations and rejects invalid/overflow durations',()=>{
    expect(parseDurationMs('3.5s')).toBe(3500); expect(parseDurationMs('0s')).toBe(0); expect(parseDurationMs('0.000000001s')).toBe(1);
    for(const value of ['-1s','1second','Infinitys','9999999999999999999999s']) expect(()=>parseDurationMs(value)).toThrow();
  });
});
