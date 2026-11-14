import type {StoryboardScene,ProviderCapabilities,VideoInputMode} from '@memories/shared';
import {ApiError} from './errors.js';
/** This plan is persisted with the quote. Ordered keyframes are never unordered references. */
export function videoInputPlan(scene:StoryboardScene,caps:ProviderCapabilities,sourceAssetId?:string){
 const type=scene.presentationType;
 if(type==='CHAINED_KEYFRAME_ANIMATION'){
  const pairs=scene.sequenceSegments??[];
  if(!caps.supportsFirstLastFrame||pairs.length<2||pairs.length>3)throw new ApiError(409,'VIDEO_SEQUENCE_UNSUPPORTED','This chained sequence needs two or three supported first/last-frame operations. Choose an original-photo montage instead.');
  for(const [i,pair] of pairs.entries())if(pair.sourcePhotoIds.length!==2||pair.sourcePhotoIds[0]!==pair.firstFramePhotoId||pair.sourcePhotoIds[1]!==pair.lastFramePhotoId||pair.sourcePhotoIds.some(id=>!scene.sourcePhotoIds.includes(id))||i>0&&pairs[i-1].lastFramePhotoId!==pair.firstFramePhotoId)throw new ApiError(409,'VIDEO_SEQUENCE_INVALID','Sequence pairs must preserve their approved adjacent capture order.');
  return {inputMode:'first_last_frame' as VideoInputMode,groups:pairs.map(pair=>pair.sourcePhotoIds),sourcePhotoIds:[...new Set(pairs.flatMap(pair=>pair.sourcePhotoIds))]};
 }
 if(type==='FIRST_LAST_FRAME_INTERPOLATION'){
  const ids=[scene.firstFramePhotoId,scene.lastFramePhotoId];
  if(!caps.supportsFirstLastFrame||ids.some(id=>!id||!scene.sourcePhotoIds.includes(id))||ids[0]===ids[1])throw new ApiError(409,'VIDEO_SEQUENCE_UNSUPPORTED','The provider or approved first/last-frame inputs are unavailable. Use an ordered local montage; no image was silently dropped.');
  return {inputMode:'first_last_frame' as VideoInputMode,groups:[ids as string[]],sourcePhotoIds:ids as string[]};
 }
 if(type==='MULTI_REFERENCE_VIDEO'){
  const ids=scene.referencePhotoIds?.length?scene.referencePhotoIds:scene.sourcePhotoIds;
  if(!caps.supportsMultiReference||ids.length<2||ids.length>(caps.maxReferenceImages??1)||ids.some(id=>!scene.sourcePhotoIds.includes(id)))throw new ApiError(409,'VIDEO_REFERENCE_LIMIT','The approved reference set exceeds this provider’s supported image limit. Use a local collage or montage; references are not silently truncated.');
  return {inputMode:'multi_reference' as VideoInputMode,groups:[ids],sourcePhotoIds:ids};
 }
 if(scene.type==='ORIGINAL_ANIMATION'){
  if(type&&scene.sourcePhotoIds.length!==1)throw new ApiError(409,'VIDEO_MULTI_IMAGE_MODE_REQUIRED','Choose a supported multi-image presentation or a local montage for this multi-photo scene.');
  const id=sourceAssetId??scene.sourcePhotoIds[0];if(!id||!scene.sourcePhotoIds.includes(id))throw new ApiError(400,'SOURCE_PHOTO_REQUIRED','Choose an approved source photograph.');
  return {inputMode:'single_image' as VideoInputMode,groups:[[id]],sourcePhotoIds:[id]};
 }
 return {inputMode:'single_image' as VideoInputMode,groups:[] as string[][],sourcePhotoIds:[] as string[]};
}
