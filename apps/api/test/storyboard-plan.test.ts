import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PhotoAnalysis, StoryboardContent, StoryboardScene } from '@memories/shared';
import { normalizeStoryboardPlan } from '../src/storyboard-plan.js';
import { validateStoryboard, type StoryboardValidationContext } from '../src/storyboard.js';
import type { DirectorPhotoRow } from '../src/curation.js';

function fixture() {
  const owner=randomUUID();
  const analysis:PhotoAnalysis={schemaVersion:'1.0',sharpness:80,exposure:80,composition:80,animationSuitability:80,storytellingPotential:80,suitability:'ANIMATED_ORIGINAL',description:'A visible original composition.',sceneType:'outdoors',visibleLocations:[],activities:[],objects:[],emotionalTone:'warm',diversityTags:[],uncertaintyNotes:[]};
  const rows:DirectorPhotoRow[]=Array.from({length:40},(_,index)=>{const id=randomUUID();return{asset:{id,projectId:owner,contributorId:'person1',filename:`photo-${index}.jpg`,mimeType:'image/jpeg',bytes:100,selected:true,importedAt:'2026-11-14',url:'/private'},analysis:structuredClone(analysis),features:null,curation:{assetId:id,pinned:false,excluded:false,protagonistIds:index<2?['person1']:index<4?['person2']:[],associationsConfirmed:true}};});
  const context:StoryboardValidationContext={photos:new Map(rows.map(row=>[row.asset.id,row])),pinnedPhotoIds:[],protagonists:[{id:'person1',name:'Alex',referencePhotoIds:rows.slice(0,2).map(row=>row.asset.id),likenessPermissionConfirmed:true,ready:true,updatedAt:'2026-11-14'},{id:'person2',name:'Sam',referencePhotoIds:rows.slice(2,4).map(row=>row.asset.id),likenessPermissionConfirmed:true,ready:true,updatedAt:'2026-11-14'}]};
  const scene=(type:StoryboardScene['type'],durationSeconds:number,ids:string[],people:StoryboardScene['protagonistIds']):StoryboardScene=>({id:randomUUID(),sequenceNumber:1,type,title:type==='NEW_CINEMATIC_SCENE'?'Fictional imagined moment':'Original moment',description:type==='NEW_CINEMATIC_SCENE'?'A fictional cinematic scene inspired by the confirmed references.':'A visible original composition.',durationSeconds,sourcePhotoIds:ids,protagonistIds:people,visualStyle:'Warm light',cameraDirection:'Slow push',motionPrompt:'Gentle movement',emotionalTone:'Warm',continuityNotes:'Thematic continuity',generationInstructions:'Preserve the source photographs and confirmed references.',isFictional:type==='NEW_CINEMATIC_SCENE',requiresUserConfirmation:type==='NEW_CINEMATIC_SCENE',userConfirmed:false});
  const content:StoryboardContent={schemaVersion:'1.0',title:'A shared story',synopsis:'Original photographs and fictional scenes.',targetDurationSeconds:150,scenes:[scene('TITLE_SEQUENCE',10,[],[]),scene('ORIGINAL_ANIMATION',60,[rows[0].asset.id],['person1']),scene('NEW_CINEMATIC_SCENE',30,[rows[0].asset.id,rows[2].asset.id],['person1','person2']),scene('PHOTO_MONTAGE',20,[rows[2].asset.id],['person2']),scene('NEW_CINEMATIC_SCENE',30,[rows[0].asset.id,rows[2].asset.id],['person1','person2']),scene('ORIGINAL_ANIMATION',20,[rows[0].asset.id],['person1'])]};
  content.scenes.forEach((value,index)=>{value.sequenceNumber=index+1;});
  return {content,context,rows};
}
const total=(content:StoryboardContent)=>content.scenes.reduce((sum,scene)=>sum+scene.durationSeconds,0);
const balance=(content:StoryboardContent)=>{const original=content.scenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION'||scene.type==='PHOTO_MONTAGE').reduce((sum,scene)=>sum+scene.durationSeconds,0);const fictional=content.scenes.filter(scene=>scene.type==='NEW_CINEMATIC_SCENE').reduce((sum,scene)=>sum+scene.durationSeconds,0);return fictional/(original+fictional);};

describe('deterministic cinematic plan normalization',()=>{
  it('repairs a 170-second unbalanced draft to exactly150 without changing creative text or inputs',()=>{
    const f=fixture(),before=structuredClone(f.content),contextBefore=structuredClone(f.context);
    expect(total(f.content)).toBe(170);
    const plan=normalizeStoryboardPlan(f.content,f.context);
    expect(total(plan)).toBe(150);expect(balance(plan)).toBe(0.5);
    expect(plan.scenes.every(scene=>Number.isInteger(scene.durationSeconds)&&scene.durationSeconds>=1&&scene.durationSeconds<=60)).toBe(true);
    expect(plan.scenes.map(scene=>[scene.title,scene.description,scene.cameraDirection,scene.motionPrompt,scene.generationInstructions])).toEqual(before.scenes.map(scene=>[scene.title,scene.description,scene.cameraDirection,scene.motionPrompt,scene.generationInstructions]));
    expect(f.content).toEqual(before);expect(f.context).toEqual(contextBefore);
    expect(validateStoryboard(plan,f.context).errors).toEqual([]);
    expect(validateStoryboard(plan,f.context).issues.every(issue=>issue.startsWith('Review and confirm scene '))).toBe(true);
  });
  it.each([120,180])('allocates exactly%i seconds with bounded scene durations and balanced creative footage',target=>{
    const f=fixture();f.content.targetDurationSeconds=target;
    const plan=normalizeStoryboardPlan(f.content,f.context);
    expect(total(plan)).toBe(target);expect(balance(plan)).toBeGreaterThanOrEqual(0.4);expect(balance(plan)).toBeLessThanOrEqual(0.6);
    expect(plan.scenes.every(scene=>scene.durationSeconds>=1&&scene.durationSeconds<=60)).toBe(true);
  });
  it('includes all thirty omitted pins in original scenes without dropping or inventing sources',()=>{
    const f=fixture();f.context.pinnedPhotoIds=f.rows.slice(4,34).map(row=>row.asset.id);
    const plan=normalizeStoryboardPlan(f.content,f.context);
    const ids=new Set(plan.scenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION'||scene.type==='PHOTO_MONTAGE').flatMap(scene=>scene.sourcePhotoIds));
    expect(f.context.pinnedPhotoIds.every(id=>ids.has(id))).toBe(true);expect(plan.scenes.every(scene=>scene.sourcePhotoIds.length<=30)).toBe(true);
    expect(plan.scenes).toHaveLength(6);expect(total(plan)).toBe(150);expect(validateStoryboard(plan,f.context).errors).toEqual([]);
  });
  it('appends a grounded montage when existing original arrays have no room',()=>{
    const f=fixture();for(const scene of f.content.scenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION'||scene.type==='PHOTO_MONTAGE')) scene.sourcePhotoIds=f.rows.slice(0,30).map(row=>row.asset.id);
    const pinned=f.rows[35];f.context.pinnedPhotoIds=[pinned.asset.id];pinned.analysis!.uncertaintyNotes=['Some visible details are uncertain.'];
    const plan=normalizeStoryboardPlan(f.content,f.context),added=plan.scenes.at(-1)!;
    expect(plan.scenes).toHaveLength(7);expect(added).toMatchObject({type:'PHOTO_MONTAGE',sourcePhotoIds:[pinned.asset.id],description:pinned.analysis!.description,protagonistIds:[],isFictional:false,requiresUserConfirmation:true,userConfirmed:false,sequenceNumber:7});
    expect(added.id).not.toBe(f.content.scenes[0].id);expect(total(plan)).toBe(150);expect(validateStoryboard(plan,f.context).errors).toEqual([]);
  });
  it.each(['missing','excluded','unanalyzed'] as const)('rejects a %s pinned photo',reason=>{
    const f=fixture(),pin=f.rows[4];f.context.pinnedPhotoIds=[pin.asset.id];
    if(reason==='missing') f.context.photos.delete(pin.asset.id);else if(reason==='excluded') pin.curation.excluded=true;else pin.analysis=null;
    expect(()=>normalizeStoryboardPlan(f.content,f.context)).toThrow(/pinned photo is unavailable/);
  });
  it('preserves malicious source references and unsupported identity claims for strict validation to reject',()=>{
    const f=fixture(),unknown=randomUUID();f.content.scenes[1].sourcePhotoIds=[unknown];f.content.scenes[1].protagonistIds=['person2'];
    f.context.pinnedPhotoIds=[f.rows[3].asset.id];
    const plan=normalizeStoryboardPlan(f.content,f.context);
    expect(plan.scenes[1].sourcePhotoIds).toEqual([unknown]);expect(plan.scenes[1].protagonistIds).toEqual(['person2']);
    expect(validateStoryboard(plan,f.context).errors.join(' ')).toMatch(/unavailable|without a user-confirmed association/);
  });
  it('rejects absent creative categories instead of inventing fictional protagonist footage',()=>{
    const f=fixture();for(const scene of f.content.scenes) if(scene.type==='NEW_CINEMATIC_SCENE') scene.type='PHOTO_MONTAGE';
    expect(()=>normalizeStoryboardPlan(f.content,f.context)).toThrow(/both original-photo footage and fictional/);
  });
  it('rejects pin capacity beyond forty scenes without removing any pin',()=>{
    const f=fixture();
    const source=f.content.scenes[1];
    source.sourcePhotoIds=f.rows.slice(0,30).map(row=>row.asset.id);
    f.content.scenes=Array.from({length:40},(_,index)=>({...structuredClone(index===39?f.content.scenes[2]:source),id:randomUUID(),sequenceNumber:index+1}));
    f.context.pinnedPhotoIds=[f.rows[35].asset.id];
    expect(()=>normalizeStoryboardPlan(f.content,f.context)).toThrow(/source-reference capacity/);
    expect(f.context.pinnedPhotoIds).toEqual([f.rows[35].asset.id]);
  });
  it('rejects infeasible balance rather than stretching one cinematic scene past sixty seconds',()=>{
    const f=fixture();f.content.targetDurationSeconds=180;
    const source=f.content.scenes[1],fiction=f.content.scenes[2];
    f.content.scenes=Array.from({length:40},(_,index)=>({...structuredClone(index===39?fiction:source),id:randomUUID(),sequenceNumber:index+1}));
    expect(()=>normalizeStoryboardPlan(f.content,f.context)).toThrow(/cannot fit a balanced movie/);
  });
});
