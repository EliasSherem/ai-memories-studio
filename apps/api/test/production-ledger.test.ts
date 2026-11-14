import {afterEach,describe,expect,it,vi} from 'vitest';
import {ProductionLedger} from '../src/production-ledger.js';
import {StudioDatabase} from '../src/database.js';
import {ApiError} from '../src/errors.js';
import {productionFixture} from './production-fixture.js';
const disposals:(()=>Promise<void>|void)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});
async function fixture(){const f=await productionFixture({cachedAnalysis:true});disposals.push(()=>f.dispose());await f.productionQueue.dispose();const run=await f.create();await f.approve(run);return {...f,run,ledger:f.productionStore.ledger};}
const response={json:{description:'A local synthetic planning result.'},usage:{inputTokens:100,outputTokens:50}};

describe('P6 atomic paid-operation ledger claims',()=>{
 it('claims a shared operation once across two ledger instances and SQLite connections',async()=>{
  const f=await fixture(),connection=new StudioDatabase(f.config.databasePath!,f.config.sessionSecret);disposals.push(()=>connection.close());const other=new ProductionLedger(connection,f.config,id=>f.productionStore.assertDispatch(id));let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});const dispatch=vi.fn(async()=>{await gate;return response;});const operation={runId:f.run.id,key:'analysis:shared-checkpoint',phase:'analysis' as const,estimateUsd:.01};
  const first=f.ledger.execute(operation,dispatch);expect(dispatch).toHaveBeenCalledTimes(1);
  await expect(other.execute(operation,dispatch)).rejects.toMatchObject({code:'PRODUCTION_SUBMISSION_UNKNOWN'});expect(dispatch).toHaveBeenCalledTimes(1);expect(connection.connection.prepare('SELECT COUNT(*) count FROM production_operations WHERE run_id=? AND operation_key=?').get(f.run.id,operation.key)).toMatchObject({count:1});
  release();expect(await first).toEqual(response);expect(f.ledger.row(f.run.id,operation.key)).toMatchObject({status:'COMPLETED'});
  expect(await other.execute(operation,dispatch)).toEqual(response);expect(dispatch).toHaveBeenCalledTimes(1);expect(f.ledger.budget(f.run.id)).toMatchObject({reservedUsd:0,observedCostUsd:null,estimatesOnly:true});
 });
 it('replays a completed result after a new ledger starts without another dispatch',async()=>{
  const f=await fixture(),operation={runId:f.run.id,key:'storyboard:durable-result',phase:'planning' as const,estimateUsd:.05},dispatch=vi.fn(async()=>response);await f.ledger.execute(operation,dispatch);const restarted=new ProductionLedger(f.media.db,f.config,id=>f.productionStore.assertDispatch(id));const result=await restarted.execute(operation,dispatch);expect(result).toEqual(response);expect(dispatch).toHaveBeenCalledTimes(1);expect(restarted.budget(f.run.id).estimatedSpendUsd).toBeCloseTo((100*.3+50*2.5)/1e6,8);
 });
 it.each(['PRODUCTION_MODEL_PREFLIGHT_FAILED','PRODUCTION_TOKEN_PREFLIGHT_FAILED','GEMINI_AUTHORIZATION','GEMINI_INVALID_REQUEST','INVALID_ANALYSIS_IMAGE','GEMINI_TOKEN_COUNT','PRODUCTION_INPUT_LIMIT','PRODUCTION_DISPATCH_BLOCKED'])('releases the known-free %s operation without misclassifying it as an unknown charge',async code=>{
  const f=await fixture(),operation={runId:f.run.id,key:`analysis:rejected:${code}`,phase:'analysis' as const,estimateUsd:.01},dispatch=vi.fn(async()=>{throw new ApiError(409,code,'The preflight rejected this local test operation before paid generation.');});await expect(f.ledger.execute(operation,dispatch)).rejects.toMatchObject({code});expect(f.ledger.row(f.run.id,operation.key)).toMatchObject({status:'REJECTED',spent_estimate_usd:0});expect(f.ledger.hasUnknown(f.run.id)).toBe(false);expect(f.ledger.budget(f.run.id)).toMatchObject({estimatedSpendUsd:0,reservedUsd:0});
 });
 it('retains an ambiguous request ceiling and blocks dispatch after restart',async()=>{
  const f=await fixture(),operation={runId:f.run.id,key:'analysis:lost-response',phase:'analysis' as const,estimateUsd:.02},dispatch=vi.fn(async()=>{throw new ApiError(503,'GEMINI_NETWORK','The synthetic response was lost after submission.');});await expect(f.ledger.execute(operation,dispatch)).rejects.toMatchObject({code:'GEMINI_NETWORK'});const restarted=new ProductionLedger(f.media.db,f.config,id=>f.productionStore.assertDispatch(id));await expect(restarted.execute(operation,dispatch)).rejects.toMatchObject({code:'PRODUCTION_SUBMISSION_UNKNOWN'});expect(dispatch).toHaveBeenCalledTimes(1);expect(restarted.row(f.run.id,operation.key)).toMatchObject({status:'UNKNOWN',spent_estimate_usd:.02});
 });
 it('rejects pause before the paid callback without consuming a run reservation',async()=>{
  const f=await fixture(),operation={runId:f.run.id,key:'analysis:paused-before-dispatch',phase:'analysis' as const,estimateUsd:.01},dispatch=vi.fn(async()=>response);f.media.db.connection.prepare("UPDATE production_runs SET state='PAUSED' WHERE id=?").run(f.run.id);await expect(f.ledger.execute(operation,dispatch)).rejects.toMatchObject({code:'PRODUCTION_PAUSED'});expect(dispatch).not.toHaveBeenCalled();expect(f.ledger.row(f.run.id,operation.key)).toBeUndefined();expect(f.ledger.budget(f.run.id)).toMatchObject({estimatedSpendUsd:0,reservedUsd:0});
 });
});
