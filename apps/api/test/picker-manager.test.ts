import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session, SessionData } from 'express-session';
import { MediaStore } from '../src/media-store.js';
import { PickerManager } from '../src/picker-manager.js';
import { ApiError } from '../src/errors.js';

const disposals:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse()) await dispose();vi.useRealTimers();});
async function fixture(overrides:Record<string,unknown>={}) {
  const root=await mkdtemp(path.join(tmpdir(),'memories-picker-'));disposals.push(()=>rm(root,{recursive:true,force:true}));
  const google={createSession:vi.fn().mockResolvedValue({id:'google-session',pickerUri:'https://photos.google.com/picker/test',expireTime:new Date(Date.now()+3600_000).toISOString(),pollingConfig:{pollInterval:'3.5s',timeoutIn:'60s'},mediaItemsSet:false}),getSession:vi.fn(),deleteSession:vi.fn().mockResolvedValue(undefined),listMediaItems:vi.fn().mockResolvedValue([]),downloadMedia:vi.fn(),...overrides};
  const media=new MediaStore(root);const manager=new PickerManager(google,media);disposals.push(async()=>{await manager.dispose();media.db.close();});
  const session={workspaceId:randomUUID(),csrfToken:'csrf',credentials:{person1:{accessToken:'access',expiresAt:Date.now()+3600_000}},save:(callback:(error?:unknown)=>void)=>callback()} as Session & SessionData;
  return {manager,google,session,root};
}
async function terminal(manager:PickerManager,session:Session & SessionData,id:string) {
  for(let i=0;i<30;i++) {const state=await manager.get(session,id);if(!['waiting','ready','importing'].includes(state.status))return state;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('Job did not finish');
}
describe('Picker lifecycle coordination',()=>{
  it('respects intervals, never extends waiting timeout, and reserves a poll while in flight',async()=>{
    const {manager,google,session}=await fixture();vi.useFakeTimers({toFake:['Date']});
    const state=await manager.create(session,'person1');
    await manager.get(session,state.id);expect(google.getSession).not.toHaveBeenCalled();
    let resolvePoll!:(value:unknown)=>void;
    google.getSession.mockImplementation(()=>new Promise(resolve=>{resolvePoll=resolve;}));
    vi.setSystemTime(Date.now()+3500);
    const first=manager.get(session,state.id),second=manager.get(session,state.id);
    await new Promise(resolve=>setTimeout(resolve,0));
    expect(google.getSession).toHaveBeenCalledTimes(1);
    resolvePoll({id:'google-session',expireTime:new Date(Date.now()+3600_000).toISOString(),pollingConfig:{pollInterval:'4s',timeoutIn:'60s'},mediaItemsSet:false});
    const [a,b]=await Promise.all([first,second]);
    expect(a.deadline).toBe(state.deadline);expect(b.pollIntervalMs).toBe(4000);
    expect(a.nextPollAt).toBe(Date.now()+4000);
    const outsider={...session,workspaceId:randomUUID()} as Session & SessionData;
    await expect(manager.get(outsider,state.id)).rejects.toMatchObject({status:404});
  });
  it('expires and deletes sessions even when selection was never completed',async()=>{
    const {manager,google,session}=await fixture();const state=await manager.create(session,'person1');
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(state.deadline+1);
    expect((await manager.get(session,state.id)).status).toBe('expired');
    expect(google.deleteSession).toHaveBeenCalledWith(expect.anything(),'person1','google-session');expect(session.pendingPicker).toBeUndefined();
  });
  it('blocks a new selection until failed cleanup succeeds, preserving session tracking',async()=>{
    const {manager,google,session}=await fixture();
    google.deleteSession.mockRejectedValue(new ApiError(503,'GOOGLE_UNAVAILABLE','Try later'));
    const state=await manager.create(session,'person1');
    expect((await manager.cancel(session,state.id)).cleanupPending).toBe(true);
    await expect(manager.create(session,'person1')).rejects.toMatchObject({code:'PICKER_ACTIVE'});
    expect(manager.latest(session)?.id).toBe(state.id);expect(manager.hasPending(session.workspaceId)).toBe(true);
    google.deleteSession.mockResolvedValue(undefined);
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+30001);
    expect((await manager.get(session,state.id)).cleanupPending).toBe(false);
    expect(session.pendingPicker).toBeUndefined();expect(manager.hasPending(session.workspaceId)).toBe(false);
  });
  it('handles an empty confirmed selection and cleans up after import',async()=>{
    const {manager,google,session}=await fixture();
    google.createSession.mockResolvedValue({id:'google-session',pickerUri:'https://photos.google.com/picker/test',expireTime:new Date(Date.now()+3600_000).toISOString(),mediaItemsSet:true});
    const state=await manager.create(session,'person1');await manager.startImport(session,state.id);
    const done=await terminal(manager,session,state.id);
    expect(done).toMatchObject({status:'complete',total:0,imported:0});expect(done.message).toContain('No photos');expect(google.deleteSession).toHaveBeenCalledTimes(1);
  });
  it('requests renewed selection when refreshed temporary URLs are still expired',async()=>{
    const {manager,google,session}=await fixture();
    google.createSession.mockResolvedValue({id:'google-session',pickerUri:'https://photos.google.com/picker/test',expireTime:new Date(Date.now()+3600_000).toISOString(),mediaItemsSet:true});
    const photo={id:'photo',type:'PHOTO',mediaFile:{baseUrl:'https://lh3.googleusercontent.com/x',filename:'test.png',mimeType:'image/png'}};
    google.listMediaItems.mockResolvedValue([photo]);google.downloadMedia.mockRejectedValue(new ApiError(410,'MEDIA_URL_EXPIRED','Select photos again.'));
    const state=await manager.create(session,'person1');await manager.startImport(session,state.id);
    const done=await terminal(manager,session,state.id);
    expect(done.status).toBe('expired');expect(done.requiresReselection).toBe(true);expect(google.downloadMedia).toHaveBeenCalledTimes(2);
    await manager.drain();expect(google.deleteSession).toHaveBeenCalledTimes(1);
  });
});
