import {describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {movieSettingsSchema,type MovieClipCandidate,type MovieSettings,type MovieTimelineInput,type StoryboardScene} from '@memories/shared';
import {calculateMovieTimelineDuration,compileMovieTimeline} from '../src/movie-timeline.js';
const scene=(type:StoryboardScene['type'],overrides:Partial<StoryboardScene>={}):StoryboardScene=>({id:randomUUID(),sequenceNumber:1,type,title:'A supplied title',description:'An existing scene.',durationSeconds:15,sourcePhotoIds:[],protagonistIds:['person1','person2'],visualStyle:'Natural',cameraDirection:'Gentle',motionPrompt:'Subtle motion',emotionalTone:'Warm',continuityNotes:'',generationInstructions:'Preserve sources',isFictional:type==='NEW_CINEMATIC_SCENE',requiresUserConfirmation:false,userConfirmed:false,...overrides});
function fixture(overrides:Partial<MovieSettings>={}){
 const storyboardId=randomUUID(),photoIds=Array.from({length:24},()=>randomUUID());
 const original=scene('ORIGINAL_ANIMATION',{sequenceNumber:1,durationSeconds:30});
 const cinematic=scene('NEW_CINEMATIC_SCENE',{sequenceNumber:2,durationSeconds:30});
 const montage=scene('PHOTO_MONTAGE',{sequenceNumber:3,durationSeconds:60,sourcePhotoIds:photoIds});
 const titles=scene('TITLE_SEQUENCE',{sequenceNumber:4,durationSeconds:30,title:'Closing title'});
 const clips:MovieClipCandidate[]=[original,cinematic].map(value=>({id:randomUUID(),sceneId:value.id,storyboardId,durationSeconds:8,decision:'approved',state:'COMPLETED'}));
 const settings=movieSettingsSchema.parse({...overrides});
 const input:MovieTimelineInput={storyboard:{id:storyboardId,title:'Our supplied story',scenes:[original,cinematic,montage,titles],targetDurationSeconds:150},settings,clips,availablePhotoIds:photoIds};
 return {input,photoIds,original,cinematic,montage,titles,clips};
}
describe('P5 frame-exact automatic timeline',()=>{
 it('fills 150 seconds from approved motion, distinct photographs and configurable titles after overlap',()=>{
  const f=fixture(),timeline=compileMovieTimeline(f.input);
  expect(timeline.ready).toBe(true);expect(timeline.issues).toEqual([]);expect(timeline.durationSeconds).toBe(150);
  expect(timeline.totalSourceDurationSeconds-timeline.transitionOverlapSeconds).toBeCloseTo(150,6);
  expect(timeline.segments.filter(value=>value.type==='photo').map(value=>value.sourceAssetId)).toEqual(f.photoIds);
  expect(timeline.segments.filter(value=>value.type==='video')).toHaveLength(2);
  expect(timeline.segments.filter(value=>value.type==='video').every(value=>value.durationSeconds<=8)).toBe(true);
  expect(timeline.segments.find(value=>value.sceneId===f.cinematic.id)?.isFictional).toBe(true);
  expect(timeline.warnings.some(value=>value.includes('No soundtrack'))).toBe(true);
  expect(timeline.segments.at(-1)?.titleText).toContain('fictional AI-created');
  for(let index=1;index<timeline.segments.length;index++){
   const previous=timeline.segments[index-1],current=timeline.segments[index];
   expect(current.startSeconds).toBeCloseTo(previous.startSeconds+previous.durationSeconds-current.transition.durationSeconds,5);
  }
 });
 it.each(['crossfade','fadeblack','cut','fadewhite'] as const)('calculates %s overlap exactly on the 30fps frame grid',transitionStyle=>{
  const f=fixture({transitionStyle,transitionDurationSeconds:0.75}),timeline=compileMovieTimeline(f.input);
  expect(timeline.ready).toBe(true);expect(timeline.durationSeconds).toBe(150);
  const expected=transitionStyle==='cut'?0:(timeline.segments.length-1)*23/30;
  expect(timeline.transitionOverlapSeconds).toBeCloseTo(expected,6);
  expect(timeline.segments.every(value=>Math.abs(value.durationSeconds*30-Math.round(value.durationSeconds*30))<.0001)).toBe(true);
 });
 it('uses restrained cuts rather than the same transition at every boundary',()=>{
  const timeline=compileMovieTimeline(fixture().input),types=new Set(timeline.segments.map(value=>value.transition.type));
  expect(types.has('cut')).toBe(true);expect(types.has('crossfade')).toBe(true);expect(types.has('fadeblack')).toBe(true);
 });
 it('blocks missing, unapproved, failed and older-storyboard clips with exact scene IDs',()=>{
  for(const change of [{decision:'pending'},{decision:'rejected'},{state:'FAILED'},{storyboardId:randomUUID()}]){
   const f=fixture();Object.assign(f.input.clips[0],change);
   const result=compileMovieTimeline(f.input);expect(result.ready).toBe(false);
   expect(result.issues).toContainEqual(expect.objectContaining({code:'APPROVED_CLIP_REQUIRED',sceneId:f.original.id}));
   expect(result.segments.some(value=>value.sceneId===f.original.id)).toBe(false);
  }
 });
 it('selects only a completed approved clip even when a newer rejected attempt is present',()=>{
  const f=fixture();f.input.clips.unshift({...f.clips[0],id:randomUUID(),decision:'rejected'});
  const timeline=compileMovieTimeline(f.input);expect(timeline.ready).toBe(true);
  expect(timeline.segments.find(value=>value.sceneId===f.original.id)?.generatedAssetId).toBe(f.clips[1].id);
 });
 it('gives an explicit duration plan instead of extending two short video clips',()=>{
  const f=fixture();f.input.storyboard.scenes=[f.original,f.cinematic];
  const timeline=compileMovieTimeline(f.input);expect(timeline.ready).toBe(false);
  const issue=timeline.issues.find(value=>value.code==='INSUFFICIENT_DURATION');expect(issue?.message).toMatch(/Add at least \d+ distinct montage photographs/);
  expect(timeline.segments.filter(value=>value.type==='video').every(value=>value.durationSeconds<=8)).toBe(true);
  expect(timeline.durationSeconds).toBeLessThan(40);
 });
 it('trims twenty approved clips without repetition or unnatural time scaling',()=>{
  const f=fixture({transitionStyle:'cut'}),scenes=Array.from({length:20},(_,index)=>scene(index%2?'NEW_CINEMATIC_SCENE':'ORIGINAL_ANIMATION',{sequenceNumber:index+1,durationSeconds:8}));
  f.input.storyboard.scenes=scenes;f.input.storyboard.title='';f.input.settings.titles.includeDisclosure=false;
  f.input.clips=scenes.map(value=>({id:randomUUID(),sceneId:value.id,storyboardId:f.input.storyboard.id,durationSeconds:8,decision:'approved',state:'COMPLETED'}));
  const timeline=compileMovieTimeline(f.input);expect(timeline.ready).toBe(true);expect(timeline.durationSeconds).toBe(150);expect(timeline.segments).toHaveLength(20);
  expect(timeline.segments.every(value=>value.durationSeconds<=8&&value.durationSeconds>=3)).toBe(true);
 });
 it('blocks missing montage sources and scenes awaiting human review',()=>{
  const f=fixture();f.input.availablePhotoIds=f.photoIds.slice(1);f.cinematic.requiresUserConfirmation=true;
  const timeline=compileMovieTimeline(f.input);expect(timeline.ready).toBe(false);
  expect(timeline.issues).toContainEqual(expect.objectContaining({code:'MISSING_PHOTO',sceneId:f.montage.id}));
  expect(timeline.issues).toContainEqual(expect.objectContaining({code:'SCENE_REVIEW_REQUIRED',sceneId:f.cinematic.id}));
 });
 it('preserves explicit Unicode names, dates, chapters and credits without inventing personal information',()=>{
  const f=fixture();f.input.settings.titles={...f.input.settings.titles,openingTitle:'זיכרונות — Élodie',names:'אליאס & Zoë',dates:'2024–2026',closingCredits:'撮影: 私たち',chapterTitles:{[f.titles.id]:'Our end title'}};
  const timeline=compileMovieTimeline(f.input);expect(timeline.segments[0].titleText).toBe('זיכרונות — Élodie\nאליאס & Zoë\n2024–2026');
  expect(timeline.segments.at(-1)?.titleText).toContain('撮影: 私たち');
 });
 it('uses local onsets only for safe elastic cuts, preserving chronology and final duration',()=>{
  const f=fixture({transitionStyle:'cut'}),first=compileMovieTimeline(f.input);
  const boundary=first.segments.find((value,index)=>value.type==='photo'&&first.segments[index+1]?.type==='photo')!;
  f.input.onsets=[boundary.startSeconds+boundary.durationSeconds+0.1];
  const aligned=compileMovieTimeline(f.input);expect(aligned.ready).toBe(true);expect(aligned.durationSeconds).toBe(150);expect(aligned.beatAlignedCuts).toBeGreaterThan(0);
  expect(aligned.segments.map(value=>value.id)).toEqual(first.segments.map(value=>value.id));
  expect(aligned.segments.filter(value=>value.type==='video').map(value=>value.durationSeconds)).toEqual(first.segments.filter(value=>value.type==='video').map(value=>value.durationSeconds));
 });
 it('does not count cut durations or an incoming transition on the first segment as overlap',()=>{
  expect(calculateMovieTimelineDuration([{durationSeconds:8,transition:{type:'crossfade',durationSeconds:1}},{durationSeconds:8,transition:{type:'cut',durationSeconds:1}},{durationSeconds:8,transition:{type:'fadeblack',durationSeconds:0.5}}])).toEqual({totalSourceDurationSeconds:24,transitionOverlapSeconds:0.5,durationSeconds:23.5});
 });
 it('rejects unsafe settings and a photo-heavy plan that cannot fit its minimum screen time',()=>{
  expect(()=>movieSettingsSchema.parse({targetDurationSeconds:119})).toThrow();expect(()=>movieSettingsSchema.parse({titles:{color:'red;movie=/tmp'}})).toThrow();
  const f=fixture();f.montage.sourcePhotoIds=Array.from({length:100},()=>randomUUID());f.input.availablePhotoIds=f.montage.sourcePhotoIds;
  const timeline=compileMovieTimeline(f.input);expect(timeline.ready).toBe(false);expect(timeline.issues.some(value=>value.code==='EXCESS_MEDIA_DURATION')).toBe(true);
 });
});
