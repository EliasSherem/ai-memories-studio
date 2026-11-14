import {createHash} from 'node:crypto';
import {photoSequenceSchema,type PhotoSequence,type PresentationType,type AnimationStrategy,type JsonGenerator,type StoryboardContent} from '@memories/shared';
import type {DirectorPhotoRow} from './director-store.js';
import {perceptualDistance} from './curation.js';

export const SEQUENCE_ANALYSIS_VERSION='moments-v1';
export const stableCinematicId=(seed:string)=>{const hex=createHash('sha256').update(seed).digest('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;};
export function reliableCaptureTimestamp(row:DirectorPhotoRow):string|undefined {
 const evidence=row.features?.exif;
 if(!evidence||evidence.dateSource==='NONE'||!evidence.dateTimeOriginal)return;
 const value=evidence.dateTimeOriginal.replace(/^(\d{4}):(\d{2}):(\d{2})/,'$1-$2-$3').replace(' ','T');
 // EXIF wall-clock times remain wall-clock times: no invented timezone or upload order.
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)?$/.test(value))return;
 if(!Number.isFinite(Date.parse(value)))return;
 return value;
}
const words=(row:DirectorPhotoRow)=>new Set([row.analysis?.sceneType,...(row.analysis?.visibleLocations??[]),...(row.analysis?.activities??[]),...(row.analysis?.diversityTags??[])].filter((value):value is string=>Boolean(value)).flatMap(value=>value.toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u)).filter(value=>value.length>2));
function semanticSimilarity(a:DirectorPhotoRow,b:DirectorPhotoRow){const one=words(a),two=words(b);let shared=0;for(const word of one)if(two.has(word))shared++;return shared/Math.max(1,one.size+two.size-shared);}
function visualSimilarity(a:DirectorPhotoRow,b:DirectorPhotoRow){const one=a.features?.perceptualHash,two=b.features?.perceptualHash;const hash=one&&two?1-perceptualDistance(one,two)/64:0;return .55*semanticSimilarity(a,b)+.45*hash;}
function cameraMismatch(a:DirectorPhotoRow,b:DirectorPhotoRow){const one=a.features?.exif,two=b.features?.exif;return Boolean(one?.cameraModel&&two?.cameraModel&&one.cameraModel!==two.cameraModel);}
function sameClockDomain(a:string,b:string){const zone=(v:string)=>/(Z|[+-]\d\d:\d\d)$/.exec(v)?.[1]??'unknown';return zone(a)===zone(b);}
function secondsApart(a:DirectorPhotoRow,b:DirectorPhotoRow){const one=reliableCaptureTimestamp(a),two=reliableCaptureTimestamp(b);if(!one||!two||!sameClockDomain(one,two))return Infinity;return Math.abs(Date.parse(two)-Date.parse(one))/1000;}
function importance(rows:DirectorPhotoRow[]){const scores=rows.map(row=>row.analysis?row.analysis.storytellingPotential*.45+(row.analysis.composition+row.analysis.sharpness+row.analysis.exposure)/3*.25+row.analysis.animationSuitability*.1+(row.curation.associationsConfirmed?10:0)+(row.curation.pinned?25:0):row.curation.pinned?90:35);return Math.min(100,Math.max(...scores)*.7+scores.reduce((a,b)=>a+b,0)/scores.length*.3+Math.min(8,rows.length));}

/** Whole-image signals only. No faces, identity embeddings, or upload-time ordering. */
export class PhotoSequenceAnalyzer {
 analyze(projectId:string,photos:readonly DirectorPhotoRow[]):PhotoSequence[]{
  const rows=photos.filter(row=>row.asset.selected&&!row.curation.excluded).sort((a,b)=>{const one=reliableCaptureTimestamp(a),two=reliableCaptureTimestamp(b);if(one&&two)return one.localeCompare(two)||a.asset.id.localeCompare(b.asset.id);if(one)return -1;if(two)return 1;return a.asset.id.localeCompare(b.asset.id);});
  const groups:DirectorPhotoRow[][]=[];
  for(const row of rows){
   const previous=groups.at(-1),last=previous?.at(-1);
   if(!previous||!last){groups.push([row]);continue;}
   const gap=secondsApart(last,row),continuity=visualSimilarity(last,row),semantic=semanticSimilarity(last,row);
   const compatible=!cameraMismatch(last,row)&&previous.length<30&&(gap<=5&&continuity>=.25||gap<=120&&continuity>=.5||gap<=900&&semantic>=.65);
   if(compatible)previous.push(row);else if(!reliableCaptureTimestamp(row)){
    // Undated visual collections are thematic, never labeled as chronological action.
    const collection=groups.slice(-16).find(group=>!reliableCaptureTimestamp(group[0])&&group.length<8&&semanticSimilarity(group[0],row)>=.8&&visualSimilarity(group[0],row)>=.7);
    if(collection)collection.push(row);else groups.push([row]);
   }else groups.push([row]);
  }
  return groups.map(group=>this.describe(projectId,group));
 }
 describe(projectId:string,rows:DirectorPhotoRow[]):PhotoSequence {
  const ids=rows.map(row=>row.asset.id),dates=rows.map(reliableCaptureTimestamp),allDated=dates.every(Boolean),pairs=rows.slice(1).map((row,index)=>({visual:visualSimilarity(rows[index],row),gap:secondsApart(rows[index],row),duplicate:row.asset.sha256===rows[index].asset.sha256&&Boolean(row.asset.sha256),hashDistance:rows[index].features&&row.features?perceptualDistance(rows[index].features!.perceptualHash,row.features.perceptualHash):64}));
  const chronological=allDated&&dates.every((date,index)=>!index||sameClockDomain(date!,dates[index-1]!)&&Date.parse(date!)>=Date.parse(dates[index-1]!));
  const visual=pairs.length?pairs.reduce((sum,pair)=>sum+pair.visual,0)/pairs.length:1;
  const action=pairs.length&&chronological?pairs.filter(pair=>!pair.duplicate&&pair.hashDistance>1&&pair.gap<=120&&pair.visual>.3).length/pairs.length:0;
  const burst=pairs.length>0&&chronological&&pairs.every(pair=>pair.gap<=3);
  const shared=rows.some(row=>row.curation.associationsConfirmed&&row.curation.protagonistIds.length===2);
  const travel=rows.some(row=>row.analysis?.diversityTags.some(tag=>/travel|journey|trip/i.test(tag)));
  const portrait=rows.every(row=>/portrait|selfie/i.test(row.analysis?.sceneType??''));
  const sequenceType=rows.length===1?'INDEPENDENT_PHOTO':burst?'BURST_SEQUENCE':action>=.5?'ACTION_SEQUENCE':shared?'SHARED_MOMENT':travel?'TRAVEL_SEQUENCE':portrait?'PORTRAIT_COLLECTION':'LOCATION_SEQUENCE';
  const presentation:PresentationType=rows.length===1?'KEN_BURNS_PHOTO':(sequenceType==='ACTION_SEQUENCE'||sequenceType==='BURST_SEQUENCE')&&action>.2?rows.length===2?'FIRST_LAST_FRAME_INTERPOLATION':'CHAINED_KEYFRAME_ANIMATION':rows.length>=2?'ANIMATED_PHOTO_COLLAGE':'CINEMATIC_PHOTO_MONTAGE';
  const strategy:AnimationStrategy=presentation==='FIRST_LAST_FRAME_INTERPOLATION'?'FIRST_LAST_FRAME':presentation==='CHAINED_KEYFRAME_ANIMATION'?'CHAINED_PAIRS':presentation==='ANIMATED_PHOTO_COLLAGE'?'LOCAL_COLLAGE':'KEN_BURNS';
  const duplicates=rows.length-new Set(rows.map(row=>row.asset.sha256||row.asset.id)).size;
  const warnings:string[]=[];if(!allDated)warnings.push('Capture time is missing or uncertain. Grouping is thematic; photo order does not imply a real chronology.');if(allDated&&!chronological)warnings.push('Supplied photo order contradicts capture-time evidence or timezone domains. It is user/thematic ordering, not verified continuous action.');if(duplicates)warnings.push(`${duplicates} exact duplicate source${duplicates===1?'':'s'} retained in the moment metadata; representative selection avoids repeating identical pixels.`);
  if(dates.some((date,index)=>date&&index>0&&dates[index-1]&&!sameClockDomain(date,dates[index-1]!)))warnings.push('Conflicting timestamp timezone evidence; do not interpolate as a verified action sequence.');
  const first=ids[0],last=ids.at(-1)!;
  return photoSequenceSchema.parse({id:stableCinematicId(`${projectId}:${SEQUENCE_ANALYSIS_VERSION}:${ids.join(',')}`),projectId,orderedPhotoIds:ids,startTimestamp:chronological?dates[0]:null,endTimestamp:chronological?dates.at(-1):null,temporalConfidence:chronological?1:0,visualContinuityScore:Math.round(visual*100),actionContinuityScore:Math.round(action*100),narrativeImportanceScore:Math.round(importance(rows)),sequenceType,description:rows.find(row=>row.analysis)?.analysis?.description.slice(0,1200)??(rows.length===1?'An original photograph.':'A group of original photographs requiring contextual review.'),proposedAction:action>.2?'Preserve the supplied capture order and visible progression.':'Present this memory with original photographs and restrained local motion.',recommendedPresentationType:presentation,recommendedAnimationStrategy:strategy,firstFramePhotoId:first,lastFramePhotoId:last,intermediatePhotoIds:ids.slice(1,-1),referencePhotoIds:rows.filter(row=>row.curation.associationsConfirmed).map(row=>row.asset.id),pinned:rows.some(row=>row.curation.pinned),excluded:false,reviewed:false,confidence:chronological?Math.min(.98,.6+visual*.35):Math.min(.65,.3+visual*.35),analysisVersion:SEQUENCE_ANALYSIS_VERSION,textOverlays:[],warnings});
 }
}

/** Existing paid storyboard call may validate ambiguous groups; this adds no paid dispatch. */
export function sequenceReasoningContext(sequences:readonly PhotoSequence[],limit=32){return sequences.filter(sequence=>!sequence.excluded).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.narrativeImportanceScore-a.narrativeImportanceScore).slice(0,limit).map(sequence=>({id:sequence.id,orderedPhotoIds:sequence.orderedPhotoIds,sequenceType:sequence.sequenceType,captureStart:sequence.startTimestamp,captureEnd:sequence.endTimestamp,temporalConfidence:sequence.temporalConfidence,visualContinuity:sequence.visualContinuityScore,actionContinuity:sequence.actionContinuityScore,importance:sequence.narrativeImportanceScore,description:sequence.description,suggestedPresentation:sequence.recommendedPresentationType,warnings:sequence.warnings}));}
