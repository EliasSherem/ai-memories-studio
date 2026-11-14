import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, GeneratedVideoAsset, Storyboard, StoryboardScene, VideoGenerationJob, VideoGenerationQuote, VideoQuoteInput, VideoStudioState } from '@memories/shared';
import { ArrowRight, Check, CheckCheck, Clapperboard, Clock3, Film, LoaderCircle, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import { request } from './api';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import './video.css';

type Props={storyboard:Storyboard;assets:Asset[];csrfToken?:string;hasUnsavedChanges?:boolean};
const activeStates=new Set(['PENDING','VALIDATING','GENERATING_KEYFRAME','GENERATING_VIDEO','DOWNLOADING','VALIDATING_OUTPUT','CANCEL_REQUESTED']);
const stateLabels:Record<string,string>={PENDING:'Queued',VALIDATING:'Validating inputs',GENERATING_KEYFRAME:'Creating keyframe',GENERATING_VIDEO:'Generating video',DOWNLOADING:'Saving private video',VALIDATING_OUTPUT:'Checking output',COMPLETED:'Completed',FAILED:'Failed',CANCEL_REQUESTED:'Cancellation requested',CANCELLED:'Cancelled'};
const money=(value:number)=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(value);
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'The video studio could not complete this request. Please try again.';
const supported=(scene:StoryboardScene)=>scene.type==='ORIGINAL_ANIMATION'||scene.type==='NEW_CINEMATIC_SCENE';
const modeLabel=(type:string)=>type==='NEW_CINEMATIC_SCENE'?'AI-created · Fictional':type==='ORIGINAL_ANIMATION'?'Original photograph animation':type==='PHOTO_MONTAGE'?'Photo montage':'Title sequence';
function useApprovalFocus(open:boolean,close:()=>void){
  const ref=useRef<HTMLDivElement>(null),closeRef=useRef(close);closeRef.current=close;
  useEffect(()=>{
    if(!open)return;
    const previous=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    const elements=()=>Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),a[href],textarea:not([disabled]),select:not([disabled]),[tabindex="0"]')??[]);
    elements()[0]?.focus();
    const key=(event:KeyboardEvent)=>{
      if(event.key==='Escape'){event.preventDefault();closeRef.current();return;}
      if(event.key!=='Tab')return;
      const nodes=elements(),first=nodes[0],last=nodes.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    };
    document.addEventListener('keydown',key);
    return()=>{document.body.style.overflow=overflow;document.removeEventListener('keydown',key);previous?.focus();};
  },[open]);
  return ref;
}

export function VideoStudio({storyboard,assets,csrfToken,hasUnsavedChanges=false}:Props){
  const [state,setState]=useState<VideoStudioState>();
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const [error,setError]=useState(''),[notice,setNotice]=useState('');
  const [quote,setQuote]=useState<VideoGenerationQuote>(),[approvalKey,setApprovalKey]=useState('');
  const [maximumSpend,setMaximumSpend]=useState('');
  const mounted=useRef(true);
  const currentStoryboard=useRef(storyboard.id);currentStoryboard.current=storyboard.id;
  const refresh=useCallback(async()=>{
    const result=await request<VideoStudioState>(`/api/video?storyboardId=${encodeURIComponent(storyboard.id)}`);
    if(!result||!Array.isArray(result.jobs)||!Array.isArray(result.assets)||!Array.isArray(result.keyframes)||!result.budget||!result.capabilities||!result.settings||!result.tools||!result.readiness)throw new Error('The video studio is unavailable. Restart the updated API and reload this section.');
    if(mounted.current&&currentStoryboard.current===storyboard.id)setState(result);
    return result;
  },[storyboard.id]);
  useEffect(()=>{
    let cancelled=false;
    mounted.current=true;setState(undefined);setLoading(true);setError('');setQuote(undefined);
    void refresh().catch(e=>{if(!cancelled)setError(errorMessage(e));}).finally(()=>{if(!cancelled)setLoading(false);});
    return()=>{cancelled=true;mounted.current=false;};
  },[refresh]);
  useEffect(()=>{if(state)setMaximumSpend(String(state.budget.maximumSpendUsd));},[state?.budget.maximumSpendUsd]);
  useEffect(()=>{
    if(!state?.jobs.some(job=>activeStates.has(job.state)))return;
    const timer=window.setTimeout(()=>{void refresh().catch(e=>{if(mounted.current)setError(errorMessage(e));});},2000);
    return()=>window.clearTimeout(timer);
  },[state,refresh]);
  async function getQuote(input:VideoQuoteInput){
    setBusy(true);setError('');setNotice('');
    try{
      const result=await request<VideoGenerationQuote>('/api/video/quotes',{method:'POST',body:JSON.stringify(input)},csrfToken);
      setQuote(result);setApprovalKey(crypto.randomUUID());
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function createJob(unknownChargeAcknowledged:boolean){
    if(!quote)return;
    setBusy(true);setError('');
    try{
      // A response lost in transit reuses this exact application key. Never auto-post.
      await request<VideoGenerationJob>('/api/video/jobs',{method:'POST',body:JSON.stringify({quoteId:quote.id,approved:true,idempotencyKey:approvalKey,...(quote.requiresUnknownChargeAcknowledgement?{acknowledgeUnknownCharge:unknownChargeAcknowledged}:{})})},csrfToken);
      setQuote(undefined);setNotice('Scene generation is queued. Progress and private results will appear below.');await refresh();
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function cancel(job:VideoGenerationJob){
    setBusy(true);setError('');
    try{
      const result=await request<VideoGenerationJob>(`/api/video/jobs/${job.id}/cancel`,{method:'POST',body:'{}'},csrfToken);
      setNotice(result.message??'Cancellation requested. An operation already accepted by the provider may still incur charges.');await refresh();
    }catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function resume(job:VideoGenerationJob){
    setBusy(true);setError('');
    try{await request<VideoGenerationJob>(`/api/video/jobs/${job.id}/resume`,{method:'POST',body:'{}'},csrfToken);setNotice('The saved generation operation will continue from its checkpoint. Existing approved quality review may still run.');await refresh();}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function review(asset:GeneratedVideoAsset,decision:'approved'|'rejected',notes:string){
    setBusy(true);setError('');
    try{await request(`/api/video/assets/${asset.id}/review`,{method:'POST',body:JSON.stringify({decision,notes})},csrfToken);setNotice(decision==='approved'?'Clip accepted for future movie assembly.':'Clip rejected. Its private version is retained for comparison.');await refresh();}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  async function saveBudget(){
    const value=Number(maximumSpend);
    if(!Number.isFinite(value)||value<=0){setError('Enter a positive project video budget in USD.');return;}
    setBusy(true);setError('');
    try{await request('/api/video/budget',{method:'PATCH',body:JSON.stringify({maximumSpendUsd:value})},csrfToken);setNotice('Project video budget saved. Future generation still requires explicit cost approval.');await refresh();}
    catch(e){setError(errorMessage(e));}finally{setBusy(false);}
  }
  const jobs=state?.jobs??[];
  const scenes=state?.scenes??storyboard.scenes;
  const byId=useMemo(()=>new Map(assets.map(asset=>[asset.id,asset])),[assets]);
  const available=!!state?.configured&&state.capabilities.available&&state.tools.available;
  const completed=jobs.filter(job=>job.state==='COMPLETED').length,failed=jobs.filter(job=>job.state==='FAILED').length,active=jobs.filter(job=>activeStates.has(job.state)).length;
  return <section id="video-generation" className="video-studio" aria-labelledby="video-studio-title"><div className="video-studio-heading"><div><span className="step-label">PHASE 04 / SCENE CLIPS</span><h3 id="video-studio-title">Bring a scene to life.</h3><p>Create and review individual clips from your saved storyboard. Every paid generation starts with a cost preview and your approval.</p></div><span className="video-phase-icon"><Clapperboard size={24}/></span></div>
    {loading&&!state?<p role="status" className="director-loading"><LoaderCircle size={18} className="animate-spin"/>Opening the video studio…</p>:!state?<div className="video-gate"><p>{error||'The video studio is unavailable.'}</p><Button variant="outline" size="sm" onClick={()=>{setLoading(true);void refresh().catch(e=>setError(errorMessage(e))).finally(()=>setLoading(false));}}>Reload video studio</Button></div>:<>
      {error&&!quote&&<div role="alert" className="video-error">{error}</div>}{notice&&<div role="status" className="video-notice">{notice}</div>}
      {!state.configured&&<div className="video-gate"><p>Video generation needs the server Gemini configuration. Existing photos, storyboard, and completed clips remain private and available.</p></div>}
      {!state.capabilities.available&&<div className="video-gate"><p>{state.capabilities.unavailabilityReason??'The configured video provider is unavailable. Check the server model configuration.'}</p></div>}
      {!state.tools.available&&<div className="video-gate"><p>{state.tools.message??'Video validation tools are unavailable. Install ffmpeg and ffprobe before generating clips.'}</p></div>}
      {state.capabilities.accountVerified===false&&<p className="video-quote-disclosure">Access to {state.capabilities.model} has not been verified for this API account. The provider can still reject a request; account availability is separate from documented model capabilities.</p>}
      {hasUnsavedChanges&&<div className="video-gate"><p>Save your storyboard edits before reviewing generation costs. Clips are linked to a saved storyboard version.</p></div>}
      <dl className="video-stats" aria-label="Video generation progress"><div><dt>Submitted jobs</dt><dd>{jobs.length}</dd></div><div><dt>Completed</dt><dd>{completed}</dd></div><div><dt>Failed</dt><dd>{failed}</dd></div><div><dt>In progress</dt><dd>{active}</dd></div></dl>
      <div className="video-budget"><div><h4>Your scene-generation budget</h4><p>Estimated costs and reservations are separate from confirmed provider charges.</p><div className="video-budget-values"><span>Estimated used<strong>{money(state.budget.estimatedSpendUsd)}</strong></span><span>Reserved / uncertain<strong>{money(state.budget.reservedUsd)}</strong></span><span>Remaining<strong>{money(state.budget.remainingUsd)}</strong></span><span>Observed charges<strong>{state.budget.observedCostUsd===null?'Not reported':money(state.budget.observedCostUsd)}</strong></span></div></div><div className="video-budget-editor"><label>Project video budget (USD)<input aria-label="Project video budget in USD" type="number" min="0.01" max="10000" step="0.01" value={maximumSpend} onChange={event=>setMaximumSpend(event.target.value)}/></label><Button variant="outline" size="sm" disabled={busy||Number(maximumSpend)===state.budget.maximumSpendUsd} onClick={()=>void saveBudget()}>Save budget</Button></div></div>
      <div className="video-scene-list">{scenes.map(scene=><VideoSceneCard key={scene.id} scene={scene} storyboardId={storyboard.id} state={state} sources={byId} busy={busy} disabled={!available||hasUnsavedChanges} onQuote={input=>void getQuote(input)} onCancel={job=>void cancel(job)} onResume={job=>void resume(job)} onReview={(asset,decision,notes)=>void review(asset,decision,notes)}/>)}</div>
      <div className="video-p5"><CheckCheck size={21}/><div><strong>{state.readiness.approvedScenes} of {state.readiness.requiredScenes} required scene clips accepted</strong><p>{state.readiness.readyForP5?'The required scene clips are ready for P5 assembly.':'Generate and review the remaining supported scene clips to prepare for P5.'}</p><p>Controlled test A: {state.readiness.testAReviewed?'reviewed':'original animation still needs review'} · Test B: {state.readiness.testBReviewed?'reviewed':'fictional scene still needs review'}. Titles, photo montages, and final movie assembly belong to P5.</p></div></div>
    </>}
    {quote&&<GenerationApproval quote={quote} busy={busy} error={error} onClose={()=>{if(!busy)setQuote(undefined);}} onApprove={ack=>void createJob(ack)}/>}</section>;
}

function VideoSceneCard({scene,storyboardId,state,sources,busy,disabled,onQuote,onCancel,onResume,onReview}:{scene:StoryboardScene;storyboardId:string;state:VideoStudioState;sources:Map<string,Asset>;busy:boolean;disabled:boolean;onQuote:(value:VideoQuoteInput)=>void;onCancel:(job:VideoGenerationJob)=>void;onResume:(job:VideoGenerationJob)=>void;onReview:(asset:GeneratedVideoAsset,decision:'approved'|'rejected',notes:string)=>void}){
  const sceneJobs=state.jobs.filter(job=>job.sceneId===scene.id).sort((first,second)=>second.createdAt.localeCompare(first.createdAt));
  const current=sceneJobs.find(job=>activeStates.has(job.state))??sceneJobs[0];
  const versions=state.assets.filter(asset=>asset.sceneId===scene.id).sort((first,second)=>second.version-first.version);
  const [sourceId,setSourceId]=useState(scene.sourcePhotoIds[0]??'');
  const [versionId,setVersionId]=useState(''),[notes,setNotes]=useState(''),[refinement,setRefinement]=useState('');
  const selected=versions.find(asset=>asset.id===versionId)??versions[0];
  useEffect(()=>{setNotes(selected?.reviewNotes??'');},[selected?.id,selected?.reviewNotes]);
  const keyframe=state.keyframes.find(frame=>frame.id===(selected?.keyframeId??current?.keyframeId));
  const source=sources.get(selected?.sourceAssetId??sourceId);
  const sceneSupported=supported(scene)&&state.capabilities.supportedModes.includes(scene.type as 'ORIGINAL_ANIMATION'|'NEW_CINEMATIC_SCENE');
  const pending=!!current&&activeStates.has(current.state),confirmed=!scene.requiresUserConfirmation||scene.userConfirmed;
  const canGenerate=sceneSupported&&!disabled&&!busy&&!pending&&confirmed&&(scene.type!=='ORIGINAL_ANIMATION'||!!sourceId);
  const estimate=state.settings.durationSeconds*state.capabilities.pricePerSecondUsd;
  function quote(refine=false){onQuote({storyboardId,sceneId:scene.id,...(scene.type==='ORIGINAL_ANIMATION'?{sourceAssetId:sourceId}:{}),...(refine&&selected?{refineAssetId:selected.id,refinementPrompt:refinement.trim()}:{})});}
  return <article className="video-scene-card" aria-label={`Video scene ${scene.sequenceNumber}: ${scene.title}`}><div className="video-scene-top"><div className="video-scene-title"><span className="video-scene-number">{String(scene.sequenceNumber).padStart(2,'0')}</span><div><span className={`video-scene-kind${scene.isFictional?' is-fictional':''}`}>{modeLabel(scene.type)}</span><h4>{scene.title}</h4></div></div>{current&&<span className={`video-job-status${pending?' is-active':current.state==='FAILED'?' is-failed':current.state==='COMPLETED'?' is-complete':''}`} role="status">{pending&&<LoaderCircle size={11} className="animate-spin"/>}{stateLabels[current.state]??current.state}</span>}</div>
    {!supported(scene)?<div className="video-deferred">{scene.type==='PHOTO_MONTAGE'?'Photo montage planning is saved for P5. This phase generates one original photograph or one fictional cinematic scene per clip.':'Title sequence planning is saved for P5. There is no video-generation request for this scene type.'}</div>:<div className="video-scene-body"><div className="video-scene-copy"><p>{scene.description}</p><span className="video-input-label">{scene.type==='ORIGINAL_ANIMATION'?'Original source photographs':'Storyboard source photographs'}</span><div className="video-source-images">{scene.sourcePhotoIds.slice(0,6).map(id=>{const asset=sources.get(id);return asset?<img key={id} src={asset.url} alt={`Scene ${scene.sequenceNumber} source ${asset.filename}`} loading="lazy"/>:null;})}{scene.sourcePhotoIds.length>6&&<span>+{scene.sourcePhotoIds.length-6} sources</span>}</div>{scene.type==='ORIGINAL_ANIMATION'&&<label className="video-source-select">Photo to animate<select aria-label={`Photo to animate for scene ${scene.sequenceNumber}`} value={sourceId} disabled={pending||busy} onChange={event=>setSourceId(event.target.value)}>{scene.sourcePhotoIds.map(id=><option key={id} value={id}>{sources.get(id)?.filename??'Source unavailable'}</option>)}</select></label>}
      <div className="video-setting-list"><span>{state.capabilities.model}</span><span>{state.settings.durationSeconds}s clip · {state.settings.resolution}</span><span>{state.settings.aspectRatio} · audio {state.settings.generateAudio?'on':'off'}</span><span>Video estimate {money(estimate)} · full estimate before approval</span></div><details className="video-prompt-details"><summary>Review scene prompt</summary><p>{scene.motionPrompt}</p><p>{scene.generationInstructions}</p></details>
      {!sceneSupported&&<p className="video-scene-guidance">The configured provider does not support this scene’s generation mode. Existing private versions remain available for review.</p>}{!confirmed&&<p className="video-scene-guidance">Review and confirm this scene in the storyboard above, then save a version before generating its clip.</p>}{current?.message&&<p className="video-scene-guidance">{current.message}</p>}{current?.errorMessage&&<p className="video-error">{current.errorMessage}</p>}{current?.submissionUnknown&&<p className="video-unknown-warning">The previous submission’s status is unknown and may still incur charges. No further paid request is submitted automatically.</p>}
      <div className="video-scene-actions"><Button variant="clay" size="sm" disabled={!canGenerate} onClick={()=>quote()}><Sparkles size={13}/>{versions.length?'Review regeneration cost':'Review generation cost'}</Button>{current?.state==='FAILED'&&current.providerOperationPending&&!current.submissionUnknown&&<Button variant="outline" size="sm" disabled={busy||disabled} onClick={()=>onResume(current)}>Continue saved operation</Button>}{pending&&current&&<Button variant="outline" size="sm" disabled={busy||current.state==='CANCEL_REQUESTED'} onClick={()=>onCancel(current)}><Square size={11}/>{current.state==='CANCEL_REQUESTED'?'Cancellation requested':'Cancel generation'}</Button>}</div>
      {selected&&state.capabilities.supportsRefinement&&<div className="video-refinement"><label htmlFor={`refinement-${scene.id}`}>Refine this version (optional)<textarea id={`refinement-${scene.id}`} aria-label={`Refinement instructions for scene ${scene.sequenceNumber}`} maxLength={2000} value={refinement} onChange={event=>setRefinement(event.target.value)} placeholder="Describe the changes for this clip…"/></label><Button variant="outline" size="sm" disabled={!canGenerate||!refinement.trim()} onClick={()=>quote(true)}>Review refinement cost <ArrowRight size={12}/></Button></div>}
    </div><div>{versions.length>0&&<label className="video-version-select">Private versions<select aria-label={`Video version for scene ${scene.sequenceNumber}`} value={selected?.id??''} onChange={event=>setVersionId(event.target.value)}>{versions.map(asset=><option key={asset.id} value={asset.id}>Version {asset.version} · {asset.decision}</option>)}</select></label>}{selected?<>{selected.storyboardId!==storyboardId&&<p className="video-scene-guidance">This clip belongs to an earlier saved storyboard version. Generate and review a clip for the current version before P5.</p>}<div className="video-comparison"><figure><figcaption>{scene.type==='NEW_CINEMATIC_SCENE'?'AI-created keyframe':'Original photograph'}</figcaption>{scene.type==='NEW_CINEMATIC_SCENE'?keyframe?<img src={keyframe.url} alt={`Fictional keyframe for scene ${scene.sequenceNumber}`}/>:<div className="video-preview-empty"><p>Keyframe unavailable</p></div>:source?<img src={source.url} alt={`Original comparison for scene ${scene.sequenceNumber}`}/>:<div className="video-preview-empty"><p>Original source unavailable</p></div>}</figure><figure><figcaption>{selected.isFictional?'Generated fictional clip':'Animated original clip'}</figcaption><video controls playsInline preload="metadata" src={selected.url} poster={selected.thumbnailUrl} aria-label={`Generated clip for scene ${scene.sequenceNumber}`}/></figure></div><div className="video-output-meta"><span>{selected.durationSeconds.toFixed(1)}s · {selected.width} × {selected.height}</span><span>{selected.videoCodec}{selected.hasAudio?` · ${selected.audioCodec??'audio present'}`:' · no audio'}</span><span>Version {selected.version} · {selected.model}</span></div><div className="video-sampled-frames" aria-label={`Representative frames for scene ${scene.sequenceNumber}`}>{selected.frameUrls.slice(0,3).map((url,index)=><img key={url} src={url} alt={`Scene ${scene.sequenceNumber} sampled frame ${index+1}`} loading="lazy"/>)}</div><span className={`video-acceptance${selected.decision==='rejected'?' is-rejected':''}`}>{selected.decision==='approved'?<Check size={11}/>:<Clock3 size={11}/>} {selected.decision==='approved'?'Accepted clip':selected.decision==='rejected'?'Rejected clip':'Awaiting your review'}</span><div className="video-quality"><h5>Advisory visual review</h5><p>{selected.quality.summary}</p>{selected.quality.flags.length>0&&<ul>{selected.quality.flags.map((flag,index)=><li key={index}>{flag}</li>)}</ul>}{selected.quality.score!==null&&<p>Advisory quality score: {selected.quality.score}/100</p>}<p className="video-quality-advisory">AI feedback is advisory and does not verify anyone’s identity. Compare faces, clothing, anatomy, and movement yourself.</p><textarea className="video-review-notes" aria-label={`Clip review notes for scene ${scene.sequenceNumber}`} maxLength={2000} value={notes} onChange={event=>setNotes(event.target.value)} placeholder="Your review notes (optional)…"/><div className="video-scene-actions"><Button variant="outline" size="sm" disabled={busy||selected.decision==='approved'} onClick={()=>onReview(selected,'approved',notes)}><Check size={12}/>Accept clip</Button><Button variant="ghost" size="sm" disabled={busy||selected.decision==='rejected'} onClick={()=>onReview(selected,'rejected',notes)}>Reject clip</Button></div></div></>:<div className="video-preview-empty">{pending?<LoaderCircle size={25} className="animate-spin"/>:<Film size={27} strokeWidth={1.2}/>}<h5>{pending?'Your scene is taking shape.':'A scene clip will appear here.'}</h5><p>{pending?'The server checkpoints progress and downloads completed output into your private project.':'Review the cost and approve a generation to create a private clip. No paid requests run when you open this section.'}</p>{keyframe&&<img src={keyframe.url} alt={`Prepared fictional keyframe for scene ${scene.sequenceNumber}`} style={{width:'100%',borderRadius:7}}/>}</div>}</div></div>}
  </article>;
}

function GenerationApproval({quote,busy,error,onClose,onApprove}:{quote:VideoGenerationQuote;busy:boolean;error:string;onClose:()=>void;onApprove:(unknownAcknowledged:boolean)=>void}){
  const [approved,setApproved]=useState(false),[unknownAcknowledged,setUnknownAcknowledged]=useState(false);
  const [now,setNow]=useState(Date.now());
  const focus=useApprovalFocus(true,onClose);
  useEffect(()=>{const timer=window.setInterval(()=>setNow(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  const expired=now>=Date.parse(quote.expiresAt),insufficient=quote.estimatedCostUsd>quote.remainingBudgetUsd;
  const operations=[quote.operations.video?`${quote.operations.video} video`:null,quote.operations.keyframe?`${quote.operations.keyframe} keyframe`:null,quote.operations.quality?`${quote.operations.quality} quality review`:null].filter(Boolean).join(' + ');
  return <div ref={focus} role="dialog" aria-modal="true" aria-label="Approve paid scene generation" className="director-modal-backdrop"><section className="director-modal video-approval-modal"><div className="director-modal-heading"><div><span className="step-label">PAID GENERATION · YOUR APPROVAL</span><h3>{quote.sceneTitle}</h3><p>{modeLabel(quote.mode)}</p></div><Button variant="ghost" size="icon" aria-label="Close generation approval" disabled={busy} onClick={onClose}><X size={18}/></Button></div><dl className="video-quote-settings"><div><dt>Video model</dt><dd>{quote.model}</dd></div><div><dt>Clip settings</dt><dd>{quote.settings.durationSeconds}s · {quote.settings.resolution} · {quote.settings.aspectRatio}</dd></div><div><dt>Audio</dt><dd>{quote.settings.generateAudio?'Enabled':'Disabled'}</dd></div><div><dt>Expected operations</dt><dd>{quote.expectedOperationCount} · {operations}</dd></div>{quote.keyframeModel&&<div><dt>Keyframe model</dt><dd>{quote.keyframeModel}</dd></div>}<div><dt>Quality review model</dt><dd>{quote.qualityModel}</dd></div><div><dt>Project budget remaining</dt><dd>{money(quote.remainingBudgetUsd)}</dd></div><div><dt>Cost breakdown</dt><dd>Video {money(quote.costBreakdown.videoUsd)} · keyframe {money(quote.costBreakdown.keyframeUsd)} · review {money(quote.costBreakdown.qualityUsd)}</dd></div></dl><div className="video-quote-price"><span>Estimated maximum for this approved job</span><strong>{money(quote.estimatedCostUsd)}</strong></div><p className="video-quote-disclosure">This sends the selected private photo or consented protagonist references to the configured Google provider. Estimates are not confirmed charges. An operation already accepted by the provider may still incur charges if you cancel.</p>{quote.warnings.map((warning,index)=><p key={index} className="video-scene-guidance">{warning}</p>)}{quote.refinementPrompt&&<details className="video-prompt-details"><summary>Refinement instructions</summary><p>{quote.refinementPrompt}</p></details>}<details className="video-prompt-details"><summary>Review the generation prompt</summary><p>{quote.prompt}</p></details>{quote.requiresUnknownChargeAcknowledgement&&<div className="video-unknown-warning"><p>A previous submission has an unknown outcome and may still be billable. This approval starts an additional request.</p><label className="video-approval-check"><Checkbox aria-label="Acknowledge previous unknown generation charges" checked={unknownAcknowledged} onCheckedChange={checked=>setUnknownAcknowledged(checked===true)}/><span>I understand that the previous unknown submission and this new request may both incur charges.</span></label></div>}<label className="video-approval-check"><Checkbox aria-label="Approve generation cost and likeness permission" checked={approved} onCheckedChange={checked=>setApproved(checked===true)}/><span>I approve this estimated spend and confirm permission to use the people visible in the selected sources.</span></label>{expired&&<p role="alert" className="video-error">This cost preview has expired. Close it and request a fresh quote before approving.</p>}{insufficient&&<p role="alert" className="video-error">The remaining project budget is insufficient for this job.</p>}{error&&<p role="alert" className="video-error">{error}</p>}<div className="director-modal-footer"><p>No generation has been submitted by opening this preview.</p><Button variant="clay" disabled={busy||!approved||expired||insufficient||quote.requiresUnknownChargeAcknowledgement&&!unknownAcknowledged} onClick={()=>onApprove(unknownAcknowledged)}>{busy?<LoaderCircle size={15} className="animate-spin"/>:<ShieldCheck size={15}/>}Approve cost and generate</Button></div></section></div>;
}
