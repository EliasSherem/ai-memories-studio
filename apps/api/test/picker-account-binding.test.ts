import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, SessionData } from 'express-session';
import { MediaStore } from '../src/media-store.js';
import { PickerManager } from '../src/picker-manager.js';
import { PHOTOS_SCOPE } from '../src/config.js';

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
async function fixture(verified=true) {
  const root=await mkdtemp(join(tmpdir(),'picker-account-binding-'));
  const expires=new Date(Date.now()+3600000).toISOString();
  const google={createSession:vi.fn().mockResolvedValue({id:'account-a-picker',pickerUri:'https://photos.google.com/picker/test',expireTime:expires,mediaItemsSet:true}),getSession:vi.fn().mockResolvedValue({id:'account-a-picker',expireTime:expires,mediaItemsSet:true}),deleteSession:vi.fn().mockResolvedValue(undefined),listMediaItems:vi.fn().mockResolvedValue([]),downloadMedia:vi.fn()};
  const media=new MediaStore(root,{minFreeDiskBytes:0});const picker=new PickerManager(google,media);
  cleanups.push(async()=>{await picker.dispose();media.db.close();await rm(root,{recursive:true,force:true});});
  const credentials={person1:{accessToken:'first-access',refreshToken:'first-grant',scope:PHOTOS_SCOPE,clientId:'configured-client',expiresAt:Date.now()+3600000,...(verified?{accountId:'account-a'}:{})},person2:{accessToken:'second-access',refreshToken:'second-grant',scope:PHOTOS_SCOPE,clientId:'configured-client',expiresAt:Date.now()+3600000,accountId:'account-b'}};
  const value={id:'original-session',workspaceId:randomUUID(),csrfToken:'csrf',credentials,save:(callback:(error?:unknown)=>void)=>callback()} as unknown as Session & SessionData;
  return {picker,google,media,value};
}

describe('durable Picker account ownership',()=>{
  it('does not resume an account-A Picker using account-B credentials after reconnection',async()=>{
    const {picker,google,value}=await fixture();const selected=await picker.create(value,'person1');
    const otherSlot=structuredClone(value.credentials!.person2);
    value.credentials!.person1={...value.credentials!.person1!,accessToken:'other-access',refreshToken:'other-grant',accountId:'account-b'};
    const result=await picker.resume(value,selected.id);
    expect(result).toMatchObject({status:'paused',requiresAuthorization:true});expect(result.message).toContain('different Google account');
    expect(google.getSession).not.toHaveBeenCalled();expect(google.downloadMedia).not.toHaveBeenCalled();expect(value.credentials!.person2).toEqual(otherSlot);
  });
  it('allows a new grant for the same verified Google account without touching the other slot',async()=>{
    const {picker,google,value}=await fixture();const selected=await picker.create(value,'person1');
    value.credentials!.person1={...value.credentials!.person1!,accessToken:'renewed-access',refreshToken:'renewed-grant'};
    const result=await picker.resume(value,selected.id);
    expect(result.status).toBe('importing');expect(google.getSession).toHaveBeenCalledWith(expect.objectContaining({credentials:expect.objectContaining({person1:expect.objectContaining({accountId:'account-a'})})}),'person1','account-a-picker');
    expect(value.credentials!.person2?.accessToken).toBe('second-access');
  });
  it('requests a new selection if grant ownership cannot be established from Google metadata',async()=>{
    const {picker,google,value,media}=await fixture(false);const selected=await picker.create(value,'person1');
    const row=media.db.connection.prepare('SELECT account_id,credential_fingerprint FROM import_jobs WHERE id=?').get(selected.id) as {account_id:string|null;credential_fingerprint:string};
    expect(row.account_id).toBeNull();expect(row.credential_fingerprint).not.toContain('first-grant');
    value.credentials!.person1={...value.credentials!.person1!,accessToken:'replacement-access',refreshToken:'replacement-grant'};
    const result=await picker.resume(value,selected.id);
    expect(result).toMatchObject({status:'paused',requiresAuthorization:false,requiresReselection:true});
    expect(result.message).toContain('did not supply an account identifier');expect(google.getSession).not.toHaveBeenCalled();
  });
  it('keeps an unidentified account bound to the same consent grant when refresh tokens rotate',async()=>{
    const {picker,google,value}=await fixture(false);
    value.credentials!.person1!.authorizationId='same-consent-grant';
    const selected=await picker.create(value,'person1');
    value.credentials!.person1={...value.credentials!.person1!,accessToken:'rotated-access',refreshToken:'rotated-refresh'};
    const result=await picker.resume(value,selected.id);
    expect(result.status).toBe('importing');expect(google.getSession).toHaveBeenCalledWith(expect.anything(),'person1','account-a-picker');
  });
});
