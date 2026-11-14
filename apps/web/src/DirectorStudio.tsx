import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AnalyzedPhoto, Asset, CuratedSelection, DirectorState, PhotoCuration, Protagonist, ProtagonistId, ProtagonistInput, Storyboard, StoryboardContent, StoryboardScene } from '@memories/shared';
import { MIN_PROTAGONIST_REFERENCES, MAX_PROTAGONIST_REFERENCES } from '@memories/shared/reference-policy';
import { ArrowRight, Check, CheckCheck, Clapperboard, Clock3, Download, Film, ImagePlus, LoaderCircle, LockKeyhole, Pin, RotateCcw, Search, ShieldCheck, Sparkles, UsersRound, X } from 'lucide-react';
import { Button } from './components/ui/button';
import { Checkbox } from './components/ui/checkbox';
import { Progress } from './components/ui/progress';
import { VirtualPhotoGallery } from './VirtualPhotoGallery';
import { request } from './api';
import {protagonistReadinessIssues} from './protagonist-readiness';
import {MIN_MOVIE_DURATION_SECONDS,MAX_MOVIE_DURATION_SECONDS,validMovieDuration,movieDurationGuidance} from './movie-duration';
import './director.css';
import { VideoStudio } from './VideoStudio';
import { MovieStudio } from './MovieStudio';

type DirectorPhoto = AnalyzedPhoto & { asset: Asset };
type Props = { projectId?: string; assets: Asset[]; csrfToken?: string };
const emptySet = new Set<string>();
const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value);
const message = (error: unknown) => error instanceof Error ? error.message : 'The director could not complete this request. Please try again.';
const activeRun = (state?: DirectorState) => !!state?.run && ['running', 'queued'].includes(state.run.status);
const labels = { ANIMATED_ORIGINAL: 'Animated original', REFERENCE_IMAGE: 'Reference image', SUPPORTING_PHOTO: 'Supporting photo' };
const sceneLabels = { ORIGINAL_ANIMATION: 'Original photograph', NEW_CINEMATIC_SCENE: 'AI-created · Fictional', PHOTO_MONTAGE: 'Photo montage', TITLE_SEQUENCE: 'Title sequence' };
function contentOf(storyboard: Storyboard): StoryboardContent { return { schemaVersion: storyboard.schemaVersion, title: storyboard.title, synopsis: storyboard.synopsis, targetDurationSeconds: storyboard.targetDurationSeconds, scenes: storyboard.scenes.map(scene => ({ ...scene })) }; }
function isDirectorState(value: DirectorState) { return value && Array.isArray(value.protagonists) && value.usage && typeof value.totalImported === 'number'; }
function usePrivateDialog(open: boolean, onClose: () => void) {
  const element = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(element.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"], summary') ?? []);
    focusable()[0]?.focus();
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable(); const first = items[0]; const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [open]);
  return element;
}

export function DirectorStudio({ projectId, assets, csrfToken }: Props) {
  const [state, setState] = useState<DirectorState>();
  const [tab, setTab] = useState<'overview' | 'protagonists' | 'curation' | 'storyboard'>(() => ['#video-generation','#movie-studio'].includes(window.location.hash) ? 'storyboard' : 'overview');
  const [videoNavigation, setVideoNavigation] = useState(0);
  const pendingVideoScroll = useRef(['#video-generation','#movie-studio'].includes(window.location.hash) ? window.location.hash.slice(1) : '');
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [photos, setPhotos] = useState<DirectorPhoto[]>([]);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [resultPreview, setResultPreview] = useState<DirectorPhoto[]>([]);
  const [resultsLoading, setResultsLoading] = useState(false);
  const [resultsError, setResultsError] = useState('');
  const [curation, setCuration] = useState<CuratedSelection>();
  const [search, setSearch] = useState('');
  const [suitability, setSuitability] = useState('');
  const [curationFilter, setCurationFilter] = useState('all');
  const [reviewId, setReviewId] = useState<string>();
  const [mutating, setMutating] = useState(new Set<string>());
  const photoRequest = useRef(0);
  const lastPhotoRefresh = useRef(0);
  const photosTab = useRef(tab);
  photosTab.current = tab;
  const assetRevision = useMemo(() => assets.map(asset => asset.id).join(','), [assets]);

  useEffect(() => {
    const openStorySection = (hash:string) => { pendingVideoScroll.current = hash.slice(1); setTab('storyboard'); setVideoNavigation(value => value + 1); };
    const hashChanged = () => { if (['#video-generation','#movie-studio'].includes(window.location.hash)) openStorySection(window.location.hash); else pendingVideoScroll.current = ''; };
    const linkClicked = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.target && anchor.target !== '_self') return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin || destination.pathname !== window.location.pathname || destination.search !== window.location.search || !['#video-generation','#movie-studio'].includes(destination.hash)) return;
      // Repeated links to the same hash do not produce a native hashchange.
      event.preventDefault();
      if (window.location.hash !== destination.hash) window.history.pushState(null, '', destination.href);
      openStorySection(destination.hash);
    };
    window.addEventListener('hashchange', hashChanged);
    document.addEventListener('click', linkClicked);
    hashChanged();
    return () => { window.removeEventListener('hashchange', hashChanged); document.removeEventListener('click', linkClicked); };
  }, []);

  useEffect(() => {
    if (!pendingVideoScroll.current || tab !== 'storyboard' || projectId && (!state || loading)) return;
    const target = document.getElementById(pendingVideoScroll.current) ?? document.getElementById('director-panel-storyboard') ?? document.getElementById('director');
    if (!target) return;
    // App session/project loading can mount this component before projectId is
    // known. Keep the deep-link intent until its private metadata arrives.
    if (state) pendingVideoScroll.current = '';
    target.scrollIntoView?.({ block: 'start', behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [videoNavigation, tab, projectId, loading, state?.storyboard?.id, !!state]);

  const loadState = useCallback(async () => {
    const result = await request<DirectorState>('/api/director');
    if (!isDirectorState(result)) throw new Error('The AI Director is not available. Restart the updated API and try again.');
    setState(result); setUnavailable(false);
    return result;
  }, []);
  const loadPhotos = useCallback(async () => {
    const generation = ++photoRequest.current;
    setPhotosLoading(true);
    let cursor: string | undefined;
    const visited = new Set<string>();
    const collected: DirectorPhoto[] = [];
    try {
      do {
        const page: { photos: DirectorPhoto[]; nextCursor?: string } = await request(`/api/director/photos?limit=100${cursor ? `&afterId=${encodeURIComponent(cursor)}` : ''}`);
        if (!Array.isArray(page.photos)) throw new Error('Photo analysis could not be loaded. Try again.');
        collected.push(...page.photos);
        if (generation !== photoRequest.current) return;
        setPhotos([...collected]);
        cursor = page.nextCursor;
        if (cursor) { if (visited.has(cursor)) throw new Error('The analysis list could not continue. Please reload it.'); visited.add(cursor); }
      } while (cursor);
      lastPhotoRefresh.current = Date.now();
    } finally { if (generation === photoRequest.current) setPhotosLoading(false); }
  }, []);

  useEffect(() => {
    if (!projectId) { setState(undefined); setPhotos([]); return; }
    let cancelled = false; setLoading(true);
    void loadState().catch(() => { if (!cancelled) setUnavailable(true); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; photoRequest.current++; };
  }, [projectId, assetRevision, loadState]);
  useEffect(() => {
    if (!projectId || !state || tab !== 'curation') return;
    void loadPhotos().catch(e => setError(message(e)));
  }, [tab, projectId, assetRevision, loadPhotos, !!state]);
  useEffect(() => {
    if (!projectId || !state?.analyzed) { setResultPreview([]); setResultsError(''); return; }
    let cancelled = false;
    setResultsLoading(true); setResultsError('');
    void request<{photos:DirectorPhoto[]}>('/api/director/photos?limit=6&analyzedOnly=true').then(page => {
      if (!Array.isArray(page.photos)) throw new Error('Saved analysis results could not be loaded. Open Photo curation to try again.');
      if (!cancelled) setResultPreview(page.photos.filter(photo => !!photo.analysis).slice(0, 6));
    }).catch(error => { if (!cancelled) setResultsError(message(error)); }).finally(() => { if (!cancelled) setResultsLoading(false); });
    return () => { cancelled = true; };
  }, [projectId, assetRevision, state?.analyzed]);
  useEffect(() => {
    if (!activeRun(state)) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const next = await loadState();
        if (!cancelled && photosTab.current === 'curation' && (!activeRun(next) || Date.now() - lastPhotoRefresh.current > 8000)) await loadPhotos();
      } catch (e) { if (!cancelled) setError(message(e)); }
    }, 1800);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [state, loadState, loadPhotos]);

  async function analysisAction(action: 'start' | 'cancel' | 'resume' | 'retry') {
    if (!state) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const path = action === 'start' ? '/api/director/analysis' : `/api/director/analysis/${state.run!.id}/${action}`;
      await request(path, { method: 'POST', body: '{}' }, csrfToken);
      await loadState();
      setNotice(action === 'cancel' ? 'Analysis stopped. Completed results are saved.' : action === 'retry' ? 'Failed images are queued for another attempt.' : 'Analysis is queued. You can leave this page and return later.');
    } catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  async function saveProtagonist(id: ProtagonistId, input: ProtagonistInput) {
    const saved = await request<Protagonist>(`/api/director/protagonists/${id}`, { method: 'PUT', body: JSON.stringify(input) }, csrfToken);
    setState(current => current ? { ...current, protagonists: current.protagonists.map(person => person.id === id ? saved : person), storyboard: current.storyboard ? { ...current.storyboard, readyForVideoGeneration: false } : undefined } : current);
    setNotice(saved.ready ? `Protagonist saved and ready with ${saved.referencePhotoIds.length} reference photos. ${MIN_PROTAGONIST_REFERENCES} are enough for your storyboard.` : `Protagonist draft saved. ${protagonistReadinessIssues(saved).join(' ')} Complete this profile before creating a storyboard.`);
    window.dispatchEvent(new Event('protagonist-updated'));
    return saved;
  }
  async function updateCuration(assetId: string, input: Partial<PhotoCuration>) {
    setMutating(current => new Set(current).add(assetId)); setError('');
    try {
      const saved = await request<PhotoCuration>(`/api/director/photos/${assetId}`, { method: 'PATCH', body: JSON.stringify(input) }, csrfToken);
      setPhotos(current => current.map(photo => photo.assetId === assetId ? { ...photo, curation: saved } : photo));
      setCuration(undefined);
      setState(current => current?.storyboard ? { ...current, storyboard: { ...current.storyboard, readyForVideoGeneration: false } } : current);
    } catch (e) { setError(message(e)); }
    finally { setMutating(current => { const next = new Set(current); next.delete(assetId); return next; }); }
  }
  async function curate() {
    setBusy(true); setError('');
    try { setCuration(await request<CuratedSelection>('/api/director/curation?durationSeconds=150')); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }

  const byAsset = useMemo(() => new Map(assets.map(asset => [asset.id, asset])), [assets]);
  const enriched = useMemo(() => photos.map(photo => ({ ...photo, asset: photo.asset ?? byAsset.get(photo.assetId) })).filter((photo): photo is DirectorPhoto => !!photo.asset), [photos, byAsset]);
  const recommendation = useMemo(() => new Set(curation?.assetIds ?? []), [curation]);
  const photoMap = useMemo(() => new Map(enriched.map(photo => [photo.assetId, photo])), [enriched]);
  const visible = useMemo(() => enriched.filter(photo => (!search || `${photo.asset.filename} ${photo.analysis?.description ?? ''} ${photo.analysis?.sceneType ?? ''} ${[...(photo.analysis?.activities ?? []), ...(photo.analysis?.objects ?? []), ...(photo.analysis?.visibleLocations ?? []), ...(photo.analysis?.diversityTags ?? [])].join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && (!suitability || photo.analysis?.suitability === suitability) && (curationFilter === 'all' || curationFilter === 'analyzed' && !!photo.analysis || curationFilter === 'pinned' && photo.curation.pinned || curationFilter === 'excluded' && photo.curation.excluded || curationFilter === 'recommended' && (recommendation.has(photo.assetId) || photo.recommended) || curationFilter === 'unassociated' && !photo.curation.protagonistIds.length || curationFilter === 'duplicates' && !!photo.duplicateOf)), [enriched, search, suitability, curationFilter, recommendation]);
  const reviewing = reviewId ? photoMap.get(reviewId) : undefined;
  const analyzed = state?.analyzed ?? 0;
  const total = state?.totalImported ?? assets.length;
  const run = state?.run;
  const ongoing = activeRun(state);

  return <section id="director" className="director-studio" aria-labelledby="director-title">
    <div className="director-heading"><div><span className="step-label">PHASE 03 / THE AI DIRECTOR</span><h2 id="director-title">Give your memories a story.</h2><p>Find the strongest moments, introduce your two protagonists, and shape a cinematic plan.</p></div><span className="director-phase-icon"><Clapperboard size={26} strokeWidth={1.3} /></span></div>
    {!projectId ? <div className="director-gate"><LockKeyhole size={22} /><div><h3>A private story starts with your photos.</h3><p>Connect Google Photos and import a collection above to open your AI Director.</p></div><a href="#connect">Bring your memories <ArrowRight size={14} /></a></div> : loading && !state ? <div className="director-loading"><LoaderCircle className="animate-spin" size={19} /> Opening your director…</div> : unavailable && !state ? <div className="director-gate"><Clock3 size={22} /><div><h3>The director is not available yet.</h3><p>Restart the updated local API, then reload this section. Your imported photos remain in the library.</p></div><Button variant="outline" size="sm" onClick={() => { setLoading(true); void loadState().catch(() => setUnavailable(true)).finally(() => setLoading(false)); }}>Reload director</Button></div> : state && <>
      <div role="tablist" aria-label="AI Director sections" className="director-tabs">{([{ id: 'overview', label: 'AI analysis', icon: Sparkles }, { id: 'protagonists', label: 'Two protagonists', icon: UsersRound }, { id: 'curation', label: 'Photo curation', icon: Pin }, { id: 'storyboard', label: 'Storyboard', icon: Film }] as const).map(item => <button key={item.id} role="tab" id={`director-tab-${item.id}`} aria-controls={`director-panel-${item.id}`} aria-selected={tab === item.id} className={tab === item.id ? 'director-tab is-selected' : 'director-tab'} onClick={() => setTab(item.id)}><item.icon size={15} />{item.label}</button>)}</div>
      {error && <div role="alert" className="director-feedback director-error"><p>{error}</p><Button size="icon" variant="ghost" aria-label="Dismiss director error" onClick={() => setError('')}><X size={15} /></Button></div>}
      {notice && <div className="director-feedback director-notice"><Check size={15} /><p>{notice}</p><Button size="icon" variant="ghost" aria-label="Dismiss director message" onClick={() => setNotice('')}><X size={15} /></Button></div>}
      <div role="tabpanel" id={`director-panel-${tab}`} aria-labelledby={`director-tab-${tab}`}>
        {tab === 'overview' && <>
          <div className="director-metrics">{[{ label: 'Imported photos', value: total }, { label: 'Analyzed', value: analyzed }, { label: 'Pending', value: state.pending }, { label: 'Duplicate candidates', value: state.duplicateCandidates }].map(stat => <div key={stat.label}><span>{stat.label}</span><strong>{stat.value.toLocaleString()}</strong></div>)}</div>
          <div className="director-overview-grid"><div className="director-work-card"><span className="rail-eyebrow">A THOUGHTFUL FIRST LOOK</span><h3>Let the little details lead.</h3><p>Gemini reviews visible scenes, technical quality, and storytelling potential. Local perceptual hashes flag similar photographs. Dates and locations come only from existing metadata.</p>
            <div className="analysis-progress-top"><strong>{analyzed.toLocaleString()} of {total.toLocaleString()} analyzed</strong><span>{total ? Math.round(analyzed / total * 100) : 0}%</span></div><Progress value={total ? analyzed / total * 100 : 0} aria-label="AI photo analysis progress" />
            {run && <p className="analysis-run-note">{run.status === 'complete' && state.pending > 0 ? `This batch is complete. ${state.pending} ${state.pending === 1 ? 'photo still needs' : 'photos still need'} analysis.` : run.message ?? `Analysis ${run.status}.`} <span>{run.active} active · {run.failed} failed · {run.skipped} skipped</span></p>}
            <div className="director-actions"><Button variant="clay" disabled={busy || ongoing || !state.configured || state.pending === 0 || !total} onClick={() => void analysisAction('start')}>{busy ? <LoaderCircle size={15} className="animate-spin" /> : <Sparkles size={15} />}{analyzed > 0 && state.pending > 0 ? 'Analyze remaining photos' : 'Analyze photos'}</Button>{ongoing && <Button variant="outline" disabled={busy} onClick={() => void analysisAction('cancel')}>Cancel analysis</Button>}{run && !ongoing && run.pending > 0 && <Button variant="outline" disabled={busy || !state.configured} onClick={() => void analysisAction('resume')}><RotateCcw size={14} />Resume analysis</Button>}{run && !ongoing && run.failed > 0 && <Button variant="outline" disabled={busy || !state.configured} onClick={() => void analysisAction('retry')}>Retry failed images</Button>}</div>
            <p className="director-privacy"><ShieldCheck size={14} /> Choosing Analyze sends resized copies of your photos to Google Gemini. Originals stay private on this device. Names are assigned only by you.</p>
            {!state.configured && <div className="director-setup"><strong>Gemini setup required</strong><p>Set GEMINI_API_KEY in the local environment and restart the API. The README includes model, privacy, and spending settings.</p></div>}
          </div><aside className="director-usage-card"><span className="rail-eyebrow">YOUR PROJECT BUDGET</span><h3>{money(state.usage.estimatedCostUsd)} <span>estimated used</span></h3><div className="usage-budget"><span>Project spending cap</span><strong>{money(state.usage.maximumSpendUsd)}</strong></div><Progress value={state.usage.maximumSpendUsd ? Math.min(100, (state.usage.estimatedCostUsd + state.usage.reservedUsd) / state.usage.maximumSpendUsd * 100) : 0} aria-label="Project AI spending" /><dl><div><dt>Active or uncertain requests</dt><dd>{money(state.usage.reservedUsd)}</dd></div><div><dt>Generation requests</dt><dd>{state.usage.requests.toLocaleString()}</dd></div><div><dt>Input / output tokens</dt><dd>{state.usage.inputTokens.toLocaleString()} / {state.usage.outputTokens.toLocaleString()}</dd></div></dl><p>Estimates use configured model rates. Ambiguous interrupted requests may retain a reservation. Analysis pauses before further calls exceed the project cap.</p><span className="director-model">Model · {state.model}</span></aside></div>
          {analyzed > 0 && <section className="analysis-results" aria-label="Saved analysis results"><div className="director-panel-heading director-curation-heading"><div><h3>Your analysis results</h3><p>{analyzed.toLocaleString()} {analyzed === 1 ? 'photo has' : 'photos have'} saved descriptions and quality scores. Review them here, then create your movie plan in Storyboard.</p></div><Button variant="outline" onClick={() => { setSearch(''); setSuitability(''); setCurationFilter('analyzed'); setTab('curation'); }}>View all analyzed photos <ArrowRight size={14} /></Button></div>{resultsLoading && !resultPreview.length && <p role="status">Loading saved results…</p>}{resultsError && <p role="alert" className="director-inline-error">{resultsError}</p>}<div className="analysis-results-grid">{resultPreview.map(photo => <article className="analysis-result-card" key={photo.assetId}><img src={photo.asset.url} alt={photo.asset.filename} loading="lazy" /><div><span className="ai-score">Story {Math.round(photo.analysis!.storytellingPotential)}/100 · {labels[photo.analysis!.suitability]}</span><h4>{photo.asset.filename}</h4><p>{photo.analysis!.description}</p><Button variant="ghost" size="sm" aria-label={`Review analysis for ${photo.asset.filename}`} onClick={() => { setReviewId(photo.assetId); setTab('curation'); }}>View scores and details <ArrowRight size={13} /></Button></div></article>)}</div></section>}
          <div className="director-next"><UsersRound size={21} /><div><strong>Two real people. Their story, with permission.</strong><p>{state.protagonists.length===2&&state.protagonists.every(person=>person.ready)?'Both protagonists are ready with confirmed references and permission.':`Choose ${MIN_PROTAGONIST_REFERENCES} reference photos per protagonist, then check any remaining profile requirements. More references are optional.`}</p></div><Button size="sm" variant="outline" onClick={() => setTab('protagonists')}>Meet your protagonists <ArrowRight size={14} /></Button></div>
        </>}
        {tab === 'protagonists' && <><div className="director-panel-heading"><h3>The two people at the heart of it.</h3><p>Name each protagonist and choose clear reference photos. Confirm who appears in additional photos yourself; the director never identifies faces across your library.</p></div><div className="protagonist-grid">{state.protagonists.map(person => <ProtagonistCard key={person.id} person={person} assets={assets} onSave={saveProtagonist} />)}</div></>}
        {tab === 'curation' && <><div className="director-panel-heading director-curation-heading"><div><h3>A collection with a little intention.</h3><p>Rank quality and story potential, keep variety, and confirm the people you recognize.</p></div><Button variant="outline" disabled={busy || analyzed === 0} onClick={() => void curate()}><Sparkles size={14} />Preview recommended selection</Button></div>
          <div className="director-curation-toolbar"><label className="director-search"><Search size={15} /><input aria-label="Search analyzed photos" placeholder="Search scenes, activities, or filenames…" value={search} onChange={event => setSearch(event.target.value)} /></label><label>Best use<select aria-label="Filter by AI suitability" value={suitability} onChange={event => setSuitability(event.target.value)}><option value="">All photo types</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>Collection<select aria-label="Filter director collection" value={curationFilter} onChange={event => setCurationFilter(event.target.value)}><option value="all">All photos</option><option value="analyzed">Analyzed photos</option><option value="recommended">Recommended</option><option value="pinned">Pinned</option><option value="excluded">Excluded</option><option value="unassociated">People unconfirmed</option><option value="duplicates">Duplicate candidates</option></select></label></div>
          {curation && <div className="curation-notice"><CheckCheck size={16} /><div><strong>{curation.assetIds.length} photos recommended for a 150-second story.</strong>{curation.warnings.map((warning, index) => <p key={index}>{warning}</p>)}</div></div>}
          <div className="director-gallery-meta"><span>{visible.length.toLocaleString()} matching photos{photosLoading ? ' · loading analysis…' : ''}</span><span>Click a photo to review scores and confirm people.</span></div>
          {visible.length ? <VirtualPhotoGallery assets={visible.map(photo => photo.asset)} mutating={mutating} ariaLabel="Photo curation gallery" hideDelete selectionLabel={asset => `Pin ${asset.filename}`} isSelected={asset => !!photoMap.get(asset.id)?.curation.pinned} onSelect={asset => { const current = photoMap.get(asset.id)!.curation; void updateCuration(asset.id, { pinned: !current.pinned, excluded: false }); }} onDelete={() => {}} onInspect={asset => setReviewId(asset.id)} resetKey={`${search}:${suitability}:${curationFilter}`} extraHeight={74} renderExtra={asset => { const photo = photoMap.get(asset.id)!; return <div className="curation-photo-extra"><div><span className="ai-score">{photo.analysis ? `Story ${Math.round(photo.analysis.storytellingPotential)}/100` : 'Analysis pending'}</span>{(photo.recommended || recommendation.has(asset.id)) && <span className="recommended-tag">Recommended</span>}</div><div className="curation-photo-actions"><button aria-label={`${photo.curation.pinned ? 'Unpin' : 'Pin'} photo ${asset.filename}`} aria-pressed={photo.curation.pinned} disabled={mutating.has(asset.id)} onClick={() => void updateCuration(asset.id, { pinned: !photo.curation.pinned, excluded: false })}><Pin size={12} />{photo.curation.pinned ? 'Pinned' : 'Pin'}</button><button aria-label={`${photo.curation.excluded ? 'Include' : 'Exclude'} ${asset.filename}`} aria-pressed={photo.curation.excluded} disabled={mutating.has(asset.id)} onClick={() => void updateCuration(asset.id, { excluded: !photo.curation.excluded, pinned: false })}>{photo.curation.excluded ? 'Excluded' : 'Exclude'}</button></div></div>; }} /> : <div className="director-empty">{photosLoading ? <LoaderCircle className="animate-spin" size={23} /> : <ImagePlus size={26} strokeWidth={1.2} />}<h4>{photosLoading ? 'Opening your collection…' : 'No photos match this view.'}</h4><p>Imported photos remain in your memory library. Analyze them to add visual quality and story recommendations.</p></div>}
          {reviewing && <PhotoReview photo={reviewing} people={state.protagonists} error={error} busy={mutating.has(reviewing.assetId)} onClose={() => setReviewId(undefined)} onUpdate={input => void updateCuration(reviewing.assetId, input)} />}
        </>}
        {tab === 'storyboard' && <StoryboardEditor state={state} assets={assets} csrfToken={csrfToken} onSaved={saved => setState(current => current ? { ...current, storyboard: saved } : current)} onUsageRefresh={() => void loadState().catch(() => {})} />}
      </div>
    </>}
  </section>;
}

function ProtagonistCard({ person, assets, onSave }: { person: Protagonist; assets: Asset[]; onSave: (id: ProtagonistId, input: ProtagonistInput) => Promise<Protagonist> }) {
  const [draft, setDraft] = useState<ProtagonistInput>({ name: person.name, referencePhotoIds: person.referencePhotoIds, likenessPermissionConfirmed: person.likenessPermissionConfirmed });
  const [dirty, setDirty] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [query, setQuery] = useState('');
  const referenceDialog = usePrivateDialog(choosing, () => setChoosing(false));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!dirty) setDraft({ name: person.name, referencePhotoIds: person.referencePhotoIds, likenessPermissionConfirmed: person.likenessPermissionConfirmed }); }, [person.updatedAt]);
  const selected = new Set(draft.referencePhotoIds);
  const visible = assets.filter(asset => !query || asset.filename.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const label = person.id === 'person1' ? 'First protagonist' : 'Second protagonist';
  const readinessIssues=!dirty?protagonistReadinessIssues(person):[];
  async function save() {
    setSaving(true); setError('');
    try { const result = await onSave(person.id, draft); setDraft({ name: result.name, referencePhotoIds: result.referencePhotoIds, likenessPermissionConfirmed: result.likenessPermissionConfirmed }); setDirty(false); }
    catch (e) { setError(message(e)); } finally { setSaving(false); }
  }
  function choose(asset: Asset) {
    if (!selected.has(asset.id) && selected.size >= MAX_PROTAGONIST_REFERENCES) { setError(`Choose no more than ${MAX_PROTAGONIST_REFERENCES} reference photos for each protagonist.`); return; }
    setError(''); setDirty(true); setDraft(current => ({ ...current, referencePhotoIds: selected.has(asset.id) ? current.referencePhotoIds.filter(id => id !== asset.id) : [...current.referencePhotoIds, asset.id] }));
  }
  return <article className="protagonist-card" aria-label={label}><div className="protagonist-card-top"><span className={`person-avatar ${person.id}`}><UsersRound size={23} strokeWidth={1.4} /></span><span className={person.ready && !dirty ? 'protagonist-ready' : 'protagonist-unfinished'}>{person.ready && !dirty ? 'Ready for your story' : 'Setup in progress'}</span></div><span className="step-label">{label}</span><label className="director-field">Name<input aria-label={`${label} name`} value={draft.name} maxLength={80} placeholder={person.id === 'person1' ? 'Their name' : 'The other person’s name'} onChange={event => { setDirty(true); setDraft(current => ({ ...current, name: event.target.value })); }} /></label><div className="reference-preview">{draft.referencePhotoIds.slice(0, 5).map(id => { const asset = assets.find(item => item.id === id); return asset && <img key={id} src={asset.url} alt={`Reference for ${draft.name || label}: ${asset.filename}`} loading="lazy" />; })}{!draft.referencePhotoIds.length && <span><ImagePlus size={20} /> Choose a few clear portraits and varied angles.</span>}</div><Button variant="outline" size="sm" onClick={() => setChoosing(true)}>Choose reference photos <span>{selected.size}/{MAX_PROTAGONIST_REFERENCES}</span></Button><p className="reference-caption">{selected.size>=MIN_PROTAGONIST_REFERENCES?`${selected.size} reference photos selected. ${MIN_PROTAGONIST_REFERENCES} are enough; additional references are optional.`:`Choose at least ${MIN_PROTAGONIST_REFERENCES} photos of this person. You can add up to ${MAX_PROTAGONIST_REFERENCES}.`} References guide the scene prompts; they do not create a face-identification database.</p><p className="reference-caption">A photo excluded from the movie can still be an explicitly approved protagonist reference. It guides appearance only and stays out of the movie unless you include it again.</p>{readinessIssues.length>0&&<ul className="protagonist-readiness-issues" aria-label={`${label} remaining requirements`}>{readinessIssues.map(issue=><li key={issue}>{issue}</li>)}</ul>}{dirty&&<p className="reference-caption">Save these profile changes to check readiness.</p>}<label className="likeness-confirmation"><Checkbox aria-label={`Permission to use ${label.toLowerCase()}'s likeness`} checked={draft.likenessPermissionConfirmed} onCheckedChange={checked => { setDirty(true); setDraft(current => ({ ...current, likenessPermissionConfirmed: checked === true })); }} /><span>I have permission to use this person’s likeness in this project.</span></label>{error && <p className="director-inline-error">{error}</p>}<Button variant="clay" disabled={saving || !dirty} onClick={() => void save()}>{saving && <LoaderCircle className="animate-spin" size={15} />}Save protagonist</Button>{selected.size < MIN_PROTAGONIST_REFERENCES && <p className="reference-caption">{MIN_PROTAGONIST_REFERENCES - selected.size} more reference {MIN_PROTAGONIST_REFERENCES - selected.size === 1 ? 'photo is' : 'photos are'} needed before storyboard generation.</p>}
    {choosing && <div ref={referenceDialog} role="dialog" aria-modal="true" aria-label={`Reference photos for ${label.toLowerCase()}`} className="director-modal-backdrop"><section className="director-modal reference-modal"><div className="director-modal-heading"><div><span className="step-label">USER-CONFIRMED REFERENCES</span><h3>{draft.name || label}</h3><p>{selected.size} selected · {MIN_PROTAGONIST_REFERENCES} photos are enough</p></div><Button variant="ghost" size="icon" aria-label="Close reference picker" onClick={() => setChoosing(false)}><X size={19} /></Button></div><label className="director-search"><Search size={15} /><input aria-label="Search reference photos" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search filenames…" /></label>{error && <p className="director-inline-error">{error}</p>}{visible.length ? <VirtualPhotoGallery assets={visible} mutating={emptySet} ariaLabel="Reference photo gallery" hideDelete selectionLabel={asset => `Use ${asset.filename} as reference`} isSelected={asset => selected.has(asset.id)} onSelect={choose} onDelete={() => {}} resetKey={query} /> : <div className="director-empty"><p>No imported photos match this search.</p></div>}<div className="director-modal-footer"><p>Only you confirm who is shown in these references.</p><Button variant="clay" onClick={() => setChoosing(false)}>Use {selected.size} references</Button></div></section></div>}
  </article>;
}

function PhotoReview({ photo, people, error, busy, onClose, onUpdate }: { photo: DirectorPhoto; people: Protagonist[]; error?: string; busy: boolean; onClose: () => void; onUpdate: (input: Partial<PhotoCuration>) => void }) {
  const photoDialog = usePrivateDialog(true, onClose);
  const analysis = photo.analysis;
  const exif = photo.features?.exif;
  return <div ref={photoDialog} role="dialog" aria-modal="true" aria-label={`Review ${photo.asset.filename}`} className="director-modal-backdrop"><section className="director-modal photo-review-modal"><div className="director-modal-heading"><div><span className="step-label">PHOTO REVIEW</span><h3>{photo.asset.filename}</h3></div><Button variant="ghost" size="icon" aria-label="Close photo review" onClick={onClose}><X size={19} /></Button></div><div className="photo-review-grid"><img className="photo-review-image" src={photo.asset.url} alt={photo.asset.filename} /><div className="photo-review-copy">{error && <p className="director-inline-error">{error}</p>}{analysis ? <><span className="suitability-tag">{labels[analysis.suitability]}</span><p>{analysis.description}</p><dl className="quality-score-grid">{[{ label: 'Sharpness', value: analysis.sharpness }, { label: 'Exposure', value: analysis.exposure }, { label: 'Composition', value: analysis.composition }, { label: 'Animation', value: analysis.animationSuitability }, { label: 'Story potential', value: analysis.storytellingPotential }].map(score => <div key={score.label}><dt>{score.label}</dt><dd>{Math.round(score.value)}<span>/100</span></dd></div>)}</dl>{analysis.uncertaintyNotes.length > 0 && <div className="association-note"><strong>Details to review</strong><ul>{analysis.uncertaintyNotes.map((note, index) => <li key={index}>{note}</li>)}</ul></div>}</> : <p>Visual analysis is pending for this photo.</p>}<p className="evidence-note">Date: {exif?.dateTimeOriginal ? `${exif.dateTimeOriginal} (${exif.dateSource === 'EXIF' ? 'EXIF' : 'Google metadata'})` : 'Not available in existing metadata.'}<br />Location: {exif?.latitude !== null && exif?.latitude !== undefined && exif.longitude !== null ? `${exif.latitude}, ${exif.longitude} (EXIF)` : 'Not available in existing metadata.'}</p><fieldset className="manual-associations"><legend>Confirm the people you recognize</legend><p>Identity is not inferred. Leave a person unchecked if you are unsure.</p>{people.map(person => <label key={person.id}><Checkbox aria-label={`Confirm ${person.name || (person.id === 'person1' ? 'first protagonist' : 'second protagonist')} appears in ${photo.asset.filename}`} checked={photo.curation.protagonistIds.includes(person.id)} disabled={busy} onCheckedChange={checked => onUpdate({ protagonistIds: checked ? [...photo.curation.protagonistIds, person.id] : photo.curation.protagonistIds.filter(id => id !== person.id) })} /><span>{person.name || (person.id === 'person1' ? 'First protagonist' : 'Second protagonist')}</span></label>)}</fieldset><div className="director-actions"><Button variant="outline" disabled={busy} onClick={() => onUpdate({ pinned: !photo.curation.pinned, excluded: false })}>{photo.curation.pinned ? 'Unpin photo' : 'Pin photo'}</Button><Button variant="outline" disabled={busy} onClick={() => onUpdate({ excluded: !photo.curation.excluded, pinned: false })}>{photo.curation.excluded ? 'Include photo' : 'Exclude from story'}</Button></div></div></div></section></div>;
}

function StoryboardEditor({ state, assets, csrfToken, onSaved, onUsageRefresh }: { state: DirectorState; assets: Asset[]; csrfToken?: string; onSaved: (value: Storyboard) => void; onUsageRefresh: () => void }) {
  const [saved, setSaved] = useState(state.storyboard);
  const [draft, setDraft] = useState<StoryboardContent | undefined>(state.storyboard ? contentOf(state.storyboard) : undefined);
  const [duration, setDuration] = useState(state.storyboard?.targetDurationSeconds ?? 150);
  const [brief, setBrief] = useState('A cinematic, warm story of two lives and their shared moments.');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!dirty && state.storyboard) { setSaved(state.storyboard); setDraft(contentOf(state.storyboard)); setDuration(state.storyboard.targetDurationSeconds); }
  }, [state.storyboard?.id, state.storyboard?.version, state.storyboard?.readyForVideoGeneration]);
  const total = draft?.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0) ?? 0;
  const peopleReady = state.protagonists.length === 2 && state.protagonists.every(person => person.ready);
  const validDuration = validMovieDuration(duration);
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const names = new Map(state.protagonists.map(person => [person.id, person.name]));
  const durationMismatch = !!draft && total !== draft.targetDurationSeconds;
  const ready = !dirty && !!saved?.readyForVideoGeneration;
  function sceneChange(id: string, change: Partial<StoryboardScene>) { setDirty(true); setDraft(current => current ? { ...current, scenes: current.scenes.map(scene => scene.id === id ? { ...scene, ...change } : scene) } : current); }
  async function generate() {
    setBusy(true); setError('');
    try { const result = await request<Storyboard>('/api/director/storyboards', { method: 'POST', body: JSON.stringify({ durationSeconds: duration, brief }) }, csrfToken); setSaved(result); setDraft(contentOf(result)); setDirty(false); onSaved(result); onUsageRefresh(); }
    catch (e) { setError(message(e)); onUsageRefresh(); } finally { setBusy(false); }
  }
  async function save() {
    if (!saved || !draft) return;
    setBusy(true); setError('');
    try { const result = await request<Storyboard>(`/api/director/storyboards/${saved.id}`, { method: 'PUT', body: JSON.stringify(draft) }, csrfToken); setSaved(result); setDraft(contentOf(result)); setDirty(false); onSaved(result); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <><div className="director-panel-heading"><h3>From your collection to a cinematic plan.</h3><p>Original photographs stay grounded in your memories. New cinematic scenes are fictional, clearly marked, and require your confirmation.</p></div><p className="director-privacy storyboard-privacy"><ShieldCheck size={14} /> Creating a storyboard sends selected reference copies and your creative direction to Google Gemini. Fictional scenes describe imagined possibilities, never claims about real events.</p><div className="storyboard-controls"><label className="director-field">Movie duration (seconds)<input aria-label="Movie duration in seconds" type="number" min={MIN_MOVIE_DURATION_SECONDS} max={MAX_MOVIE_DURATION_SECONDS} step={1} value={duration} onChange={event => { const value = Number(event.target.value); setDuration(value); if (draft) { setDirty(true); setDraft(current => current ? { ...current, targetDurationSeconds: value } : current); } }} /></label><label className="director-field storyboard-brief">Creative direction<textarea aria-label="Storyboard creative direction" rows={2} maxLength={3000} value={brief} onChange={event => setBrief(event.target.value)} /></label><Button variant="clay" disabled={busy || !state.configured || !peopleReady || state.analyzed === 0 || !validDuration} onClick={() => void generate()}>{busy ? <LoaderCircle className="animate-spin" size={15} /> : <Sparkles size={15} />}{saved ? 'Regenerate storyboard' : 'Create storyboard'}</Button></div>{!state.configured && <p className="director-inline-error">Configure Gemini before creating a storyboard.</p>}{!peopleReady && <div className="storyboard-guidance"><p>Finish the remaining profile requirements before creating a storyboard:</p><ul>{state.protagonists.filter(person=>!person.ready).map((person,index)=><li key={person.id}>{person.name||`Protagonist ${index+1}`}: {protagonistReadinessIssues(person).join(' ')}</li>)}</ul></div>}{!validDuration && <p className="director-inline-error">{movieDurationGuidance}</p>}{error && <div role="alert" className="director-feedback director-error"><p>{error}</p></div>}
    {!draft ? <div className="storyboard-empty"><Film size={34} strokeWidth={1.1} /><h4>Your movie begins on the storyboard.</h4><p>Analyze your photos, confirm your two protagonists, and the director will prepare a balanced plan of original photo animations and fictional cinematic scenes.</p><span>{MIN_MOVIE_DURATION_SECONDS}–{MAX_MOVIE_DURATION_SECONDS} SECONDS · NO VIDEO GENERATED IN THIS PHASE</span></div> : <>
      <div className="storyboard-document-heading"><div><span className="step-label">VERSION {saved?.version ?? 1} · SCHEMA {draft.schemaVersion}</span><label className="director-field"><span className="sr-only">Storyboard title</span><input aria-label="Storyboard title" value={draft.title} onChange={event => { setDirty(true); setDraft({ ...draft, title: event.target.value }); }} /></label></div><span className={ready ? 'storyboard-readiness is-ready' : 'storyboard-readiness'}>{ready ? <CheckCheck size={16} /> : <Clock3 size={16} />}{ready ? 'Ready for video generation' : dirty ? 'Unsaved changes' : 'Draft · review required'}</span></div><label className="director-field">Story synopsis<textarea aria-label="Story synopsis" rows={2} value={draft.synopsis} onChange={event => { setDirty(true); setDraft({ ...draft, synopsis: event.target.value }); }} /></label>
      <div className={`storyboard-duration ${durationMismatch ? 'has-issue' : ''}`}><strong>{total} seconds</strong><span>of {draft.targetDurationSeconds} planned · {draft.scenes.length} scenes</span><span>{draft.scenes.filter(scene => scene.type === 'NEW_CINEMATIC_SCENE').reduce((sum, scene) => sum + scene.durationSeconds, 0)}s AI-created · {draft.scenes.filter(scene => scene.type !== 'NEW_CINEMATIC_SCENE').reduce((sum, scene) => sum + scene.durationSeconds, 0)}s original / montage / title</span></div>
      {durationMismatch && <p className="director-inline-error">Scene durations must add up to exactly {draft.targetDurationSeconds} seconds. Current total: {total} seconds.</p>}
      {!dirty && saved?.validationIssues.length ? <ul className="storyboard-validation">{saved.validationIssues.map((issue, index) => <li key={index}>{issue}</li>)}</ul> : null}
      <ol className="storyboard-scenes">{draft.scenes.map(scene => <li className={`storyboard-scene scene-${scene.type.toLowerCase()}`} key={scene.id}><div className="scene-heading"><span className="scene-number">{String(scene.sequenceNumber).padStart(2, '0')}</span><div><span className={scene.isFictional ? 'scene-kind is-fictional' : 'scene-kind'}>{sceneLabels[scene.type]}</span><input className="scene-title-input" aria-label={`Scene ${scene.sequenceNumber} title`} value={scene.title} maxLength={160} onChange={event => sceneChange(scene.id, { title: event.target.value })} /></div><label className="scene-duration">Seconds<input aria-label={`Scene ${scene.sequenceNumber} duration`} type="number" min={1} max={60} step={1} value={scene.durationSeconds} onChange={event => sceneChange(scene.id, { durationSeconds: Number(event.target.value) })} /></label></div><label className="director-field">Description<textarea aria-label={`Scene ${scene.sequenceNumber} description`} rows={2} value={scene.description} onChange={event => sceneChange(scene.id, { description: event.target.value })} /></label><div className="scene-source-photos">{scene.sourcePhotoIds.slice(0, 4).map(id => { const asset = byId.get(id); return asset ? <a key={id} href={asset.url} target="_blank" rel="noopener noreferrer" aria-label={`Open scene ${scene.sequenceNumber} reference ${asset.filename}`}><img src={asset.url} alt={`Scene ${scene.sequenceNumber} source: ${asset.filename}`} loading="lazy" /></a> : <span className="missing-scene-photo" key={id}>Source unavailable</span>; })}{scene.sourcePhotoIds.length > 4 && <span>+{scene.sourcePhotoIds.length - 4} source photos</span>}<span>{scene.protagonistIds.map(id => names.get(id) || id).join(' · ') || 'Atmosphere / titles'}</span></div><details className="scene-prompt-details"><summary>Review camera, motion, and generation prompts</summary><div className="scene-prompt-grid">{([{ key: 'visualStyle', label: 'Visual style' }, { key: 'cameraDirection', label: 'Camera direction' }, { key: 'motionPrompt', label: 'Motion prompt' }, { key: 'emotionalTone', label: 'Emotional tone' }, { key: 'continuityNotes', label: 'Continuity notes' }, { key: 'generationInstructions', label: 'Generation instructions' }] as const).map(field => <label className="director-field" key={field.key}>{field.label}<textarea aria-label={`Scene ${scene.sequenceNumber} ${field.label.toLowerCase()}`} rows={field.key === 'generationInstructions' ? 3 : 2} value={scene[field.key]} onChange={event => sceneChange(scene.id, { [field.key]: event.target.value })} /></label>)}</div></details>{scene.requiresUserConfirmation && <label className="scene-confirmation"><Checkbox aria-label={`Confirm ${scene.isFictional ? 'fictional ' : ''}scene ${scene.sequenceNumber}`} checked={scene.userConfirmed} onCheckedChange={checked => sceneChange(scene.id, { userConfirmed: checked === true })} /><span>{scene.isFictional ? 'I understand this is an AI-created fictional scene, inspired by the references.' : 'I have reviewed and confirmed this scene.'}</span></label>}</li>)}</ol>
      <div className="storyboard-save-bar"><div><strong>{ready ? 'Prepared for scene generation.' : 'Keep shaping the story.'}</strong><p>{ready ? 'Your validated storyboard is ready for individual scene clips below. Final movie assembly belongs to P5.' : 'Save a new version to validate duration, references, permissions, and scene confirmations.'}</p><a href="#video-generation">Open scene clips <ArrowRight size={12}/></a></div><Button variant="clay" disabled={busy || !dirty || !validDuration} onClick={() => void save()}>{busy && <LoaderCircle className="animate-spin" size={14} />}Save storyboard version</Button>{saved && <Button variant="outline" asChild disabled={dirty}><a aria-disabled={dirty} onClick={event => { if (dirty) event.preventDefault(); }} href={`/api/director/storyboards/${saved.id}/export`} download={`storyboard-v${saved.version}.json`}><Download size={14} />{ready ? 'Download P4 storyboard' : 'Download saved draft JSON'}</a></Button>}</div>
      {saved&&<VideoStudio storyboard={saved} assets={assets} csrfToken={csrfToken} hasUnsavedChanges={dirty}/>}
      {saved&&<p className="storyboard-guidance">Your approved clips keep their original source images. With moment mixing enabled, saved moment, collage, and caption edits update the local timeline below. Create a new movie to include those changes; new AI animations still require generation approval.</p>}
      {saved&&<MovieStudio storyboard={saved} assets={assets} csrfToken={csrfToken} hasUnsavedChanges={dirty}/>}
    </>}
  </>;
}
