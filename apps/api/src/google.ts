import { createHash, randomUUID } from 'node:crypto';
import type { Session, SessionData } from 'express-session';
import { z } from 'zod';
import type { ContributorId } from '@memories/shared';
import { PHOTOS_SCOPE, type Config } from './config.js';
import { ApiError } from './errors.js';
import { saveGoogleCredential } from './session-store.js';
import { googleDiagnostic, type GoogleDiagnostic, type GoogleOperation } from './google-diagnostics.js';

export interface Tokens {
  accessToken:string; refreshToken?:string; expiresAt:number; scope?:string;
  scopeVerifiedAt?:number; clientId?:string; accountId?:string; authorizationId?:string;
  requiresReauthorization?:boolean; authorizationError?:string; authorizationMessage?:string;
}
export interface GoogleConnectionStatus {connected:boolean;requiresReauthorization:boolean;reason?:string;message?:string;grantedScopes:string[];verified:boolean;}
export interface GoogleClientOptions {onDiagnostic?:(diagnostic:GoogleDiagnostic)=>void;}
const grantedScopes=(tokens:Tokens|undefined)=>tokens?.scope?.split(/\s+/).filter(Boolean) ?? [];
const authorizationFailureCodes=new Set(['RECONNECT_REQUIRED','MISSING_PHOTOS_SCOPE','WRONG_OAUTH_CLIENT','ACCOUNT_MISMATCH']);
const duration = z.string().regex(/^\d+(?:\.\d{1,9})?s$/);
export function parseDurationMs(value:string):number {
  const parsed = duration.safeParse(value);
  if (!parsed.success) throw new ApiError(502,'INVALID_GOOGLE_RESPONSE','Google returned an invalid polling duration. Please try again.');
  const milliseconds = Math.ceil(Number(value.slice(0,-1)) * 1000);
  if (!Number.isSafeInteger(milliseconds)) throw new ApiError(502,'INVALID_GOOGLE_RESPONSE','Google returned an invalid polling duration.');
  return milliseconds;
}
const pickingSessionSchema = z.object({
  id:z.string().min(1).max(1024),
  pickerUri:z.string().url().optional(),
  pollingConfig:z.object({pollInterval:duration,timeoutIn:duration}).optional(),
  expireTime:z.string().datetime({offset:true}),
  mediaItemsSet:z.boolean().default(false),
});
export type GooglePickingSession = z.infer<typeof pickingSessionSchema>;
const itemSchema = z.object({
  id:z.string().min(1).max(2048),
  createTime:z.string().datetime({offset:true}).optional(),
  type:z.string(),
  mediaFile:z.object({
    baseUrl:z.string().url().max(16384),
    mimeType:z.string().min(1).max(200),
    filename:z.string().max(4096).default('Untitled photo'),
    mediaFileMetadata:z.object({width:z.number().int().positive().optional(),height:z.number().int().positive().optional()}).passthrough().optional(),
  }).passthrough(),
}).passthrough();
export type PickedMediaItem = z.infer<typeof itemSchema>;
const pageSchema = z.object({mediaItems:z.array(itemSchema).max(100).default([]),nextPageToken:z.string().max(16384).optional()});
const tokenSchema = z.object({access_token:z.string().min(1).max(16384),refresh_token:z.string().min(1).max(16384).optional(),expires_in:z.number().positive().max(31536000),token_type:z.string().refine((type)=>type.toLowerCase()==='bearer'),scope:z.string().optional()});
type OAuthSession = Session & Partial<SessionData>;
type FetchLike = typeof fetch;
const API_BASE = 'https://photospicker.googleapis.com/v1';

export function imageDownloadUrl(baseUrl:string):string {
  let url:URL;
  try { url = new URL(baseUrl); } catch { throw new ApiError(502,'UNSAFE_MEDIA_URL','Google returned an unsupported media download URL.'); }
  // These are Google's media-serving hosts, never a caller-supplied arbitrary URL.
  // A label boundary prevents googleusercontent.com.attacker.example and suffix attacks.
  const host = url.hostname;
  if (url.protocol !== 'https:' || !(host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com')) || url.username || url.password || url.port || url.search || url.hash) {
    throw new ApiError(502,'UNSAFE_MEDIA_URL','Google returned an unsupported media download URL.');
  }
  return `${url.href}=d`;
}

function invalidResponse():never { throw new ApiError(502,'INVALID_GOOGLE_RESPONSE','Google returned an unexpected response. Please try connecting again.'); }
function parse<S extends z.ZodType>(schema:S, value:unknown):z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) return invalidResponse();
  return result.data;
}
async function json(response:Response):Promise<unknown> {
  // Limit API JSON independently from the streamed photo body.
  const chunks:Uint8Array[] = [];
  const reader = response.body?.getReader();
  if (!reader) return invalidResponse();
  let bytes = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) { await reader.cancel(); return invalidResponse(); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502,'GOOGLE_NETWORK_ERROR','Google could not be reached. Check your connection and try again.');
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { return invalidResponse(); }
}
function retryAfter(response:Response):number {
  const header = response.headers.get('retry-after');
  if (!header) return 30_000;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(ms) ? Math.max(1000, Math.min(ms, 60*60*1000)) : 30_000;
}
/** Classify Google's structured reason; an unexplained 403 is never treated as a disabled API. */
export function errorForGoogleDiagnostic(diagnostic:GoogleDiagnostic,retryAfterMs?:number):ApiError {
  const {httpStatus:status,reason,googleStatus,operation}=diagnostic;
  const token=operation==='oauth.token' || operation==='oauth.tokenInfo';
  const download=operation==='media.download';
  const why=(reason ?? '').toUpperCase();
  const message=diagnostic.message.toLowerCase();
  const error=(httpStatus:number,code:string,text:string,retry?:number)=>new ApiError(httpStatus,code,text,retry,diagnostic);
  if(status===429 || googleStatus==='RESOURCE_EXHAUSTED') return error(429,'GOOGLE_RATE_LIMIT','Google is limiting requests. The importer will wait before retrying.',retryAfterMs ?? 30000);
  if(status>=500) return error(503,'GOOGLE_UNAVAILABLE','Google Photos is temporarily unavailable. Please try again.',retryAfterMs ?? 30000);
  if(['INVALID_CLIENT','UNAUTHORIZED_CLIENT'].includes(why)) return error(503,'INVALID_GOOGLE_CREDENTIALS','Google rejected the OAuth client. GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must come from the same Web OAuth client. Check the registered callback URI.');
  if(['INVALID_GRANT','TOKEN_EXPIRED','TOKEN_REVOKED'].includes(why) || status===401 || (token && status===400)) return error(401,'RECONNECT_REQUIRED','Google authorization expired, was revoked, or no longer matches this OAuth client. Reconnect Google Photos.');
  if(['ACCESS_TOKEN_SCOPE_INSUFFICIENT','INSUFFICIENTPERMISSIONS','INSUFFICIENT_SCOPE'].includes(why) || message.includes('insufficient authentication scopes')) return error(403,'MISSING_PHOTOS_SCOPE','This Google token does not grant the Photos Picker permission. Reconnect Google Photos and approve access to the photos you select.');
  if(['SERVICE_DISABLED','API_DISABLED','ACCESSNOTCONFIGURED'].includes(why)) {
    const project=diagnostic.consumerProject?` for Cloud ${diagnostic.consumerProject}`:'';
    return error(403,'GOOGLE_API_DISABLED',`Google reports that the Photos Picker API is disabled${project}. Enable photospicker.googleapis.com in that exact OAuth client's project; enabling a different project does not apply.`);
  }
  if(['CONSUMER_INVALID','PROJECT_INVALID','PROJECT_NOT_FOUND','CONSUMER_PROJECT_MISMATCH'].includes(why)) return error(403,'WRONG_GOOGLE_PROJECT','Google rejected the API consumer project. Check that the OAuth client belongs to the Cloud project where Photos Picker API is enabled.');
  if(['ACCOUNT_MISMATCH','SESSION_ACCOUNT_MISMATCH','USER_MISMATCH','NOT_SESSION_OWNER','SESSION_NOT_OWNED_BY_USER'].includes(why)) return error(403,'ACCOUNT_MISMATCH','This Google account does not own this Picker selection. Reconnect the account that created it, or start a new selection with the intended account.');
  if(['ORG_RESTRICTION_VIOLATION','ACCESS_BLOCKED','ADMIN_POLICY_ENFORCED'].includes(why)) return error(403,'GOOGLE_ACCOUNT_POLICY','Google account policy blocked this request. Check your Workspace administrator policy and OAuth app access settings.');
  if(['TEST_USER_NOT_AUTHORIZED','APP_NOT_VERIFIED','TESTING_USER_NOT_ALLOWED'].includes(why)) return error(403,'GOOGLE_TEST_USER_REQUIRED','This OAuth app is in testing. Add this Google account under Google Auth Platform → Audience → Test users, then reconnect.');
  if(status===404 || status===410) return error(410,download?'MEDIA_URL_EXPIRED':'PICKER_EXPIRED',download?'The temporary photo URL expired. The importer will refresh live selection links when possible.':'This Google Picker session expired or was deleted. Start a new selection; completed photos remain safe.');
  if(status===403 && download) return error(403,'MEDIA_URL_EXPIRED','The temporary photo URL is no longer accessible. The importer will refresh links while the Picker session remains valid.');
  if(googleStatus==='FAILED_PRECONDITION' || (status===400 && !token)) {
    if(operation==='picker.sessions.create') return error(409,'GOOGLE_PHOTOS_ACCOUNT_REQUIRED','Google could not create a Picker session for this account. Confirm that the selected account has an active Google Photos library.');
    return error(409,'PICKER_NOT_READY','Google has not confirmed a completed photo selection. Finish in Google Photos with Done, then retry.');
  }
  if(status===403) return error(403,'GOOGLE_PERMISSION_DENIED',`Google denied ${operation}${reason?` (${reason})`:''}. The API response did not establish that the API is disabled. Check the granted Picker permission, the OAuth client's project, and account access settings.`);
  return error(502,download?'DOWNLOAD_FAILED':'GOOGLE_API_ERROR',`Google could not complete ${operation}${reason?` (${reason})`:''}. Please try again.`);
}

export class GoogleClient {
  private readonly refreshes = new Map<string, Promise<Tokens>>();
  private readonly verifications = new Map<string,Promise<Tokens>>();
  constructor(private readonly config:Config, private readonly fetchImpl:FetchLike=fetch, private readonly options:GoogleClientOptions={}) {}
  private record(diagnostic:GoogleDiagnostic):void {
    try {
      if(this.options.onDiagnostic) this.options.onDiagnostic(diagnostic);
      else if(diagnostic.httpStatus>=400) console.warn('Google API diagnostic',JSON.stringify(diagnostic));
    } catch { /* A diagnostic sink cannot change authentication or import behavior. */ }
  }
  private async responseError(response:Response,operation:GoogleOperation,secrets:string[]=[]):Promise<never> {
    let payload:unknown;
    try {payload=await json(response);} catch {payload=undefined;}
    const diagnostic=googleDiagnostic(operation,response.status,payload,[this.config.googleClientSecret,...secrets]);
    this.record(diagnostic);
    throw errorForGoogleDiagnostic(diagnostic,retryAfter(response));
  }
  private success(operation:GoogleOperation,status:number) {if(this.options.onDiagnostic)this.record({operation,httpStatus:status,message:'Google request succeeded.'});}
  private async markAuthorization(session:OAuthSession,contributorId:ContributorId,error:ApiError):Promise<void> {
    const credentials=session.credentials?.[contributorId];
    if(credentials) {
      await saveGoogleCredential(session,contributorId,credentials,{...credentials,requiresReauthorization:true,authorizationError:error.code,authorizationMessage:error.message});
    }
  }
  private checkKnownAuthorization(tokens:Tokens):void {
    if(tokens.requiresReauthorization) throw new ApiError(401,tokens.authorizationError ?? 'RECONNECT_REQUIRED',tokens.authorizationMessage ?? 'Reconnect Google Photos to renew this account authorization.');
    if(tokens.clientId && tokens.clientId!==this.config.googleClientId) throw new ApiError(401,'WRONG_OAUTH_CLIENT','The stored Google token belongs to another OAuth client. Reconnect using the client configured for this project.');
    if(tokens.scope!==undefined && !grantedScopes(tokens).includes(PHOTOS_SCOPE)) throw new ApiError(403,'MISSING_PHOTOS_SCOPE','The stored Google token is missing Photos Picker permission. Reconnect Google Photos and approve access to the photos you select.');
  }

  private async inspect(tokens:Tokens,force=false):Promise<Tokens> {
    this.checkKnownAuthorization(tokens);
    if(!force && tokens.scope!==undefined && tokens.clientId) return tokens;
    const key=createHash('sha256').update(tokens.accessToken).digest('hex');
    let pending=this.verifications.get(key);
    if(!pending) {
      pending=(async()=>{
        // Google's official Node OAuth client uses POST + bearer header for token inspection.
        const response=await this.request('https://oauth2.googleapis.com/tokeninfo',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded;charset=UTF-8',Authorization:`Bearer ${tokens.accessToken}`}});
        if(!response.ok) return this.responseError(response,'oauth.tokenInfo',[tokens.accessToken,tokens.refreshToken ?? '']);
        const schema=z.object({scope:z.string(),aud:z.string().optional(),issued_to:z.string().optional(),azp:z.string().optional(),sub:z.string().optional(),user_id:z.string().optional(),expires_in:z.coerce.number().optional()});
        const data=parse(schema,await json(response));
        const audience=data.aud ?? data.issued_to;
        if(!audience || audience!==this.config.googleClientId || (data.azp && data.azp!==this.config.googleClientId)) throw new ApiError(401,'WRONG_OAUTH_CLIENT','Google reports that this token was issued to a different OAuth client. Reconnect using the configured client; enable Picker in that client’s Cloud project.');
        const accountId=data.sub ?? data.user_id;
        if(tokens.accountId && accountId && tokens.accountId!==accountId) throw new ApiError(403,'ACCOUNT_MISMATCH','The Google token no longer belongs to the account that authorized this connection. Reconnect the original account.');
        const verified={...tokens,scope:data.scope,clientId:audience,accountId:accountId ?? tokens.accountId,scopeVerifiedAt:Date.now()};
        this.checkKnownAuthorization(verified);
        this.success('oauth.tokenInfo',response.status);
        return verified;
      })();
      this.verifications.set(key,pending);
    }
    try {return await pending;} finally {if(this.verifications.get(key)===pending)this.verifications.delete(key);}
  }

  async connectionStatus(session:OAuthSession,contributorId:ContributorId,options:{force?:boolean}={}):Promise<GoogleConnectionStatus> {
    if(!session.credentials?.[contributorId]) return {connected:false,requiresReauthorization:false,grantedScopes:[],verified:false};
    try {
      await this.accessToken(session,contributorId);
      const current=session.credentials![contributorId]!;
      if(options.force) {await saveGoogleCredential(session,contributorId,current,await this.inspect(current,true));}
      this.checkKnownAuthorization(session.credentials![contributorId]!);
      return {connected:true,requiresReauthorization:false,grantedScopes:grantedScopes(session.credentials![contributorId]!),verified:true};
    } catch(error) {
      if(error instanceof ApiError && error.code==='AUTHORIZATION_REPLACED')throw error;
      const code=error instanceof ApiError?error.code:'TOKEN_VERIFICATION_FAILED';
      if(error instanceof ApiError && authorizationFailureCodes.has(code)) await this.markAuthorization(session,contributorId,error);
      return {connected:false,requiresReauthorization:authorizationFailureCodes.has(code),reason:code,message:error instanceof ApiError?error.message:'Google authorization could not be verified. Try reconnecting.',grantedScopes:grantedScopes(session.credentials?.[contributorId]!),verified:false};
    }
  }

  authorizeUrl(state:string, verifier:string):string {
    if (!this.config.googleClientId || !this.config.googleClientSecret) throw new ApiError(503,'GOOGLE_NOT_CONFIGURED','Add your Google OAuth client credentials to .env and restart the API to connect Google Photos.');
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({client_id:this.config.googleClientId,redirect_uri:this.config.googleRedirectUri,response_type:'code',scope:PHOTOS_SCOPE,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',access_type:'offline',prompt:'consent select_account'}).toString();
    return url.href;
  }

  private async request(url:string, init:RequestInit={}):Promise<Response> {
    if (init.signal?.aborted) throw new ApiError(499,'IMPORT_CANCELLED','Import cancelled.');
    const timeout = AbortSignal.timeout(60_000);
    const signal = init.signal ? AbortSignal.any([init.signal,timeout]) : timeout;
    try { return await this.fetchImpl(url,{...init,redirect:'error',signal}); }
    catch {
      if (init.signal?.aborted) throw new ApiError(499,'IMPORT_CANCELLED','Import cancelled.');
      throw new ApiError(502,'GOOGLE_NETWORK_ERROR','Google could not be reached. Check your connection and try again.');
    }
  }

  private async tokens(body:Record<string,string>):Promise<Tokens> {
    const response=await this.request('https://oauth2.googleapis.com/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...body,client_id:this.config.googleClientId,client_secret:this.config.googleClientSecret})});
    if(!response.ok) return this.responseError(response,'oauth.token',Object.values(body));
    const data=parse(tokenSchema,await json(response));
    const tokens:Tokens={accessToken:data.access_token,refreshToken:data.refresh_token,expiresAt:Date.now()+data.expires_in*1000,scope:data.scope,clientId:this.config.googleClientId,scopeVerifiedAt:data.scope!==undefined?Date.now():undefined};
    this.checkKnownAuthorization(tokens);
    this.success('oauth.token',response.status);
    return tokens;
  }

  async exchangeCode(code:string,verifier:string):Promise<Tokens> {
    return {...await this.inspect(await this.tokens({grant_type:'authorization_code',code,code_verifier:verifier,redirect_uri:this.config.googleRedirectUri}),true),authorizationId:randomUUID()};
  }

  async accessToken(session:OAuthSession,contributorId:ContributorId,forceRefresh=false):Promise<string> {
    const current=session.credentials?.[contributorId];
    if(!current) throw new ApiError(401,'RECONNECT_REQUIRED','Connect this Google account before selecting photos.');
    try {
      this.checkKnownAuthorization(current);
      if(!forceRefresh && current.expiresAt>Date.now()+30000) {
        const verified=await this.inspect(current);
        if(verified!==current) {await saveGoogleCredential(session,contributorId,current,verified);this.checkKnownAuthorization(session.credentials![contributorId]!);}
        return verified.accessToken;
      }
      if(!current.refreshToken) throw new ApiError(401,'RECONNECT_REQUIRED','Google authorization expired and no refresh token is available. Reconnect Google Photos.');
      const generation=createHash('sha256').update(current.refreshToken).digest('hex');
      const key=`${session.workspaceId}:${contributorId}:${generation}`;
      let pending=this.refreshes.get(key);
      if(!pending) {
        pending=this.tokens({grant_type:'refresh_token',refresh_token:current.refreshToken}).then(async fresh=>{
          const merged={...current,...fresh,refreshToken:fresh.refreshToken ?? current.refreshToken,scope:fresh.scope ?? current.scope,scopeVerifiedAt:fresh.scopeVerifiedAt ?? current.scopeVerifiedAt,accountId:current.accountId,clientId:fresh.clientId ?? current.clientId};
          return this.inspect(merged);
        });
        this.refreshes.set(key,pending);
      }
      try {
        const fresh=await pending;
        const latest=session.credentials?.[contributorId];
        if(latest && latest!==current && latest.refreshToken!==current.refreshToken) throw new ApiError(409,'AUTHORIZATION_REPLACED','This account connection changed while a token refresh was running. Retry with the current connection.');
        await saveGoogleCredential(session,contributorId,current,fresh);this.checkKnownAuthorization(session.credentials![contributorId]!);
        return fresh.accessToken;
      } finally {if(this.refreshes.get(key)===pending)this.refreshes.delete(key);}
    } catch(error) {
      if(error instanceof ApiError && authorizationFailureCodes.has(error.code)) await this.markAuthorization(session,contributorId,error);
      throw error;
    }
  }

  private async authenticated(session:OAuthSession,contributorId:ContributorId,url:string,operation:GoogleOperation,init:RequestInit={}):Promise<Response> {
    const send=async(force:boolean)=>this.request(url,{...init,headers:{...init.headers,Authorization:`Bearer ${await this.accessToken(session,contributorId,force)}`}});
    let response=await send(false);
    if(response.status===401) {
      // Record the original failure before refreshing. It may be the only evidence for a transient 401.
      try {await this.responseError(response,operation,[session.credentials?.[contributorId]?.accessToken ?? '',session.credentials?.[contributorId]?.refreshToken ?? '']);} catch(error) {if(!(error instanceof ApiError))throw error;}
      response=await send(true);
    }
    if(!response.ok) {
      try {return await this.responseError(response,operation,[session.credentials?.[contributorId]?.accessToken ?? '',session.credentials?.[contributorId]?.refreshToken ?? '']);}
      catch(error) {if(error instanceof ApiError && authorizationFailureCodes.has(error.code))await this.markAuthorization(session,contributorId,error);throw error;}
    }
    this.success(operation,response.status);
    return response;
  }

  async createSession(session:OAuthSession, contributorId:ContributorId):Promise<GooglePickingSession> {
    const response = await this.authenticated(session,contributorId,`${API_BASE}/sessions`,'picker.sessions.create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});
    const picked = parse(pickingSessionSchema,await json(response));
    let valid = Boolean(picked.pickerUri && (picked.mediaItemsSet || picked.pollingConfig));
    if (picked.pickerUri) {
      try {
        const picker = new URL(picked.pickerUri);
        valid &&= picker.protocol === 'https:' && picker.hostname === 'photos.google.com' && !picker.port && !picker.username && !picker.password;
      } catch { valid = false; }
    }
    if (!valid) {
      try { await this.deleteSession(session,contributorId,picked.id); } catch { /* Best-effort cleanup of known Google session. */ }
      return invalidResponse();
    }
    return picked;
  }

  async getSession(session:OAuthSession, contributorId:ContributorId, id:string, signal?:AbortSignal):Promise<GooglePickingSession> {
    const response = await this.authenticated(session,contributorId,`${API_BASE}/sessions/${encodeURIComponent(id)}`,'picker.sessions.get',{signal});
    const picked = parse(pickingSessionSchema,await json(response));
    if (picked.id !== id || (!picked.mediaItemsSet && !picked.pollingConfig)) return invalidResponse();
    return picked;
  }

  async deleteSession(session:OAuthSession, contributorId:ContributorId, id:string):Promise<void> {
    try { await this.authenticated(session,contributorId,`${API_BASE}/sessions/${encodeURIComponent(id)}`,'picker.sessions.delete',{method:'DELETE'}); }
    catch (error) { if (!(error instanceof ApiError && error.code === 'PICKER_EXPIRED')) throw error; }
  }

  async listMediaItemsPage(session:OAuthSession, contributorId:ContributorId, sessionId:string, pageToken?:string, signal?:AbortSignal):Promise<{mediaItems:PickedMediaItem[];nextPageToken?:string}> {
    if(signal?.aborted) throw new ApiError(499,'IMPORT_CANCELLED','Import cancelled.');
    const url=new URL(`${API_BASE}/mediaItems`);
    url.search=new URLSearchParams({sessionId,pageSize:'100',...(pageToken?{pageToken}:{})}).toString();
    const response=await this.authenticated(session,contributorId,url.href,'picker.mediaItems.list',{signal});
    return parse(pageSchema,await json(response));
  }

  async listMediaItems(session:OAuthSession, contributorId:ContributorId, sessionId:string, signal?:AbortSignal):Promise<PickedMediaItem[]> {
    const items:PickedMediaItem[]=[];
    const seen=new Set<string>();
    let token:string|undefined;
    do {
      const page=await this.listMediaItemsPage(session,contributorId,sessionId,token,signal);
      items.push(...page.mediaItems);
      token=page.nextPageToken || undefined;
      if(token) {
        if(seen.has(token)) return invalidResponse();
        seen.add(token);
      }
    } while(token);
    return items;
  }

  async downloadMedia(session:OAuthSession, contributorId:ContributorId, baseUrl:string, signal?:AbortSignal):Promise<Response> {
    return this.authenticated(session,contributorId,imageDownloadUrl(baseUrl),'media.download',{signal});
  }
}
