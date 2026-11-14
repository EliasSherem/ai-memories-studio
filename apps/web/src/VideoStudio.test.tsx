// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type {Asset,GeneratedVideoAsset,Storyboard,StoryboardScene,VideoGenerationJob,VideoGenerationQuote,VideoStudioState} from '@memories/shared';
import {VideoStudio} from './VideoStudio';

const id=(number:number)=>`00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const photo:Asset={id:id(1),projectId:id(9),contributorId:'person1',filename:'A private photograph.jpg',mimeType:'image/jpeg',bytes:100,importedAt:'2026-11-14T10:00:00Z',selected:true,url:`/api/projects/${id(9)}/assets/${id(1)}/content`};
const secondPhoto={...photo,id:id(2),filename:'Another photograph.jpg',url:`/api/projects/${id(9)}/assets/${id(2)}/content`};
const scene=(type:StoryboardScene['type']='ORIGINAL_ANIMATION',number=1):StoryboardScene=>({id:id(100+number),sequenceNumber:number,type,title:number===1?'A real moment':'An imagined moment',description:'Faithful details and cinematic motion.',durationSeconds:25,sourcePhotoIds:[photo.id,secondPhoto.id],protagonistIds:['person1','person2'],visualStyle:'Natural light',cameraDirection:'Slow camera drift',motionPrompt:'Gentle movement only.',emotionalTone:'Warm',continuityNotes:'Thematic transition',generationInstructions:'Preserve the supplied composition.',isFictional:type==='NEW_CINEMATIC_SCENE',requiresUserConfirmation:true,userConfirmed:true});
const board:Storyboard={schemaVersion:'1.0',id:id(20),projectId:id(9),version:1,title:'Our storyboard',synopsis:'A shared story.',targetDurationSeconds:150,scenes:[scene(),scene('NEW_CINEMATIC_SCENE',2),scene('PHOTO_MONTAGE',3),scene('TITLE_SEQUENCE',4)],createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z',status:'validated',readyForVideoGeneration:true,validationIssues:[]};
function studio(overrides:Partial<VideoStudioState>={}):VideoStudioState{return{configured:true,capabilities:{provider:'gemini-omni',backend:'gemini',model:'gemini-omni-1.1-flash',available:true,accountVerified:true,supportedModes:['ORIGINAL_ANIMATION','NEW_CINEMATIC_SCENE'],durationsSeconds:[8],resolutions:['720p'],aspectRatios:['16:9'],audioModes:[true],supportsCancellation:false,supportsRefinement:true,pollIntervalMs:10000,pricePerSecondUsd:0.15,priceVerifiedAt:'2026-11-14'},settings:{durationSeconds:8,resolution:'720p',aspectRatio:'16:9',generateAudio:true},budget:{maximumSpendUsd:10,estimatedSpendUsd:0,reservedUsd:0,remainingUsd:10,observedCostUsd:null,currency:'USD',estimatesOnly:true},jobs:[],assets:[],keyframes:[],readiness:{requiredScenes:2,approvedScenes:0,missingSceneIds:[id(101),id(102)],readyForP5:false,testAReviewed:false,testBReviewed:false},tools:{available:true},scenes:board.scenes,...overrides};}
const quote=(overrides:Partial<VideoGenerationQuote>={}):VideoGenerationQuote=>({id:id(30),expiresAt:new Date(Date.now()+60000).toISOString(),storyboardId:board.id,sceneId:id(101),sceneTitle:'A real moment',mode:'ORIGINAL_ANIMATION',sourceAssetId:photo.id,sourcePhotoIds:[photo.id],prompt:'Keep the people and framing faithful.',provider:'gemini-omni',model:'gemini-omni-1.1-flash',qualityModel:'gemini-test-quality',settings:studio().settings,estimatedCostUsd:1.25,remainingBudgetUsd:10,expectedOperationCount:2,operations:{video:1,keyframe:0,quality:1},costBreakdown:{videoUsd:1.2,keyframeUsd:0,qualityUsd:0.05},requiresUnknownChargeAcknowledgement:false,warnings:[],...overrides});
const job=(overrides:Partial<VideoGenerationJob>={}):VideoGenerationJob=>({id:id(40),projectId:id(9),storyboardId:board.id,sceneId:id(101),sceneTitle:'A real moment',mode:'ORIGINAL_ANIMATION',version:1,state:'PENDING',provider:'gemini-omni',model:'gemini-omni-1.1-flash',settings:studio().settings,estimatedCostUsd:1.25,submissionUnknown:false,providerOperationPending:false,attempts:0,createdAt:'2026-11-14T10:00:00Z',updatedAt:'2026-11-14T10:00:00Z',...overrides});
const video=(number=1):GeneratedVideoAsset=>({id:id(50+number),jobId:id(40),projectId:id(9),storyboardId:board.id,sceneId:id(101),version:number,url:`/api/video/assets/${id(50+number)}/content`,thumbnailUrl:`/api/video/assets/${id(50+number)}/thumbnail`,frameUrls:[`/api/video/assets/${id(50+number)}/frames/0`],sourceAssetId:photo.id,durationSeconds:8,width:1280,height:720,videoCodec:'h264',audioCodec:'aac',hasAudio:true,bytes:100000,sha256:'private-hash',model:'gemini-omni-1.1-flash',isFictional:false,decision:'pending',quality:{status:'complete',summary:'No obvious distortion is visible in the sampled frames.',flags:['Review clothing continuity.'],score:82,identityAssessment:'advisory_not_identity_verification',requiresHumanReview:true},createdAt:'2026-11-14T10:00:00Z'});
const response=(body:unknown,status=200)=>({ok:status>=200&&status<300,status,json:async()=>body}) as Response;
function setup(initial=studio(),handler?:(path:string,options?:RequestInit)=>Response|Promise<Response>|undefined,dirty=false){
 const fetch=vi.fn(async(path:string,options?:RequestInit)=>handler?.(path,options)??response(path.startsWith('/api/video?')?initial:quote()));
 vi.stubGlobal('fetch',fetch);
 render(<VideoStudio storyboard={board} assets={[photo,secondPhoto]} csrfToken="private-csrf" hasUnsavedChanges={dirty}/>);
 return fetch;
}
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe('private paid scene generation',()=>{
 it('only reads local metadata on mount and leaves unsupported scene types for P5',async()=>{
  const fetch=setup();
  await screen.findByText('Your scene-generation budget');
  expect(fetch.mock.calls).toHaveLength(1);expect(fetch.mock.calls[0][0]).toContain(`/api/video?storyboardId=${board.id}`);expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
  expect(within(screen.getByRole('article',{name:/Video scene 3/})).queryByRole('button',{name:/generation cost/})).not.toBeInTheDocument();
  expect(within(screen.getByRole('article',{name:/Video scene 4/})).queryByRole('button',{name:/generation cost/})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/assemble|render movie/i})).not.toBeInTheDocument();
  expect(screen.getByText('Not reported')).toBeInTheDocument();
 });
 it('shows an exact cost preview and requires an unchecked explicit approval before creating a job',async()=>{
  let created:Record<string,unknown>|undefined;
  const fetch=setup(studio(),(path,options)=>path==='/api/video/jobs'?(created=JSON.parse(String(options?.body)),response(job())):undefined);
  const card=await screen.findByRole('article',{name:/Video scene 1/});
  fireEvent.change(within(card).getByRole('combobox',{name:'Photo to animate for scene 1'}),{target:{value:secondPhoto.id}});
  fireEvent.click(within(card).getByRole('button',{name:'Review generation cost'}));
  const modal=await screen.findByRole('dialog',{name:'Approve paid scene generation'});
  expect(within(modal).getByText('gemini-omni-1.1-flash')).toBeInTheDocument();expect(within(modal).getByText('8s · 720p · 16:9')).toBeInTheDocument();expect(within(modal).getByText('$1.25')).toBeInTheDocument();
  const approve=within(modal).getByRole('button',{name:'Approve cost and generate'});
  expect(approve).toBeDisabled();expect(created).toBeUndefined();
  expect(fetch.mock.calls.find(([path])=>path==='/api/video/quotes')?.[1]).toMatchObject({method:'POST',credentials:'include',headers:{'X-CSRF-Token':'private-csrf'},body:JSON.stringify({storyboardId:board.id,sceneId:id(101),sourceAssetId:secondPhoto.id})});
  fireEvent.click(within(modal).getByRole('checkbox',{name:'Approve generation cost and likeness permission'}));fireEvent.click(approve);
  await waitFor(()=>expect(created).toMatchObject({quoteId:id(30),approved:true,idempotencyKey:expect.any(String)}));
  expect(await screen.findByText('Scene generation is queued. Progress and private results will appear below.')).toBeInTheDocument();
 });
 it('retains the same application idempotency key if the approval response is lost',async()=>{
  const attempts:Record<string,unknown>[]=[];
  setup(studio(),(path,options)=>{if(path==='/api/video/jobs'){attempts.push(JSON.parse(String(options?.body)));if(attempts.length===1)throw new Error('Network interrupted');return response(job());}});
  fireEvent.click(within(await screen.findByRole('article',{name:/Video scene 1/})).getByRole('button',{name:'Review generation cost'}));
  const modal=await screen.findByRole('dialog');fireEvent.click(within(modal).getByRole('checkbox',{name:'Approve generation cost and likeness permission'}));
  fireEvent.click(within(modal).getByRole('button',{name:'Approve cost and generate'}));
  await within(modal).findByText(/Could not reach the studio/);
  expect(attempts).toHaveLength(1);
  fireEvent.click(within(modal).getByRole('button',{name:'Approve cost and generate'}));
  await waitFor(()=>expect(attempts).toHaveLength(2));expect(attempts[0].idempotencyKey).toBe(attempts[1].idempotencyKey);
 });
 it('requires a separate acknowledgement before replacing an unknown billable submission',async()=>{
  const fetch=setup(studio({jobs:[job({state:'FAILED',submissionUnknown:true})]}),path=>path==='/api/video/quotes'?response(quote({requiresUnknownChargeAcknowledgement:true})):undefined);
  fireEvent.click(within(await screen.findByRole('article',{name:/Video scene 1/})).getByRole('button',{name:'Review generation cost'}));
  const modal=await screen.findByRole('dialog');fireEvent.click(within(modal).getByRole('checkbox',{name:'Approve generation cost and likeness permission'}));
  const submit=within(modal).getByRole('button',{name:'Approve cost and generate'});expect(submit).toBeDisabled();
  fireEvent.click(within(modal).getByRole('checkbox',{name:'Acknowledge previous unknown generation charges'}));expect(submit).toBeEnabled();fireEvent.click(submit);
  await waitFor(()=>expect(fetch.mock.calls.find(([path])=>path==='/api/video/jobs')?.[1]?.body).toContain('"acknowledgeUnknownCharge":true'));
 });
 it('blocks quotes for unsaved edits, unreviewed scenes, missing tools and unavailable providers',async()=>{
  setup(studio(),undefined,true);expect(within(await screen.findByRole('article',{name:/Video scene 1/})).getByRole('button',{name:'Review generation cost'})).toBeDisabled();cleanup();
  const scenes=structuredClone(board.scenes);scenes[0].userConfirmed=false;
  setup(studio({scenes}));expect(within(await screen.findByRole('article',{name:/Video scene 1/})).getByRole('button',{name:'Review generation cost'})).toBeDisabled();cleanup();
  setup(studio({tools:{available:false,message:'Install local ffprobe.'}}));expect(await screen.findByText('Install local ffprobe.')).toBeInTheDocument();expect(screen.getAllByRole('button',{name:'Review generation cost'}).every(button=>button.hasAttribute('disabled'))).toBe(true);
 });
 it('blocks approval for expired or unaffordable quotes',async()=>{
  setup(studio(),path=>path==='/api/video/quotes'?response(quote({expiresAt:new Date(Date.now()-1000).toISOString(),remainingBudgetUsd:0.5})):undefined);
  fireEvent.click(within(await screen.findByRole('article',{name:/Video scene 1/})).getByRole('button',{name:'Review generation cost'}));
  const modal=await screen.findByRole('dialog');fireEvent.click(within(modal).getByRole('checkbox',{name:'Approve generation cost and likeness permission'}));
  expect(within(modal).getByRole('button',{name:'Approve cost and generate'})).toBeDisabled();expect(within(modal).getByText(/cost preview has expired/)).toBeInTheDocument();expect(within(modal).getByText(/remaining project budget is insufficient/)).toBeInTheDocument();
 });
 it('cancels pending work and reports when an accepted operation may still incur charges',async()=>{
  let cancelled=false;
  const running=job({state:'GENERATING_VIDEO',providerOperationPending:true});
  setup(studio({jobs:[running]}),path=>path.endsWith('/cancel')?(cancelled=true,response({...running,state:'CANCELLED',message:'Provider operation may still incur charges.'})):undefined);
  fireEvent.click(within(await screen.findByRole('article',{name:/Video scene 1/})).getByRole('button',{name:'Cancel generation'}));
  expect(await screen.findByText('Provider operation may still incur charges.')).toBeInTheDocument();expect(cancelled).toBe(true);
 });
 it('continues a known saved operation without creating another generation approval or job',async()=>{
  const failed=job({state:'FAILED',providerOperationPending:true,submissionUnknown:false});
  const fetch=setup(studio({jobs:[failed]}),path=>path.endsWith('/resume')?response({...failed,state:'GENERATING_VIDEO'}):undefined);
  fireEvent.click(within(await screen.findByRole('article',{name:/Video scene 1/})).getByRole('button',{name:'Continue saved operation'}));
  expect(await screen.findByText('The saved generation operation will continue from its checkpoint. Existing approved quality review may still run.')).toBeInTheDocument();
  expect(fetch.mock.calls.find(([path])=>path===`/api/video/jobs/${failed.id}/resume`)?.[1]).toMatchObject({method:'POST',headers:{'X-CSRF-Token':'private-csrf'}});
  expect(fetch.mock.calls.some(([path])=>path==='/api/video/jobs'||path==='/api/video/quotes')).toBe(false);
  cleanup();setup(studio({jobs:[{...failed,submissionUnknown:true}]}));await screen.findByText('Your scene-generation budget');expect(screen.queryByRole('button',{name:'Continue saved operation'})).not.toBeInTheDocument();
 });
 it('shows private video comparisons, version history, advisory quality and explicit human acceptance',async()=>{
  const latest=video(2),older=video(1);let reviewBody:Record<string,unknown>|undefined;
  const fetch=setup(studio({assets:[older,latest],jobs:[job({state:'COMPLETED',assetId:latest.id})]}),(path,options)=>path.endsWith('/review')?(reviewBody=JSON.parse(String(options?.body)),response({...latest,decision:'approved'})):undefined);
  const card=await screen.findByRole('article',{name:/Video scene 1/});
  const player=within(card).getByLabelText('Generated clip for scene 1');expect(player.tagName).toBe('VIDEO');expect(player).toHaveAttribute('src',latest.url);expect(player).toHaveAttribute('controls');expect(player).not.toHaveAttribute('autoplay');
  expect(within(card).getByRole('img',{name:'Original comparison for scene 1'})).toHaveAttribute('src',photo.url);expect(within(card).getByText(/AI feedback is advisory and does not verify/)).toBeInTheDocument();
  fireEvent.change(within(card).getByRole('combobox',{name:'Video version for scene 1'}),{target:{value:older.id}});expect(player).toHaveAttribute('src',older.url);
  fireEvent.change(within(card).getByRole('textbox',{name:'Clip review notes for scene 1'}),{target:{value:'Faces and movement look consistent to me.'}});
  fireEvent.click(within(card).getByRole('button',{name:'Accept clip'}));
  await waitFor(()=>expect(reviewBody).toEqual({decision:'approved',notes:'Faces and movement look consistent to me.'}));expect(fetch.mock.calls.find(([path])=>path===`/api/video/assets/${older.id}/review`)).toBeTruthy();
 });
 it('supports provider-approved refinement without submitting before a new cost approval',async()=>{
  const previous=video();let input:Record<string,unknown>|undefined;
  const fetch=setup(studio({assets:[previous]}),(path,options)=>path==='/api/video/quotes'?(input=JSON.parse(String(options?.body)),response(quote({refineAssetId:previous.id,refinementPrompt:'Make the camera movement slower.'}))):undefined);
  const card=await screen.findByRole('article',{name:/Video scene 1/});fireEvent.change(within(card).getByRole('textbox',{name:'Refinement instructions for scene 1'}),{target:{value:'Make the camera movement slower.'}});fireEvent.click(within(card).getByRole('button',{name:'Review refinement cost'}));
  await screen.findByRole('dialog');expect(input).toMatchObject({refineAssetId:previous.id,refinementPrompt:'Make the camera movement slower.'});expect(fetch.mock.calls.some(([path])=>path==='/api/video/jobs')).toBe(false);
 });
 it('compares a private fictional keyframe with its clip and sampled frames without identity-verification claims',async()=>{
  const clip={...video(),sceneId:id(102),isFictional:true,keyframeId:id(70)};
  const frame={id:id(70),jobId:id(40),projectId:id(9),storyboardId:board.id,sceneId:id(102),version:1,url:`/api/video/keyframes/${id(70)}/content`,mimeType:'image/jpeg',bytes:100,isFictional:true as const,createdAt:'2026-11-14T10:00:00Z'};
  setup(studio({assets:[clip],keyframes:[frame]}));
  const card=await screen.findByRole('article',{name:/Video scene 2/});
  expect(within(card).getByText('AI-created · Fictional')).toBeInTheDocument();
  expect(within(card).getByRole('img',{name:'Fictional keyframe for scene 2'})).toHaveAttribute('src',frame.url);
  expect(within(card).getByLabelText('Generated clip for scene 2')).toHaveAttribute('src',clip.url);
  expect(within(card).getByRole('img',{name:'Scene 2 sampled frame 1'})).toHaveAttribute('src',clip.frameUrls[0]);
  expect(within(card).getByText(/AI feedback is advisory and does not verify anyone’s identity/)).toBeInTheDocument();
 });
 it('updates the local video budget with CSRF while keeping approval mandatory for generation',async()=>{
  let updated:unknown;
  const fetch=setup(studio(),(path,options)=>path==='/api/video/budget'?(updated=JSON.parse(String(options?.body)),response(studio().budget)):undefined);
  const input=await screen.findByRole('spinbutton',{name:'Project video budget in USD'});
  fireEvent.change(input,{target:{value:'5'}});fireEvent.click(screen.getByRole('button',{name:'Save budget'}));
  expect(await screen.findByText('Project video budget saved. Future generation still requires explicit cost approval.')).toBeInTheDocument();
  expect(updated).toEqual({maximumSpendUsd:5});
  expect(fetch.mock.calls.find(([path])=>path==='/api/video/budget')?.[1]).toMatchObject({method:'PATCH',headers:{'X-CSRF-Token':'private-csrf'}});
  expect(fetch.mock.calls.some(([path])=>path==='/api/video/jobs')).toBe(false);
 });
 it('keeps completed private clips viewable when the configured provider cannot generate their mode',async()=>{
  const state=studio({assets:[video()]});state.capabilities={...state.capabilities,available:false,supportedModes:[],unavailabilityReason:'This provider is unavailable.'};
  setup(state);
  const card=await screen.findByRole('article',{name:/Video scene 1/});
  expect(within(card).getByLabelText('Generated clip for scene 1')).toHaveAttribute('src',video().url);
  expect(within(card).getByText(/Existing private versions remain available for review/)).toBeInTheDocument();
  expect(within(card).getByRole('button',{name:'Review regeneration cost'})).toBeDisabled();
  expect(within(card).queryByText(/Title sequence planning/)).not.toBeInTheDocument();
 });
 it('distinguishes old saved-storyboard clips from current readiness while preserving playback and versions',async()=>{
  const previous={...video(),storyboardId:id(19),decision:'approved' as const};
  setup(studio({assets:[previous]}));
  const card=await screen.findByRole('article',{name:/Video scene 1/});
  expect(within(card).getByText(/This clip belongs to an earlier saved storyboard version/)).toBeInTheDocument();
  expect(within(card).getByLabelText('Generated clip for scene 1')).toHaveAttribute('src',previous.url);
  expect(screen.getByText('0 of 2 required scene clips accepted')).toBeInTheDocument();
 });
});
