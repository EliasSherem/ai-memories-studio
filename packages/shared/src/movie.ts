import {movieDurationSecondsSchema} from './duration-policy.js';
import {z} from 'zod';
import type {SceneType,StoryboardScene} from './director.js';
import type {TextOverlay,CollageAnimationSettings,CollageLayout,PresentationType} from './cinematic.js';

export const movieTransitionTypeSchema=z.enum(['cut','crossfade','fadeblack','fadewhite']);
export type MovieTransitionType=z.infer<typeof movieTransitionTypeSchema>;
export const movieTitleSettingsSchema=z.object({
  openingTitle:z.string().trim().max(200).default(''),
  names:z.string().trim().max(200).default(''),
  dates:z.string().trim().max(160).default(''),
  closingCredits:z.string().trim().max(800).default(''),
  chapterTitles:z.record(z.string().max(100),z.string().trim().max(200)).default({}),
  font:z.enum(['serif','sans']).default('serif'),
  color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#F5F1E8'),
  includeDisclosure:z.boolean().default(true),
}).strict();
export const movieSettingsSchema=z.object({
  storytellingEnabled:z.boolean().optional(),
  targetDurationSeconds:movieDurationSecondsSchema.default(150),
  resolution:z.enum(['1080p','720p']).default('1080p'),
  aspectRatio:z.enum(['16:9','9:16']).default('16:9'),
  fps:z.literal(30).default(30),
  preset:z.enum(['ultrafast','veryfast','fast','medium','slow']).default('veryfast'),
  crf:z.number().int().min(18).max(28).default(22),
  transitionStyle:z.enum(['restrained','crossfade','fadeblack','cut','fadewhite']).default('restrained'),
  transitionDurationSeconds:z.number().finite().min(0.5).max(1).default(0.75),
  retainSceneAudio:z.boolean().default(true),
  musicVolume:z.number().finite().min(0).max(1).default(0.2),
  soundtrackId:z.string().uuid().optional(),
  titles:movieTitleSettingsSchema.default(()=>movieTitleSettingsSchema.parse({})),
}).strict();
export type MovieSettings=z.infer<typeof movieSettingsSchema>;
export const movieSettingsInputSchema=z.object({settings:movieSettingsSchema}).strict();
export const movieCreateJobSchema=z.object({storyboardId:z.string().uuid(),idempotencyKey:z.string().uuid()}).strict();
export const movieRenderStateSchema=z.enum(['PENDING','VALIDATING','PREPARING_MEDIA','COMPILING_TIMELINE','RENDERING','VALIDATING_OUTPUT','COMPLETED','FAILED','CANCELLED']);
export type MovieRenderState=z.infer<typeof movieRenderStateSchema>;
export type MovieReadinessIssue={code:string;sceneId?:string;message:string};
export type MovieLayerKeyframe={time:number;x?:number;y?:number;scale?:number;opacity?:number};
/** Positions are normalized to the canvas; times are relative to the parent scene. */
export type MovieCompositionLayer={id:string;kind:'photo'|'video'|'text'|'background';sourcePhotoId?:string;generatedAssetId?:string;text?:string;zIndex:number;x:number;y:number;width:number;height:number;opacity:number;startSeconds:number;durationSeconds:number;fit:'contain'|'cover';easing:'linear'|'easeInOut';animation?:'fade'|'slide'|'none';keyframes:MovieLayerKeyframe[]};
export type MovieStorytellingSummary={applied:boolean;source:'saved-moments'|'storyboard'|'disabled'|'none';revision?:string;sequences:number;collages:number;montages:number;representedPhotos:number;textOverlays:number;referenceOnlyCount:number;warnings:string[];reusedClipCount:number;multiImageAnimations:number};
/** Incoming transition duration overlaps this segment and its predecessor. */
export type MovieTimelineSegment={id:string;sceneId:string;sceneType:SceneType;type:'video'|'photo'|'title'|'composition';durationSeconds:number;startSeconds:number;sourceAssetId?:string;generatedAssetId?:string;thumbnailUrl?:string;titleText?:string;sourcePhotoIds?:string[];photoSequenceId?:string;relatedSequenceIds?:string[];compositionLayers?:MovieCompositionLayer[];textOverlays?:TextOverlay[];collageLayout?:CollageLayout;collageAnimationSettings?:CollageAnimationSettings;presentationType?:PresentationType;isFictional:boolean;transition:{type:MovieTransitionType;durationSeconds:number}};
export type MovieTimeline={storytelling?:MovieStorytellingSummary;id?:string;storyboardId:string;targetDurationSeconds:number;durationSeconds:number;totalSourceDurationSeconds:number;transitionOverlapSeconds:number;segments:MovieTimelineSegment[];issues:MovieReadinessIssue[];warnings:string[];ready:boolean;beatAlignedCuts:number};
export type MovieClipCandidate={sourcePhotoIds?:string[];id:string;sceneId:string;storyboardId:string;durationSeconds:number;decision:'approved'|'pending'|'rejected';state:string;hasAudio?:boolean;thumbnailUrl?:string;createdAt?:string};
export type MovieRenderJob={id:string;projectId:string;storyboardId:string;version:number;state:MovieRenderState;progress:number;message?:string;errorCode?:string;errorMessage?:string;timelineId?:string;assetId?:string;createdAt:string;updatedAt:string};
export type MovieRenderAsset={storytellingRevision?:string;id:string;jobId:string;projectId:string;storyboardId:string;version:number;url:string;downloadUrl:string;thumbnailUrl?:string;durationSeconds:number;width:number;height:number;fps:number;videoCodec:string;audioCodec?:string;hasAudio:boolean;bytes:number;sha256:string;isFictional:boolean;fictionalSceneIds:string[];createdAt:string};
export type MovieSoundtrack={id:string;projectId:string;name:string;mimeType:string;bytes:number;durationSeconds:number;instrumental:boolean;licensed:boolean;createdAt:string;url?:string};
export type MovieStudioState={settings:MovieSettings;timeline:MovieTimeline;readiness:{ready:boolean;issues:MovieReadinessIssue[];warnings:string[]};jobs:MovieRenderJob[];assets:MovieRenderAsset[];soundtracks:MovieSoundtrack[];tools:{available:boolean;message?:string}};
export type MovieTimelineInput={storyboard:{id:string;title?:string;scenes:StoryboardScene[];targetDurationSeconds:number};settings:MovieSettings;clips:MovieClipCandidate[];availablePhotoIds:readonly string[];onsets?:readonly number[]};
