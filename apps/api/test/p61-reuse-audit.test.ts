import {afterEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {movieFixture} from './movie-fixture.js';
const fixtures:Awaited<ReturnType<typeof movieFixture>>[]=[];
afterEach(async()=>{for(const f of fixtures.splice(0))await f.dispose();});
async function fixture(){const f=await movieFixture();fixtures.push(f);return f;}
describe('P6.1 exact P4 asset reuse and per-pair duration audit',()=>{
 it('does not substitute a conversationally refined clip for an exact base scene request',async()=>{
  const f=await fixture(),baseId=f.clipIds[0],base=f.videoStore.assetRow(f.owner,baseId),quote=await f.videoStore.quote(f.owner,{storyboardId:f.board.id,sceneId:f.content.scenes[0].id,refineAssetId:baseId,refinementPrompt:'Change this to an energetic rapid camera move.'}),job=await f.videoStore.create(f.owner,{quoteId:quote.id,approved:true,idempotencyKey:randomUUID()});
  const refinedId=randomUUID();f.insert('generated_video_assets',{...base,id:refinedId,job_id:job.id,version:job.version,refine_asset_id:baseId,created_at:new Date(Date.now()+1000).toISOString()});
  const quality=f.media.db.connection.prepare('SELECT * FROM video_quality_reviews WHERE asset_id=?').get(baseId) as Record<string,unknown>;f.insert('video_quality_reviews',{...quality,id:randomUUID(),asset_id:refinedId});
  f.media.db.connection.prepare("UPDATE video_generation_jobs SET state='COMPLETED',asset_id=?,operation_id=?,spent_usd=estimated_usd,reserved_usd=0 WHERE id=?").run(refinedId,f.media.db.seal('synthetic-refinement-operation'),job.id);
  await f.videoStore.assertCurrent(f.videoStore.row(f.owner,job.id));
  const target={...f.content.scenes[0],id:randomUUID()},reused=await f.videoStore.reusable(f.owner,target,randomUUID());expect(reused?.id).toBe(baseId);expect(reused?.refineAssetId).toBeUndefined();
 });
 it('never discovers another project’s approved private assets',async()=>{const f=await fixture(),other=await f.other();expect(await f.videoStore.reusable(other.owner,{...f.content.scenes[0],id:randomUUID()},randomUUID())).toBeUndefined();});
 it('rejects a chained storyboard whose declared pair duration differs from the actual provider settings',async()=>{
  const f=await fixture(),originalCapabilities=f.provider.capabilities;f.provider.capabilities=()=>({...originalCapabilities(),supportsFirstLastFrame:true,supportsMultiReference:true,maxReferenceImages:3});
  const content=structuredClone(f.content),scene=content.scenes[0];scene.presentationType='CHAINED_KEYFRAME_ANIMATION';scene.animationStrategy='CHAINED_PAIRS';scene.sourcePhotoIds=f.ids.slice(0,3);scene.firstFramePhotoId=f.ids[0];scene.lastFramePhotoId=f.ids[2];scene.sequenceSegments=[{id:randomUUID(),firstFramePhotoId:f.ids[0],lastFramePhotoId:f.ids[1],sourcePhotoIds:f.ids.slice(0,2),durationSeconds:5},{id:randomUUID(),firstFramePhotoId:f.ids[1],lastFramePhotoId:f.ids[2],sourcePhotoIds:f.ids.slice(1,3),durationSeconds:5}];const board=await f.director.save(f.owner,content);
  expect(board.readyForVideoGeneration).toBe(true);await expect(f.videoStore.quote(f.owner,{storyboardId:board.id,sceneId:scene.id})).rejects.toMatchObject({code:'VIDEO_SEQUENCE_DURATION'});
 });
});
