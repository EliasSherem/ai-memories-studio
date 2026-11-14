import {compileMovieTimeline} from './movie-timeline.js';
import {cinematicPreferencesSchema,collageAnimationSettingsSchema,textOverlaySchema,storyboardContentSchema,type PhotoSequence,type PresentationType,type AnimationStrategy,type SequenceSegment,type StoryboardContent,type StoryboardScene,type ProductionConfig,type CinematicCompositionSummary,type TextOverlay,type CinematicPreferences} from '@memories/shared';
import type {DirectorPhotoRow} from './director-store.js';
import {stableCinematicId,reliableCaptureTimestamp} from './photo-sequence-analyzer.js';
import {ApiError} from './errors.js';

export type SequenceProviderCapabilities={supportsFirstLastFrame:boolean;supportsMultiReference:boolean;maxReferenceImages:number;clipDurationSeconds:number;maximumSegments?:number};
export type SequenceAnimationPlan={presentationType:PresentationType;animationStrategy:AnimationStrategy;sourcePhotoIds:string[];firstFramePhotoId:string;lastFramePhotoId:string;intermediatePhotoIds:string[];referencePhotoIds:string[];sequenceSegments:SequenceSegment[];warnings:string[]};
/** Sequential keyframes and unordered references are separate provider modes. */
export class SequenceAnimationPlanner {
 plan(sequence:PhotoSequence,capabilities:SequenceProviderCapabilities):SequenceAnimationPlan {
  const ids=sequence.orderedPhotoIds,warnings=[...sequence.warnings];let presentationType=sequence.recommendedPresentationType,animationStrategy=sequence.recommendedAnimationStrategy;const segments:SequenceSegment[]=[];
  let frames=[ids[0],ids.at(-1)!],references:string[]=[];
  if(presentationType==='ANIMATED_PHOTO_COLLAGE')animationStrategy='LOCAL_COLLAGE';if(presentationType==='CINEMATIC_PHOTO_MONTAGE')animationStrategy='LOCAL_MONTAGE';if(presentationType==='KEN_BURNS_PHOTO')animationStrategy='KEN_BURNS';
  if(presentationType==='SINGLE_IMAGE_ANIMATION'&&ids.length>1){presentationType='CINEMATIC_PHOTO_MONTAGE';animationStrategy='LOCAL_MONTAGE';warnings.push('A multi-photo moment cannot silently become a single-image request; all originals will remain in a local montage. Split the moment to animate one image.');}
  if(['NEW_CINEMATIC_SCENE','TEXT_OVERLAY','CHAPTER_TITLE','OPENING_TITLE','CLOSING_SEQUENCE'].includes(presentationType)){presentationType='CINEMATIC_PHOTO_MONTAGE';animationStrategy='LOCAL_MONTAGE';warnings.push('This original moment uses a local photographic scene with text; new fictional generation uses separately budgeted cinematic scenes.');}
  if(ids.length===1){if(sequence.reviewed&&['ANIMATED_PHOTO_COLLAGE','CINEMATIC_PHOTO_MONTAGE','KEN_BURNS_PHOTO'].includes(presentationType)){presentationType='KEN_BURNS_PHOTO';animationStrategy='KEN_BURNS';}else {presentationType='SINGLE_IMAGE_ANIMATION';animationStrategy='SINGLE_IMAGE';}}
  else if(presentationType==='MULTI_REFERENCE_VIDEO'){
   if(capabilities.supportsMultiReference&&ids.length<=capabilities.maxReferenceImages){references=[...ids];animationStrategy='UNORDERED_REFERENCES';}
   else {presentationType='CINEMATIC_PHOTO_MONTAGE';animationStrategy='LOCAL_MONTAGE';warnings.push(`This provider accepts at most ${capabilities.maxReferenceImages} unordered references; all ${ids.length} images will remain in a local montage instead of silently dropping sources.`);}
  }else if((presentationType==='CHAINED_KEYFRAME_ANIMATION'||presentationType==='FIRST_LAST_FRAME_INTERPOLATION')&&capabilities.supportsFirstLastFrame&&sequence.temporalConfidence>=.8&&sequence.actionContinuityScore>=20){
   const maximumPairs=Math.max(1,Math.min(3,capabilities.maximumSegments??3));
   if(ids.length>=3&&presentationType==='CHAINED_KEYFRAME_ANIMATION'&&maximumPairs>=2){
    const count=Math.min(ids.length,maximumPairs+1);frames=Array.from({length:count},(_,index)=>ids[Math.round(index*(ids.length-1)/(count-1))]);
    for(let index=0;index<frames.length-1;index++)segments.push({id:stableCinematicId(`${sequence.id}:pair:${frames[index]}:${frames[index+1]}`),firstFramePhotoId:frames[index],lastFramePhotoId:frames[index+1],sourcePhotoIds:[frames[index],frames[index+1]],durationSeconds:capabilities.clipDurationSeconds});
    animationStrategy='CHAINED_PAIRS';
   }else {presentationType='FIRST_LAST_FRAME_INTERPOLATION';animationStrategy='FIRST_LAST_FRAME';}
  }else if(presentationType==='FIRST_LAST_FRAME_INTERPOLATION'||presentationType==='CHAINED_KEYFRAME_ANIMATION'){
   presentationType='CINEMATIC_PHOTO_MONTAGE';animationStrategy='LOCAL_MONTAGE';warnings.push('Capture progression or actual first/last-frame capability is uncertain; preserve the ordered originals in a local montage.');
  }
  return {presentationType,animationStrategy,sourcePhotoIds:[...ids],firstFramePhotoId:frames[0],lastFramePhotoId:frames.at(-1)!,intermediatePhotoIds:frames.slice(1,-1),referencePhotoIds:references,sequenceSegments:segments,warnings};
 }
}

const languageText={en:{opening:'A story in moments',chapter:'The moments we keep',caption:'Small moments, lasting memories',closing:'To the chapters still to come'},es:{opening:'Una historia en instantes',chapter:'Los momentos que guardamos',caption:'Pequeños momentos, recuerdos que perduran',closing:'Por los capítulos que vendrán'},he:{opening:'סיפור ברגעים',chapter:'הרגעים שנשארים איתנו',caption:'רגעים קטנים, זיכרונות שנשארים',closing:'לפרקים שעוד יבואו'}};
export class NarrativeTextEngine {
 propose(seed:string,language:'en'|'es'|'he',kind:'opening'|'chapter'|'caption'|'closing',durationSeconds=4):TextOverlay {
  return textOverlaySchema.parse({id:stableCinematicId(`${seed}:text:${kind}:${language}`),type:kind==='opening'?'OPENING_TITLE':kind==='chapter'?'CHAPTER_TITLE':kind==='closing'?'CLOSING_MESSAGE':'EMOTIONAL_PHRASE',text:languageText[language][kind],durationSeconds,position:kind==='caption'?'lower-third':'center',alignment:language==='he'?'right':'center',language,animation:'fade',factual:false});
 }
 verifiedDate(seed:string,row:DirectorPhotoRow,language:'en'|'es'|'he'):TextOverlay|undefined {
  const date=reliableCaptureTimestamp(row);if(!date)return;
  return textOverlaySchema.parse({id:stableCinematicId(`${seed}:date:${row.asset.id}`),type:'DATE_CAPTION',text:date.slice(0,10),durationSeconds:3,position:'lower-third',alignment:language==='he'?'right':'left',language,evidencePhotoIds:[row.asset.id],factual:true});
 }
 /** AI factual labels need exact trusted evidence, never scene-description guesses. */
 validateProposal(overlay:TextOverlay,photos:readonly DirectorPhotoRow[]):boolean {
  if(!overlay.factual||overlay.userProvided)return true;
  if(overlay.type!=='DATE_CAPTION'||!overlay.evidencePhotoIds.length)return false;
  return overlay.evidencePhotoIds.every(id=>{const photo=photos.find(row=>row.asset.id===id);return photo&&reliableCaptureTimestamp(photo)?.slice(0,10)===overlay.text;});
 }
}

function layoutFor(count:number,index:number){if(count<=2)return index%2?'BEFORE_AFTER':'SPLIT_SCREEN';if(count===3)return 'EDITORIAL_THREE';if(count<=4)return 'GRID_FOUR';if(count<=6)return index%2?'FILMSTRIP':'MOSAIC_SIX';return index%2?'TRAVEL_BOARD':'CONTACT_SHEET_EIGHT';}
function quality(row:DirectorPhotoRow){return row.analysis?row.analysis.storytellingPotential*.6+(row.analysis.sharpness+row.analysis.composition)/2*.4:0;}
function rankMoments(sequences:readonly PhotoSequence[]){
 const remaining=sequences.filter(sequence=>!sequence.excluded),selected:PhotoSequence[]=[];
 while(remaining.length){remaining.sort((a,b)=>{const score=(item:PhotoSequence)=>Number(item.pinned)*1000+item.narrativeImportanceScore+item.actionContinuityScore*.1-(selected.slice(-2).some(prior=>prior.sequenceType===item.sequenceType)?8:0);return score(b)-score(a)||a.id.localeCompare(b.id);});selected.push(remaining.shift()!);}
 return selected;
}
/** Existing guarded Gemini output can refine local candidates without inventing capture evidence. */
export function applyCinematicProposals(sequences:readonly PhotoSequence[],content:StoryboardContent,photos:readonly DirectorPhotoRow[]):PhotoSequence[]{
 const text=new NarrativeTextEngine();
 return sequences.map(sequence=>{
  if(sequence.reviewed)return sequence;
  const proposal=content.scenes.find(scene=>scene.photoSequenceId===sequence.id&&scene.sourcePhotoIds.length>0&&scene.sourcePhotoIds.every(id=>sequence.orderedPhotoIds.includes(id))&&!scene.isFictional);
  if(!proposal)return sequence;
  const mode=proposal.presentationType??sequence.recommendedPresentationType;
  const strategy:AnimationStrategy=mode==='FIRST_LAST_FRAME_INTERPOLATION'?'FIRST_LAST_FRAME':mode==='CHAINED_KEYFRAME_ANIMATION'?'CHAINED_PAIRS':mode==='MULTI_REFERENCE_VIDEO'?'UNORDERED_REFERENCES':mode==='ANIMATED_PHOTO_COLLAGE'?'LOCAL_COLLAGE':mode==='SINGLE_IMAGE_ANIMATION'?'SINGLE_IMAGE':mode==='KEN_BURNS_PHOTO'?'KEN_BURNS':'LOCAL_MONTAGE';
  return {...sequence,recommendedPresentationType:mode,recommendedAnimationStrategy:strategy,...(proposal.collageLayout?{collageLayout:proposal.collageLayout}:{}),textOverlays:[...sequence.textOverlays,...(proposal.textOverlays??[]).filter(overlay=>text.validateProposal(overlay,photos))].slice(0,12),warnings:[...sequence.warnings,'Presentation refined by the existing approved Gemini storyboard request; capture-time confidence remains unchanged.']};
 });
}

export type CinematicShapeInput={content:StoryboardContent;proposals?:StoryboardContent;photos:readonly DirectorPhotoRow[];sequences:readonly PhotoSequence[];config:ProductionConfig;seed:string;automaticSceneApproval:boolean;capabilities:SequenceProviderCapabilities;estimatedAiCostUsd?:number;reusedP4ClipCount?:number};
export type CinematicShapeResult={content:StoryboardContent;summary:CinematicCompositionSummary;warnings:string[]};

/** Hierarchical moment selection; generated scenes retain existing P3/P4 contracts. */
export class CinematicEditingDirector {
 readonly animation=new SequenceAnimationPlanner();readonly text=new NarrativeTextEngine();
 shape(input:CinematicShapeInput):CinematicShapeResult {
  const excludedIds=new Set(input.sequences.filter(sequence=>sequence.excluded).flatMap(sequence=>sequence.orderedPhotoIds));
  const preferences=cinematicPreferencesSchema.parse(input.config.cinematic??{}),available=new Map(input.photos.filter(photo=>photo.asset.selected&&!photo.curation.excluded&&!excludedIds.has(photo.asset.id)).map(photo=>[photo.asset.id,photo]));
  const sequences=rankMoments(applyCinematicProposals(input.sequences,input.proposals??input.content,input.photos).map(sequence=>({...sequence,orderedPhotoIds:sequence.orderedPhotoIds.filter(id=>available.has(id))})).filter(sequence=>sequence.orderedPhotoIds.length));
  const warnings:string[]=[],base=storyboardContentSchema.parse(input.content),originals=base.scenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION'),fiction=base.scenes.filter(scene=>scene.type==='NEW_CINEMATIC_SCENE');
  const used=new Set<string>(),animated:StoryboardScene[]=[],local:StoryboardScene[]=[];let chainExtraAllowance=2;
  const templates=base.scenes.filter(scene=>scene.type==='PHOTO_MONTAGE');
  const neutral=templates[0]??base.scenes.find(scene=>scene.type==='ORIGINAL_ANIMATION')??base.scenes[0];
  if(!neutral)throw new ApiError(409,'CINEMATIC_PLAN_EMPTY','A cinematic plan needs source scenes.');
  const defaultTransition=preferences.editingStyle==='Energetic'?'cut':preferences.editingStyle==='Minimal'?'cut':'crossfade';
  const decorate=(scene:StoryboardScene):StoryboardScene=>({...scene,typographyPreset:preferences.editingStyle==='Documentary'?'documentary':preferences.editingStyle==='Minimal'?'minimal':'cinematic',visualStyle:`${input.config.cinematicStyle} Editing style: ${preferences.editingStyle}.`,transitionIn:defaultTransition,transitionOut:defaultTransition,musicCue:{syncToBeat:true,energy:preferences.editingStyle==='Energetic'?'high':preferences.editingStyle==='Emotional'||preferences.editingStyle==='Romantic'?'low':'medium'},fictionalScene:scene.isFictional});
  for(const [index,template] of originals.entries()){
   // Rank whole moments first, then choose the strongest representative only
   // when a genuinely independent single image is the appropriate technique.
   const eligible=sequences.filter(sequence=>!used.has(sequence.id)&&!sequence.excluded&&(!sequence.reviewed||['SINGLE_IMAGE_ANIMATION','FIRST_LAST_FRAME_INTERPOLATION','CHAINED_KEYFRAME_ANIMATION','MULTI_REFERENCE_VIDEO'].includes(sequence.recommendedPresentationType)));
   const moment=eligible.find(sequence=>sequence.orderedPhotoIds.some(id=>template.sourcePhotoIds.includes(id)))??eligible[0];
   if(!moment){warnings.push('No additional distinct moment is available for an original animation.');continue;}
   used.add(moment.id);
   let candidate=moment;
   if(!candidate.reviewed&&(candidate.recommendedPresentationType==='ANIMATED_PHOTO_COLLAGE'||candidate.recommendedPresentationType==='CINEMATIC_PHOTO_MONTAGE'||candidate.recommendedPresentationType==='KEN_BURNS_PHOTO'))candidate={...candidate,recommendedPresentationType:candidate.orderedPhotoIds.length>1?'MULTI_REFERENCE_VIDEO':'SINGLE_IMAGE_ANIMATION',recommendedAnimationStrategy:candidate.orderedPhotoIds.length>1?'UNORDERED_REFERENCES':'SINGLE_IMAGE'};
   const plan=this.animation.plan(candidate,{...input.capabilities,maximumSegments:1+chainExtraAllowance});
   if(plan.sequenceSegments.length>1)chainExtraAllowance-=plan.sequenceSegments.length-1;
   warnings.push(...plan.warnings);
   const common={...decorate(template),protagonistIds:[...new Set(moment.orderedPhotoIds.flatMap(id=>{const row=available.get(id);return row?.curation.associationsConfirmed?row.curation.protagonistIds:[];}))],id:stableCinematicId(`${input.seed}:animation:${index}`),photoSequenceId:moment.id,textOverlays:moment.textOverlays.filter(overlay=>this.text.validateProposal(overlay,input.photos)),sourcePhotoIds:plan.sourcePhotoIds,firstFramePhotoId:plan.firstFramePhotoId,lastFramePhotoId:plan.lastFramePhotoId,intermediatePhotoIds:plan.intermediatePhotoIds,referencePhotoIds:plan.referencePhotoIds,presentationType:plan.presentationType,animationStrategy:plan.animationStrategy,sequenceSegments:plan.sequenceSegments,description:moment.description,durationSeconds:plan.sequenceSegments.length>1?plan.sequenceSegments.reduce((sum,segment)=>sum+segment.durationSeconds,0):template.durationSeconds,estimatedDuration:plan.sequenceSegments.length>1?plan.sequenceSegments.reduce((sum,segment)=>sum+segment.durationSeconds,0):template.durationSeconds,continuityNotes:`${moment.temporalConfidence>=.8?'Retain evidenced capture ordering.':'Thematic sequence: capture chronology is unknown.'} ${plan.warnings.join(' ')}`.slice(0,2000)};
   if(plan.animationStrategy==='LOCAL_MONTAGE'||plan.animationStrategy==='LOCAL_COLLAGE'||plan.animationStrategy==='KEN_BURNS')local.push({...common,type:'PHOTO_MONTAGE',collageLayout:layoutFor(Math.min(8,moment.orderedPhotoIds.length),index),presentationType:moment.orderedPhotoIds.length>8?'CINEMATIC_PHOTO_MONTAGE':moment.orderedPhotoIds.length>1?'ANIMATED_PHOTO_COLLAGE':'KEN_BURNS_PHOTO',animationStrategy:moment.orderedPhotoIds.length>8?'LOCAL_MONTAGE':moment.orderedPhotoIds.length>1?'LOCAL_COLLAGE':'KEN_BURNS',collageAnimationSettings:collageAnimationSettingsSchema.parse({}),isFictional:false,fictionalScene:false});
   else {
    animated.push(common);
    const transmitted=new Set(plan.animationStrategy==='CHAINED_PAIRS'?plan.sequenceSegments.flatMap(segment=>segment.sourcePhotoIds):plan.animationStrategy==='FIRST_LAST_FRAME'?[plan.firstFramePhotoId,plan.lastFramePhotoId]:plan.animationStrategy==='UNORDERED_REFERENCES'?plan.referencePhotoIds:[plan.sourcePhotoIds[0]]);
    const supporting=moment.orderedPhotoIds.filter(id=>!transmitted.has(id));
    for(let at=0;at<supporting.length;at+=preferences.maximumCollagePhotos){const ids=supporting.slice(at,at+preferences.maximumCollagePhotos),collage=ids.length>1;
     local.push(decorate({...neutral,id:stableCinematicId(`${input.seed}:sequence-continuation:${moment.id}:${at}`),sequenceNumber:1,type:'PHOTO_MONTAGE',title:'The rest of this moment',description:moment.description,durationSeconds:4,sourcePhotoIds:ids,photoSequenceId:moment.id,protagonistIds:[...new Set(ids.flatMap(id=>{const photo=available.get(id);return photo?.curation.associationsConfirmed?photo.curation.protagonistIds:[];}))],presentationType:collage?'ANIMATED_PHOTO_COLLAGE':'KEN_BURNS_PHOTO',animationStrategy:collage?'LOCAL_COLLAGE':'KEN_BURNS',collageLayout:layoutFor(ids.length,index),collageAnimationSettings:collageAnimationSettingsSchema.parse({}),firstFramePhotoId:ids[0],lastFramePhotoId:ids.at(-1),intermediatePhotoIds:ids.slice(1,-1),referencePhotoIds:[],sequenceSegments:[],textOverlays:[],isFictional:false,fictionalScene:false,requiresUserConfirmation:true,userConfirmed:input.automaticSceneApproval,generationInstructions:'Render these additional original sequence frames locally; they were not sent as generated-video keyframes.'}));
    }
   }
  }
  // Include a broad set of complete memories through simultaneous compositions.
  // Limits are timeline/schema capacity; pins are never silently discarded.
  const candidates=sequences.filter(sequence=>!used.has(sequence.id));
  const maxLocalScenes=Math.max(2,38-animated.length-fiction.length);
  const related=new Map<string,string[]>();
  const bundleIndependent=(values:PhotoSequence[],packCompleteMoments=false)=>{const thematic:PhotoSequence[]=[],packable:PhotoSequence[]=[];for(const moment of values){if(!moment.reviewed&&(moment.orderedPhotoIds.length===1||packCompleteMoments&&moment.orderedPhotoIds.length<=preferences.maximumCollagePhotos))packable.push(moment);else thematic.push(moment);}let group:PhotoSequence[]=[],count=0;const flush=()=>{if(!group.length)return;const first=group[0],ids=group.flatMap(moment=>moment.orderedPhotoIds);thematic.push({...first,orderedPhotoIds:ids,firstFramePhotoId:ids[0],lastFramePhotoId:ids.at(-1)!,intermediatePhotoIds:ids.slice(1,-1),description:group.length>1?'A thematic collection of complete original moments, not a claim of one continuous event.':first.description,recommendedPresentationType:ids.length>1?'ANIMATED_PHOTO_COLLAGE':'KEN_BURNS_PHOTO',recommendedAnimationStrategy:ids.length>1?'LOCAL_COLLAGE':'KEN_BURNS',...(group.length>1?{temporalConfidence:0,startTimestamp:null,endTimestamp:null,warnings:[...first.warnings,'Complete memories share a composition thematically; no continuous action or chronology is inferred.']}:{})});related.set(first.id,group.map(moment=>moment.id));group=[];count=0;};for(const moment of packable){if(count+moment.orderedPhotoIds.length>preferences.maximumCollagePhotos)flush();group.push(moment);count+=moment.orderedPhotoIds.length;}flush();return thematic.sort((a,b)=>b.narrativeImportanceScore-a.narrativeImportanceScore||a.id.localeCompare(b.id));};
  const pinned=bundleIndependent(candidates.filter(sequence=>sequence.pinned),true),thematic=bundleIndependent(candidates.filter(sequence=>!sequence.pinned));
  if(pinned.length+local.length>maxLocalScenes)throw new ApiError(409,'CINEMATIC_PIN_CAPACITY','Pinned complete moments exceed the movie’s 40-scene format capacity. Combine compatible moments or split the project; none were silently discarded.');
  const desiredLocal=Math.min(maxLocalScenes,Math.max(10,Math.ceil(input.config.durationSeconds/15)));
  const chosen=[...pinned,...thematic.slice(0,Math.max(0,desiredLocal-pinned.length))];
  let collageIndex=0,montageIndex=0;
  for(const moment of chosen){used.add(moment.id);let ids=moment.orderedPhotoIds;const byHash=new Set<string>();ids=ids.filter(id=>{const photo=available.get(id)!;const key=photo.asset.sha256??id;if(byHash.has(key)&&!photo.curation.pinned)return false;byHash.add(key);return true;});
   const chunks:string[][]=[];for(let at=0;at<ids.length;at+=preferences.maximumCollagePhotos)chunks.push(ids.slice(at,at+preferences.maximumCollagePhotos));
   for(const [chunkIndex,chunk] of chunks.entries()){
    if(local.length>=maxLocalScenes){if(moment.pinned)throw new ApiError(409,'CINEMATIC_PIN_CAPACITY','The pinned moment cannot fit the movie’s supported scene capacity.');break;}
    const montage=moment.reviewed?moment.recommendedPresentationType==='CINEMATIC_PHOTO_MONTAGE'||moment.recommendedPresentationType==='KEN_BURNS_PHOTO':chunk.length===1||preferences.distribution.collages===0||preferences.distribution.montages>0&&collageIndex>=2&&montageIndex<2;
    const presentation=moment.reviewed?moment.recommendedPresentationType:montage?chunk.length===1?'KEN_BURNS_PHOTO':'CINEMATIC_PHOTO_MONTAGE':'ANIMATED_PHOTO_COLLAGE';
    const textLed=['TEXT_OVERLAY','CHAPTER_TITLE','OPENING_TITLE','CLOSING_SEQUENCE'].includes(presentation);const collage=!montage&&!textLed&&chunk.length>1;
    const title=moment.sequenceType==='ACTION_SEQUENCE'||moment.sequenceType==='BURST_SEQUENCE'?'A moment in motion':moment.sequenceType==='TRAVEL_SEQUENCE'?'Along the way':'Photographic memories';
    const scene:StoryboardScene=decorate({...neutral,id:stableCinematicId(`${input.seed}:moment:${moment.id}:${chunkIndex}`),sequenceNumber:1,type:'PHOTO_MONTAGE',title,description:moment.description,durationSeconds:6,sourcePhotoIds:chunk,photoSequenceId:moment.id,relatedSequenceIds:related.get(moment.id),presentationType:collage?'ANIMATED_PHOTO_COLLAGE':presentation,animationStrategy:collage?'LOCAL_COLLAGE':chunk.length===1?'KEN_BURNS':'LOCAL_MONTAGE',firstFramePhotoId:chunk[0],lastFramePhotoId:chunk.at(-1),intermediatePhotoIds:chunk.slice(1,-1),referencePhotoIds:[],sequenceSegments:[],collageLayout:moment.collageLayout??layoutFor(chunk.length,collageIndex),collageAnimationSettings:collageAnimationSettingsSchema.parse({entrance:preferences.editingStyle==='Minimal'?'fade':'stagger',staggerSeconds:preferences.editingStyle==='Energetic'?.08:.18,gentleZoom:preferences.editingStyle!=='Documentary'}),textOverlays:moment.textOverlays.filter(overlay=>this.text.validateProposal(overlay,input.photos)),isFictional:false,fictionalScene:false,requiresUserConfirmation:true,userConfirmed:input.automaticSceneApproval,generationInstructions:'Render these exact original photographs locally. Do not generate collage pixels or invent historical events.'});
    if(textLed&&!scene.textOverlays?.length&&preferences.automaticText)scene.textOverlays=[this.text.propose(scene.id,preferences.language,presentation==='OPENING_TITLE'?'opening':presentation==='CLOSING_SEQUENCE'?'closing':presentation==='CHAPTER_TITLE'?'chapter':'caption',4)];
    if(moment.reviewed&&['FIRST_LAST_FRAME_INTERPOLATION','CHAINED_KEYFRAME_ANIMATION','MULTI_REFERENCE_VIDEO','NEW_CINEMATIC_SCENE'].includes(presentation)){scene.presentationType='CINEMATIC_PHOTO_MONTAGE';scene.animationStrategy='LOCAL_MONTAGE';warnings.push('A requested additional generated moment exceeded this plan’s selected paid-scene slots; its originals remain in a local montage. Increase AI scene count in a newly approved quote to generate it.');}
    local.push(scene);if(collage)collageIndex++;else montageIndex++;
   }
  }
  if(local.length<2){const supporting=sequences.filter(sequence=>!sequence.excluded);for(const moment of supporting.slice(0,2-local.length))local.push(decorate({...neutral,id:stableCinematicId(`${input.seed}:support:${moment.id}`),sequenceNumber:1,type:'PHOTO_MONTAGE',title:'Original memories',durationSeconds:6,sourcePhotoIds:moment.orderedPhotoIds.slice(0,8),photoSequenceId:moment.id,presentationType:moment.orderedPhotoIds.length>8?'CINEMATIC_PHOTO_MONTAGE':moment.orderedPhotoIds.length>1?'ANIMATED_PHOTO_COLLAGE':'KEN_BURNS_PHOTO',animationStrategy:moment.orderedPhotoIds.length>8?'LOCAL_MONTAGE':moment.orderedPhotoIds.length>1?'LOCAL_COLLAGE':'KEN_BURNS',collageLayout:layoutFor(moment.orderedPhotoIds.length,local.length),collageAnimationSettings:collageAnimationSettingsSchema.parse({}),isFictional:false,fictionalScene:false,requiresUserConfirmation:true,userConfirmed:input.automaticSceneApproval}));}
  const distributionTotal=Object.values(preferences.distribution).reduce((sum,value)=>sum+value,0);const preferredTitleSeconds=Math.max(4,Math.min(16,Math.round(input.config.durationSeconds*preferences.distribution.titles/distributionTotal)));
  const titles=base.scenes.filter(scene=>scene.type==='TITLE_SEQUENCE');
  const title=(closing:boolean)=>decorate({...titles[closing?titles.length-1:0]??neutral,id:stableCinematicId(`${input.seed}:${closing?'closing':'opening'}`),sequenceNumber:1,type:'TITLE_SEQUENCE',title:closing?'Closing sequence':input.config.title,description:closing?'A closing message, not a claim about real events.':'The user-provided movie title.',durationSeconds:closing?preferredTitleSeconds-Math.floor(preferredTitleSeconds/2):Math.floor(preferredTitleSeconds/2),sourcePhotoIds:[],protagonistIds:[],presentationType:closing?'CLOSING_SEQUENCE':'OPENING_TITLE',animationStrategy:'TEXT_ONLY',textOverlays:preferences.automaticText?[this.text.propose(input.seed,preferences.language,closing?'closing':'opening',5)]:[],isFictional:false,fictionalScene:false,requiresUserConfirmation:false,userConfirmed:input.automaticSceneApproval});
  const motion=animated.map(decorate),fictional=fiction.map(scene=>decorate({...scene,presentationType:'NEW_CINEMATIC_SCENE',animationStrategy:'FICTIONAL_KEYFRAME',fictionalScene:true}));
  const units=[...motion,...local];units.sort((a,b)=>{const one=sequences.find(sequence=>sequence.id===a.photoSequenceId),two=sequences.find(sequence=>sequence.id===b.photoSequenceId);if(one?.startTimestamp&&two?.startTimestamp)return one.startTimestamp.localeCompare(two.startTimestamp)||a.id.localeCompare(b.id);return a.sequenceNumber-b.sequenceNumber||a.id.localeCompare(b.id);});
  const scenes:StoryboardScene[]=[title(false)];let fictionalAt=0;
  for(let index=0;index<units.length;index++){scenes.push(units[index]);const target=Math.floor((index+1)*fictional.length/units.length);while(fictionalAt<target)scenes.push(fictional[fictionalAt++]);}
  while(fictionalAt<fictional.length)scenes.push(fictional[fictionalAt++]);scenes.push(title(true));scenes.forEach((scene,index)=>{scene.sequenceNumber=index+1;});
  const generatedSeconds=[...motion,...fictional].reduce((sum,scene)=>sum+scene.durationSeconds,0),titleSeconds=preferredTitleSeconds,localSeconds=input.config.durationSeconds-generatedSeconds-titleSeconds;
  if(localSeconds<local.length*2)throw new ApiError(409,'CINEMATIC_DURATION_CAPACITY','This plan has too much generated motion to represent the selected moments safely. Use fewer AI scenes.');
  const isCollage=(scene:StoryboardScene)=>scene.presentationType==='ANIMATED_PHOTO_COLLAGE';
  const localMaximum=(scene:StoryboardScene)=>isCollage(scene)?20:Math.min(60,scene.sourcePhotoIds.length*8);
  const localMinimum=(scene:StoryboardScene)=>isCollage(scene)?3:Math.max(1,scene.sourcePhotoIds.length);
  const capacity=()=>compileMovieTimeline({storyboard:{id:input.seed,title:input.config.title,scenes,targetDurationSeconds:input.config.durationSeconds},settings:{...input.config.movieSettings,targetDurationSeconds:input.config.durationSeconds},availablePhotoIds:[...available.keys()],clips:scenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION'||scene.type==='NEW_CINEMATIC_SCENE').map(scene=>({id:scene.id,sceneId:scene.id,storyboardId:input.seed,durationSeconds:scene.durationSeconds,decision:'approved' as const,state:'COMPLETED'}))});
  const lacksDuration=()=>capacity().issues.some(issue=>issue.code==='INSUFFICIENT_DURATION');
  // Ask the same frame-exact P5 compiler for actual transition/cut capacity.
  // Longer films add genuine still-photo time rather than paid clip seconds.
  for(const scene of [...local].filter(isCollage).sort((a,b)=>b.sourcePhotoIds.length-a.sourcePhotoIds.length)){
   if(!lacksDuration()&&local.reduce((sum,item)=>sum+localMaximum(item),0)>=localSeconds)break;
   scene.presentationType='CINEMATIC_PHOTO_MONTAGE';scene.animationStrategy='LOCAL_MONTAGE';
  }
  if(lacksDuration())throw new ApiError(409,'CINEMATIC_DURATION_CAPACITY','The distinct original photographs, approved short clips, and titles cannot safely fill this duration after transitions. Add more photographs or shorten the movie; no video will be stretched, frozen, or silently repeated.');
  const collageCount=local.filter(isCollage).length,montageCount=local.length-collageCount;
  const weights=local.map(scene=>isCollage(scene)?Math.max(.001,preferences.distribution.collages)/Math.max(1,collageCount):Math.max(.001,preferences.distribution.montages)/Math.max(1,montageCount));
  const allocations=local.map(localMinimum);let remaining=localSeconds-allocations.reduce((sum,value)=>sum+value,0);
  if(remaining<0)throw new ApiError(409,'CINEMATIC_DURATION_CAPACITY','These original photographs need more screen time to remain legible. Choose a longer movie or combine more photographs in collages.');
  while(remaining>0){const eligible=local.map((_,index)=>index).filter(index=>allocations[index]<localMaximum(local[index])),totalWeight=eligible.reduce((sum,index)=>sum+weights[index],0);if(!eligible.length)throw new ApiError(409,'CINEMATIC_DURATION_CAPACITY','This movie needs more distinct visual material.');for(const index of eligible){const part=Math.min(localMaximum(local[index])-allocations[index],remaining,Math.max(1,Math.floor(remaining*weights[index]/totalWeight)));allocations[index]+=part;remaining-=part;if(!remaining)break;}}
  local.forEach((scene,index)=>{scene.durationSeconds=allocations[index];scene.estimatedDuration=scene.durationSeconds;});
  if(preferences.automaticText){const eligible=scenes.filter(scene=>scene.type==='PHOTO_MONTAGE');for(const [index,scene] of eligible.entries()){if(index===0||index===Math.floor(eligible.length/2)){const proposal=this.text.propose(scene.id,preferences.language,index===0?'chapter':'caption',Math.min(4,scene.durationSeconds));scene.textOverlays=[...(scene.textOverlays??[]),proposal];}const generated=(input.proposals??base).scenes.find(old=>old.sourcePhotoIds.some(id=>scene.sourcePhotoIds.includes(id)))?.textOverlays??[];for(const overlay of generated)if(this.text.validateProposal(overlay,input.photos)&&!(scene.textOverlays??[]).some(old=>old.text===overlay.text))scene.textOverlays=[...(scene.textOverlays??[]),{...overlay,durationSeconds:Math.min(overlay.durationSeconds,scene.durationSeconds)}];}}
  scenes.forEach((scene,index)=>{scene.sequenceNumber=index+1;scene.estimatedDuration=scene.durationSeconds;if(scene.textOverlays)scene.textOverlays=scene.textOverlays.filter(overlay=>overlay.startSeconds<scene.durationSeconds).map(overlay=>({...overlay,durationSeconds:Math.min(overlay.durationSeconds,scene.durationSeconds-overlay.startSeconds)}));});
  const content=storyboardContentSchema.parse({...base,title:input.config.title,targetDurationSeconds:input.config.durationSeconds,scenes});
  const represented=new Set(content.scenes.filter(scene=>!scene.isFictional).flatMap(scene=>scene.sourcePhotoIds));
  const pins=input.photos.filter(photo=>photo.asset.selected&&!photo.curation.excluded&&!excludedIds.has(photo.asset.id)&&photo.curation.pinned);if(pins.some(photo=>!represented.has(photo.asset.id)))throw new ApiError(409,'CINEMATIC_PIN_MISSING','A pinned photo is missing from the cinematic plan. Review the moment assignments.');
  const total=content.scenes.reduce((sum,scene)=>sum+scene.durationSeconds,0),distribution:Record<string,number>={originalAnimations:0,newScenes:0,collages:0,montages:0,titles:0};
  for(const scene of content.scenes){const key=scene.type==='ORIGINAL_ANIMATION'?'originalAnimations':scene.type==='NEW_CINEMATIC_SCENE'?'newScenes':scene.type==='TITLE_SEQUENCE'?'titles':scene.presentationType==='ANIMATED_PHOTO_COLLAGE'?'collages':'montages';distribution[key]+=scene.durationSeconds/total;}
  if(chainExtraAllowance<2)warnings.push(`${2-chainExtraAllowance} additional adjacent-pair operations are planned inside the quoted chain allowance. All pair ordering persists.`);
  warnings.push('Composition percentages are screen-time preferences. Provider clip duration, source capacity and approved costs may adjust the final distribution; overlay text adds no standalone duration.');
  return {content,summary:{importedPhotos:input.photos.length,recognizedSequences:input.sequences.length,selectedMoments:new Set(content.scenes.flatMap(scene=>scene.relatedSequenceIds?.length?scene.relatedSequenceIds:scene.photoSequenceId?[scene.photoSequenceId]:[])).size,uniqueSourcePhotos:represented.size,multiImageAnimatedScenes:content.scenes.filter(scene=>scene.type==='ORIGINAL_ANIMATION'&&scene.sourcePhotoIds.length>1).length,collageScenes:content.scenes.filter(scene=>scene.presentationType==='ANIMATED_PHOTO_COLLAGE').length,montageScenes:content.scenes.filter(scene=>scene.type==='PHOTO_MONTAGE'&&scene.presentationType!=='ANIMATED_PHOTO_COLLAGE').length,newFictionalScenes:fictional.length,animatedScenes:motion.length,textElements:content.scenes.reduce((sum,scene)=>sum+(scene.textOverlays?.length??0),0)+2,plannedDurationSeconds:total,estimatedAiCostUsd:input.estimatedAiCostUsd??0,reusedP4ClipCount:input.reusedP4ClipCount??0,distribution,warnings:[...new Set(warnings)]},warnings:[...new Set(warnings)]};
 }
}
