import { randomUUID } from 'node:crypto';
import {movieDurationSecondsSchema,MIN_MOVIE_DURATION_SECONDS,MAX_MOVIE_DURATION_SECONDS,type ProtagonistId,type StoryboardContent,type StoryboardScene} from '@memories/shared';
import type { StoryboardValidationContext } from './storyboard.js';
import type { DirectorPhotoRow } from './curation.js';
import { ApiError } from './errors.js';

const original=(scene:StoryboardScene)=>scene.type==='ORIGINAL_ANIMATION'||scene.type==='PHOTO_MONTAGE';
function reject(message:string):never {throw new ApiError(502,'INVALID_AI_STORYBOARD',message);}
function confirmedPeople(row:DirectorPhotoRow,context:StoryboardValidationContext):ProtagonistId[] {
  const ids=new Set(row.curation.associationsConfirmed?row.curation.protagonistIds:[]);
  for(const person of context.protagonists) if(person.referencePhotoIds.includes(row.asset.id)) ids.add(person.id);
  return [...ids];
}
function uncertain(row:DirectorPhotoRow):boolean {
  return Boolean(row.analysis?.uncertaintyNotes.length||(row.curation.protagonistIds.length&&!row.curation.associationsConfirmed));
}
/** Allocate integer seconds in source order, retaining relative pacing within 1–60 seconds. */
function allocate(scenes:StoryboardScene[],seconds:number):void {
  if(!scenes.length) {if(seconds) reject('The generated storyboard is missing a required scene category.');return;}
  if(seconds<scenes.length||seconds>scenes.length*60) reject('The scene count cannot fit the requested movie duration.');
  const weights=scenes.map(scene=>Number.isFinite(scene.durationSeconds)&&scene.durationSeconds>0?scene.durationSeconds:1);
  const sum=weights.reduce((total,value)=>total+value,0);
  const ideal=weights.map(weight=>weight/sum*seconds);
  const values=ideal.map(value=>Math.min(60,Math.max(1,Math.floor(value))));
  let difference=seconds-values.reduce((total,value)=>total+value,0);
  while(difference) {
    const direction=difference>0?1:-1;
    let best=-1,bestPriority=-Infinity;
    for(let index=0;index<values.length;index++) {
      if(direction===1?values[index]>=60:values[index]<=1) continue;
      const priority=direction*(ideal[index]-values[index]);
      if(priority>bestPriority) {best=index;bestPriority=priority;}
    }
    if(best<0) reject('The generated scene pacing cannot fit the requested movie duration.');
    values[best]+=direction;difference-=direction;
  }
  scenes.forEach((scene,index)=>{scene.durationSeconds=values[index];});
}

/**
 * Repair mechanical planning mistakes without a second paid generation call.
 * Source claims, identity claims, fictional labels and creative prompts remain
 * subject to the original strict storyboard validation after normalization.
 */
export function normalizeStoryboardPlan(content:StoryboardContent,context:StoryboardValidationContext):StoryboardContent {
  const plan=structuredClone(content);
  if(!movieDurationSecondsSchema.safeParse(plan.targetDurationSeconds).success) reject(`Choose a movie duration between ${MIN_MOVIE_DURATION_SECONDS} and ${MAX_MOVIE_DURATION_SECONDS} seconds.`);
  if(plan.scenes.length<6||plan.scenes.length>40) reject('A storyboard needs 6–40 scenes before pacing can be normalized.');
  const referenced=new Set(plan.scenes.flatMap(scene=>scene.sourcePhotoIds));
  const pins=[...new Set(context.pinnedPhotoIds)];
  const missing:DirectorPhotoRow[]=[];
  for(const id of pins) {
    const row=context.photos.get(id);
    if(!row||row.curation.excluded||!row.analysis) reject('A pinned photo is unavailable, excluded, or has not been analyzed. Restore or analyze it before directing.');
    if(!referenced.has(id)) missing.push(row);
  }
  // Never make an existing unsupported identity claim appear valid by attaching
  // a new confirmed pin. Such scenes remain unchanged for the strict validator.
  const destinations=plan.scenes.filter(scene=>original(scene)&&scene.protagonistIds.every(person=>scene.sourcePhotoIds.some(id=>{
    const row=context.photos.get(id);return row&&confirmedPeople(row,context).includes(person);
  }))).sort((first,second)=>Number(second.type==='PHOTO_MONTAGE')-Number(first.type==='PHOTO_MONTAGE'));
  for(const scene of destinations) {
    while(missing.length&&scene.sourcePhotoIds.length<30) {
      const row=missing.shift()!;scene.sourcePhotoIds.push(row.asset.id);
      if(uncertain(row)) scene.requiresUserConfirmation=true;
      scene.userConfirmed=false;
    }
  }
  while(missing.length) {
    if(plan.scenes.length>=40) reject('The pinned photographs exceed this storyboard’s source-reference capacity. Use another storyboard for the remaining pins.');
    const rows=missing.splice(0,30),people=[...new Set(rows.flatMap(row=>confirmedPeople(row,context)))];
    plan.scenes.push({id:randomUUID(),sequenceNumber:plan.scenes.length+1,type:'PHOTO_MONTAGE',title:'Pinned photographs',
      description:rows.map(row=>row.analysis!.description).join(' ').slice(0,3000),durationSeconds:5,sourcePhotoIds:rows.map(row=>row.asset.id),protagonistIds:people,
      visualStyle:'Faithful presentation of the supplied original photographs with gentle cinematic light.',
      cameraDirection:'Slow camera drift within each original composition, joined with soft crossfades.',
      motionPrompt:'Subtle parallax and transitions between the supplied photographs; preserve the original people and setting.',
      emotionalTone:'Reflective',continuityNotes:'User-pinned original photographs. Thematic placement; no dates, places, or events are inferred.',
      generationInstructions:'Use only the supplied original photographs. Preserve their visible composition and user-confirmed people. Do not invent historical events, identities, dates, or locations.',
      isFictional:false,requiresUserConfirmation:rows.some(uncertain),userConfirmed:false});
  }
  const originals=plan.scenes.filter(original),fiction=plan.scenes.filter(scene=>scene.type==='NEW_CINEMATIC_SCENE'),titles=plan.scenes.filter(scene=>scene.type==='TITLE_SEQUENCE');
  if(!originals.length||!fiction.length) reject('The generated storyboard must include both original-photo footage and fictional cinematic scenes.');
  const target=plan.targetDurationSeconds;
  const minimumTitle=titles.length,maximumTitle=titles.length?Math.min(titles.length*60,Math.floor(target*0.15)):0;
  if(minimumTitle>maximumTitle) reject('Too many title sequences leave insufficient time for the movie.');
  const preferredTitle=Math.min(maximumTitle,Math.max(minimumTitle,titles.reduce((sum,scene)=>sum+scene.durationSeconds,0)));
  let choice:{title:number;original:number;fiction:number;score:number}|undefined;
  for(let title=minimumTitle;title<=maximumTitle;title++) {
    const creative=target-title;
    const minimumOriginal=Math.max(originals.length,creative-fiction.length*60,Math.ceil(creative*0.4));
    const maximumOriginal=Math.min(originals.length*60,creative-fiction.length,Math.floor(creative*0.6));
    if(minimumOriginal>maximumOriginal) continue;
    const originalSeconds=Math.max(minimumOriginal,Math.min(maximumOriginal,Math.round(creative/2)));
    const fictionalSeconds=creative-originalSeconds;
    const score=Math.abs(title-preferredTitle)*1000+Math.abs(originalSeconds-fictionalSeconds);
    if(!choice||score<choice.score) choice={title,original:originalSeconds,fiction:fictionalSeconds,score};
  }
  if(!choice) reject('The generated scene categories cannot fit a balanced movie at the requested duration.');
  allocate(titles,choice.title);allocate(originals,choice.original);allocate(fiction,choice.fiction);
  plan.scenes.forEach((scene,index)=>{scene.sequenceNumber=index+1;});
  return plan;
}
