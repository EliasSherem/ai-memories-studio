import { describe, expect, it, vi } from 'vitest';
import type { Session, SessionData } from 'express-session';
import { GoogleClient, errorForGoogleDiagnostic, type Tokens } from '../src/google.js';
import { googleDiagnostic, sanitizeGoogleMessage, type GoogleDiagnostic } from '../src/google-diagnostics.js';
import { loadConfig, PHOTOS_SCOPE } from '../src/config.js';

const config=loadConfig({SESSION_SECRET:'testing-session-secret-longer-than-thirty-two',GOOGLE_CLIENT_ID:'correct-client',GOOGLE_CLIENT_SECRET:'client-secret-private'});
function json(value:unknown,status=200) {return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
function owner(first:Partial<Tokens>={},second?:Partial<Tokens>) {
  const tokens={accessToken:'access-first-private',refreshToken:'refresh-first-private',expiresAt:Date.now()+3600000,scope:PHOTOS_SCOPE,clientId:config.googleClientId,scopeVerifiedAt:Date.now(),...first};
  return {workspaceId:'workspace',credentials:{person1:tokens,...(second?{person2:{...tokens,accessToken:'access-second-private',refreshToken:'refresh-second-private',...second}}:{})},save:vi.fn((cb:(error?:Error)=>void)=>cb())} as unknown as Session & SessionData;
}
const goodPicker={id:'picker-session',pickerUri:'https://photos.google.com/picker/a',expireTime:'2099-01-01T00:00:00Z',pollingConfig:{pollInterval:'1s',timeoutIn:'300s'}};
function errorInfo(reason:string,message='The request was denied.') {return {error:{code:403,status:'PERMISSION_DENIED',message,details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason,domain:'googleapis.com',metadata:{service:'photospicker.googleapis.com',consumer:'projects/123456789'}}]}};}

describe('safe Google diagnostics',()=>{
  it('keeps only operation/status/reason/project evidence and removes credentials and personal media details',()=>{
    const access='ya29.a-super-secret-access-token',refresh='1//refresh-private',secret='a-client-secret',code='4/a-private-authorization-code';
    const diagnostic=googleDiagnostic('picker.sessions.create',403,errorInfo('ACCESS_TOKEN_SCOPE_INSUFFICIENT',`Insufficient scopes. ${access} ${refresh} ${secret} ${code} user@example.com photo-name.jpg https://photos.google.com/private`),[access,refresh,secret,code]);
    expect(diagnostic).toMatchObject({operation:'picker.sessions.create',httpStatus:403,googleCode:403,googleStatus:'PERMISSION_DENIED',reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT',consumerProject:'projects/123456789'});
    const safe=JSON.stringify(diagnostic);
    for(const sensitive of [access,refresh,secret,code,'user@example.com','photo-name.jpg','https://photos.google.com/private']) expect(safe).not.toContain(sensitive);
    expect(diagnostic.message).toContain('Insufficient scopes');
    expect(sanitizeGoogleMessage('Token opaque_random_credential_value_that_is_longer_than_32')).not.toContain('opaque_random_credential');
  });
  it('does not infer a disabled API from an unexplained HTTP403',()=>{
    const diagnostic=googleDiagnostic('picker.sessions.create',403,{error:{code:403,status:'PERMISSION_DENIED',message:'Permission denied.'}});
    const error=errorForGoogleDiagnostic(diagnostic);
    expect(error).toMatchObject({code:'GOOGLE_PERMISSION_DENIED',diagnostic});
    expect(error.message).toContain('did not establish that the API is disabled');
  });
  it('redacts credential-shaped structured identifiers instead of trusting non-message fields',()=>{
    const diagnostic=googleDiagnostic('picker.sessions.create',403,{error:{status:'ya29.private-access-token',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'GOCSPX-private-client-secret',domain:'ya29.other-access-token'}]}});
    expect(diagnostic.googleStatus).toBeUndefined();expect(diagnostic.reason).toBeUndefined();expect(diagnostic.domain).toBeUndefined();
    expect(JSON.stringify(diagnostic)).not.toMatch(/ya29\.|GOCSPX-/);
  });
  it.each([
    ['SERVICE_DISABLED','GOOGLE_API_DISABLED','projects/123456789'],
    ['ACCESS_TOKEN_SCOPE_INSUFFICIENT','MISSING_PHOTOS_SCOPE','Reconnect'],
    ['SESSION_ACCOUNT_MISMATCH','ACCOUNT_MISMATCH','does not own'],
    ['CONSUMER_INVALID','WRONG_GOOGLE_PROJECT','consumer project'],
    ['TEST_USER_NOT_AUTHORIZED','GOOGLE_TEST_USER_REQUIRED','Audience → Test users'],
  ])('classifies %s using actual ErrorInfo instead of status alone',(reason,code,message)=>{
    const error=errorForGoogleDiagnostic(googleDiagnostic('picker.sessions.create',403,errorInfo(reason)));
    expect(error.code).toBe(code);expect(error.message).toContain(message);
  });
});

describe('stored Google authorization validation',()=>{
  it('requests exactly the Picker scope even if an unsafe Config object contains extra scopes',()=>{
    const client=new GoogleClient({...config,googlePhotosScope:`${PHOTOS_SCOPE} openid email`});
    const url=new URL(client.authorizeUrl('state','verifier'));
    expect(url.searchParams.get('scope')).toBe(PHOTOS_SCOPE);expect(url.searchParams.get('prompt')).toBe('consent select_account');
  });
  it('marks a missing stored grant as requiring reauthorization without contacting Picker',async()=>{
    const session=owner({scope:'https://www.googleapis.com/auth/photoslibrary.readonly'});const fetcher=vi.fn<typeof fetch>();
    const client=new GoogleClient(config,fetcher);
    expect(await client.connectionStatus(session,'person1')).toMatchObject({connected:false,requiresReauthorization:true,reason:'MISSING_PHOTOS_SCOPE'});
    await expect(client.createSession(session,'person1')).rejects.toMatchObject({code:'MISSING_PHOTOS_SCOPE'});
    expect(fetcher).not.toHaveBeenCalled();expect(session.credentials?.person1?.requiresReauthorization).toBe(true);
  });
  it('inspects a legacy token via POST bearer header and caches its granted scope and audience',async()=>{
    const session=owner({scope:undefined,clientId:undefined,scopeVerifiedAt:undefined});
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json({scope:PHOTOS_SCOPE,aud:config.googleClientId,expires_in:3600})).mockResolvedValueOnce(json(goodPicker));
    const client=new GoogleClient(config,fetcher);
    expect(await client.connectionStatus(session,'person1')).toMatchObject({connected:true,verified:true,grantedScopes:[PHOTOS_SCOPE]});
    await client.createSession(session,'person1');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]).toEqual(['https://oauth2.googleapis.com/tokeninfo',expect.objectContaining({method:'POST',headers:expect.objectContaining({Authorization:'Bearer access-first-private'})})]);
    expect(fetcher.mock.calls[1][0]).toBe('https://photospicker.googleapis.com/v1/sessions');
  });
  it('rejects an actually granted token audience from a different OAuth client',async()=>{
    const session=owner({clientId:undefined});const fetcher=vi.fn<typeof fetch>().mockResolvedValue(json({scope:PHOTOS_SCOPE,aud:'other-client',expires_in:3600}));
    const client=new GoogleClient(config,fetcher);
    expect(await client.connectionStatus(session,'person1')).toMatchObject({connected:false,requiresReauthorization:true,reason:'WRONG_OAUTH_CLIENT'});
    expect(fetcher).toHaveBeenCalledTimes(1);expect(session.credentials?.person1?.requiresReauthorization).toBe(true);
  });
  it('refreshes an expired token while retaining the previously verified grant when refresh omits scope',async()=>{
    const session=owner({expiresAt:0,accountId:'server-only-account'});const fetcher=vi.fn<typeof fetch>().mockResolvedValue(json({access_token:'refreshed-private',token_type:'Bearer',expires_in:3600}));
    const client=new GoogleClient(config,fetcher);
    expect(await client.accessToken(session,'person1')).toBe('refreshed-private');
    expect(session.credentials?.person1).toMatchObject({scope:PHOTOS_SCOPE,clientId:config.googleClientId,accountId:'server-only-account',refreshToken:'refresh-first-private'});
  });
  it('creates each Picker session with its own contributor token and emits only safe diagnostics',async()=>{
    const diagnostics:GoogleDiagnostic[]=[];const session=owner({},{});
    const fetcher=vi.fn<typeof fetch>().mockResolvedValueOnce(json(goodPicker)).mockResolvedValueOnce(json(errorInfo('ACCESS_TOKEN_SCOPE_INSUFFICIENT','Insufficient scopes for access-second-private.'),403));
    const client=new GoogleClient(config,fetcher,{onDiagnostic:diagnostic=>diagnostics.push(diagnostic)});
    await client.createSession(session,'person1');await expect(client.createSession(session,'person2')).rejects.toMatchObject({code:'MISSING_PHOTOS_SCOPE',diagnostic:{operation:'picker.sessions.create',httpStatus:403,reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}});
    expect(fetcher.mock.calls[0][1]?.headers).toMatchObject({Authorization:'Bearer access-first-private'});
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({Authorization:'Bearer access-second-private'});
    expect(session.credentials?.person1?.requiresReauthorization).not.toBe(true);expect(session.credentials?.person2?.requiresReauthorization).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain('access-second-private');
  });
});
