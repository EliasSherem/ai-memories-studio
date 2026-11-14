import session from 'express-session';
import type { RequestHandler } from 'express';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContributorId } from '@memories/shared';
import type { Tokens } from './google.js';
import type { GoogleDiagnostic } from './google-diagnostics.js';
import { ApiError } from './errors.js';

declare module 'express-session' {
  interface SessionData {
    workspaceId: string;
    csrfToken: string;
    authorizedAt?:number;
    googleDiagnostics?:Partial<Record<ContributorId,GoogleDiagnostic>>;
    credentials?: Partial<Record<ContributorId, Tokens>>;
    oauth?: { state: string; verifier: string; contributorId: ContributorId; createdAt: number; processing?:boolean };
  }
}

export const ensureSession: RequestHandler = (req, _res, next) => {
  req.session.workspaceId ||= randomUUID();
  req.session.csrfToken ||= randomBytes(32).toString('base64url');
  next();
};

export function saveSession(value: session.Session): Promise<void> {
  return new Promise((resolve, reject) => value.save((error) => error ? reject(error) : resolve()));
}

const credentialWriter=Symbol('google-credential-writer');
const requestBaseline=Symbol('session-request-baseline');
type CredentialMap=NonNullable<session.SessionData['credentials']>;
type BoundSession=session.Session & Partial<session.SessionData> & {
  [credentialWriter]?: (contributorId:ContributorId,previous:Tokens|undefined,next:Tokens|undefined)=>Promise<Tokens|undefined>;
  [requestBaseline]?:session.SessionData;
};
const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const sameGeneration=(a:Tokens|undefined,b:Tokens|undefined)=>!a || !b ? a===b : a.accessToken===b.accessToken && a.refreshToken===b.refreshToken && a.authorizationId===b.authorizationId;
const replaced=()=>new ApiError(409,'AUTHORIZATION_REPLACED','This Google account connection changed during the request. Reload the studio and use the current connection.');

/** Serializes session writes and applies only changes made by this request, slot by slot. */
class CredentialPersistence {
  private readonly pending=new Map<string,Promise<unknown>>();
  private readonly revoked=new Set<string>();
  private readonly rawGet:session.Store['get'];
  private readonly rawSet:session.Store['set'];
  constructor(private readonly store:session.Store) {
    this.rawGet=store.get.bind(store);this.rawSet=store.set.bind(store);
    const rawDestroy=store.destroy.bind(store);
    store.set=(sid,data,callback)=>{
      this.serial(sid,async()=>{
        if(this.isRevoked(sid))throw replaced();
        const baseline=(data as BoundSession)[requestBaseline];
        const latest=baseline?await this.read(sid):undefined;
        if(this.isRevoked(sid))throw replaced();
        const merged=baseline && latest ? this.merge(latest,baseline,data) : data;
        await this.write(sid,merged);
        if(baseline) {
          // One request can save several times (e.g. OAuth processing then callback result).
          // Advance its baseline and canonical data together so a later save cannot treat
          // concurrently added credentials as an intentional deletion.
          for(const key of Object.keys(baseline))delete (baseline as unknown as Record<string,unknown>)[key];
          Object.assign(baseline,copy(merged));
          for(const key of Object.keys(data))if(!(key in merged))delete (data as unknown as Record<string,unknown>)[key];
          Object.assign(data,merged);
        }
      }).then(()=>callback?.(),error=>callback?.(error));
    };
    store.destroy=(sid,callback)=>{
      // Revoke synchronously, before an already-running request can save or set its cookie.
      this.revoked.add(sid);
      this.serial(sid,()=>new Promise<void>((resolve,reject)=>rawDestroy(sid,error=>error?reject(error):resolve()))).then(()=>callback?.(),error=>callback?.(error));
    };
  }
  isRevoked(sid:string):boolean {return this.revoked.has(sid) || (this.store instanceof EncryptedSessionStore && this.store.isRevoked(sid));}
  private read(sid:string):Promise<session.SessionData|null|undefined> {return new Promise((resolve,reject)=>this.rawGet(sid,(error,data)=>error?reject(error):resolve(data)));}
  private write(sid:string,data:session.SessionData):Promise<void> {return new Promise((resolve,reject)=>this.rawSet(sid,data,error=>error?reject(error):resolve()));}
  private serial<T>(sid:string,action:()=>Promise<T>):Promise<T> {
    const operation=(this.pending.get(sid) ?? Promise.resolve()).catch(()=>{}).then(action);
    this.pending.set(sid,operation);
    void operation.then(()=>{},()=>{}).finally(()=>{if(this.pending.get(sid)===operation)this.pending.delete(sid);});
    return operation;
  }
  private nextCredential(latest:Tokens|undefined,previous:Tokens|undefined,next:Tokens|undefined):Tokens|undefined {
    // A verification or refresh cannot undo Google's rejection of the same consent grant.
    // Only an explicitly replaced authorization generation can clear that state.
    const sameGrant=latest && next && (latest.authorizationId || next.authorizationId ? latest.authorizationId===next.authorizationId : latest.refreshToken===next.refreshToken);
    if(latest?.requiresReauthorization && !next?.requiresReauthorization && sameGrant)return latest;
    if(sameGeneration(latest,previous))return next;
    if(sameGeneration(latest,next))return latest; // An identical concurrent refresh already committed; keep later rejection flags.
    throw replaced();
  }
  private merge(latest:session.SessionData,baseline:session.SessionData,data:session.SessionData):session.SessionData {
    const result=copy(latest) as session.SessionData & Record<string,unknown>;
    const before=baseline as session.SessionData & Record<string,unknown>;
    const after=data as session.SessionData & Record<string,unknown>;
    for(const key of new Set([...Object.keys(before),...Object.keys(after)])) {
      if(key==='credentials' || key==='googleDiagnostics')continue;
      if(key==='cookie') {result.cookie=data.cookie;continue;}
      if(equal(before[key],after[key]))continue;
      if(['workspaceId','csrfToken','oauth'].includes(key) && !equal(result[key],before[key]) && !equal(result[key],after[key]))throw replaced();
      if(after[key]===undefined)delete result[key];else result[key]=after[key];
    }
    const credentials:CredentialMap={...latest.credentials};
    for(const contributorId of ['person1','person2'] as const) {
      const previous=baseline.credentials?.[contributorId],next=data.credentials?.[contributorId];
      if(!equal(previous,next)) {
        const safe=this.nextCredential(latest.credentials?.[contributorId],previous,next);
        if(safe)credentials[contributorId]=safe;else delete credentials[contributorId];
      }
    }
    result.credentials=credentials;
    const diagnostics={...latest.googleDiagnostics};
    for(const contributorId of ['person1','person2'] as const) {
      if(!equal(baseline.googleDiagnostics?.[contributorId],data.googleDiagnostics?.[contributorId])) {
        if(data.googleDiagnostics?.[contributorId])diagnostics[contributorId]=data.googleDiagnostics[contributorId];else delete diagnostics[contributorId];
      }
    }
    result.googleDiagnostics=diagnostics;
    return result;
  }
  attach(value:BoundSession):void {
    if(value[credentialWriter])return;
    const baseline=copy(value) as session.SessionData;
    Object.defineProperty(value,requestBaseline,{value:baseline,enumerable:false});
    Object.defineProperty(value,credentialWriter,{enumerable:false,value:async(contributorId:ContributorId,previous:Tokens|undefined,next:Tokens|undefined)=>{
      const saved=await this.serial(value.id,async()=>{
        if(this.isRevoked(value.id))throw replaced();
        const latest=await this.read(value.id);
        if(!latest || latest.workspaceId!==value.workspaceId || this.isRevoked(value.id))throw replaced();
        const canonical=this.nextCredential(latest.credentials?.[contributorId],previous,next);
        const credentials={...latest.credentials};if(canonical)credentials[contributorId]=canonical;else delete credentials[contributorId];
        await this.write(value.id,{...latest,credentials});
        return canonical;
      });
      value.credentials ||= {};baseline.credentials ||= {};
      if(saved) {value.credentials[contributorId]=saved;baseline.credentials[contributorId]=copy(saved);}
      else {delete value.credentials[contributorId];delete baseline.credentials[contributorId];}
      return saved;
    }});
  }
}
const persistence=new WeakMap<session.Store,CredentialPersistence>();
function persistenceFor(store:session.Store):CredentialPersistence {
  let value=persistence.get(store);
  if(!value) {value=new CredentialPersistence(store);persistence.set(store,value);}
  return value;
}

/** Bind before asynchronous Google calls; ordinary OAuth/CSRF saves still merge their own fields. */
export function bindCredentialPersistence(store:session.Store):RequestHandler {
  const adapter=persistenceFor(store);
  return (req,res,next)=>{
    adapter.attach(req.session);
    const writeHead=res.writeHead;
    res.writeHead=function(this:typeof res,...args:Parameters<typeof res.writeHead>) {
      // Suppress a stale rolling cookie if OAuth rotated the SID while this request was waiting.
      if(req.session && adapter.isRevoked(req.session.id)) (req as unknown as {session:null}).session=null;
      return writeHead.apply(this,args);
    } as typeof res.writeHead;
    next();
  };
}
export async function saveGoogleCredential(value:BoundSession,contributorId:ContributorId,previous:Tokens|undefined,next:Tokens|undefined):Promise<Tokens|undefined> {
  const writer=value[credentialWriter];
  if(writer)return writer(contributorId,previous,next);
  value.credentials ||= {};if(next)value.credentials[contributorId]=next;else delete value.credentials[contributorId];
  await saveSession(value);
  return next;
}

/** Restore server credentials for a background worker without a browser request. */
export async function loadStoredSession(store:session.Store,sid:string):Promise<(session.Session & session.SessionData)|null> {
  const adapter=persistenceFor(store);
  if(adapter.isRevoked(sid))return null;
  const data=await new Promise<session.SessionData|null|undefined>((resolve,reject)=>store.get(sid,(error,value)=>error?reject(error):resolve(value)));
  if(!data || !data.workspaceId || (data.cookie?.expires && new Date(data.cookie.expires).getTime()<=Date.now()))return null;
  const value={...data} as session.Session & session.SessionData;
  Object.defineProperty(value,'id',{value:sid,enumerable:false});
  Object.defineProperty(value,'save',{enumerable:false,value:(callback:(error?:unknown)=>void)=>{store.set(sid,value,callback);return value;}});
  adapter.attach(value);
  return value;
}

/** Encrypted, local-only server sessions. The browser holds only a signed opaque ID. */
export class EncryptedSessionStore extends session.Store {
  private readonly key: Buffer;
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly directory: string, secret: string) {
    super();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.key = createHash('sha256').update('ai-memories-studio:sessions:').update(secret).digest();
  }

  private path(sid: string) { return join(this.directory, `${createHash('sha256').update(sid).digest('hex')}.json`); }
  private revokedPath(sid:string) {return `${this.path(sid)}.revoked`;}
  isRevoked(sid:string):boolean {return existsSync(this.revokedPath(sid));}

  private async read(sid: string): Promise<session.SessionData | null> {
    if(this.isRevoked(sid))return null;
    try {
      const payload = JSON.parse(await readFile(this.path(sid), 'utf8')) as {iv:string;tag:string;data:string};
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
      decipher.setAAD(Buffer.from(sid));
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(payload.data, 'base64')), decipher.final()]);
      const data = JSON.parse(plain.toString('utf8')) as session.SessionData;
      if (!data.cookie || !data.cookie.expires || new Date(data.cookie.expires).getTime() <= Date.now()) {
        await rm(this.path(sid), {force:true});
        return null;
      }
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      // Invalid ciphertext (including a changed secret) must never authenticate a session.
      if (error instanceof SyntaxError || (error as Error).message.includes('authenticate') || (error as Error).message.includes('Invalid')) return null;
      throw error;
    }
  }

  private async write(sid:string, data:session.SessionData) {
    if(this.isRevoked(sid))throw replaced();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(sid));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
    const payload = JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});
    const target = this.path(sid);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, payload, {mode:0o600,flag:'wx'});
      if(this.isRevoked(sid))throw replaced();
      await rename(temporary, target);
    } finally { await rm(temporary, {force:true}); }
  }

  private serial(sid:string, action:()=>Promise<unknown>, callback?: (error?:unknown)=>void) {
    const promise = (this.pending.get(sid) ?? Promise.resolve()).catch(() => {}).then(action);
    this.pending.set(sid, promise);
    promise.then(() => callback?.(), (error) => callback?.(error)).finally(() => { if (this.pending.get(sid) === promise) this.pending.delete(sid); });
  }

  get(sid:string, callback:(error:unknown, session?:session.SessionData|null)=>void) {
    void (this.pending.get(sid) ?? Promise.resolve()).catch(() => {}).then(() => this.read(sid)).then((data) => callback(null,data), callback);
  }

  set(sid:string, data:session.SessionData, callback?:(error?:unknown)=>void) {
    this.serial(sid, () => this.write(sid,data), callback);
  }

  destroy(sid:string, callback?:(error?:unknown)=>void) {
    this.serial(sid, async()=>{await writeFile(this.revokedPath(sid),'revoked',{mode:0o600});await rm(this.path(sid),{force:true});}, callback);
  }

  touch(sid:string, data:session.SessionData, callback?:(error?:unknown)=>void) {
    this.serial(sid, async () => {
      const latest = await this.read(sid);
      if (latest) await this.write(sid, {...latest,cookie:data.cookie});
    }, callback);
  }
}
