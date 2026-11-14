import {movieDurationSecondsSchema} from './duration-policy.js';
import {cinematicPreferencesSchema,type CinematicCompositionSummary} from './cinematic.js';
import {z} from 'zod';
import {movieSettingsSchema,type MovieRenderAsset,type MovieSettings,type MovieSoundtrack} from './movie.js';
import type {Protagonist,SceneType} from './director.js';

export const productionStateSchema=z.enum(['DRAFT','PREFLIGHT','ANALYZING','CURATING','PLANNING','AWAITING_BUDGET_APPROVAL','GENERATING','QUALITY_REVIEW','RENDERING','VALIDATING_FINAL_MOVIE','COMPLETED','PAUSED','FAILED','CANCELLED']);
export type ProductionState=z.infer<typeof productionStateSchema>;
/** The ratio applies to generated motion. Additional stills fill the movie without stretching clips. */
export const productionConfigSchema=z.object({
 cinematic:cinematicPreferencesSchema.optional(),
 title:z.string().trim().min(1).max(160).default('Our shared story'),
 durationSeconds:movieDurationSecondsSchema.default(150),
 cinematicStyle:z.string().trim().min(1).max(1000).default('Warm, natural cinematic light and restrained camera movement.'),
 emotionalTone:z.string().trim().min(1).max(300).default('Warm and reflective'),
 originalRatio:z.number().finite().min(0).max(1).default(0.5),
 aiSceneCount:z.number().int().min(2).max(20).default(8),
 qualityThreshold:z.number().finite().min(0).max(100).default(70),
 maxRetriesPerScene:z.number().int().min(0).max(2).default(1),
 totalRetryAllowance:z.number().int().min(0).max(20).default(2),
 allowApprovedFallback:z.boolean().default(false),
 maxSpendUsd:z.number().finite().positive().max(10000).default(20),
 movieSettings:movieSettingsSchema.default(()=>movieSettingsSchema.parse({})),
}).strict();
export type ProductionConfig=z.infer<typeof productionConfigSchema>;
export const productionQuoteInputSchema=z.object({config:productionConfigSchema}).strict();
export const productionCreateRunSchema=z.object({quoteId:z.string().uuid(),idempotencyKey:z.string().uuid()}).strict();
export const productionApproveSchema=z.object({maximumSpendUsd:z.number().finite().positive().max(10000),automaticSceneApproval:z.literal(true),visiblePeoplePermission:z.literal(true),acknowledgeUnknownPriorCost:z.boolean().optional()}).strict();
export const productionSceneReviewSchema=z.object({decision:z.enum(['approved','rejected']),notes:z.string().trim().max(2000).default('')}).strict();
export type ProductionModels={analysis:string;storyboard:string;video:string;keyframe:string;quality:string};
export type ProductionCostBreakdown={analysisUsd:number;planningUsd:number;videoUsd:number;keyframesUsd:number;qualityUsd:number;retryAllowanceUsd:number};
export type ProductionEstimate={analysisPhotos:number;cachedPhotos:number;aiSceneCount:number;originalSceneCount:number;newSceneCount:number;retrySceneAllowance:number;clipDurationSeconds:number;expectedBillableVideoSeconds:number;maximumBillableVideoSeconds:number;totalEstimatedUsd:number;costBreakdown:ProductionCostBreakdown;budgetSufficient:boolean;alternatives:string[];warnings:string[];models:ProductionModels};
export type ProductionIssue={code:string;message:string};
export type ProductionQuote={id:string;expiresAt:string;config:ProductionConfig;estimate:ProductionEstimate;readiness:{ready:boolean;issues:ProductionIssue[]};warnings:string[]};
/** Provider-reported usage is an estimate of cost, never a confirmed invoice. */
export type ProductionBudget={maximumSpendUsd:number;approvedMaximumUsd:number|null;estimatedTotalUsd:number;estimatedSpendUsd:number;reservedUsd:number;remainingUsd:number;observedCostUsd:number|null;currency:'USD';estimatesOnly:true};
export type ProductionCurationSummary={selectedPhotoCount:number;pinnedPhotoCount:number;animationCount:number;fictionalSceneCount:number;montagePhotoCount:number;referencePhotoIds:string[];summary:string;warnings:string[];composition?:CinematicCompositionSummary};
export type ProductionScene={sceneId:string;sequenceNumber:number;title:string;type:SceneType;state:string;attempts:number;maximumAttempts:number;videoJobId?:string;assetId?:string;score:number|null;message?:string;fallbackAssetId?:string;userOverride?:boolean};
export type ProductionError={id:string;stage:ProductionState;code:string;message:string;sceneId?:string;createdAt:string};
export type ProductionApproval={maximumSpendUsd:number;automaticSceneApproval:true;visiblePeoplePermission:true;acknowledgeUnknownPriorCost?:boolean;approvedAt:string};
export type ProductionRun={id:string;projectId:string;version:number;config:ProductionConfig;state:ProductionState;stageProgress:number;overallProgress:number;message?:string;requiredAction?:string;analysisRunId?:string;storyboardId?:string;renderJobId?:string;finalMovieAssetId?:string;finalMovie?:MovieRenderAsset;curation?:ProductionCurationSummary;scenes:ProductionScene[];budget:ProductionBudget;quote:ProductionQuote;approval?:ProductionApproval;errors:ProductionError[];createdAt:string;updatedAt:string};
export type ProductionStudioState={configured:boolean;models:ProductionModels;defaultConfig:ProductionConfig;importedCount:number;analyzedCount:number;protagonists:Protagonist[];soundtracks:MovieSoundtrack[];runs:ProductionRun[];activeRun?:ProductionRun;quote?:ProductionQuote;readiness:{ready:boolean;issues:ProductionIssue[]}};
export type ProductionMovieSettings=MovieSettings;
