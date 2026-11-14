import {z} from 'zod';

export const presentationTypeSchema=z.enum(['SINGLE_IMAGE_ANIMATION','FIRST_LAST_FRAME_INTERPOLATION','CHAINED_KEYFRAME_ANIMATION','MULTI_REFERENCE_VIDEO','NEW_CINEMATIC_SCENE','ANIMATED_PHOTO_COLLAGE','CINEMATIC_PHOTO_MONTAGE','KEN_BURNS_PHOTO','TEXT_OVERLAY','CHAPTER_TITLE','OPENING_TITLE','CLOSING_SEQUENCE']);
export type PresentationType=z.infer<typeof presentationTypeSchema>;
export const animationStrategySchema=z.enum(['SINGLE_IMAGE','FIRST_LAST_FRAME','CHAINED_PAIRS','UNORDERED_REFERENCES','LOCAL_COLLAGE','LOCAL_MONTAGE','KEN_BURNS','TEXT_ONLY','FICTIONAL_KEYFRAME']);
export type AnimationStrategy=z.infer<typeof animationStrategySchema>;
export const collageLayoutSchema=z.enum(['SPLIT_SCREEN','EDITORIAL_THREE','GRID_FOUR','MOSAIC_SIX','CONTACT_SHEET_EIGHT','FILMSTRIP','SCRAPBOOK','BEFORE_AFTER','ACTION_GRID','TRAVEL_BOARD']);
export type CollageLayout=z.infer<typeof collageLayoutSchema>;
export const editingStyleSchema=z.enum(['Cinematic','Emotional','Documentary','Travel','Romantic','Minimal','Energetic']);
export type EditingStyle=z.infer<typeof editingStyleSchema>;
export const textLanguageSchema=z.enum(['en','es','he']);
export const typographyPresetSchema=z.enum(['cinematic','editorial','documentary','minimal']);
export const narrativeTextTypeSchema=z.enum(['OPENING_TITLE','CHAPTER_TITLE','MOMENT_CAPTION','DATE_CAPTION','LOCATION_CAPTION','EMOTIONAL_PHRASE','TRANSITION_TEXT','CLOSING_MESSAGE','CREDITS']);
export const textOverlaySchema=z.object({
 id:z.string().uuid(),type:narrativeTextTypeSchema,text:z.string().trim().min(1).max(240),
 startSeconds:z.number().finite().min(0).max(180).default(0),durationSeconds:z.number().finite().positive().max(60).default(4),
 position:z.enum(['top','center','bottom','lower-third']).default('bottom'),alignment:z.enum(['left','center','right']).default('center'),
 animation:z.enum(['fade','slide','typewriter','scale','reveal','none']).default('fade'),language:textLanguageSchema.default('en'),
 font:z.enum(['serif','sans']).default('sans'),fontSize:z.number().finite().min(16).max(120).default(44),
 color:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#F5F1E8'),background:z.boolean().default(true),
 safeMargin:z.number().finite().min(.04).max(.2).default(.08),avoidSubjects:z.boolean().default(true),
 evidencePhotoIds:z.array(z.string().uuid()).max(30).default([]),factual:z.boolean().default(false),userProvided:z.boolean().default(false),
}).strict();
export type TextOverlay=z.infer<typeof textOverlaySchema>;
export const collageAnimationSettingsSchema=z.object({
 entrance:z.enum(['fade','slide','stagger','none']).default('stagger'),exit:z.enum(['fade','none']).default('fade'),
 staggerSeconds:z.number().finite().min(0).max(1).default(.18),gentleZoom:z.boolean().default(true),
 backgroundColor:z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#20372F'),backgroundBlur:z.boolean().default(false),
 safeMargin:z.number().finite().min(.02).max(.15).default(.05),gap:z.number().finite().min(0).max(.08).default(.015),
 cornerRadius:z.number().finite().min(0).max(60).default(18),fit:z.enum(['contain','cover']).default('contain'),
 syncToMusic:z.boolean().default(true),
}).strict();
export type CollageAnimationSettings=z.infer<typeof collageAnimationSettingsSchema>;
export const sequenceSegmentSchema=z.object({id:z.string().uuid(),firstFramePhotoId:z.string().uuid(),lastFramePhotoId:z.string().uuid(),sourcePhotoIds:z.array(z.string().uuid()).min(2).max(30),durationSeconds:z.number().finite().positive().max(60),generatedAssetId:z.string().uuid().optional(),videoJobId:z.string().uuid().optional()}).strict();
export type SequenceSegment=z.infer<typeof sequenceSegmentSchema>;
export const photoSequenceTypeSchema=z.enum(['ACTION_SEQUENCE','BURST_SEQUENCE','SHARED_MOMENT','LOCATION_SEQUENCE','PORTRAIT_COLLECTION','TRAVEL_SEQUENCE','INDEPENDENT_PHOTO']);
export const photoSequenceSchema=z.object({
 id:z.string().uuid(),projectId:z.string().uuid(),orderedPhotoIds:z.array(z.string().uuid()).min(1),
 startTimestamp:z.string().nullable(),endTimestamp:z.string().nullable(),temporalConfidence:z.number().min(0).max(1),
 visualContinuityScore:z.number().min(0).max(100),actionContinuityScore:z.number().min(0).max(100),narrativeImportanceScore:z.number().min(0).max(100),
 sequenceType:photoSequenceTypeSchema,description:z.string().max(1500),proposedAction:z.string().max(1200),recommendedPresentationType:presentationTypeSchema,recommendedAnimationStrategy:animationStrategySchema,
 firstFramePhotoId:z.string().uuid(),lastFramePhotoId:z.string().uuid(),intermediatePhotoIds:z.array(z.string().uuid()),referencePhotoIds:z.array(z.string().uuid()),
 pinned:z.boolean(),excluded:z.boolean(),reviewed:z.boolean(),confidence:z.number().min(0).max(1),analysisVersion:z.string(),
 collageLayout:collageLayoutSchema.optional(),textOverlays:z.array(textOverlaySchema).max(12).default([]),warnings:z.array(z.string().max(500)).default([]),
}).strict();
export type PhotoSequence=z.infer<typeof photoSequenceSchema>;
export const compositionPreferencesSchema=z.object({originalAnimations:z.number().finite().min(0).max(1).default(.35),newScenes:z.number().finite().min(0).max(1).default(.25),collages:z.number().finite().min(0).max(1).default(.20),montages:z.number().finite().min(0).max(1).default(.12),titles:z.number().finite().min(0).max(1).default(.08)}).strict().refine(value=>Object.values(value).reduce((sum,v)=>sum+v,0)>0,'Choose at least one visual technique.');
export const cinematicPreferencesSchema=z.object({enabled:z.boolean().default(true),editingStyle:editingStyleSchema.default('Cinematic'),language:textLanguageSchema.default('en'),distribution:compositionPreferencesSchema.default(()=>compositionPreferencesSchema.parse({})),automaticText:z.boolean().default(true),maximumCollagePhotos:z.union([z.literal(2),z.literal(3),z.literal(4),z.literal(6),z.literal(8)]).default(8)}).strict();
export type CinematicPreferences=z.infer<typeof cinematicPreferencesSchema>;
export const sequenceEditSchema=z.object({orderedPhotoIds:z.array(z.string().uuid()).min(1).optional(),pinned:z.boolean().optional(),excluded:z.boolean().optional(),recommendedPresentationType:presentationTypeSchema.optional(),collageLayout:collageLayoutSchema.optional(),description:z.string().max(1500).optional(),textOverlays:z.array(textOverlaySchema).max(12).optional()}).strict();
export const sequenceMergeSchema=z.object({sequenceIds:z.array(z.string().uuid()).min(2).refine(ids=>new Set(ids).size===ids.length,'Choose distinct moments.')}).strict();
export const sequenceSplitSchema=z.object({atIndex:z.number().int().positive()}).strict();
export type CinematicCompositionSummary={importedPhotos:number;recognizedSequences:number;selectedMoments:number;uniqueSourcePhotos:number;multiImageAnimatedScenes:number;collageScenes:number;montageScenes:number;newFictionalScenes:number;animatedScenes:number;textElements:number;plannedDurationSeconds:number;estimatedAiCostUsd:number;reusedP4ClipCount:number;distribution:Record<string,number>;warnings:string[]};
export type CinematicState={sequences:PhotoSequence[];preferences:CinematicPreferences;importedCount:number;analyzedCount:number;analysisVersion:string;warnings:string[];summary?:CinematicCompositionSummary;};
