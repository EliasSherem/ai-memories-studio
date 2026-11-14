import {isApprovedSceneReference} from './reference-usage.js';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  assetSchema, protagonistInputSchema, curationInputSchema, photoAnalysisSchema, storyboardContentSchema, MIN_PROTAGONIST_REFERENCES, MAX_PROTAGONIST_REFERENCES,
  type Asset, type PhotoAnalysis, type LocalPhotoFeatures, type PhotoCuration, type Protagonist,
  type ProtagonistId, type ProtagonistInput, type StoryboardContent, type Storyboard,
  type GeminiUsage, type DirectorUsage,
} from '@memories/shared';
import type { Config } from './config.js';
import { MediaStore } from './media-store.js';
import { ApiError } from './errors.js';
import type {StoryboardProductionPolicy} from './storyboard.js';

export type DirectorPhotoRow = { assetId:string; asset: Asset; analysis: PhotoAnalysis | null; features: LocalPhotoFeatures | null; curation: PhotoCuration; duplicateOf?: string };
type JoinedRow = {id:string;public_json:string;selected:number;sha256:string;result_json:string|null;features_json:string|null;duplicate_of:string|null;pinned:number|null;excluded:number|null;protagonist_ids_json:string|null;associations_confirmed:number|null};
const now = () => new Date().toISOString();
const uuid = z.string().uuid();
const roundCost = (value:number) => Math.ceil(value * 1e8) / 1e8;
const storageName=z.string().regex(/^[a-f0-9-]{36}\.(jpg|png|webp|gif)$/);

/** Additive P3 migration. P2 media, imports, tokens and checkpoints remain authoritative. */
export class DirectorStore {
  readonly db;
  constructor(readonly media:MediaStore, readonly config:Config) {
    this.db=media.db;
    this.db.transaction(()=>{
      this.db.connection.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS p3_analysis_runs(
          id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          status TEXT NOT NULL,model TEXT NOT NULL,pipeline_version TEXT NOT NULL,
          created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,message TEXT
        );
        CREATE INDEX IF NOT EXISTS p3_runs_project ON p3_analysis_runs(project_id,created_at DESC);
        CREATE TABLE IF NOT EXISTS p3_analysis_items(
          id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES p3_analysis_runs(id) ON DELETE CASCADE,
          asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,sha256 TEXT,
          status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL DEFAULT 0,
          lease_owner TEXT,lease_until INTEGER DEFAULT 0,error_code TEXT,safe_message TEXT,
          UNIQUE(run_id,asset_id)
        );
        CREATE INDEX IF NOT EXISTS p3_items_ready ON p3_analysis_items(status,available_at);
        CREATE TABLE IF NOT EXISTS p3_local_features(
          asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          sha256 TEXT NOT NULL,features_json TEXT NOT NULL,phash TEXT NOT NULL,duplicate_of TEXT
        );
        CREATE INDEX IF NOT EXISTS p3_features_project ON p3_local_features(project_id,asset_id);
        CREATE TRIGGER IF NOT EXISTS p3_duplicate_root_deleted AFTER DELETE ON p3_local_features
          WHEN OLD.duplicate_of IS NULL BEGIN
            UPDATE p3_local_features SET duplicate_of=(SELECT MIN(asset_id) FROM p3_local_features WHERE project_id=OLD.project_id AND duplicate_of=OLD.asset_id)
              WHERE project_id=OLD.project_id AND duplicate_of=OLD.asset_id;
            UPDATE p3_local_features SET duplicate_of=NULL WHERE project_id=OLD.project_id AND duplicate_of=asset_id;
          END;
        CREATE TABLE IF NOT EXISTS p3_photo_analysis(
          asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          sha256 TEXT NOT NULL,model TEXT NOT NULL,pipeline_version TEXT NOT NULL,
          result_json TEXT NOT NULL,completed_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS p3_results_project ON p3_photo_analysis(project_id,asset_id);
        CREATE TABLE IF NOT EXISTS p3_worker_lease(id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS p3_rate_limits(model TEXT PRIMARY KEY,until_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS p3_protagonists(
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          slot TEXT NOT NULL CHECK(slot IN ('person1','person2')),name TEXT NOT NULL DEFAULT '',
          reference_ids_json TEXT NOT NULL DEFAULT '[]',consent INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,
          PRIMARY KEY(project_id,slot)
        );
        CREATE TABLE IF NOT EXISTS p3_photo_settings(
          asset_id TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          pinned INTEGER NOT NULL DEFAULT 0,excluded INTEGER NOT NULL DEFAULT 0,
          protagonist_ids_json TEXT NOT NULL DEFAULT '[]',associations_confirmed INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS p3_storyboards(
          id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version INTEGER NOT NULL,content_json TEXT NOT NULL,status TEXT NOT NULL,validation_json TEXT NOT NULL,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,version)
        );
        CREATE TABLE IF NOT EXISTS p3_storyboard_policies(storyboard_id TEXT PRIMARY KEY REFERENCES p3_storyboards(id) ON DELETE CASCADE,project_id TEXT NOT NULL REFERENCES projects(id),policy_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS p3_usage(
          id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          operation TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,
          reserved_usd REAL NOT NULL,estimated_usd REAL NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,output_tokens INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS p3_usage_project ON p3_usage(project_id,status);
      `);
      this.db.connection.prepare('INSERT OR IGNORE INTO schema_migrations(version,name,applied_at) VALUES(3,?,?)').run('AI Director, local features, analysis queue, usage and versioned storyboards',now());
      const version=this.db.connection.prepare('PRAGMA user_version').get() as {user_version:number};
      if(version.user_version<3) this.db.connection.exec('PRAGMA user_version=3');
    });
  }
  async ensure(owner:string):Promise<void> {
    await this.media.ensure(owner);
    const insert=this.db.connection.prepare("INSERT OR IGNORE INTO p3_protagonists(project_id,slot,updated_at) VALUES(?,?,?)");
    for(const slot of ['person1','person2']) insert.run(owner,slot,now());
  }
  async asset(owner:string,id:string):Promise<{asset:Asset;file:string;originalMetadata:Record<string,unknown>[]}> {
    uuid.parse(id);
    const result=await this.media.content(owner,owner,id);
    const metadata=this.db.connection.prepare('SELECT original_metadata_json FROM media_sources WHERE project_id=? AND asset_id=? ORDER BY id').all(owner,id) as {original_metadata_json:string}[];
    return {...result,originalMetadata:metadata.map(row=>JSON.parse(row.original_metadata_json) as Record<string,unknown>)};
  }
  rows(owner:string,limit=100,afterId?:string,analyzedOnly=false,productionRunId?:string):DirectorPhotoRow[] {
    uuid.parse(owner); if(afterId) uuid.parse(afterId);
    const rows=this.db.connection.prepare(`SELECT a.id,a.public_json,a.selected,a.sha256,
      r.result_json,f.features_json,f.duplicate_of,s.pinned,s.excluded,s.protagonist_ids_json,s.associations_confirmed
      FROM assets a LEFT JOIN p3_photo_analysis r ON r.asset_id=a.id AND r.sha256=a.sha256 AND r.model=? AND r.pipeline_version=?
      LEFT JOIN p3_local_features f ON f.asset_id=a.id AND f.sha256=a.sha256 LEFT JOIN p3_photo_settings s ON s.asset_id=a.id
      WHERE a.project_id=? AND a.id>? AND (?=0 OR r.asset_id IS NOT NULL) ${productionRunId?'AND EXISTS(SELECT 1 FROM production_run_photos p WHERE p.run_id=? AND p.asset_id=a.id AND p.sha256=a.sha256)':''} ORDER BY a.id LIMIT ?`).all(this.config.geminiModel??'gemini-3.5-flash-lite',this.config.analysisPipelineVersion??'photo-v1',owner,afterId??'',analyzedOnly?1:0,...(productionRunId?[productionRunId]:[]),Math.max(1,Math.min(200,limit))) as JoinedRow[];
    return rows.map(row=>{
      const raw=JSON.parse(row.public_json) as Record<string,unknown>;
      delete raw.storageName;
      const asset=assetSchema.parse({...raw,selected:Boolean(row.selected),sha256:row.sha256,url:`/api/projects/${owner}/assets/${row.id}/content`});
      return {assetId:asset.id,asset,analysis:row.result_json?photoAnalysisSchema.parse(JSON.parse(row.result_json)):null,features:row.features_json?JSON.parse(row.features_json) as LocalPhotoFeatures:null,
        curation:{assetId:row.id,pinned:Boolean(row.pinned),excluded:Boolean(row.excluded),protagonistIds:row.protagonist_ids_json?JSON.parse(row.protagonist_ids_json):[],associationsConfirmed:Boolean(row.associations_confirmed)},
        ...(row.duplicate_of?{duplicateOf:row.duplicate_of}:{})};
    });
  }
  productionRows(owner:string,runId:string,limit=100,afterId?:string):DirectorPhotoRow[]{return this.rows(owner,limit,afterId,false,uuid.parse(runId));}
  protagonists(owner:string):Protagonist[] {
    const rows=this.db.connection.prepare('SELECT * FROM p3_protagonists WHERE project_id=? ORDER BY slot').all(owner) as {slot:ProtagonistId;name:string;reference_ids_json:string;consent:number;updated_at:string}[];
    const owned=this.db.connection.prepare('SELECT storage_name FROM assets WHERE project_id=? AND id=?');
    return rows.map(row=>{
      const ids=(JSON.parse(row.reference_ids_json) as string[]).filter(id=>{
        const asset=owned.get(owner,id) as {storage_name:string}|undefined;
        return Boolean(asset&&storageName.safeParse(asset.storage_name).success&&existsSync(join(this.media.root,owner,asset.storage_name)));
      });
      const originalIds=JSON.parse(row.reference_ids_json) as string[];
      const readinessIssues:string[]=[];
      if(!row.name.trim())readinessIssues.push('Enter a protagonist name.');
      if(!row.consent)readinessIssues.push('Confirm permission to use this person’s likeness.');
      if(originalIds.length<MIN_PROTAGONIST_REFERENCES)readinessIssues.push(`Choose at least ${MIN_PROTAGONIST_REFERENCES} reference photos.`);
      if(originalIds.length>MAX_PROTAGONIST_REFERENCES)readinessIssues.push(`Choose no more than ${MAX_PROTAGONIST_REFERENCES} reference photos.`);
      if(new Set(originalIds).size!==originalIds.length)readinessIssues.push('Choose different reference photographs.');
      if(ids.length!==originalIds.length)readinessIssues.push('A selected reference file is missing or unavailable in this project. Choose a replacement.');
      return {id:row.slot,name:row.name,referencePhotoIds:ids,likenessPermissionConfirmed:Boolean(row.consent),updatedAt:row.updated_at,
        ready:readinessIssues.length===0,readinessIssues};
    });
  }
  async saveProtagonist(owner:string,slot:ProtagonistId,input:ProtagonistInput):Promise<Protagonist> {
    await this.ensure(owner);
    const data=protagonistInputSchema.parse(input);
    if(new Set(data.referencePhotoIds).size!==data.referencePhotoIds.length) throw new ApiError(400,'DUPLICATE_REFERENCES','Select distinct reference photos.');
    for(const id of data.referencePhotoIds) await this.asset(owner,id);
    this.db.transaction(()=>{
      this.db.connection.prepare('UPDATE p3_protagonists SET name=?,reference_ids_json=?,consent=?,updated_at=? WHERE project_id=? AND slot=?').run(data.name,JSON.stringify(data.referencePhotoIds),data.likenessPermissionConfirmed?1:0,now(),owner,slot);
      // A reference selection is an explicit user association, never an inferred identity.
      for(const id of data.referencePhotoIds) {
        const settings=this.curation(owner,id);
        this.writeCuration(owner,id,{...settings,protagonistIds:[...new Set([...settings.protagonistIds,slot])],associationsConfirmed:true});
      }
      this.invalidate(owner,'Protagonist references or likeness permission changed. Validate a new storyboard version.');
    });
    return this.protagonists(owner).find(person=>person.id===slot)!;
  }
  curation(owner:string,id:string):PhotoCuration {
    if(!this.db.connection.prepare('SELECT 1 FROM assets WHERE project_id=? AND id=?').get(owner,id)) throw new ApiError(404,'NOT_FOUND','Photo not found.');
    const row=this.db.connection.prepare('SELECT * FROM p3_photo_settings WHERE project_id=? AND asset_id=?').get(owner,id) as {pinned:number;excluded:number;protagonist_ids_json:string;associations_confirmed:number}|undefined;
    return {assetId:id,pinned:Boolean(row?.pinned),excluded:Boolean(row?.excluded),protagonistIds:row?JSON.parse(row.protagonist_ids_json):[],associationsConfirmed:Boolean(row?.associations_confirmed)};
  }
  private writeCuration(owner:string,id:string,value:PhotoCuration) {
    this.db.connection.prepare(`INSERT INTO p3_photo_settings(asset_id,project_id,pinned,excluded,protagonist_ids_json,associations_confirmed) VALUES(?,?,?,?,?,?)
      ON CONFLICT(asset_id) DO UPDATE SET pinned=excluded.pinned,excluded=excluded.excluded,protagonist_ids_json=excluded.protagonist_ids_json,associations_confirmed=excluded.associations_confirmed`).run(id,owner,value.pinned?1:0,value.excluded?1:0,JSON.stringify(value.protagonistIds),value.associationsConfirmed?1:0);
  }
  async setCuration(owner:string,id:string,input:unknown):Promise<PhotoCuration> {
    const patch=curationInputSchema.parse(input); await this.asset(owner,id);
    const current=this.curation(owner,id);
    if(patch.pinned&&patch.excluded) throw new ApiError(400,'CURATION_CONFLICT','A photo cannot be both pinned and excluded.');
    const next:PhotoCuration={...current,...patch,associationsConfirmed:patch.protagonistIds!==undefined?true:current.associationsConfirmed};
    if(patch.excluded) next.pinned=false;
    if(patch.pinned) next.excluded=false;
    this.db.transaction(()=>{this.writeCuration(owner,id,next);this.invalidate(owner,'Photo curation changed. Validate a new storyboard version.');});
    return next;
  }
  private invalidate(owner:string,reason:string) {
    this.db.connection.prepare("UPDATE p3_storyboards SET status='draft',validation_json=? WHERE project_id=? AND status='validated'").run(JSON.stringify([reason]),owner);
  }
  saveStoryboard(owner:string,input:StoryboardContent,validationIssues:string[],productionPolicy?:StoryboardProductionPolicy):Storyboard {
    const content=storyboardContentSchema.parse(input);
    return this.db.transaction(()=>{
      const version=(this.db.connection.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM p3_storyboards WHERE project_id=?').get(owner) as {version:number}).version;
      const id=randomUUID(),created=now(),status=validationIssues.length?'draft':'validated';
      this.db.connection.prepare('INSERT INTO p3_storyboards(id,project_id,version,content_json,status,validation_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,owner,version,JSON.stringify(content),status,JSON.stringify(validationIssues),created,created);
      if(productionPolicy)this.saveStoryboardPolicy(owner,id,productionPolicy);
      return this.getStoryboard(owner,id)!;
    });
  }
  getStoryboard(owner:string,id?:string):Storyboard|undefined {
    if(id) uuid.parse(id);
    const row=(id?this.db.connection.prepare('SELECT * FROM p3_storyboards WHERE project_id=? AND id=?').get(owner,id):this.db.connection.prepare('SELECT * FROM p3_storyboards WHERE project_id=? ORDER BY version DESC LIMIT 1').get(owner)) as {id:string;version:number;content_json:string;status:'draft'|'validated';validation_json:string;created_at:string;updated_at:string}|undefined;
    if(!row) return;
    const content=storyboardContentSchema.parse(JSON.parse(row.content_json));
    const issues=JSON.parse(row.validation_json) as string[];
    const valid=this.db.connection.prepare('SELECT storage_name FROM assets WHERE project_id=? AND id=?');
    const excluded=this.db.connection.prepare('SELECT 1 FROM p3_photo_settings WHERE project_id=? AND asset_id=? AND excluded=1');
    const people=this.protagonists(owner);
    for(const scene of content.scenes)for(const id of scene.sourcePhotoIds) {
      const asset=valid.get(owner,id) as {storage_name:string}|undefined;
      if(!asset) issues.push('A source photo was deleted. Replace its storyboard references.');
      else if(!storageName.safeParse(asset.storage_name).success||!existsSync(join(this.media.root,owner,asset.storage_name))) issues.push('A local source photo file is missing. Restore it or replace its storyboard references.');
      else if(excluded.get(owner,id)&&!isApprovedSceneReference(scene,id,people)) issues.push('A source photo is now excluded. Replace its storyboard references.');
    }
    if(this.protagonists(owner).length!==2||this.protagonists(owner).some(person=>!person.ready)) issues.push(`Both protagonists need names, ${MIN_PROTAGONIST_REFERENCES}–${MAX_PROTAGONIST_REFERENCES} existing references, and confirmed likeness permission.`);
    if(content.scenes.some(scene=>scene.requiresUserConfirmation&&!scene.userConfirmed)) issues.push('Confirm the scenes that require review before video generation.');
    const validationIssues=[...new Set(issues)];
    return {...content,id:row.id,projectId:owner,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at,status:validationIssues.length?'draft':row.status,validationIssues,readyForVideoGeneration:row.status==='validated'&&!validationIssues.length};
  }
  storyboardPolicy(owner:string,id:string):StoryboardProductionPolicy|undefined {const row=this.db.connection.prepare('SELECT policy_json FROM p3_storyboard_policies WHERE project_id=? AND storyboard_id=?').get(owner,uuid.parse(id)) as {policy_json:string}|undefined;return row?JSON.parse(row.policy_json):undefined;}
  saveStoryboardPolicy(owner:string,id:string,policy:StoryboardProductionPolicy):void {if(!this.db.connection.prepare('SELECT 1 FROM p3_storyboards WHERE project_id=? AND id=?').get(owner,uuid.parse(id)))throw new ApiError(404,'STORYBOARD_NOT_FOUND','Storyboard not found.');if(policy.productionRunId)uuid.parse(policy.productionRunId);if(!Number.isFinite(policy.originalRatio)||policy.originalRatio<0||policy.originalRatio>1||policy.aiScenesOnly!==true)throw new ApiError(400,'INVALID_PRODUCTION_POLICY','The automatic storyboard policy is invalid.');this.db.connection.prepare('INSERT INTO p3_storyboard_policies(storyboard_id,project_id,policy_json) VALUES(?,?,?) ON CONFLICT(storyboard_id) DO UPDATE SET policy_json=excluded.policy_json').run(id,owner,JSON.stringify(policy));}
  usage(owner:string):DirectorUsage {
    const row=this.db.connection.prepare(`SELECT COUNT(*) AS requests,COALESCE(SUM(input_tokens),0) AS inputTokens,COALESCE(SUM(output_tokens),0) AS outputTokens,
      COALESCE(SUM(estimated_usd),0) AS estimatedCostUsd,COALESCE(SUM(CASE WHEN status='reserved' THEN reserved_usd ELSE 0 END),0) AS reservedUsd FROM p3_usage WHERE project_id=?`).get(owner) as Omit<DirectorUsage,'maximumSpendUsd'|'currency'|'estimatesOnly'>;
    return {...row,maximumSpendUsd:this.config.geminiMaxProjectSpendUsd??10,currency:'USD',estimatesOnly:true};
  }
  reserveUsage(projectId:string,operation:string,model:string,inputTokens:number,maxOutputTokens:number,approvedProductionRunId?:string):{id:string;reservedUsd:number} {
    if(approvedProductionRunId)uuid.parse(approvedProductionRunId);
    if(![inputTokens,maxOutputTokens].every(value=>Number.isSafeInteger(value)&&value>=0)) throw new ApiError(400,'INVALID_USAGE','Gemini token limits are invalid.');
    const reservedUsd=roundCost((inputTokens*(this.config.geminiInputPricePerMillion??0.30)+maxOutputTokens*(this.config.geminiOutputPricePerMillion??2.50))/1e6);
    return this.db.transaction(()=>{
      const usage=this.usage(projectId);
      if(!approvedProductionRunId&&usage.estimatedCostUsd+usage.reservedUsd+reservedUsd>usage.maximumSpendUsd+1e-9) throw new ApiError(402,'PROJECT_BUDGET_EXCEEDED','The project Gemini spending limit has been reached. Increase GEMINI_MAX_PROJECT_SPEND_USD on the server to resume analysis.');
      const id=randomUUID(),created=now();
      this.db.connection.prepare("INSERT INTO p3_usage(id,project_id,operation,model,status,reserved_usd,created_at,updated_at) VALUES(?,?,?,?,'reserved',?,?,?)").run(id,projectId,operation,model,reservedUsd,created,created);
      return {id,reservedUsd};
    });
  }
  settleUsage(id:string,usage:GeminiUsage,status:'succeeded'|'failed'|'unknown'):void {
    this.db.transaction(()=>{
      const row=this.db.connection.prepare('SELECT reserved_usd,status FROM p3_usage WHERE id=?').get(id) as {reserved_usd:number;status:string}|undefined;
      if(!row||row.status!=='reserved') return;
      if(![usage.inputTokens,usage.outputTokens].every(value=>Number.isSafeInteger(value)&&value>=0)) {usage={inputTokens:0,outputTokens:0};status='unknown';}
      const cost=status==='unknown'?row.reserved_usd:roundCost((usage.inputTokens*(this.config.geminiInputPricePerMillion??0.30)+usage.outputTokens*(this.config.geminiOutputPricePerMillion??2.50))/1e6);
      this.db.connection.prepare('UPDATE p3_usage SET status=?,estimated_usd=?,input_tokens=?,output_tokens=?,updated_at=? WHERE id=? AND status=\'reserved\'').run(status,cost,usage.inputTokens,usage.outputTokens,now(),id);
    });
  }
}
