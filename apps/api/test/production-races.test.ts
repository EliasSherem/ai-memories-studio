import {afterEach,describe,expect,it,vi} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import {productionFixture,waitForProduction,fixtureInspection} from './production-fixture.js';
const disposals:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});
async function until(check:()=>boolean,timeout=10000){const deadline=Date.now()+timeout;while(!check()){if(Date.now()>deadline)throw new Error('Production race checkpoint timed out');await delay(5);}}

describe('P6 late automatic decisions',()=>{
 it('preserves a human scene rejection when an earlier automatic acceptance finishes after pause',async()=>{
  const f=await productionFixture({cachedAnalysis:true});disposals.push(()=>f.dispose());let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});disposals.push(async()=>release());let entered=false,finished=false,assetId='';const original=f.videoStore.review.bind(f.videoStore);
  vi.spyOn(f.videoStore,'review').mockImplementation(async(...args)=>{if(args[2]==='approved'&&args[3].startsWith('Automatically accepted')&&!entered){entered=true;assetId=args[1];try{await gate;return await original(...args);}finally{finished=true;}}return original(...args);});
  const run=await f.create();await f.approve(run);await until(()=>entered);const scene=f.productionStore.sceneRows(run.id).find(scene=>scene.asset_id===assetId)!;expect(scene).toBeDefined();await f.productionQueue.pause(f.owner,run.id);await f.productionQueue.reviewScene(f.owner,run.id,scene.scene_id,'rejected','Human override: use another approved attempt.');release();await until(()=>finished);
  const current=f.productionStore.scene(f.owner,run.id,scene.scene_id),asset=f.videoStore.assets(f.owner).find(asset=>asset.id===assetId)!;expect(f.productionStore.row(f.owner,run.id).state).toBe('PAUSED');expect(asset.decision).toBe('rejected');expect(current.user_override).toBe(1);expect(current.state).not.toBe('APPROVED');expect(current.message).not.toMatch(/Automatically accepted/);
 });
 it('does not publish completion after a source clip is rejected through the existing P4 interface during final verification',async()=>{
  const f=await productionFixture({cachedAnalysis:true});disposals.push(()=>f.dispose());let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});disposals.push(async()=>release());let validating=false;
  vi.spyOn(f.renderer,'validate').mockImplementation(async()=>{validating=true;await gate;return fixtureInspection;});
  const run=await f.create();await f.approve(run);await until(()=>validating);const scene=f.productionStore.sceneRows(run.id).find(scene=>scene.state==='APPROVED'&&scene.asset_id)!;await f.videoStore.review(f.owner,scene.asset_id!,'rejected','Rejected through the existing P4 review controls.');release();const result=await waitForProduction(f,run.id,current=>current.state==='PAUSED'||current.state==='COMPLETED');expect(result.state).toBe('PAUSED');expect(f.videoStore.assets(f.owner).find(asset=>asset.id===scene.asset_id)?.decision).toBe('rejected');expect(result.errors.at(0)?.code).toMatch(/SCENE|SOURCE|APPROVAL/);
 });

 it('pauses a known operation whose retrieval window expired rather than automatically paying for a replacement',async()=>{
  const f=await productionFixture({cachedAnalysis:true,video:async input=>({operationId:`synthetic-pending-${input.jobId}`,done:false}),poll:async operationId=>({operationId,done:false})});
  disposals.push(()=>f.dispose());
  const run=await f.create();await f.approve(run);
  await until(()=>Boolean(f.media.db.connection.prepare("SELECT 1 FROM video_generation_jobs WHERE state='GENERATING_VIDEO' AND operation_id IS NOT NULL AND lease_owner IS NULL").get()));
  f.media.db.connection.prepare("UPDATE video_generation_jobs SET state='FAILED',error_code='VIDEO_OPERATION_EXPIRED',error_message='The saved operation retrieval window expired before its result was available.',reserved_usd=0,lease_owner=NULL,next_attempt_at=0 WHERE state='GENERATING_VIDEO' AND operation_id IS NOT NULL").run();
  const result=await waitForProduction(f,run.id,current=>current.state==='PAUSED',10000);
  expect(result.errors.at(0)?.code).toBe('PRODUCTION_SUBMISSION_UNKNOWN');
  // Polling the dashboard must not reconcile an unresolved terminal child to a free completion.
  f.productionStore.run(f.owner,run.id);f.productionStore.run(f.owner,run.id);
  expect(f.productionStore.ledger.hasUnknown(run.id)).toBe(true);
  const operation=f.media.db.connection.prepare("SELECT status,cap_usd,spent_estimate_usd FROM production_operations WHERE run_id=? AND phase='video'").get(run.id) as {status:string;cap_usd:number;spent_estimate_usd:number};
  expect(operation.status).toBe('UNKNOWN');expect(operation.spent_estimate_usd).toBeGreaterThanOrEqual(operation.cap_usd);
  await expect(f.productionQueue.resume(f.owner,run.id)).rejects.toMatchObject({code:'PRODUCTION_SUBMISSION_UNKNOWN'});
  await expect(f.productionQueue.retry(f.owner,run.id)).rejects.toMatchObject({code:'PRODUCTION_SUBMISSION_UNKNOWN'});
  expect(f.media.db.connection.prepare("SELECT 1 FROM video_generation_jobs WHERE state='FAILED' AND error_code='VIDEO_OPERATION_EXPIRED' AND operation_id IS NOT NULL").get()).toBeDefined();
  expect(f.counters.video).toBe(1);expect(f.productionStore.sceneRows(run.id).filter(scene=>scene.attempts>0)).toHaveLength(1);
 });

});
