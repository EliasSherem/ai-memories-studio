import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import session from 'express-session';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { DirectorStore } from '../src/director-store.js';
import { MediaStore } from '../src/media-store.js';
import { loadConfig } from '../src/config.js';
import type { JsonGenerator, StoryboardContent } from '@memories/shared';

class InspectableStore extends session.MemoryStore {
  latestId='';
  override set(id:string,data:session.SessionData,callback?:(error?:unknown)=>void) {this.latestId=id;super.set(id,data,callback);}
  async authorize() {
    const sid=this.latestId;
    const data=await new Promise<session.SessionData>((resolve,reject)=>this.get(sid,(error,value)=>error?reject(error):resolve(value!)));
    data.authorizedAt=Date.now();
    await new Promise<void>((resolve,reject)=>this.set(sid,data,error=>error?reject(error):resolve()));
    return data.workspaceId;
  }
}
const disposals:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse()) await dispose();});
async function fixture(gemini?:JsonGenerator) {
  const root=await mkdtemp(join(tmpdir(),'memories-director-api-'));
  const config=loadConfig({SESSION_SECRET:'test-only-private-director-secret-at-least-32-chars',MEDIA_STORAGE_PATH:join(root,'imports'),DATABASE_PATH:join(root,'studio.sqlite'),NODE_ENV:'test',MIN_FREE_DISK_BYTES:'0'});
  const store=new InspectableStore();
  const app=createApp(config,{store,gemini});
  const agent=request.agent(app.app);
  const initial=(await agent.get('/api/session')).body;
  const owner=await store.authorize();
  await app.directorStore.ensure(owner);
  disposals.push(async()=>{await Promise.all([app.analysis.dispose(),app.picker.dispose()]);app.media.db.close();await rm(root,{recursive:true,force:true});});
  const seed=async(count=10)=>{
    const ids:string[]=[];
    for(let index=0;index<count;index++) {
      const id=randomUUID();ids.push(id);
      const file=await sharp({create:{width:12,height:12,channels:3,background:{r:20+index,g:50,b:80}}}).jpeg().toBuffer();
      await writeFile(join(config.mediaStoragePath,owner,`${id}.jpg`),file);
      const asset={id,projectId:owner,contributorId:'person1',filename:`Photo ${index}.jpg`,mimeType:'image/jpeg',bytes:file.length,sha256:`hash-${index}`,importedAt:new Date().toISOString(),selected:true,storageName:`${id}.jpg`};
      app.media.db.connection.prepare('INSERT INTO assets(id,project_id,sha256,storage_name,bytes,selected,public_json) VALUES(?,?,?,?,?,1,?)').run(id,owner,asset.sha256,asset.storageName,file.length,JSON.stringify(asset));
    }
    return ids;
  };
  const mutate=(method:'post'|'put'|'patch',path:string,body:unknown)=>agent[method](path).set('Origin',config.webOrigin).set('X-CSRF-Token',initial.csrfToken).send(body as object);
  return {...app,agent,config,owner,root,seed,mutate,sessionStore:store};
}

describe('private P3 API and additive migrations',()=>{
  it('returns cached analysis previews before applying the page limit and excludes pending or stale results',async()=>{
    const f=await fixture();const ids=(await f.seed(4)).sort();
    const result={schemaVersion:'1.0',sharpness:85,exposure:80,composition:90,animationSuitability:88,storytellingPotential:91,suitability:'ANIMATED_ORIGINAL',description:'A visible outdoor scene.',sceneType:'outdoors',visibleLocations:[],activities:[],objects:[],emotionalTone:'warm',diversityTags:[],uncertaintyNotes:[]};
    for(const [index,id] of ids.entries()) {
      if(index===0) continue;
      const asset=f.media.db.connection.prepare('SELECT sha256 FROM assets WHERE id=?').get(id) as {sha256:string};
      f.media.db.connection.prepare('INSERT INTO p3_photo_analysis(asset_id,project_id,sha256,model,pipeline_version,result_json,completed_at) VALUES(?,?,?,?,?,?,?)').run(id,f.owner,asset.sha256,index===1?'old-model':f.config.geminiModel!,f.config.analysisPipelineVersion!,JSON.stringify(result),new Date().toISOString());
    }
    const path='/api/director/photos';
    const first=(await f.agent.get(path).query({analyzedOnly:'true',limit:1}).expect(200)).body;
    expect(first.photos).toHaveLength(1);expect(first.photos[0]).toMatchObject({assetId:ids[2],analysis:result});
    const second=(await f.agent.get(path).query({analyzedOnly:'true',limit:1,afterId:first.nextCursor}).expect(200)).body;
    expect(second.photos.map((photo:{assetId:string})=>photo.assetId)).toEqual([ids[3]]);
    await f.agent.get(path).query({analyzedOnly:'invalid'}).expect(400);
  });
  it('saves immutable storyboard versions, exports privately, and rechecks consent, edits and missing files',async()=>{
    const f=await fixture();const ids=await f.seed(10);
    for(const [index,id] of (['person1','person2'] as const).entries()) await f.directorStore.saveProtagonist(f.owner,id,{name:index?'Jamie':'Alex',referencePhotoIds:ids.slice(index*5,index*5+2),likenessPermissionConfirmed:true});
    const content:StoryboardContent={schemaVersion:'1.0',title:'Our story',synopsis:'An original-photo and imagined cinematic story.',targetDurationSeconds:150,scenes:Array.from({length:6},(_,index)=>({
      id:randomUUID(),sequenceNumber:index+1,type:index<3?'ORIGINAL_ANIMATION':'NEW_CINEMATIC_SCENE',title:index<3?'A visible moment':'Fictional cinematic moment',description:index<3?'Animate the original composition.':'An imagined, fictional scene inspired by the references.',durationSeconds:25,sourcePhotoIds:[ids[0],ids[5]],protagonistIds:['person1','person2'],visualStyle:'Warm cinematic light',cameraDirection:'Slow push',motionPrompt:'Subtle movement',emotionalTone:'Warm',continuityNotes:'Thematic placement; date unknown.',generationInstructions:'Use the confirmed private references.',isFictional:index>=3,requiresUserConfirmation:index>=3,userConfirmed:true,
    }))};
    const first=await f.director.save(f.owner,content);
    expect(first).toMatchObject({version:1,readyForVideoGeneration:true});
    const exportPath=`/api/director/storyboards/${first.id}/export`;
    await request(f.app).get(exportPath).expect(401);
    await f.agent.get(exportPath).expect(200).then(result=>expect(result.headers['content-disposition']).toContain('storyboard-v1.json'));
    const edited=structuredClone(content);edited.scenes[0].durationSeconds=24;
    const second=(await f.mutate('put',`/api/director/storyboards/${first.id}`,edited).expect(200)).body;
    expect(second).toMatchObject({version:2,readyForVideoGeneration:false});
    expect(second.validationIssues.join(' ')).toContain('149 seconds');
    expect(f.directorStore.getStoryboard(f.owner,first.id)?.scenes[0].durationSeconds).toBe(25);
    const third=(await f.mutate('put',`/api/director/storyboards/${second.id}`,content).expect(200)).body;
    expect(third).toMatchObject({version:3,readyForVideoGeneration:true});
    await f.directorStore.saveProtagonist(f.owner,'person1',{name:'New name',referencePhotoIds:ids.slice(0,5),likenessPermissionConfirmed:true});
    expect(f.director.get(f.owner,third.id)?.readyForVideoGeneration).toBe(false);
    await rm(join(f.config.mediaStoragePath,f.owner,`${ids[0]}.jpg`));
    const board=(await f.agent.get(`/api/director/storyboards/${third.id}/export`).expect(200)).body;
    expect(board.readyForVideoGeneration).toBe(false);expect(board.validationIssues.join(' ')).toMatch(/file is missing|reference photo|2–10/);
    const other=request.agent(f.app);await other.get('/api/session');await f.sessionStore.authorize();
    await other.get(exportPath).expect(404);
  });
  it('promotes a remaining duplicate root when an imported source is deleted',async()=>{
    const f=await fixture();const ids=(await f.seed(5)).sort();
    const insert=f.media.db.connection.prepare('INSERT INTO p3_local_features(asset_id,project_id,sha256,features_json,phash,duplicate_of) VALUES(?,?,?,?,?,?)');
    for(const id of ids) insert.run(id,f.owner,'hash','{}','0000000000000000',id===ids[0]?null:ids[0]);
    await f.media.delete(f.owner,f.owner,ids[0]);
    const rows=f.media.db.connection.prepare('SELECT asset_id,duplicate_of FROM p3_local_features ORDER BY asset_id').all() as {asset_id:string;duplicate_of:string|null}[];
    expect(rows).toHaveLength(4);expect(rows[0]).toEqual({asset_id:ids[1],duplicate_of:null});
    expect(rows.slice(1).every(row=>row.duplicate_of===ids[1])).toBe(true);
  });
  it('keeps all director state private and never triggers Gemini on page view',async()=>{
    const gemini={generateJson:vi.fn()};const f=await fixture(gemini);await f.seed(1);
    for(const path of ['/api/director','/api/director/photos','/api/director/protagonists','/api/director/curation']) await request(f.app).get(path).expect(401);
    const state=(await f.agent.get('/api/director').expect(200)).body;
    expect(state).toMatchObject({totalImported:1,analyzed:0,pending:1,configured:true});
    expect(state.protagonists).toHaveLength(2);
    expect(gemini.generateJson).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toMatch(/apiKey|accessToken|refreshToken|storageName/);
    const photos=(await f.agent.get('/api/director/photos').expect(200)).body.photos;
    expect(photos[0].asset.url).toMatch(/^\/api\/projects\//);
    expect(photos[0].assetId).toBe(photos[0].asset.id);
    expect(photos[0].asset.storageName).toBeUndefined();
  });
  it('persists explicit protagonist references and enforces ownership and CSRF',async()=>{
    const f=await fixture();const ids=await f.seed();
    const path='/api/director/protagonists/person1';
    await f.agent.put(path).send({}).expect(403);
    const body={name:'Alex',referencePhotoIds:ids.slice(0,5),likenessPermissionConfirmed:true};
    const saved=(await f.mutate('put',path,body).expect(200)).body;
    expect(saved).toMatchObject({name:'Alex',ready:true,referencePhotoIds:body.referencePhotoIds});
    const photos=(await f.agent.get('/api/director/photos').expect(200)).body.photos;
    expect(photos.filter((row:{curation:{protagonistIds:string[]}})=>row.curation.protagonistIds.includes('person1'))).toHaveLength(5);
    await f.mutate('put',path,{...body,referencePhotoIds:[randomUUID()]}).expect(404);
    await f.mutate('put',path,{...body,referencePhotoIds:[ids[0],ids[0]]}).expect(400);
    await f.mutate('put',path,{...body,referencePhotoIds:ids.slice(0,2)}).expect(200).then(result=>expect(result.body.ready).toBe(true));
    await f.mutate('put',path,{...body,referencePhotoIds:ids.slice(0,1)}).expect(200).then(result=>expect(result.body.ready).toBe(false));
    await f.mutate('put',path,{...body,referencePhotoIds:ids.slice(0,2),likenessPermissionConfirmed:false}).expect(200).then(result=>expect(result.body.ready).toBe(false));
    const second=request.agent(f.app);await second.get('/api/session');await f.sessionStore.authorize();
    await second.get(`/api/projects/${f.owner}/assets/${ids[0]}/content`).expect(404);
    const info=(await second.get('/api/session')).body;
    await second.put(path).set('Origin',f.config.webOrigin).set('X-CSRF-Token',info.csrfToken).send(body).expect(404);
  });
  it('paginates metadata and supports manual pin, exclusion and two-person associations',async()=>{
    const f=await fixture();const ids=await f.seed(7);
    const all:string[]=[];let cursor:string|undefined;
    do {
      const page=(await f.agent.get('/api/director/photos').query({limit:3,...(cursor?{afterId:cursor}:{})}).expect(200)).body;
      all.push(...page.photos.map((row:{asset:{id:string}})=>row.asset.id));cursor=page.nextCursor;
    } while(cursor);
    expect(new Set(all).size).toBe(7);expect(all).toEqual([...ids].sort());
    const path=`/api/director/photos/${ids[0]}`;
    await f.mutate('patch',path,{pinned:true,protagonistIds:['person1','person2']}).expect(200).then(result=>expect(result.body).toMatchObject({pinned:true,associationsConfirmed:true}));
    await f.mutate('patch',path,{excluded:true}).expect(200).then(result=>expect(result.body).toMatchObject({excluded:true,pinned:false}));
    await f.mutate('patch',path,{pinned:true,excluded:true}).expect(400);
    await f.mutate('post','/api/director/analysis',{}).expect(503).then(result=>expect(result.body.error.code).toBe('GEMINI_NOT_CONFIGURED'));
  });
  it('upgrades and reopens the same P2 database without losing media or lowering its version',async()=>{
    const f=await fixture();const ids=await f.seed(1);
    const reopened=new MediaStore(f.config.mediaStoragePath,{databasePath:f.config.databasePath,sessionSecret:f.config.sessionSecret});
    try {
      const store=new DirectorStore(reopened,f.config);await store.ensure(f.owner);
      expect(store.rows(f.owner)[0].asset.id).toBe(ids[0]);
      expect(store.db.connection.prepare('PRAGMA user_version').get()).toMatchObject({user_version:8});
      expect(store.db.connection.prepare('SELECT version FROM schema_migrations').all()).toEqual([{version:3},{version:4},{version:5},{version:6},{version:7},{version:8}]);
      expect(store.db.connection.prepare("SELECT name FROM sqlite_master WHERE name='import_jobs'").get()).toBeTruthy();
    } finally {reopened.db.close();}
  });
  it('reserves spending atomically, counts uncertain requests, and never double settles',async()=>{
    const f=await fixture();const store=new DirectorStore(f.media,{...f.config,geminiMaxProjectSpendUsd:0.01});
    const first=store.reserveUsage(f.owner,'photo_analysis','mock',1000,2000);
    expect(first.reservedUsd).toBeCloseTo(0.0053);
    expect(()=>store.reserveUsage(f.owner,'photo_analysis','mock',1000,2000)).toThrow(/spending limit/);
    store.settleUsage(first.id,{inputTokens:1000,outputTokens:100},'succeeded');
    expect(store.usage(f.owner).estimatedCostUsd).toBeCloseTo(0.00055);
    const second=store.reserveUsage(f.owner,'storyboard','mock',1000,2000);
    store.settleUsage(second.id,{inputTokens:0,outputTokens:0},'unknown');
    store.settleUsage(second.id,{inputTokens:0,outputTokens:0},'failed');
    expect(store.usage(f.owner).estimatedCostUsd).toBeCloseTo(0.00585);
    expect(store.usage(f.owner).reservedUsd).toBe(0);
    expect(()=>store.reserveUsage(f.owner,'photo_analysis','mock',NaN,1)).toThrow();
  });
});
