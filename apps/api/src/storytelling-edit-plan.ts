import {cinematicPreferencesSchema,collageAnimationSettingsSchema,movieSettingsSchema,storyboardContentSchema,type CinematicPreferences,type CinematicCompositionSummary,type PhotoSequence,type StoryboardContent,type StoryboardScene,type MovieReadinessIssue,type MovieSettings,type MovieClipCandidate,type TextOverlay} from '@memories/shared';
import type {DirectorPhotoRow} from './director-store.js';
import {stableCinematicId} from './photo-sequence-analyzer.js';
import {NarrativeTextEngine} from './cinematic-editing-director.js';
import {compileMovieTimeline} from './movie-timeline.js';

export type StorytellingClipCandidate=MovieClipCandidate&{sourcePhotoIds?:string[];sourceAssetId?:string};
export type StorytellingEditPlanInput={storyboard:StoryboardContent&{id?:string;projectId?:string};photos:readonly DirectorPhotoRow[];sequences:readonly PhotoSequence[];preferences:CinematicPreferences;seed?:string;settings?:MovieSettings;targetDurationSeconds?:number;clips?:readonly StorytellingClipCandidate[]};
export type StorytellingEditPlanProof={sourcePhotoIds:string[];representedPhotoIds:string[];excludedPhotoIds:string[];preservedGeneratedSceneIds:string[];reusedGeneratedSceneCount:number;existingMultiImageSceneIds:string[];collageScenes:{id:string;sourcePhotoIds:string[];photoSequenceId?:string;relatedSequenceIds:string[];layout:string}[];localOnly:true;paidGenerationRequests:0;metadataCapacityOnly:boolean};
export type StorytellingEditPlan={content:StoryboardContent;summary:CinematicCompositionSummary;warnings:string[];issues:MovieReadinessIssue[];proof:StorytellingEditPlanProof};
type Group={ids:string[];sequence?:PhotoSequence;relatedIds:string[];reviewed:boolean;presentation:StoryboardScene['presentationType'];layout?:StoryboardScene['collageLayout'];overlays:TextOverlay[];description:string;};
const generated=(scene:StoryboardScene)=>scene.type==='ORIGINAL_ANIMATION'||scene.type==='NEW_CINEMATIC_SCENE';
function actualOriginalInputs(scene:StoryboardScene,clips?:readonly StorytellingClipCandidate[]){if(scene.type!=='ORIGINAL_ANIMATION')return [];
 const clip=clips?.find(clip=>clip.sceneId===scene.id&&clip.decision==='approved'&&clip.state==='COMPLETED');if(clip?.sourcePhotoIds?.length)return [...new Set(clip.sourcePhotoIds)];if(clip?.sourceAssetId)return [clip.sourceAssetId];
 if(scene.presentationType==='CHAINED_KEYFRAME_ANIMATION')return [...new Set((scene.sequenceSegments??[]).flatMap(segment=>segment.sourcePhotoIds))];
 if(scene.presentationType==='FIRST_LAST_FRAME_INTERPOLATION')return [scene.firstFramePhotoId,scene.lastFramePhotoId].filter((id):id is string=>Boolean(id));
 if(scene.presentationType==='MULTI_REFERENCE_VIDEO')return scene.referencePhotoIds?.length?scene.referencePhotoIds:[...scene.sourcePhotoIds];
 return scene.sourcePhotoIds.slice(0,1); // Legacy single-image video used one original, regardless of its provenance array.
}
function layout(count:number,index:number):NonNullable<StoryboardScene['collageLayout']>{return count===2?'SPLIT_SCREEN':count===3?'EDITORIAL_THREE':count<=4?'GRID_FOUR':count<=6?index%2?'FILMSTRIP':'MOSAIC_SIX':index%2?'TRAVEL_BOARD':'CONTACT_SHEET_EIGHT';}

/**
 * Free, deterministic edit adapter for saved P3 storyboards and manual P5.
 * Existing generated scene IDs/prompts/approvals are immutable. Only local
 * montage slots are re-composed; no provider call or scene approval occurs.
 */
export function buildStorytellingEditPlan(input:StorytellingEditPlanInput):StorytellingEditPlan {
 const board=storyboardContentSchema.parse({schemaVersion:input.storyboard.schemaVersion,title:input.storyboard.title,synopsis:input.storyboard.synopsis,targetDurationSeconds:input.storyboard.targetDurationSeconds,scenes:input.storyboard.scenes});
 const preferences=cinematicPreferencesSchema.parse(input.preferences),seed=input.seed??input.storyboard.id??stableCinematicId(JSON.stringify(board)),owner=input.storyboard.projectId??input.photos[0]?.asset.projectId;
 const settings=movieSettingsSchema.parse(input.settings??{targetDurationSeconds:input.targetDurationSeconds??board.targetDurationSeconds});
 const target=input.targetDurationSeconds??settings.targetDurationSeconds,issues:MovieReadinessIssue[]=[],warnings:string[]=[];
 const byId=new Map(input.photos.filter(photo=>photo.asset.projectId===owner).map(photo=>[photo.asset.id,photo]));
 const sequences=input.sequences.filter(sequence=>sequence.projectId===owner),sequenceExclusions=new Set(sequences.filter(sequence=>sequence.excluded).flatMap(sequence=>sequence.orderedPhotoIds));
 const localSlots=board.scenes.filter(scene=>scene.type==='PHOTO_MONTAGE'),fixed=board.scenes.filter(scene=>scene.type!=='PHOTO_MONTAGE'),generatedScenes=fixed.filter(generated),originalInputs=[...new Set(generatedScenes.flatMap(scene=>actualOriginalInputs(scene,input.clips)))],originalInputSet=new Set(originalInputs);
 const named=new Set(board.scenes.flatMap(scene=>scene.sourcePhotoIds));
 const supplemental=board.scenes.flatMap(scene=>scene.type==='TITLE_SEQUENCE'?scene.sourcePhotoIds:scene.type==='ORIGINAL_ANIMATION'?scene.sourcePhotoIds.filter(id=>!originalInputSet.has(id)):[]);
 // An explicit pin authorizes an original already named in this saved board to
 // appear as a still, even when the older plan used it only as fictional guidance.
 const pinnedNamed=[...named].filter(id=>byId.get(id)?.curation.pinned&&!originalInputSet.has(id));
 const allSources=[...new Set([...localSlots.flatMap(scene=>scene.sourcePhotoIds),...supplemental,...pinnedNamed])];
 const excluded=allSources.filter(id=>!byId.get(id)?.asset.selected||byId.get(id)?.curation.excluded||sequenceExclusions.has(id));
 const allowed=allSources.filter(id=>!excluded.includes(id)),allowedSet=new Set(allowed);
 if(input.sequences.some(sequence=>sequence.projectId!==owner))issues.push({code:'STORYTELLING_SEQUENCE_OWNER',message:'A moment belongs to another project. Load only this project’s private moments.'});
 if(excluded.length)warnings.push(`${excluded.length} missing, deselected, or excluded originals were omitted from local compositions. Their inclusion settings were not changed.`);
 for(const scene of generatedScenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION'))if(actualOriginalInputs(scene,input.clips).some(id=>!byId.has(id)||byId.get(id)?.curation.excluded||sequenceExclusions.has(id)))issues.push({code:'STORYTELLING_GENERATED_SOURCE_EXCLUDED',sceneId:scene.id,message:'An existing animated clip uses a source from an excluded moment. Remove or revise that saved scene before rendering; this local edit will not replace an approved clip silently.'});
 const engine=new NarrativeTextEngine(),assigned=new Set<string>(),groups:Group[]=[];
 const candidates=[...sequences].filter(sequence=>!sequence.excluded).sort((a,b)=>Number(b.reviewed)-Number(a.reviewed)||Math.min(...a.orderedPhotoIds.map(id=>allSources.indexOf(id)).filter(index=>index>=0),Infinity)-Math.min(...b.orderedPhotoIds.map(id=>allSources.indexOf(id)).filter(index=>index>=0),Infinity)||a.id.localeCompare(b.id));
 for(const sequence of candidates){const ids=sequence.orderedPhotoIds.filter(id=>allowedSet.has(id)&&!assigned.has(id));if(!ids.length)continue;ids.forEach(id=>assigned.add(id));let presentation=sequence.recommendedPresentationType;
  if(['SINGLE_IMAGE_ANIMATION','FIRST_LAST_FRAME_INTERPOLATION','CHAINED_KEYFRAME_ANIMATION','MULTI_REFERENCE_VIDEO','NEW_CINEMATIC_SCENE'].includes(presentation)){
   presentation=sequence.reviewed?'CINEMATIC_PHOTO_MONTAGE':ids.length>1?'ANIMATED_PHOTO_COLLAGE':'KEN_BURNS_PHOTO';
   if(sequence.reviewed)warnings.push('A moment requesting new generated motion is represented with its original photographs in this local render. Generate a separately approved multi-image clip to change its motion.');
  }
  if(!sequence.reviewed)presentation=ids.length===1?'KEN_BURNS_PHOTO':preferences.distribution.collages===0||preferences.distribution.montages>0&&groups.length%3===2?'CINEMATIC_PHOTO_MONTAGE':'ANIMATED_PHOTO_COLLAGE';
  groups.push({ids,sequence,relatedIds:[sequence.id],reviewed:sequence.reviewed,presentation,layout:sequence.collageLayout,overlays:sequence.textOverlays.filter(overlay=>engine.validateProposal(overlay,input.photos)&&overlay.evidencePhotoIds.every(id=>ids.includes(id))),description:sequence.description});
 }
 for(const id of allowed)if(!assigned.has(id))groups.push({ids:[id],relatedIds:[],reviewed:false,presentation:'KEN_BURNS_PHOTO',overlays:[],description:byId.get(id)?.analysis?.description??'An original photographic memory.'});
 // Contact sheets may show independent memories together; grouping is not a
 // claim that they form one real event or a continuous generated animation.
 const packed:Group[]=[],singletons:Group[]=[];
 for(const group of groups)if(group.ids.length===1&&!group.reviewed)singletons.push(group);else packed.push(group);
 for(let at=0;at<singletons.length;at+=preferences.maximumCollagePhotos){const chunk=singletons.slice(at,at+preferences.maximumCollagePhotos),ids=chunk.flatMap(group=>group.ids),relatedIds=[...new Set(chunk.flatMap(group=>group.relatedIds))];packed.push({ids,relatedIds,sequence:chunk[0].sequence,reviewed:false,presentation:ids.length>1&&preferences.distribution.collages>0?preferences.distribution.montages>0&&Math.floor(at/preferences.maximumCollagePhotos)%3===2?'CINEMATIC_PHOTO_MONTAGE':'ANIMATED_PHOTO_COLLAGE':'KEN_BURNS_PHOTO',overlays:chunk.flatMap(group=>group.overlays),description:ids.length>1?'A thematic collection of original memories, not a claim of one continuous event.':chunk[0].description});}
 packed.sort((a,b)=>Math.min(...a.ids.map(id=>allSources.indexOf(id)))-Math.min(...b.ids.map(id=>allSources.indexOf(id))));
 const chunks:Group[]=[];for(const group of packed){const size=group.presentation==='ANIMATED_PHOTO_COLLAGE'?preferences.maximumCollagePhotos:30;for(let at=0;at<group.ids.length;at+=size){const ids=group.ids.slice(at,at+size);chunks.push({...group,ids,presentation:ids.length===1&&group.presentation==='ANIMATED_PHOTO_COLLAGE'?'KEN_BURNS_PHOTO':group.presentation,overlays:group.overlays.filter(overlay=>overlay.evidencePhotoIds.every(id=>ids.includes(id)))});}}
 const localSeconds=localSlots.reduce((sum,scene)=>sum+scene.durationSeconds,0),capacity=40-fixed.length;
 if(chunks.length>capacity)issues.push({code:'STORYTELLING_SCENE_CAPACITY',message:'These moment overrides exceed the saved storyboard’s 40-scene composition capacity. Merge compatible moments or use fewer separate local layouts.'});
 if(chunks.length>localSeconds||localSeconds>chunks.length*60)issues.push({code:'STORYTELLING_PACING_CAPACITY',message:'The saved local montage slots cannot allocate these moment groups within 1–60 seconds per scene. Save a storyboard with more local-photo time or merge compatible moments.'});
 const baseline=localSlots[0],locals:StoryboardScene[]=[];
 if(baseline&&chunks.length&&chunks.length<=capacity&&chunks.length<=localSeconds&&localSeconds<=chunks.length*60){
  const values=chunks.map(()=>1);let remaining=localSeconds-chunks.length;while(remaining){const eligible=chunks.map((_,index)=>index).filter(index=>values[index]<60),weight=eligible.reduce((sum,index)=>sum+chunks[index].ids.length,0);for(const index of eligible){const value=Math.min(60-values[index],remaining,Math.max(1,Math.floor(remaining*chunks[index].ids.length/weight)));values[index]+=value;remaining-=value;if(!remaining)break;}}
  const usedTextIds=new Set<string>();
  for(const [index,group] of chunks.entries()){
   const collage=group.presentation==='ANIMATED_PHOTO_COLLAGE',ids=group.ids,sceneId=stableCinematicId(`${seed}:storytelling-local:${index}:${ids.join(',')}:${group.presentation}:${group.layout??''}`),people=[...new Set(ids.flatMap(id=>{const photo=byId.get(id);return photo?.curation.associationsConfirmed?photo.curation.protagonistIds:[];}))];
   const existingText=localSlots.filter(slot=>slot.sourcePhotoIds.some(id=>ids.includes(id))).flatMap(slot=>slot.textOverlays??[]).filter(overlay=>engine.validateProposal(overlay,input.photos)&&overlay.evidencePhotoIds.every(id=>ids.includes(id)));
   const selectedText=[...group.overlays,...existingText].filter(overlay=>{if(usedTextIds.has(overlay.id))return false;usedTextIds.add(overlay.id);return true;}).slice(0,12);
   const overlays=selectedText.map(overlay=>({...overlay,startSeconds:Math.min(overlay.startSeconds,Math.max(0,values[index]-1/30)),durationSeconds:Math.min(overlay.durationSeconds,values[index]-Math.min(overlay.startSeconds,Math.max(0,values[index]-1/30)))}));
   if(preferences.automaticText&&!overlays.length&&(index===0||index===Math.floor(chunks.length/2)))overlays.push(engine.propose(sceneId,preferences.language,index===0?'chapter':'caption',Math.min(4,values[index])));
   locals.push({...baseline,id:sceneId,sequenceNumber:1,type:'PHOTO_MONTAGE',title:group.sequence?.sequenceType==='ACTION_SEQUENCE'||group.sequence?.sequenceType==='BURST_SEQUENCE'?'Original sequence of moments':collage?'Original-photo collage':'Original photographic memories',description:group.description.slice(0,3000),durationSeconds:values[index],sourcePhotoIds:ids,protagonistIds:people,photoSequenceId:group.sequence?.id,relatedSequenceIds:group.relatedIds,presentationType:group.presentation,animationStrategy:collage?'LOCAL_COLLAGE':ids.length===1?'KEN_BURNS':'LOCAL_MONTAGE',collageLayout:collage?group.layout??layout(ids.length,index):undefined,collageAnimationSettings:collage?collageAnimationSettingsSchema.parse({entrance:preferences.editingStyle==='Minimal'?'fade':'stagger',gentleZoom:preferences.editingStyle!=='Documentary'}):undefined,firstFramePhotoId:ids[0],lastFramePhotoId:ids.at(-1),intermediatePhotoIds:ids.slice(1,-1),referencePhotoIds:[],sequenceSegments:[],textOverlays:overlays,typographyPreset:preferences.editingStyle==='Minimal'?'minimal':preferences.editingStyle==='Documentary'?'documentary':'cinematic',musicCue:{syncToBeat:true,energy:preferences.editingStyle==='Energetic'?'high':'medium'},isFictional:false,fictionalScene:false,requiresUserConfirmation:localSlots.some(scene=>scene.requiresUserConfirmation),userConfirmed:localSlots.every(scene=>!scene.requiresUserConfirmation||scene.userConfirmed),generationInstructions:'Render exactly these original imported photographs as a deterministic local composition. No generated motion or new provider request is authorized.'});
  }
 }
 let content=structuredClone(board);
 if(locals.length){
  let cursor=0,seenSlots=0;const scenes:StoryboardScene[]=[];let accumulated=0;
  for(const scene of board.scenes){if(scene.type!=='PHOTO_MONTAGE'){scenes.push(structuredClone(scene));continue;}seenSlots++;accumulated+=scene.durationSeconds;const desired=seenSlots===localSlots.length?locals.length:Math.round(accumulated/Math.max(1,localSeconds)*locals.length);while(cursor<desired)scenes.push(locals[cursor++]);}
  while(cursor<locals.length)scenes.push(locals[cursor++]);scenes.forEach((scene,index)=>{scene.sequenceNumber=index+1;});content=storyboardContentSchema.parse({...board,scenes});
  const boardId=input.storyboard.id??stableCinematicId(`${seed}:storyboard`);
  const metadataClips=generatedScenes.map(scene=>({id:scene.id,sceneId:scene.id,storyboardId:boardId,durationSeconds:Math.min(scene.durationSeconds,scene.sequenceSegments?.length?scene.sequenceSegments.reduce((sum,segment)=>sum+segment.durationSeconds,0):8),decision:'approved' as const,state:'COMPLETED'}));
  const compile=()=>compileMovieTimeline({storyboard:{...content,id:boardId},settings:{...settings,targetDurationSeconds:target},clips:input.clips?[...input.clips]:metadataClips,availablePhotoIds:allowed});
  for(const scene of locals.filter(scene=>scene.presentationType==='ANIMATED_PHOTO_COLLAGE').sort((a,b)=>b.sourcePhotoIds.length-a.sourcePhotoIds.length)){
   if(!compile().issues.some(issue=>issue.code==='INSUFFICIENT_DURATION'))break;
   const group=chunks.find(group=>group.ids.length===scene.sourcePhotoIds.length&&group.ids.every(id=>scene.sourcePhotoIds.includes(id)));
   if(group?.reviewed||scene.sourcePhotoIds.length*8<=20)continue;
   const current=content.scenes.find(item=>item.id===scene.id)!;current.presentationType='CINEMATIC_PHOTO_MONTAGE';current.animationStrategy='LOCAL_MONTAGE';current.collageLayout=undefined;current.collageAnimationSettings=undefined;
  }
  const compiled=compile();for(const issue of compiled.issues.filter(issue=>['INSUFFICIENT_DURATION','EXCESS_MEDIA_DURATION','COLLAGE_PHOTO_COUNT','MISSING_PHOTO','TIMELINE_DURATION_MISMATCH'].includes(issue.code)))issues.push({...issue,code:`STORYTELLING_${issue.code}`});
 }
 const renderedLocal=content.scenes.filter(scene=>scene.type==='PHOTO_MONTAGE'),represented=[...new Set([...renderedLocal.flatMap(scene=>scene.sourcePhotoIds),...originalInputs])];
 const outsidePins=input.photos.filter(photo=>photo.asset.projectId===owner&&photo.asset.selected&&!photo.curation.excluded&&!sequenceExclusions.has(photo.asset.id)&&photo.curation.pinned&&!represented.includes(photo.asset.id));if(outsidePins.length)issues.push({code:'STORYTELLING_PIN_NOT_IN_STORYBOARD',message:'Some pinned originals are not named anywhere in the saved storyboard. Save a revised storyboard to include them; this local edit does not add photographs outside the saved storyboard or regenerate clips.'});
 const currentGenerated=content.scenes.filter(generated),approved=input.clips?currentGenerated.filter(scene=>input.clips!.some(clip=>clip.sceneId===scene.id&&clip.decision==='approved'&&clip.state==='COMPLETED')).length:0;
 const distribution:Record<string,number>={originalAnimations:0,newScenes:0,collages:0,montages:0,titles:0};for(const scene of content.scenes){const key=scene.type==='ORIGINAL_ANIMATION'?'originalAnimations':scene.type==='NEW_CINEMATIC_SCENE'?'newScenes':scene.type==='TITLE_SEQUENCE'?'titles':scene.presentationType==='ANIMATED_PHOTO_COLLAGE'?'collages':'montages';distribution[key]+=scene.durationSeconds/Math.max(1,board.targetDurationSeconds);}
 if(!locals.length&&allSources.length)warnings.push('The saved local-photo slots could not be re-composed safely. Resolve the displayed moment/pacing issues before rendering.');
 if(!allSources.length)warnings.push('This storyboard has no local PHOTO_MONTAGE sources. Save a storyboard with original-photo slots to render moment collages; existing clips were left unchanged.');
 warnings.push('Existing generated clips keep their original input mode. Adding a local collage does not turn an old single-image clip into a multi-image animation.');
 const proof:StorytellingEditPlanProof={sourcePhotoIds:allSources,representedPhotoIds:represented,excludedPhotoIds:excluded,preservedGeneratedSceneIds:generatedScenes.map(scene=>scene.id),reusedGeneratedSceneCount:approved,existingMultiImageSceneIds:generatedScenes.filter(scene=>['FIRST_LAST_FRAME_INTERPOLATION','CHAINED_KEYFRAME_ANIMATION','MULTI_REFERENCE_VIDEO'].includes(scene.presentationType??'')).map(scene=>scene.id),collageScenes:renderedLocal.filter(scene=>scene.presentationType==='ANIMATED_PHOTO_COLLAGE').map(scene=>({id:scene.id,sourcePhotoIds:scene.sourcePhotoIds,photoSequenceId:scene.photoSequenceId,relatedSequenceIds:scene.relatedSequenceIds??[],layout:scene.collageLayout??layout(scene.sourcePhotoIds.length,0)})),localOnly:true,paidGenerationRequests:0,metadataCapacityOnly:!input.clips};
 return {content,summary:{importedPhotos:input.photos.length,recognizedSequences:sequences.length,selectedMoments:new Set(renderedLocal.flatMap(scene=>scene.relatedSequenceIds?.length?scene.relatedSequenceIds:scene.photoSequenceId?[scene.photoSequenceId]:[])).size,uniqueSourcePhotos:represented.length,multiImageAnimatedScenes:proof.existingMultiImageSceneIds.length,collageScenes:proof.collageScenes.length,montageScenes:renderedLocal.filter(scene=>scene.presentationType!=='ANIMATED_PHOTO_COLLAGE').length,newFictionalScenes:generatedScenes.filter(scene=>scene.type==='NEW_CINEMATIC_SCENE').length,animatedScenes:generatedScenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION').length,textElements:content.scenes.reduce((sum,scene)=>sum+(scene.textOverlays?.length??0),0),plannedDurationSeconds:target,estimatedAiCostUsd:0,reusedP4ClipCount:approved,distribution,warnings:[...new Set(warnings)]},warnings:[...new Set(warnings)],issues,proof};
}
