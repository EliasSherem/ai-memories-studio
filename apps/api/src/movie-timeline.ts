import {MIN_MOVIE_DURATION_SECONDS,MAX_MOVIE_DURATION_SECONDS} from '@memories/shared';
import {movieSettingsSchema,type MovieTimelineInput,type MovieTimeline,type MovieTimelineSegment,type MovieTransitionType,type MovieReadinessIssue} from '@memories/shared';
import {buildCollageLayers} from './collage-engine.js';

const FPS=30;
const frames=(seconds:number)=>Math.round(seconds*FPS);
const seconds=(value:number)=>Math.round(value/FPS*1e6)/1e6;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
type Planned={segment:MovieTimelineSegment;min:number;max:number;preferred:number;duration:number};

/** Every transition is incoming; a cut never consumes source duration. */
export function calculateMovieTimelineDuration(segments:readonly Pick<MovieTimelineSegment,'durationSeconds'|'transition'>[]){
 const sourceFrames=segments.reduce((sum,segment)=>sum+frames(segment.durationSeconds),0);
 const overlapFrames=segments.reduce((sum,segment,index)=>sum+(index&&segment.transition.type!=='cut'?frames(segment.transition.durationSeconds):0),0);
 return {totalSourceDurationSeconds:seconds(sourceFrames),transitionOverlapSeconds:seconds(overlapFrames),durationSeconds:seconds(sourceFrames-overlapFrames)};
}

/**
 * Pure, frame-exact compilation. Generated motion is trimmed, never stretched,
 * looped or frozen; only distinct stills and titles have elastic screen time.
 */
export function compileMovieTimeline(input:MovieTimelineInput):MovieTimeline {
 const settings=movieSettingsSchema.parse(input.settings),targetFrames=frames(settings.targetDurationSeconds);
 const issues:MovieReadinessIssue[]=[],warnings:string[]=[],planned:Planned[]=[];
 const photos=new Set(input.availablePhotoIds);
 const scenes=[...input.storyboard.scenes].sort((a,b)=>a.sequenceNumber-b.sequenceNumber);
 const sceneIds=new Set<string>();
 const fictional=scenes.some(scene=>scene.isFictional);
 const disclosure=fictional&&settings.titles.includeDisclosure?'Includes fictional AI-created scenes.':'';
 const titleIndexes=scenes.flatMap((scene,index)=>scene.type==='TITLE_SEQUENCE'?[index]:[]);
 const openingSlot=titleIndexes.find(index=>index===0),closingSlot=[...titleIndexes].reverse().find(index=>index===scenes.length-1&&index!==openingSlot);
 function push(segment:Omit<MovieTimelineSegment,'durationSeconds'|'startSeconds'|'transition'>,min:number,max:number,preferred:number){planned.push({segment:{...segment,durationSeconds:0,startSeconds:0,transition:{type:'cut',durationSeconds:0}},min,max,preferred:clamp(preferred,min,max),duration:clamp(preferred,min,max)});}
 function title(sceneId:string,text:string,preferredSeconds=4,extra:Partial<MovieTimelineSegment>={}){push({id:`${sceneId}:title`,sceneId,sceneType:'TITLE_SEQUENCE',type:'title',titleText:text,isFictional:false,...extra},60,240,frames(preferredSeconds));}
 if(openingSlot===undefined){const text=[settings.titles.openingTitle||input.storyboard.title||'',settings.titles.names,settings.titles.dates].filter(Boolean).join('\n');if(text)title('opening-title',text);}
 for(const [index,scene] of scenes.entries()){
  if(sceneIds.has(scene.id)){issues.push({code:'DUPLICATE_SCENE',sceneId:scene.id,message:`Scene ${scene.id} is repeated. Save a storyboard with unique scene IDs.`});continue;}sceneIds.add(scene.id);
  if(scene.requiresUserConfirmation&&!scene.userConfirmed)issues.push({code:'SCENE_REVIEW_REQUIRED',sceneId:scene.id,message:`Review and confirm scene ${scene.id} before rendering.`});
  const visual={presentationType:scene.presentationType,textOverlays:scene.textOverlays,photoSequenceId:scene.photoSequenceId,relatedSequenceIds:scene.relatedSequenceIds};
  if(scene.presentationType==='ANIMATED_PHOTO_COLLAGE'){
   const ids=[...new Set(scene.sourcePhotoIds)],missing=ids.filter(id=>!photos.has(id));
   if(ids.length<2||ids.length>8)issues.push({code:'COLLAGE_PHOTO_COUNT',sceneId:scene.id,message:'A deterministic collage needs 2–8 source photographs; split larger moments across scenes.'});
   if(missing.length)issues.push({code:'MISSING_PHOTO',sceneId:scene.id,message:`Collage ${scene.id} references unavailable or excluded originals. Restore them or revise the storyboard.`});
   if(ids.length>=2&&ids.length<=8&&!missing.length){const layout=scene.collageLayout??(ids.length===2?'SPLIT_SCREEN':ids.length===3?'EDITORIAL_THREE':ids.length<=4?'GRID_FOUR':ids.length<=6?'MOSAIC_SIX':'CONTACT_SHEET_EIGHT');
    const animation=scene.collageAnimationSettings;
    push({id:`${scene.id}:composition`,sceneId:scene.id,sceneType:scene.type,type:'composition',sourcePhotoIds:ids,collageLayout:layout,collageAnimationSettings:animation,isFictional:false,...visual},90,600,frames(scene.durationSeconds));
   }
  }else if(scene.type==='ORIGINAL_ANIMATION'||scene.type==='NEW_CINEMATIC_SCENE'){
   const clip=input.clips.find(clip=>clip.sceneId===scene.id&&clip.storyboardId===input.storyboard.id&&clip.decision==='approved'&&clip.state==='COMPLETED'&&Number.isFinite(clip.durationSeconds)&&clip.durationSeconds>=1/FPS);
   if(!clip){issues.push({code:'APPROVED_CLIP_REQUIRED',sceneId:scene.id,message:`Scene ${scene.id} requires a completed, approved P4 clip for this saved storyboard. No unapproved clip or photograph will be substituted.`});continue;}
   // Flooring guarantees a clip cannot be over-read due to rounded metadata.
   const maximum=Math.min(Math.floor(clip.durationSeconds*FPS+1e-7),frames(scene.durationSeconds));
   const minimum=Math.min(maximum,90);
   push({id:`${scene.id}:video`,sceneId:scene.id,sceneType:scene.type,type:'video',generatedAssetId:clip.id,thumbnailUrl:clip.thumbnailUrl,isFictional:scene.isFictional,sourcePhotoIds:[...(clip.sourcePhotoIds??scene.sourcePhotoIds)],...visual},minimum,maximum,maximum);
   if(maximum<frames(scene.durationSeconds))warnings.push(`Scene ${scene.id}: approved motion supplies ${seconds(maximum)}s of its ${scene.durationSeconds}s storyboard plan. Distinct photographs and titles may cover the remaining movie time; the clip will not be stretched or frozen.`);
  }else if(scene.type==='PHOTO_MONTAGE'){
   const ids=[...new Set(scene.sourcePhotoIds)];
   if(!ids.length)issues.push({code:'MONTAGE_PHOTOS_REQUIRED',sceneId:scene.id,message:`Scene ${scene.id} needs at least one available original photograph.`});
   const missing=ids.filter(id=>!photos.has(id));if(missing.length)issues.push({code:'MISSING_PHOTO',sceneId:scene.id,message:`Scene ${scene.id} references unavailable or excluded photographs: ${missing.join(', ')}. Restore them or save a revised storyboard.`});
   for(const [photoIndex,id] of ids.filter(id=>photos.has(id)).entries())push({id:`${scene.id}:photo:${photoIndex+1}`,sceneId:scene.id,sceneType:scene.type,type:'photo',sourceAssetId:id,sourcePhotoIds:[id],isFictional:false,...visual,textOverlays:scene.textOverlays},scene.presentationType?30:90,240,frames(scene.durationSeconds/Math.max(1,ids.length)));
  }else if(scene.type==='TITLE_SEQUENCE'){
   let text=settings.titles.chapterTitles[scene.id]??scene.title;
   if(index===openingSlot)text=[settings.titles.openingTitle||text,settings.titles.names,settings.titles.dates].filter(Boolean).join('\n');
   if(index===closingSlot)text=[settings.titles.closingCredits||text,disclosure].filter(Boolean).join('\n');
   title(scene.id,text,scene.durationSeconds,visual);
  }
 }
 if(closingSlot===undefined){const text=[settings.titles.closingCredits,disclosure].filter(Boolean).join('\n');if(text)title('closing-credits',text);}
 if(!planned.length)issues.push({code:'NO_RENDERABLE_MEDIA',message:'No approved clips, original photographs or title scenes are available.'});
 let boundary=0;
 for(let index=1;index<planned.length;index++){
  let type:MovieTransitionType;
  const scene=scenes.find(scene=>scene.id===planned[index].segment.sceneId);
  const priorScene=scenes.find(scene=>scene.id===planned[index-1].segment.sceneId);
  if(scene?.id!==priorScene?.id&&scene?.transitionIn){type=scene.transitionIn;}else if(scene?.id!==priorScene?.id&&priorScene?.transitionOut){type=priorScene.transitionOut;}else if(settings.transitionStyle==='restrained'){
   const sceneChange=planned[index-1].segment.sceneId!==planned[index].segment.sceneId;
   if(sceneChange){boundary++;type=boundary%3===1?'crossfade':boundary%3===2?'cut':'fadeblack';}
   else type=index%4===0?'crossfade':'cut';
  }else type=settings.transitionStyle;
  const overlap=type==='cut'?0:Math.min(frames(settings.transitionDurationSeconds),Math.floor(planned[index-1].min/2),Math.floor(planned[index].min/2));
  planned[index].segment.transition={type:overlap?type:'cut',durationSeconds:seconds(overlap)};
 }
 const overlapFrames=planned.reduce((sum,item)=>sum+frames(item.segment.transition.durationSeconds),0),needed=targetFrames+overlapFrames;
 const minimum=planned.reduce((sum,item)=>sum+item.min,0),maximum=planned.reduce((sum,item)=>sum+item.max,0);
 let requested=needed;
 if(needed>maximum){requested=maximum;issues.push({code:'INSUFFICIENT_DURATION',message:`Available approved motion, distinct photographs and titles can fill at most ${seconds(Math.max(0,maximum-overlapFrames))}s after transitions, below the requested ${settings.targetDurationSeconds}s. Add at least ${Math.ceil((needed-maximum)/240)} distinct montage photographs (up to 8s each), approve longer clips, or reduce the requested duration within ${MIN_MOVIE_DURATION_SECONDS}–${MAX_MOVIE_DURATION_SECONDS}s. No video will be frozen, stretched or silently repeated.`});}
 else if(needed<minimum){requested=minimum;issues.push({code:'EXCESS_MEDIA_DURATION',message:`The shortest safe plan is ${seconds(minimum-overlapFrames)}s after transitions, above the requested ${settings.targetDurationSeconds}s. Reduce montage photographs or title scenes, shorten approved clips, or increase the target within ${MIN_MOVIE_DURATION_SECONDS}–${MAX_MOVIE_DURATION_SECONDS}s.`});}
 let current=planned.reduce((sum,item)=>sum+item.duration,0);
 // First distribute time over stills/titles; preserve real clip motion where possible.
 for(const elastic of [true,false]){
  const candidates=planned.filter(item=>(item.segment.type!=='video')===elastic);
  while(current!==requested){const direction=requested>current?1:-1;const eligible=candidates.filter(item=>direction>0?item.duration<item.max:item.duration>item.min);if(!eligible.length)break;
   const step=Math.max(1,Math.floor(Math.abs(requested-current)/eligible.length));
   for(const item of eligible){const change=Math.min(step,Math.abs(requested-current),direction>0?item.max-item.duration:item.duration-item.min);item.duration+=direction*change;current+=direction*change;if(current===requested)break;}
  }
 }
 let beatAlignedCuts=0;
 // Local audio onsets may move a clean cut by at most 0.2s. Only adjacent
 // elastic segments move, preserving video integrity, chronology and total time.
 const onsets=(input.onsets??[]).filter(value=>Number.isFinite(value)&&value>0).map(frames).sort((a,b)=>a-b);
 let position=0;
 for(let index=0;index<planned.length;index++){
  const item=planned[index];position+=item.duration-frames(item.segment.transition.durationSeconds);
  const next=planned[index+1];if(scenes.find(scene=>scene.id===item.segment.sceneId)?.musicCue?.syncToBeat===false)continue;if(!next||!onsets.length||next.segment.transition.type!=='cut'||item.segment.type==='video'||next.segment.type==='video')continue;
  const onset=onsets.reduce((best,value)=>Math.abs(value-position)<Math.abs(best-position)?value:best,onsets[0]),shift=onset-position;
  if(shift&&Math.abs(shift)<=6&&item.duration+shift>=item.min&&item.duration+shift<=item.max&&next.duration-shift>=next.min&&next.duration-shift<=next.max){item.duration+=shift;next.duration-=shift;position+=shift;beatAlignedCuts++;}
 }
 let end=0;const sceneStarts=new Map<string,number>();
 const segments=planned.map((item,index)=>{
  const incoming=index?frames(item.segment.transition.durationSeconds):0,start=end-incoming;end=start+item.duration;
  const durationSeconds=seconds(item.duration),startSeconds=seconds(start);if(!sceneStarts.has(item.segment.sceneId))sceneStarts.set(item.segment.sceneId,startSeconds);
  const offset=item.segment.type==='photo'?startSeconds-sceneStarts.get(item.segment.sceneId)!:0;
  const textOverlays=item.segment.textOverlays?.filter(overlay=>overlay.startSeconds<offset+durationSeconds&&overlay.startSeconds+overlay.durationSeconds>offset).map(overlay=>({...overlay,startSeconds:Math.max(0,overlay.startSeconds-offset),durationSeconds:Math.min(offset+durationSeconds,overlay.startSeconds+overlay.durationSeconds)-Math.max(offset,overlay.startSeconds)}));
  // The elastic fit changes local composition duration. Build all layer timing
  // from that final duration, including stagger, exit fades and zoom keyframes.
  const animation=item.segment.collageAnimationSettings;
  const compositionLayers=item.segment.type==='composition'?buildCollageLayers(item.segment.sourcePhotoIds??[],item.segment.collageLayout??'GRID_FOUR',durationSeconds,settings.aspectRatio,{staggerSeconds:animation?.entrance==='none'?0:animation?.staggerSeconds,zoom:animation?.gentleZoom===false?1:1.025,fit:animation?.fit,animation:animation?.entrance,safeMargin:animation?.safeMargin,gap:animation?.gap}):item.segment.compositionLayers;
  return {...item.segment,startSeconds,durationSeconds,textOverlays,compositionLayers};
 });
 const math=calculateMovieTimelineDuration(segments);
 if(!issues.length&&Math.abs(frames(math.durationSeconds)-targetFrames)>0)issues.push({code:'TIMELINE_DURATION_MISMATCH',message:'The frame-exact timeline does not match the requested duration. Recompile before rendering.'});
 if(!settings.soundtrackId)warnings.push('No soundtrack is selected. No background music will be added; retained scene audio or silence will be used.');
 return {storyboardId:input.storyboard.id,targetDurationSeconds:settings.targetDurationSeconds,...math,segments,issues,warnings,ready:issues.length===0,beatAlignedCuts};
}
