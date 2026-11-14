export * from './duration-policy.js';
export * from './movie.js';
import { z } from 'zod';
export * from './director.js';
export * from './video.js';

export const contributorIdSchema = z.enum(['person1', 'person2']);
export type ContributorId = z.infer<typeof contributorIdSchema>;
export const contributors = [{id:'person1',label:'Your memories'}, {id:'person2',label:'Their memories'}] as const;
export const assetSchema = z.object({
  id:z.string().uuid(), projectId:z.string().uuid(), contributorId:contributorIdSchema,
  filename:z.string(), mimeType:z.string(), bytes:z.number(), importedAt:z.string(),
  createdAt:z.string().optional(), width:z.number().optional(), height:z.number().optional(),
  selected:z.boolean(), url:z.string(), sha256:z.string().optional(), sourceCount:z.number().optional(),
});
export type Asset = z.infer<typeof assetSchema>;
export type SessionInfo = { authenticated:boolean; configured:boolean; csrfToken:string; contributors:{id:ContributorId;label:string;connected:boolean;requiresReauthorization?:boolean;reauthorizationReason?:string;reauthorizationMessage?:string;grantedScopes?:string[];accountVerified?:boolean;grantsVerified?:boolean}[] };
export type PickerStatus = 'waiting'|'ready'|'importing'|'complete'|'cancelled'|'expired'|'error'|'paused';
export type PickerState = {
  id:string; contributorId:ContributorId; status:PickerStatus; pickerUri?:string;
  pollIntervalMs:number; nextPollAt:number; deadline:number; message?:string;
  total:number; processed:number; imported:number; skipped:number; failed:number;
  issues:{filename:string;message:string}[]; cleanupPending?:boolean;
  completed?:number; remaining?:number; retrying?:number; activeDownloads?:number;
  resumable?:boolean; requiresReselection?:boolean; requiresAuthorization?:boolean;
  createdAt?:number; listingComplete?:boolean; issueCount?:number; duplicates?:number; expiresAt?:number;
};
export type ProjectState = {project:{id:string;name:string;createdAt:string};assets:Asset[];picker?:PickerState;jobs?:PickerState[]};
export const createPickerSchema = z.object({contributorId:contributorIdSchema}).strict();
export const selectionSchema = z.object({selected:z.boolean()}).strict();
export const galleryQuerySchema = z.object({search:z.string().max(500).optional(),contributorId:contributorIdSchema.optional(),selected:z.boolean().optional(),mimeType:z.enum(['image/jpeg','image/png','image/webp','image/gif']).optional()}).strict();
export type GalleryQuery = z.infer<typeof galleryQuerySchema>;
export const bulkSelectionSchema = z.object({ids:z.array(z.string().uuid()).optional(),query:galleryQuerySchema.optional(),selected:z.boolean()}).strict().refine(value=>!(value.ids&&value.query),'Use ids or query, not both.');
// A future analysis provider receives only explicit local asset references. P2 never executes it.
export const mediaAnalysisScoresSchema=z.object({sharpness:z.number().min(0).max(1),composition:z.number().min(0).max(1),visualDiversity:z.number().min(0).max(1),storytellingPotential:z.number().min(0).max(1)});
export type MediaAnalysisScores=z.infer<typeof mediaAnalysisScoresSchema>;
export interface MediaAnalysisRequest {assetId:string;projectId:string;sha256:string;localFilePath:string;mimeType:string;originalMetadata:Record<string,unknown>[];}
export interface MediaAnalysisResult {assetId:string;provider:string;model:string;version:string;scores:MediaAnalysisScores;embedding?:number[];reasoning?:string;}
export interface MediaAnalyzer {analyze(request:MediaAnalysisRequest,signal:AbortSignal):Promise<MediaAnalysisResult>;}
export type GoogleDiagnostic = {operation:string;httpStatus:number;googleCode?:number;googleStatus?:string;reason?:string;domain?:string;service?:string;consumerProject?:string;message:string};
export type ApiErrorBody = {error:{code:string;message:string;retryAfterMs?:number;diagnostic?:GoogleDiagnostic}};

export * from './production.js';

export * from './cinematic.js';
