import {movieDurationSecondsSchema} from './duration-policy.js';
import {presentationTypeSchema,animationStrategySchema,collageLayoutSchema,collageAnimationSettingsSchema,textOverlaySchema,typographyPresetSchema,sequenceSegmentSchema} from './cinematic.js';
import { z } from 'zod';
import { MIN_PROTAGONIST_REFERENCES, MAX_PROTAGONIST_REFERENCES } from './reference-policy.js';
export { MIN_PROTAGONIST_REFERENCES, MAX_PROTAGONIST_REFERENCES } from './reference-policy.js';

export const protagonistIdSchema=z.enum(['person1','person2']);
export type ProtagonistId=z.infer<typeof protagonistIdSchema>;
export const suitabilitySchema=z.enum(['ANIMATED_ORIGINAL','REFERENCE_IMAGE','SUPPORTING_PHOTO']);
export const scoreSchema=z.number().min(0).max(100);
export const photoAnalysisSchema=z.object({
  schemaVersion:z.literal('1.0'),
  sharpness:scoreSchema, exposure:scoreSchema, composition:scoreSchema, animationSuitability:scoreSchema, storytellingPotential:scoreSchema,
  suitability:suitabilitySchema, description:z.string().min(1).max(1500),
  sceneType:z.string().min(1).max(120),visibleLocations:z.array(z.string().max(120)).max(12),
  activities:z.array(z.string().max(120)).max(20),objects:z.array(z.string().max(120)).max(30),
  emotionalTone:z.string().max(120),diversityTags:z.array(z.string().max(80)).max(20),
  uncertaintyNotes:z.array(z.string().max(500)).max(12),
}).strict();
export type PhotoAnalysis=z.infer<typeof photoAnalysisSchema>;
export const exifEvidenceSchema=z.object({
  dateTimeOriginal:z.string().nullable(),dateSource:z.enum(['EXIF','GOOGLE_METADATA','NONE']),
  latitude:z.number().min(-90).max(90).nullable(),longitude:z.number().min(-180).max(180).nullable(),
  locationSource:z.enum(['EXIF','NONE']),cameraMake:z.string().nullable(),cameraModel:z.string().nullable(),
});
export type ExifEvidence=z.infer<typeof exifEvidenceSchema>;
export type LocalPhotoFeatures={sha256:string;perceptualHash:string;exif:ExifEvidence;width:number;height:number;};
// Partial profiles can be saved; the minimum is enforced when checking readiness.
export const protagonistInputSchema=z.object({name:z.string().trim().max(80),referencePhotoIds:z.array(z.string().uuid()).max(MAX_PROTAGONIST_REFERENCES),likenessPermissionConfirmed:z.boolean()}).strict();
export type ProtagonistInput=z.infer<typeof protagonistInputSchema>;
export type Protagonist=ProtagonistInput & {id:ProtagonistId;ready:boolean;readinessIssues?:string[];updatedAt:string;};
export const curationInputSchema=z.object({pinned:z.boolean().optional(),excluded:z.boolean().optional(),protagonistIds:z.array(protagonistIdSchema).max(2).refine(ids=>new Set(ids).size===ids.length).optional()}).strict();
export type PhotoCuration={assetId:string;pinned:boolean;excluded:boolean;protagonistIds:ProtagonistId[];associationsConfirmed:boolean;};
export type AnalyzedPhoto={assetId:string;analysis:PhotoAnalysis|null;features:LocalPhotoFeatures|null;curation:PhotoCuration;duplicateOf?:string;rankScore?:number;recommended?:boolean;};
export const sceneTypeSchema=z.enum(['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE','PHOTO_MONTAGE','TITLE_SEQUENCE']);
export type SceneType=z.infer<typeof sceneTypeSchema>;
export const sceneSchema=z.object({
  relatedSequenceIds:z.array(z.string().uuid()).max(30).optional(),photoSequenceId:z.string().uuid().optional(),firstFramePhotoId:z.string().uuid().optional(),lastFramePhotoId:z.string().uuid().optional(),intermediatePhotoIds:z.array(z.string().uuid()).max(30).optional(),referencePhotoIds:z.array(z.string().uuid()).max(30).optional(),presentationType:presentationTypeSchema.optional(),animationStrategy:animationStrategySchema.optional(),collageLayout:collageLayoutSchema.optional(),collageAnimationSettings:collageAnimationSettingsSchema.optional(),textOverlays:z.array(textOverlaySchema).max(12).optional(),typographyPreset:typographyPresetSchema.optional(),transitionIn:z.enum(['cut','crossfade','fadeblack','fadewhite']).optional(),transitionOut:z.enum(['cut','crossfade','fadeblack','fadewhite']).optional(),musicCue:z.object({syncToBeat:z.boolean(),energy:z.enum(['low','medium','high']).optional()}).strict().optional(),estimatedDuration:z.number().finite().positive().max(60).optional(),estimatedCost:z.number().finite().min(0).optional(),sequenceSegments:z.array(sequenceSegmentSchema).max(20).optional(),fictionalScene:z.boolean().optional(),
  id:z.string().uuid(),sequenceNumber:z.number().int().positive(),type:sceneTypeSchema,
  title:z.string().min(1).max(160),description:z.string().min(1).max(3000),durationSeconds:z.number().int().min(1).max(60),
  sourcePhotoIds:z.array(z.string().uuid()).max(30),protagonistIds:z.array(protagonistIdSchema).max(2),
  visualStyle:z.string().min(1).max(1200),cameraDirection:z.string().min(1).max(1500),motionPrompt:z.string().min(1).max(3000),
  emotionalTone:z.string().min(1).max(500),continuityNotes:z.string().max(2000),generationInstructions:z.string().min(1).max(4000),
  isFictional:z.boolean(),requiresUserConfirmation:z.boolean(),userConfirmed:z.boolean(),
}).strict();
export type StoryboardScene=z.infer<typeof sceneSchema>;
export const storyboardContentSchema=z.object({
  schemaVersion:z.literal('1.0'),title:z.string().min(1).max(160),synopsis:z.string().min(1).max(2500),
  targetDurationSeconds:movieDurationSecondsSchema,scenes:z.array(sceneSchema).min(6).max(40),
}).strict();
export type StoryboardContent=z.infer<typeof storyboardContentSchema>;
export type Storyboard=StoryboardContent & {id:string;projectId:string;version:number;createdAt:string;updatedAt:string;status:'draft'|'validated';readyForVideoGeneration:boolean;validationIssues:string[];};
export const storyboardRequestSchema=z.object({durationSeconds:movieDurationSecondsSchema.default(150),brief:z.string().max(3000).default('A cinematic, warm story of two lives and their shared moments.')}).strict();
export type CuratedSelection={assetIds:string[];ranked:{assetId:string;score:number;reasons:string[];pinned:boolean;protagonistIds:ProtagonistId[]}[];warnings:string[];};
export type AnalysisRun={id:string;status:'queued'|'running'|'paused'|'complete'|'cancelled'|'error';total:number;completed:number;pending:number;failed:number;skipped:number;active:number;message?:string;createdAt:string;updatedAt:string;};
export type DirectorUsage={requests:number;inputTokens:number;outputTokens:number;estimatedCostUsd:number;reservedUsd:number;maximumSpendUsd:number;currency:'USD';estimatesOnly:true;};
export type DirectorState={configured:boolean;model:string;pipelineVersion:string;totalImported:number;analyzed:number;pending:number;duplicateCandidates:number;run?:AnalysisRun;usage:DirectorUsage;protagonists:Protagonist[];storyboard?:Storyboard;};
export type GeminiUsage={inputTokens:number;outputTokens:number;};
export type JsonGenerationRequest={projectId:string;operation:'photo_analysis'|'storyboard';prompt:string;schema:Record<string,unknown>;images?:{data:Uint8Array;mimeType:string}[];maxOutputTokens?:number;productionRunId?:string;operationKey?:string;maximumInputTokens?:number;productionBudgetAuthorized?:true;beforePaidDispatch?:()=>void;};
export interface JsonGenerator {generateJson(request:JsonGenerationRequest,signal:AbortSignal):Promise<{json:unknown;usage:GeminiUsage}>;checkModel?():Promise<void>;}
