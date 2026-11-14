import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, MovieRenderAsset, MovieRenderJob, MovieSettings, MovieStudioState, MovieSoundtrack, MovieTimeline, MovieTimelineSegment, Storyboard } from '@memories/shared';
import { Check, Download, Film, Image, Layers3, LoaderCircle, Music2, Play, RotateCcw, ShieldCheck, Square, Trash2, Upload } from 'lucide-react';
import { request } from './api';
import { Button } from './components/ui/button';
import {MIN_MOVIE_DURATION_SECONDS,MAX_MOVIE_DURATION_SECONDS,validMovieDuration,movieDurationGuidance} from './movie-duration';
import './movie.css';

type Props = { storyboard: Storyboard; assets: Asset[]; csrfToken?: string; hasUnsavedChanges?: boolean };
const activeStates = new Set(['PENDING', 'VALIDATING', 'PREPARING_MEDIA', 'COMPILING_TIMELINE', 'RENDERING', 'VALIDATING_OUTPUT']);
const stateLabels: Record<string, string> = { PENDING: 'Queued', VALIDATING: 'Checking sources', PREPARING_MEDIA: 'Preparing media', COMPILING_TIMELINE: 'Compiling timeline', RENDERING: 'Rendering movie', VALIDATING_OUTPUT: 'Checking final MP4', COMPLETED: 'Completed', FAILED: 'Failed', CANCELLED: 'Cancelled' };
const issueMessage = (error: unknown) => error instanceof Error ? error.message : 'The movie studio could not complete this request. Please try again.';
const seconds = (value: number) => `${Number(value.toFixed(2))}s`;
const duration = (value: number) => `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
const bytes = (value: number) => `${(value / 1024 ** 2).toFixed(1)} MB`;
const PAGE_SIZE = 30;

export function MovieStudio({ storyboard, assets, csrfToken, hasUnsavedChanges = false }: Props) {
  const [state, setState] = useState<MovieStudioState>();
  const [settings, setSettings] = useState<MovieSettings>();
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false);
  const [error, setError] = useState(''), [pollError, setPollError] = useState(''), [notice, setNotice] = useState('');
  const [trackFile, setTrackFile] = useState<File>(), [licensed, setLicensed] = useState(false), [instrumental, setInstrumental] = useState(true);
  const [selectedAssetId, setSelectedAssetId] = useState<string>(), [page, setPage] = useState(0);
  const trackInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true), currentStoryboard = useRef(storyboard.id), dirtyRef = useRef(false), createKey = useRef<string>();
  currentStoryboard.current = storyboard.id;
  const dirty = !!settings && !!state && JSON.stringify(settings) !== JSON.stringify(state.settings);
  dirtyRef.current = dirty;
  const refresh = useCallback(async (options:{preserveDraft?:boolean;addedTrack?:MovieSoundtrack;removedTrackId?:string}={}) => {
    const result = await request<MovieStudioState>(`/api/movie?storyboardId=${encodeURIComponent(storyboard.id)}`);
    if (!result?.settings || !result.timeline || !result.readiness || !result.tools || !Array.isArray(result.jobs) || !Array.isArray(result.assets) || !Array.isArray(result.soundtracks)) throw new Error('The movie studio is unavailable. Restart the updated API and reload this section.');
    if (mounted.current && currentStoryboard.current === storyboard.id) {
      setState({...result,soundtracks:options.addedTrack?[options.addedTrack,...result.soundtracks.filter(track=>track.id!==options.addedTrack!.id)]:options.removedTrackId?result.soundtracks.filter(track=>track.id!==options.removedTrackId):result.soundtracks});
      setSettings(previous => (options.preserveDraft||dirtyRef.current) && previous ? previous : result.settings);
    }
    return result;
  }, [storyboard.id]);
  useEffect(() => {
    let cancelled = false;
    mounted.current = true; dirtyRef.current = false; createKey.current = undefined;
    setState(undefined); setSettings(undefined); setSelectedAssetId(undefined); setLoading(true); setError(''); setPollError(''); setNotice(''); setPage(0);
    void refresh().catch(error => { if (!cancelled) setError(issueMessage(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; mounted.current = false; };
  }, [refresh]);
  useEffect(()=>{const changed=()=>{createKey.current=undefined;void refresh({preserveDraft:true}).then(()=>{if(mounted.current)setNotice('Saved moments and storytelling choices are updated in the compiled timeline. Existing exports are unchanged; create a new local movie to include the changes.');}).catch(error=>{if(mounted.current)setPollError(`The moment edits are saved, but the movie timeline could not refresh: ${issueMessage(error)}`);});};window.addEventListener('cinematic-updated',changed);return()=>window.removeEventListener('cinematic-updated',changed);},[refresh]);
  const rendering = !!state?.jobs.some(job => activeStates.has(job.state));
  useEffect(() => {
    if (!rendering) return;
    let stopped = false, timer: number;
    const poll = async () => {
      try { await refresh(); if (!stopped) setPollError(''); }
      catch (error) { if (!stopped && mounted.current) setPollError(issueMessage(error)); }
      finally { if (!stopped) timer = window.setTimeout(() => void poll(), 1500); }
    };
    timer = window.setTimeout(() => void poll(), 1500);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [rendering, refresh]);
  useEffect(() => { setPage(previous => Math.min(previous, Math.max(0, Math.ceil((state?.timeline.segments.length ?? 0) / PAGE_SIZE) - 1))); }, [state?.timeline.segments.length]);

  async function saveSettings() {
    if (!settings) return;
    if(!validMovieDuration(settings.targetDurationSeconds)){setError(movieDurationGuidance);return;}
    setBusy(true); setError(''); setNotice('');
    try {
      await request('/api/movie/settings', { method: 'PATCH', body: JSON.stringify({ settings }) }, csrfToken);
      dirtyRef.current = false; await refresh(); setNotice('Movie settings saved. The timeline and readiness checks are updated.');
    } catch (error) { setError(issueMessage(error)); } finally { setBusy(false); }
  }
  async function createMovie() {
    if (!state?.readiness.ready || dirty || hasUnsavedChanges) return;
    setBusy(true); setError(''); setNotice('');
    createKey.current ??= crypto.randomUUID();
    try {
      const job = await request<MovieRenderJob>('/api/movie/jobs', { method: 'POST', body: JSON.stringify({ storyboardId: storyboard.id, idempotencyKey: createKey.current }) }, csrfToken);
      setState(previous => previous ? { ...previous, jobs: [job, ...previous.jobs.filter(item => item.id !== job.id)] } : previous);
      createKey.current = undefined;
      setNotice('Movie rendering is queued. You can leave this page while the local server continues.'); await refresh();
    } catch (error) { setError(issueMessage(error)); } finally { setBusy(false); }
  }
  async function changeJob(job: MovieRenderJob, action: 'cancel' | 'retry') {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<MovieRenderJob>(`/api/movie/jobs/${job.id}/${action}`, { method: 'POST', body: '{}' }, csrfToken);
      setState(previous => previous ? { ...previous, jobs: [result, ...previous.jobs.filter(item => item.id !== result.id)] } : previous);
      setNotice(action === 'cancel' ? result.message ?? 'Cancellation requested. The local renderer is stopping.' : 'The render will retry from safe local checkpoints. Source clips are preserved.'); await refresh();
    } catch (error) { setError(issueMessage(error)); } finally { setBusy(false); }
  }
  function clearPendingTrack(){setTrackFile(undefined);setLicensed(false);if(trackInput.current)trackInput.current.value='';}
  async function uploadTrack() {
    if (!trackFile || !licensed || uploading) return;
    const extension = trackFile.name.split('.').at(-1)?.toLowerCase();
    const mimeType = extension === 'mp3' ? 'audio/mpeg' : extension === 'wav' ? 'audio/wav' : extension === 'm4a' ? 'audio/mp4' : undefined;
    if (!mimeType) { setError('Choose a licensed MP3, WAV, or M4A soundtrack.'); return; }
    setUploading(true); setError(''); setNotice('');
    try {
      const track=await request<MovieSoundtrack>('/api/movie/soundtracks', { method: 'POST', body: trackFile, headers: { 'Content-Type': mimeType, 'X-Upload-Name': encodeURIComponent(trackFile.name), 'X-License-Confirmed': 'true', 'X-Instrumental': String(instrumental) } }, csrfToken);
      if(!track?.id||!track.name)throw new Error('The server did not confirm a saved soundtrack. Your selected file is retained; reload the private library before retrying.');
      if(!mounted.current||currentStoryboard.current!==storyboard.id)return;
      dirtyRef.current=true;
      setState(previous=>previous?{...previous,soundtracks:[track,...previous.soundtracks.filter(item=>item.id!==track.id)]}:previous);
      setSettings(previous=>previous?{...previous,soundtrackId:track.id}:previous);
      clearPendingTrack();
      setNotice('Licensed soundtrack saved privately and selected in your draft. Your other movie settings are unchanged; save them when ready.');
      window.dispatchEvent(new CustomEvent('soundtracks-updated',{detail:{action:'added',track,source:'movie-studio'}}));
      await refresh({preserveDraft:true,addedTrack:track}).catch(error=>setPollError(`The soundtrack is saved and selected. Library refresh failed: ${issueMessage(error)}`));
    } catch (error) { setError(issueMessage(error)); } finally { setUploading(false); }
  }
  async function removeTrack(id: string) {
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/api/movie/soundtracks/${id}`, { method: 'DELETE' }, csrfToken);
      if(!mounted.current||currentStoryboard.current!==storyboard.id)return;
      dirtyRef.current=true;
      setState(previous=>previous?{...previous,soundtracks:previous.soundtracks.filter(track=>track.id!==id)}:previous);
      setSettings(previous=>previous?.soundtrackId===id?{...previous,soundtrackId:undefined}:previous);
      setNotice('Soundtrack removed from this private library. Your other draft settings and existing rendered movies are preserved.');
      window.dispatchEvent(new CustomEvent('soundtracks-updated',{detail:{action:'removed',id,source:'movie-studio'}}));
      await refresh({preserveDraft:true,removedTrackId:id}).catch(error=>setPollError(`The soundtrack was removed. Library refresh failed: ${issueMessage(error)}`));
    } catch (error) { setError(issueMessage(error)); } finally { setBusy(false); }
  }

  const sources = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets]);
  const scenes = useMemo(() => new Map(storyboard.scenes.map(scene => [scene.id, scene])), [storyboard.scenes]);
  const jobs = state?.jobs ?? [], active = jobs.find(job => activeStates.has(job.state));
  const currentAsset = state?.assets.find(asset => asset.id === selectedAssetId) ?? state?.assets[0];
  const validDuration=!!settings&&validMovieDuration(settings.targetDurationSeconds);
  const canCreate = validDuration&&!!state?.tools.available && !!state.readiness.ready && !hasUnsavedChanges && !dirty && !active && !busy && !uploading;
  const edit = <K extends keyof MovieSettings>(key: K, value: MovieSettings[K]) => setSettings(previous => previous ? { ...previous, [key]: value } : previous);
  const editTitle = <K extends keyof MovieSettings['titles']>(key: K, value: MovieSettings['titles'][K]) => setSettings(previous => previous ? { ...previous, titles: { ...previous.titles, [key]: value } } : previous);

  return <section id="movie-studio" className="movie-studio" aria-labelledby="movie-studio-title">
    <div className="movie-heading"><div><span className="step-label">PHASE 05 / YOUR MOVIE</span><h3 id="movie-studio-title">A story, ready to keep.</h3><p>Turn your approved clips and photographs into a complete movie. Rendering happens on this device and makes no paid AI requests.</p></div><span className="movie-phase-icon"><Film size={25} strokeWidth={1.4}/></span></div>
    {loading && !state ? <p role="status" className="director-loading"><LoaderCircle size={18} className="animate-spin"/>Opening the movie studio…</p> : !state || !settings ? <div className="movie-gate"><p>{error || 'The movie studio is unavailable.'}</p><Button variant="outline" size="sm" onClick={() => { setLoading(true); void refresh().catch(error => setError(issueMessage(error))).finally(() => setLoading(false)); }}>Reload movie studio</Button></div> : <>
      {(error || pollError) && <div role="alert" className="movie-error">{error || pollError}</div>}{notice && <div role="status" className="movie-notice">{notice}</div>}
      {hasUnsavedChanges && <div className="movie-gate">Save your storyboard edits before creating a movie. Each render uses an immutable saved version.</div>}
      {!state.tools.available && <div className="movie-gate">{state.tools.message || 'FFmpeg and ffprobe are required before rendering can start.'}</div>}
      <div className="movie-overview"><div><span>SAVED STORYBOARD</span><strong>{storyboard.title}</strong><p>Version {storyboard.version} · {storyboard.scenes.length} scenes</p></div><div><span>CALCULATED MOVIE</span><strong>{duration(state.timeline.durationSeconds)}</strong><p>{seconds(state.timeline.durationSeconds)} after {seconds(state.timeline.transitionOverlapSeconds)} of transition overlap</p></div><div><span>FINAL FORMAT</span><strong>{settings.resolution} · {settings.aspectRatio}</strong><p>30 FPS · H.264 · AAC · MP4</p></div></div>

      <CompiledCompositionSummary timeline={state.timeline} draftChanged={dirty}/>
      <div className="movie-editor-grid"><div className="movie-settings"><h4>Make it yours.</h4><p className="movie-muted">Blank opening and closing text keeps existing storyboard title cards. Optional names and dates are omitted when blank.</p><fieldset disabled={busy || uploading || !!active}>
        <div className="movie-field-grid"><label>Movie duration (seconds)<input aria-label="Movie duration in seconds" type="number" min={MIN_MOVIE_DURATION_SECONDS} max={MAX_MOVIE_DURATION_SECONDS} step="1" value={settings.targetDurationSeconds} onChange={event => edit('targetDurationSeconds', Number(event.target.value))}/></label><label>Output resolution<select aria-label="Movie output resolution" value={settings.resolution} onChange={event => edit('resolution', event.target.value as MovieSettings['resolution'])}><option value="1080p">1080p · Full HD</option><option value="720p">720p · HD</option></select></label><label>Aspect ratio<select aria-label="Movie aspect ratio" value={settings.aspectRatio} onChange={event => edit('aspectRatio', event.target.value as MovieSettings['aspectRatio'])}><option value="16:9">Landscape · 16:9</option><option value="9:16">Portrait · 9:16</option></select></label><label>Transitions<select aria-label="Movie transition style" value={settings.transitionStyle} onChange={event => edit('transitionStyle', event.target.value as MovieSettings['transitionStyle'])}><option value="restrained">Restrained cinematic mix</option><option value="crossfade">Crossfade</option><option value="fadeblack">Fade to black</option><option value="cut">Clean cuts</option><option value="fadewhite">Dip to white</option></select></label><label>Transition duration<select aria-label="Movie transition duration" value={settings.transitionDurationSeconds} onChange={event => edit('transitionDurationSeconds', Number(event.target.value))}><option value="0.5">0.5 seconds</option><option value="0.75">0.75 seconds</option><option value="1">1 second</option></select></label><label>Typography<select aria-label="Movie title typography" value={settings.titles.font} onChange={event => editTitle('font', event.target.value as MovieSettings['titles']['font'])}><option value="serif">Serif</option><option value="sans">Sans-serif</option></select></label></div>
        <label className="movie-checkbox"><input aria-label="Mix saved moments and collages into this movie" type="checkbox" checked={settings.storytellingEnabled!==false} onChange={event=>edit('storytellingEnabled',event.target.checked)}/>Mix saved moments and collages into this movie</label><p className="movie-muted">Uses the saved group order, collage layouts, and captions in the local render. Approved AI clips keep their existing source images; this does not generate new motion.</p><label>Opening title override<input aria-label="Opening movie title" maxLength={160} value={settings.titles.openingTitle} onChange={event => editTitle('openingTitle', event.target.value)}/></label>
        <div className="movie-field-grid"><label>Protagonist names (optional)<input aria-label="Movie protagonist names" maxLength={200} value={settings.titles.names} placeholder="Your chosen display names" onChange={event => editTitle('names', event.target.value)}/></label><label>Dates (optional)<input aria-label="Movie dates" maxLength={120} value={settings.titles.dates} placeholder="Only dates you provide" onChange={event => editTitle('dates', event.target.value)}/></label></div>
        <label>Closing credits override<textarea aria-label="Movie closing credits" maxLength={800} rows={3} value={settings.titles.closingCredits} onChange={event => editTitle('closingCredits', event.target.value)}/></label>
        <div className="movie-title-options"><label>Text color<input aria-label="Movie title text color" type="color" value={settings.titles.color} onChange={event => editTitle('color', event.target.value)}/></label><label className="movie-checkbox"><input type="checkbox" checked={settings.titles.includeDisclosure} onChange={event => editTitle('includeDisclosure', event.target.checked)}/>Add a discreet end-credit disclosure for fictional AI-created scenes</label></div>
        <details className="movie-details"><summary>Chapter titles</summary><p>Optional overlays follow the existing story order.</p>{storyboard.scenes.map(scene => <label key={scene.id}>Scene {scene.sequenceNumber}: {scene.title}<input aria-label={`Chapter title for scene ${scene.sequenceNumber}`} maxLength={160} value={settings.titles.chapterTitles[scene.id] ?? ''} onChange={event => editTitle('chapterTitles', { ...settings.titles.chapterTitles, [scene.id]: event.target.value })}/></label>)}</details>
        <details className="movie-details"><summary>Encoding quality</summary><div className="movie-field-grid"><label>Encoding preset<select aria-label="Movie encoding preset" value={settings.preset} onChange={event => edit('preset', event.target.value as MovieSettings['preset'])}><option value="ultrafast">Ultrafast · larger file</option><option value="veryfast">Very fast</option><option value="fast">Fast</option><option value="medium">Balanced</option><option value="slow">Slow · smaller file</option></select></label><label>Quality (CRF · lower is higher)<input aria-label="Movie encoding quality" type="number" min="18" max="28" step="1" value={settings.crf} onChange={event => edit('crf', Number(event.target.value))}/></label></div></details>
      </fieldset>{!validDuration&&<p className="movie-error" role="alert">{movieDurationGuidance}</p>}</div>

      <div className="movie-audio"><h4>The sound of your story.</h4><label>Soundtrack<select aria-label="Movie soundtrack" disabled={busy || uploading || !!active} value={settings.soundtrackId ?? ''} onChange={event => edit('soundtrackId', event.target.value || undefined)}><option value="">No soundtrack</option>{state.soundtracks.map(track => <option key={track.id} value={track.id}>{track.name}{track.instrumental ? ' · instrumental' : ''}</option>)}</select></label>
        {!settings.soundtrackId && <p className="movie-muted">No music will be added. Only enabled source audio will be retained.</p>}
        <fieldset disabled={busy || uploading || !!active}><label>Music volume · {Math.round(settings.musicVolume * 100)}%<input aria-label="Movie music volume" type="range" min="0" max="1" step="0.05" value={settings.musicVolume} onChange={event => edit('musicVolume', Number(event.target.value))}/></label><label className="movie-checkbox"><input type="checkbox" checked={settings.retainSceneAudio} onChange={event => edit('retainSceneAudio', event.target.checked)}/>Retain scene audio with automatic music ducking</label></fieldset>
        <p className="movie-muted">Selected music is trimmed or looped with smooth joins and fades. Local onset analysis may gently align eligible cuts while preserving the story order.</p>
        <div className="movie-upload"><span className="movie-small-label"><Music2 size={13}/>YOUR LICENSED MUSIC</span><label className="movie-file-picker">MP3, WAV, or M4A<input ref={trackInput} aria-label="Upload licensed soundtrack file" type="file" accept=".mp3,.wav,.m4a,audio/mpeg,audio/wav,audio/mp4" disabled={uploading || busy || !!active} onChange={event => { setTrackFile(event.target.files?.[0]); setLicensed(false); }}/></label>{trackFile && <div className="movie-pending-file"><p className="movie-muted">{trackFile.name} · {bytes(trackFile.size)} · File selected, save to add it to your private library.</p><Button variant="ghost" size="sm" disabled={uploading||busy} onClick={clearPendingTrack}>Clear selected soundtrack file</Button></div>}<label className="movie-checkbox"><input type="checkbox" disabled={uploading||busy||!!active} checked={licensed} onChange={event => setLicensed(event.target.checked)}/>I have permission or a license to use this soundtrack in my movie</label><label className="movie-checkbox"><input type="checkbox" disabled={uploading||busy||!!active} checked={instrumental} onChange={event => setInstrumental(event.target.checked)}/>This is an instrumental track</label><Button variant="outline" size="sm" disabled={!trackFile || !licensed || uploading || busy || !!active} onClick={() => void uploadTrack()}>{uploading ? <LoaderCircle size={14} className="animate-spin"/> : <Upload size={14}/>}Save licensed soundtrack</Button>{uploading&&<div role="status" className="movie-upload-progress"><progress aria-label="Soundtrack upload progress"/><p>Saving and validating your licensed soundtrack locally… Your draft movie settings are preserved.</p></div>}<p className="movie-muted">You can add music before saving movie settings. Saving a soundtrack does not start rendering.</p><p className="movie-muted">Stored privately on this device. Music is never downloaded automatically.</p></div>
        {state.soundtracks.length > 0 && <ul className="movie-track-list" aria-label="Private soundtrack library">{state.soundtracks.map(track => <li key={track.id}><div><strong>{track.name}</strong><span>{duration(track.durationSeconds)} · {track.instrumental ? 'Instrumental' : 'Vocals / other'} · Licensed by you</span>{track.url && <audio controls preload="none" src={track.url} aria-label={`Preview soundtrack ${track.name}`}/>}</div><Button variant="ghost" size="icon" aria-label={`Remove soundtrack ${track.name}`} disabled={busy || uploading || !!active} onClick={() => void removeTrack(track.id)}><Trash2 size={14}/></Button></li>)}</ul>}
      </div></div>

      <div className="movie-save-bar"><div>{dirty ? <p>Save these settings to recalculate the timeline before rendering.</p> : <p><Check size={13}/>Movie settings are saved.</p>}</div><Button variant="outline" size="sm" disabled={!dirty || !validDuration || busy || uploading || !!active} onClick={() => void saveSettings()}>Save movie settings</Button></div>
      <div className="movie-timeline-heading"><div><span className="step-label">YOUR AUTOMATIC TIMELINE</span><h4>A beginning, a middle, and everything between.</h4></div><span>{state.timeline.segments.length} segments · {seconds(state.timeline.durationSeconds)}</span></div>
      {state.timeline.segments.length > 0 ? <><ol className="movie-timeline" aria-label="Automatic movie timeline">{state.timeline.segments.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((segment, index) => { const scene = scenes.get(segment.sceneId), photo = segment.sourceAssetId ? sources.get(segment.sourceAssetId) : undefined; const thumbnail = segment.thumbnailUrl ?? photo?.url; const compositionIds=segment.type==='composition'?segment.sourcePhotoIds??[]:[]; return <li key={segment.id} className={segment.isFictional ? 'is-fictional' : ''} aria-label={`Movie segment ${page * PAGE_SIZE + index + 1}`}><span className="movie-timeline-time">{duration(segment.startSeconds)}</span>{segment.type==='composition'?<span className="movie-composition-preview" role="img" aria-label={`Collage timeline preview with ${compositionIds.length} original photographs`}>{compositionIds.slice(0,4).map(id=>{const source=sources.get(id);return source?<img key={id} src={`/api/projects/${source.projectId}/assets/${source.id}/thumbnail`} alt="" loading="lazy"/>:<Layers3 key={id} size={14}/>;})}{compositionIds.length>4&&<span>+{compositionIds.length-4}</span>}</span>:thumbnail ? <img src={thumbnail} alt={`Timeline preview for ${scene?.title ?? 'title card'}`} loading="lazy"/> : <span className="movie-timeline-placeholder">{segment.type === 'photo' ? <Image size={19}/> : <Film size={19}/>}</span>}<div className="movie-segment-copy"><span className="movie-segment-kind">{scene ? `SCENE ${scene.sequenceNumber} · ` : ''}{timelineKind(segment)}{segment.isFictional ? ' · FICTIONAL AI SCENE' : ''}</span><strong>{segment.type === 'title' ? segment.titleText || scene?.title || 'Title card' : scene?.title ?? (segment.type==='composition'?'Photographic moment':segment.type==='photo'?'Original photograph':'Scene clip')}</strong><span>{seconds(segment.durationSeconds)}{segment.transition.durationSeconds ? ` · ${segment.transition.type} overlap ${seconds(segment.transition.durationSeconds)}` : ' · clean cut'}{segment.type==='composition'?` · ${compositionIds.length} original photographs`:''}{segment.textOverlays?.length?` · ${segment.textOverlays.length} text overlay${segment.textOverlays.length===1?'':'s'}`:''}</span></div>{segment.type === 'video' && <span className="movie-approved"><Check size={12}/>Approved</span>}</li>; })}</ol>{state.timeline.segments.length > PAGE_SIZE && <div className="movie-pagination"><Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous segments</Button><span>Page {page + 1} of {Math.ceil(state.timeline.segments.length / PAGE_SIZE)}</span><Button variant="outline" size="sm" disabled={(page + 1) * PAGE_SIZE >= state.timeline.segments.length} onClick={() => setPage(value => value + 1)}>Next segments</Button></div>}</> : <p className="movie-gate">The timeline will appear when its source media is ready.</p>}

      <div className={`movie-readiness${state.readiness.ready ? ' is-ready' : ''}`} aria-label="Movie render readiness"><h4>{state.readiness.ready ? 'Your movie is ready to render.' : 'A few pieces still need attention.'}</h4>{state.readiness.issues.length > 0 && <ul>{state.readiness.issues.map((issue, index) => <li key={`${issue.code}-${issue.sceneId ?? index}`}><strong>{issue.message}</strong>{issue.sceneId && <code>Scene ID: {issue.sceneId}</code>}</li>)}</ul>}{state.readiness.warnings.length > 0 && <ul className="movie-warnings">{state.readiness.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>}{state.readiness.ready && <p>Required clips are approved, source media is available, and the timeline fits the requested duration.</p>}</div>
      <div className="movie-create-row"><div><ShieldCheck size={18}/><p>Local rendering only. Your existing photos and approved clips are preserved.</p></div><Button variant="clay" disabled={!canCreate} onClick={() => void createMovie()}>{busy ? <LoaderCircle size={16} className="animate-spin"/> : <Play size={16}/>}Create Movie</Button></div>

      {active && <div className="movie-render-progress" role="status"><div><strong>{stateLabels[active.state] ?? active.state}</strong><span>{Math.round(active.progress)}%</span></div><progress aria-label="Movie render progress" max="100" value={active.progress}/><p>{active.message ?? 'The local renderer is preparing your movie.'}</p><Button variant="outline" size="sm" disabled={busy} onClick={() => void changeJob(active, 'cancel')}><Square size={13}/>Cancel render</Button></div>}
      <div className="movie-output"><div className="movie-output-heading"><h4>Your finished movie.</h4>{state.assets.length > 0 && <label>Render version<select aria-label="Movie render version" value={currentAsset?.id ?? ''} onChange={event => setSelectedAssetId(event.target.value)}>{state.assets.map(asset => <option key={asset.id} value={asset.id}>Version {asset.version} · {new Date(asset.createdAt).toLocaleString()}</option>)}</select></label>}</div>{currentAsset ? <>{state.timeline.storytelling?.revision&&currentAsset.storytellingRevision!==state.timeline.storytelling.revision&&<p className="movie-plan-warning">This export uses an earlier movie plan. Saved moment, collage, and caption edits do not change an existing MP4. Create a new local movie to include the compiled timeline above; no paid generation is needed.</p>}<MovieOutput asset={currentAsset}/></> : <div className="movie-output-empty"><Film size={30} strokeWidth={1.2}/><strong>Your movie will appear here.</strong><p>Create a movie when the readiness checks pass. A completed MP4 will be available to preview and download privately.</p></div>}</div>
      {jobs.length > 0 && <details className="movie-history" open={jobs.some(job => job.state === 'FAILED')}><summary>Render history · {jobs.length} {jobs.length === 1 ? 'version' : 'versions'}</summary><ol>{jobs.map(job => <li key={job.id}><div><strong>Version {job.version} · {stateLabels[job.state] ?? job.state}</strong><span>{job.message}</span>{job.errorMessage && <p className="movie-job-error">{job.errorMessage}</p>}</div>{job.state === 'FAILED' && <Button variant="outline" size="sm" disabled={busy || !!active || dirty || hasUnsavedChanges} onClick={() => void changeJob(job, 'retry')}><RotateCcw size={13}/>Retry render</Button>}</li>)}</ol></details>}
    </>}
  </section>;
}

function MovieOutput({ asset }: { asset: MovieRenderAsset }) {
  return <><video controls playsInline preload="metadata" src={asset.url} poster={asset.thumbnailUrl} aria-label="Final assembled movie"/><div className="movie-file-meta"><span>{seconds(asset.durationSeconds)} · {asset.width} × {asset.height} · {asset.fps} FPS</span><span>{asset.videoCodec}{asset.hasAudio ? ` · ${asset.audioCodec ?? 'audio'}` : ' · no audio'} · {bytes(asset.bytes)}</span><span>Version {asset.version}</span></div>{asset.isFictional && <p className="movie-fiction-note">Includes fictional AI-created scenes. Their scene IDs are retained in this movie’s private metadata.</p>}<Button variant="clay" size="sm" asChild><a href={asset.downloadUrl} download={`ai-memories-v${asset.version}.mp4`}><Download size={14}/>Download MP4</a></Button></>;
}

function timelineKind(segment:MovieTimelineSegment){
 if(segment.type==='composition')return `ANIMATED PHOTO COLLAGE${segment.collageLayout?` · ${segment.collageLayout.replaceAll('_',' ')}`:''}`;
 if(segment.type==='video')return 'APPROVED CLIP';
 if(segment.type==='photo')return segment.presentationType==='CINEMATIC_PHOTO_MONTAGE'?'ORIGINAL PHOTO MONTAGE':segment.presentationType==='KEN_BURNS_PHOTO'?'KEN BURNS ORIGINAL PHOTOGRAPH':'ORIGINAL PHOTOGRAPH';
 return segment.presentationType==='CHAPTER_TITLE'?'CHAPTER TITLE':'TITLE CARD';
}
function CompiledCompositionSummary({timeline,draftChanged}:{timeline:MovieTimeline;draftChanged:boolean}){
 const summary=timeline.storytelling;
 const directPhotos=new Set(timeline.segments.flatMap(segment=>segment.type==='composition'?segment.sourcePhotoIds??[]:segment.type==='photo'&&segment.sourceAssetId?[segment.sourceAssetId]:[]));
 const textIds=new Set(timeline.segments.flatMap(segment=>(segment.textOverlays??[]).map(overlay=>overlay.id)));
 return <section className="movie-composition-summary" aria-label="Actual compiled movie composition"><div><h4>What the next render includes.</h4><p>These counts come from the compiled movie timeline.{draftChanged?' Save your draft movie settings to recalculate them.':' Existing MP4 exports stay unchanged.'}</p></div><dl>{[['Included moments',summary?.sequences??0],['Animated collages',summary?.collages??timeline.segments.filter(segment=>segment.type==='composition').length],['Photo montage segments',summary?.montages??timeline.segments.filter(segment=>segment.type==='photo').length],['Original photographs represented',summary?.representedPhotos??directPhotos.size],['Text overlays',summary?.textOverlays??textIds.size],['Reference-only photographs',summary?.referenceOnlyCount??0],['Approved clips reused',summary?.reusedClipCount??timeline.segments.filter(segment=>segment.type==='video').length],['Multi-image AI clips',summary?.multiImageAnimations??0]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>{summary?.source==='disabled'?<p>Saved moment mixing is disabled for this movie.</p>:summary?.source==='none'?<p>No saved moments are included yet. Detect and save groups in Sequence &amp; Storytelling, then review this timeline.</p>:summary?.source==='saved-moments'?<p>Saved group order, layouts, and captions are included alongside your existing approved clips. This local editing step does not create new AI animations.</p>:null}{summary&&summary.multiImageAnimations===0&&summary.reusedClipCount>0&&<p>Existing approved clips retain their original inputs. A multi-photo AI animation requires a separately approved generation; local collages and montages need no paid generation.</p>}{summary?.warnings.map(warning=><p className="movie-plan-warning" key={warning}>{warning}</p>)}<a href="#storytelling-studio">Edit moments, collage layouts, and captions</a></section>;
}
