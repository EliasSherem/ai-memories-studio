import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Asset, ContributorId, PickerState, ProjectState, SessionInfo } from '@memories/shared';
import { ArrowRight, Check, CheckCheck, ChevronRight, CircleHelp, Clock3, Clapperboard, ExternalLink, Film, FolderHeart, Heart, ImagePlus, Images, Layers3, LoaderCircle, LockKeyhole, Menu, Plus, Search, ShieldCheck, Sparkles, UsersRound, X } from 'lucide-react';
import { Button } from './components/ui/button';
import { ImportProgress, type ImportState } from './ImportProgress';
import { VirtualPhotoGallery } from './VirtualPhotoGallery';
import { DirectorStudio } from './DirectorStudio';
import { ProductionStudio } from './ProductionStudio';
import { StorytellingStudio } from './StorytellingStudio';
import { ApiClientError, request, type GoogleRequestDiagnostic } from './api';

const activeStatuses = new Set(['waiting', 'ready', 'importing']);
const authMessages: Record<string, string> = {
  connected: 'Google Photos is connected. Choose the photos you want to bring into your story.',
  denied: 'Google Photos access was not granted. If Google blocked this testing app, add this Google account under Google Auth Platform → Audience → Test users. If you cancelled consent, reconnect when ready.',
  oauth_testing_required: 'Google blocked access to this testing app. Add this Google account under Google Auth Platform → Audience → Test users in the OAuth client’s Cloud project, then reconnect Google Photos.',
  oauth_org_restricted: 'This OAuth app is restricted to its Google organization. Use an allowed organization account or update the OAuth audience configuration.',
  oauth_admin_policy: 'A Google Workspace administrator blocked this authorization. Ask the administrator to allow this OAuth app and its Photos Picker permission.',
  wrong_oauth_client: 'This Google authorization belongs to a different OAuth client. Reconnect Google Photos using this app’s current configuration.',
  account_mismatch: 'The current Google account does not own that photo selection. Reconnect the original account before resuming.',
  error: 'Google Photos could not be connected. Please try again.',
  expired: 'The connection request expired. Start a new connection to try again.',
  invalid_state: 'This connection request could not be verified. Please start again.',
  failed: 'Google Photos could not be connected. Check your Google app configuration and try again.',
  invalid_credentials: 'Google rejected the configured credentials. Check the client ID, client secret, and redirect URI in your local environment file.',
  missing_scope: 'Google Photos access was not granted. Connect again and approve access to the photos you explicitly select.',
  picker_active: 'Finish or cancel the current photo selection before switching Google accounts.',
};

function GooglePhotosMark() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 shrink-0"><path fill="#4285f4" d="M12 12V2a5 5 0 0 1 5 5v5z" /><path fill="#34a853" d="M12 12h10a5 5 0 0 1-5 5h-5z" /><path fill="#fbbc04" d="M12 12v10a5 5 0 0 1-5-5v-5z" /><path fill="#ea4335" d="M12 12H2a5 5 0 0 1 5-5h5z" /></svg>;
}

type GalleryQuery = { search?: string; contributorId?: ContributorId; selected?: boolean; mimeType?: string };
function matchesQuery(asset: Asset, query: GalleryQuery) {
  return (!query.contributorId || asset.contributorId === query.contributorId)
    && (query.selected === undefined || asset.selected === query.selected)
    && (!query.mimeType || asset.mimeType === query.mimeType)
    && (!query.search || `${asset.filename} ${asset.createdAt ?? ''} ${asset.importedAt}`.toLocaleLowerCase().includes(query.search.toLocaleLowerCase()));
}

type ContributorConnection = SessionInfo['contributors'][number] & { requiresReauthorization?: boolean; reauthorizationReason?: string };
function needsConnectionRefresh(error: unknown) { return error instanceof ApiClientError && (error.status === 401 || ['MISSING_PHOTOS_SCOPE', 'WRONG_OAUTH_CLIENT', 'ACCOUNT_MISMATCH', 'RECONNECT_REQUIRED'].includes(error.code)); }
function connectionIssueMessage(reason?: string) {
  if (reason === 'MISSING_PHOTOS_SCOPE') return 'The Photos Picker permission is missing. Reconnect and approve access to the photos you select.';
  if (reason === 'WRONG_OAUTH_CLIENT') return 'The saved authorization belongs to another OAuth client. Reconnect using this app’s current configuration.';
  if (reason === 'ACCOUNT_MISMATCH') return 'Reconnect the Google account that owns this photo selection.';
  return 'Google authorization needs to be renewed before you can choose photos.';
}

function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }

export default function App() {
  const [session, setSession] = useState<SessionInfo>();
  const [project, setProject] = useState<ProjectState>();
  const [picker, setPicker] = useState<ImportState>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorDiagnostic,setErrorDiagnostic]=useState<{forMessage:string;details:GoogleRequestDiagnostic}>();
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState<ContributorId>();
  const [checkingConnection,setCheckingConnection]=useState<ContributorId>();
  const [cancelling, setCancelling] = useState(false);
  const [mutating, setMutating] = useState(new Set<string>());
  const [filter, setFilter] = useState<'all' | ContributorId>('all');
  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [selectionFilter, setSelectionFilter] = useState<'all' | 'selected' | 'unselected'>('all');
  const [mimeType, setMimeType] = useState('');
  const [bulkPending, setBulkPending] = useState(false);
  const [jobActionPending, setJobActionPending] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const importRequests = useRef(new Map<string, Promise<PickerState>>());
  const localRetryAt = useRef(0);
  const selectedImport = useRef<string>();
  const [selectedImportId, setSelectedImportId] = useState<string>();
  const [historyPending, setHistoryPending] = useState(false);
  const reportError=useCallback((value:unknown)=>{
    const message=errorMessage(value);setError(message);
    setErrorDiagnostic(value instanceof ApiClientError && value.diagnostic ? {forMessage:message,details:value.diagnostic}:undefined);
  },[]);

  const loadProject = useCallback(async () => {
    const result = await request<ProjectState>('/api/project');
    setProject(result);
    const chosen = selectedImport.current;
    if (chosen) {
      const historical = result.jobs?.find(job => job.id === chosen) ?? (result.picker?.id === chosen ? result.picker : undefined);
      if (historical) setPicker(historical);
      else {
        try { setPicker(await request<ImportState>(`/api/picker/sessions/${chosen}`)); }
        catch (error) {
          if (!(error instanceof ApiClientError) || error.status !== 404) throw error;
          selectedImport.current = undefined; setSelectedImportId(undefined); setPicker(result.picker);
        }
      }
    } else setPicker(result.picker);
    return result;
  }, []);

  const refreshSession = useCallback(async () => {
    const currentSession = await request<SessionInfo>('/api/session');
    setSession(currentSession);
    if (!currentSession.authenticated) { setProject(undefined); setPicker(undefined); selectedImport.current = undefined; setSelectedImportId(undefined); }
    return currentSession;
  }, []);

  const initialize = useCallback(async () => {
    setLoading(true);
    try {
      const currentSession = await refreshSession();
      if (currentSession.authenticated) await loadProject();
    } catch (e) { reportError(e); }
    finally { setLoading(false); }
  }, [loadProject, refreshSession, reportError]);

  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const result = params.get('auth');
    if (result) {
      const message = authMessages[result] ?? 'The Google connection could not be completed. Try connecting again.';
      if (result === 'connected') setNotice(message); else setError(message);
      params.delete('auth');
      window.history.replaceState(null, '', window.location.pathname + (params.size ? `?${params}` : '') + window.location.hash);
    }
  }, []);

  useEffect(() => {
    if (!picker || (!activeStatuses.has(picker.status) && !picker.cleanupPending)) return;
    let cancelled = false;
    const normalDelay = picker.status === 'ready' ? 0 : picker.status === 'importing' ? 1000 : picker.cleanupPending ? 3000 : Math.max(250, Math.min(picker.nextPollAt, picker.deadline) - Date.now());
    const delay = Math.max(normalDelay, localRetryAt.current - Date.now());
    const timer = window.setTimeout(async () => {
      try {
        let updated: ImportState;
        if (picker.status === 'ready') {
          // Keep the actual request, so an effect restart can observe its result.
          let pending = importRequests.current.get(picker.id);
          if (!pending) {
            pending = request<PickerState>(`/api/picker/sessions/${picker.id}/import`, { method: 'POST' }, session?.csrfToken);
            importRequests.current.set(picker.id, pending);
          }
          try {
            updated = await pending;
          } catch (e) { importRequests.current.delete(picker.id); throw e; }
        } else {
          updated = await request<PickerState>(`/api/picker/sessions/${picker.id}`);
        }
        if (cancelled) return;
        localRetryAt.current = 0;
        setPicker(updated);
        if (!activeStatuses.has(updated.status)) {
          importRequests.current.delete(updated.id);
          try { await loadProject(); }
          catch (e) {
            reportError(e);
            if (needsConnectionRefresh(e)) {
              try { await refreshSession(); } catch { /* The reconnect error remains visible. */ }
            }
          }
          if ((updated as ImportState).requiresAuthorization) {
            try { await refreshSession(); } catch { /* Reconnection guidance remains visible. */ }
          }
          if (updated.status === 'complete') setNotice(updated.imported ? `${updated.imported} ${updated.imported === 1 ? 'photo is' : 'photos are'} safely in your studio.` : updated.message ?? 'No supported photos were imported. You can choose more photos.');
        }
      } catch (e) {
        if (cancelled) return;
        reportError(e);
        if (e instanceof ApiClientError && (e.status === 429 || e.status >= 500 || e.status === 0)) {
          localRetryAt.current = Date.now() + Math.max(e.retryAfterMs ?? 5000, 1000);
          setPicker(current => current ? { ...current, nextPollAt: Date.now() + Math.max(e.retryAfterMs ?? 5000, 1000), status: current.status === 'ready' ? 'waiting' : current.status } : current);
        } else {
          setPicker(current => current ? { ...current, status: e instanceof ApiClientError && e.status === 410 ? 'expired' : 'error', message: errorMessage(e) } : current);
          if (needsConnectionRefresh(e)) {
            try { await refreshSession(); } catch { /* Keep the actionable original error visible. */ }
          }
          try {
            const latest = await request<ProjectState>('/api/project');
            if (!cancelled) { setProject(latest); if (latest.picker) setPicker(latest.picker); }
          } catch { /* Keep already imported media visible if authorization expired. */ }
        }
      }
    }, delay);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [picker, session?.csrfToken, loadProject, refreshSession,reportError]);

  async function startPicker(contributorId: ContributorId) {
    if (!session) return;
    setError(''); setNotice('');
    // Reserve the window inside the click event, before the asynchronous API call.
    const pickerWindow = window.open('about:blank', '_blank');
    if (!pickerWindow) { setError('Your browser blocked the photo picker. Allow pop-ups for localhost, then choose photos again.'); return; }
    pickerWindow.opener = null;
    setCreating(contributorId);
    let created: PickerState | undefined;
    try {
      created = await request<PickerState>('/api/picker/sessions', { method: 'POST', body: JSON.stringify({ contributorId }) }, session.csrfToken);
      if (!created.pickerUri) throw new Error('Google did not return a photo picker link. Please try again.');
      if (pickerWindow.closed) throw new Error('The photo picker window was closed before it could open. Choose photos again to start a new session.');
      const destination = new URL(created.pickerUri);
      if (destination.protocol !== 'https:' || destination.hostname !== 'photos.google.com') throw new Error('Google returned an unexpected photo picker link. Please try again.');
      pickerWindow.location.replace(destination.href);
      selectedImport.current = created.id; setSelectedImportId(created.id); setPicker(created);
    } catch (e) {
      pickerWindow.close();
      if (created) {
        try { setPicker(await request<PickerState>(`/api/picker/sessions/${created.id}`, { method: 'DELETE' }, session.csrfToken)); }
        catch { setPicker({ ...created, status: 'error', cleanupPending: true, message: 'The picker could not open. Retrying Google session cleanup.' }); }
      }
      reportError(e);
      if (needsConnectionRefresh(e)) {
        try { await refreshSession(); } catch { /* The connection error stays visible. */ }
      }
    } finally { setCreating(undefined); }
  }

  async function cancelPicker() {
    if (!picker || !session || cancelling) return;
    setCancelling(true);
    try {
      const result = await request<PickerState>(`/api/picker/sessions/${picker.id}`, { method: 'DELETE' }, session.csrfToken);
      setPicker(result); setNotice('Photo selection cancelled. Your already imported photos are still here.');
      await loadProject();
    } catch (e) {
      reportError(e);
      if (needsConnectionRefresh(e)) {
        try { await refreshSession(); } catch { /* Keep the original authorization error. */ }
      }
    }
    finally { setCancelling(false); }
  }

  async function updateAsset(asset: Asset, remove = false) {
    if (!session) return;
    setMutating(current => new Set(current).add(asset.id));
    setError('');
    try {
      const path = `/api/projects/${asset.projectId}/assets/${asset.id}`;
      const updated = await request<Asset>(path, { method: remove ? 'DELETE' : 'PATCH', ...(remove ? {} : { body: JSON.stringify({ selected: !asset.selected }) }) }, session.csrfToken);
      setProject(current => current ? { ...current, assets: remove ? current.assets.filter(item => item.id !== asset.id) : current.assets.map(item => item.id === asset.id ? updated : item) } : current);
      if (remove) setNotice('Photo deleted from the local studio. The original in Google Photos is unchanged.');
    } catch (e) {
      reportError(e);
      if (needsConnectionRefresh(e)) {
        try { await refreshSession(); } catch { /* Keep the original authorization error. */ }
      }
    }
    finally { setMutating(current => { const next = new Set(current); next.delete(asset.id); return next; }); }
  }

  async function chooseImportJob(id: string) {
    const previous = selectedImport.current;
    selectedImport.current = id; setSelectedImportId(id); setHistoryPending(true); setError('');
    try {
      const selected = await request<ImportState>(`/api/picker/sessions/${id}`);
      if (selectedImport.current === id) setPicker(selected);
    } catch (error) {
      if (selectedImport.current === id) { selectedImport.current = previous; setSelectedImportId(previous); }
      reportError(error);
    } finally { setHistoryPending(false); }
  }

  async function runJobAction(action: 'resume' | 'retry') {
    if (!picker || !session || jobActionPending) return;
    setJobActionPending(true); setError('');
    try {
      const updated = await request<ImportState>(`/api/picker/sessions/${picker.id}/${action}`, { method: 'POST' }, session.csrfToken);
      importRequests.current.delete(picker.id);
      setPicker(updated);
      setNotice(action === 'retry' ? 'Failed items have been queued to retry.' : 'Your import has resumed from its saved progress.');
    } catch (e) {
      reportError(e);
      if (needsConnectionRefresh(e)) { try { await refreshSession(); } catch { /* Keep the original authorization message. */ } }
    }
    finally { setJobActionPending(false); }
  }

  const assets = project?.assets ?? [];
  const selectedCount = assets.filter(asset => asset.selected).length;
  const galleryQuery: GalleryQuery = useMemo(() => ({
    ...(deferredSearch ? { search: deferredSearch } : {}),
    ...(filter !== 'all' ? { contributorId: filter } : {}),
    ...(selectionFilter !== 'all' ? { selected: selectionFilter === 'selected' } : {}),
    ...(mimeType ? { mimeType } : {}),
  }), [deferredSearch, filter, selectionFilter, mimeType]);
  const visibleAssets = useMemo(() => assets.filter(asset => matchesQuery(asset, galleryQuery)), [assets, galleryQuery]);
  const searchPending = search.trim() !== deferredSearch;
  const isActive = !!picker && activeStatuses.has(picker.status);
  const connectionBusy = isActive || !!picker?.cleanupPending || !!creating || !!checkingConnection || Boolean(project?.jobs?.some(job => activeStatuses.has(job.status) || job.cleanupPending));
  const connectedCount = session?.contributors.filter(person => person.connected && !(person as ContributorConnection).requiresReauthorization).length ?? 0;

  async function bulkSelect(selected: boolean) {
    if (!session || !project || bulkPending || searchPending || !visibleAssets.length) return;
    const query = galleryQuery;
    setBulkPending(true); setError('');
    try {
      const { updated } = await request<{ updated: number }>(`/api/projects/${project.project.id}/assets/selection`, { method: 'PATCH', body: JSON.stringify({ query, selected }) }, session.csrfToken);
      setProject(current => current ? { ...current, assets: current.assets.map(asset => matchesQuery(asset, query) ? { ...asset, selected } : asset) } : current);
      setNotice(`${selected ? 'Selected' : 'Deselected'} ${updated.toLocaleString()} matching ${updated === 1 ? 'photo' : 'photos'}.`);
    } catch (e) { reportError(e); }
    finally { setBulkPending(false); }
  }

  function reconnect(contributorId: ContributorId) { window.location.assign(`/auth/google?person=${contributorId}&reconnect=1`); }
  async function checkConnection(contributorId:ContributorId) {
    if(!session || connectionBusy)return;
    setCheckingConnection(contributorId);setError('');setNotice('');
    try {
      const result=await request<{connection:ContributorConnection & {reauthorizationMessage?:string}}>(`/api/connections/${contributorId}/verify`,{method:'POST'},session.csrfToken);
      const refreshed=await refreshSession();
      const current=refreshed.contributors.find(person=>person.id===contributorId) as ContributorConnection | undefined;
      if(result.connection.connected && current?.connected && !current.requiresReauthorization) setNotice('Google connection verified. Choose photos to open Picker.');
      else setError(result.connection.reauthorizationMessage ?? connectionIssueMessage(result.connection.reauthorizationReason));
    } catch(error) {
      reportError(error);
      try {await refreshSession();} catch { /* Keep the actionable verification error and safe details. */ }
    } finally {setCheckingConnection(undefined);}
  }
  function chooseAgain(contributorId: ContributorId) {
    const connection=session?.contributors.find(person => person.id === contributorId) as ContributorConnection | undefined;
    if (connection?.connected && !connection.requiresReauthorization) void startPicker(contributorId);
    else reconnect(contributorId);
  }

  return <div className="studio-shell">
    <aside className={`sidebar ${mobileNav ? 'is-open' : ''}`} aria-label="Studio navigation">
      <a className="brand" href="#overview" onClick={() => setMobileNav(false)}><span className="brand-icon"><Clapperboard size={21} strokeWidth={1.7} /></span><span>AI Memories<span className="brand-sub">STUDIO</span></span></a>
      <div className="workspace-label">YOUR PRIVATE WORKSPACE</div>
      <nav className="nav-links">
        <a className="nav-item active" href="#overview" onClick={() => setMobileNav(false)}><Layers3 size={18} /> Overview <span className="nav-dot" /></a>
        <a className="nav-item" href="#library" onClick={() => setMobileNav(false)}><Images size={18} /> Memory library <span className="nav-count">{assets.length}</span></a>
        <a className="nav-item" href="#director" onClick={() => setMobileNav(false)}><Sparkles size={18} /> AI Director <span className="soon-label">P3</span></a>
        <a className="nav-item" href="#video-generation" onClick={() => setMobileNav(false)}><Clapperboard size={18} /> Scene clips <span className="soon-label">P4</span></a>
        <a className="nav-item" href="#movie-studio" onClick={() => setMobileNav(false)}><Film size={18} /> Movie Studio <span className="soon-label">P5</span></a>
        <a className="nav-item" href="#storytelling-studio" onClick={() => setMobileNav(false)}><Layers3 size={18} /> Sequence &amp; Storytelling <span className="soon-label">P6.1</span></a>
        <a className="nav-item" href="#production-studio" onClick={() => setMobileNav(false)}><Sparkles size={18} /> Create My Movie <span className="soon-label">P6</span></a>
        <a className="nav-item" href="#whats-next" onClick={() => setMobileNav(false)}><Film size={18} /> The next chapter <span className="soon-label">SOON</span></a>
      </nav>
      <div className="sidebar-note"><div className="note-orbit"><Heart size={17} /></div><h3>Made from your moments.</h3><p>A little ordinary. A little extraordinary. All yours.</p><span className="handwritten">Two lives, one story.</span></div>
      <div className="sidebar-footer"><span className="private-avatar"><LockKeyhole size={16} /></span><div><strong>Personal studio</strong><span>Private · Stored on this device</span></div><ShieldCheck size={16} className="footer-shield" /></div>
    </aside>
    {mobileNav && <button className="nav-scrim" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}

    <div className="main-shell">
      <header className="topbar"><div className="breadcrumb"><Button size="icon" variant="ghost" className="mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(!mobileNav)}><Menu size={20} /></Button><span>Workspace</span><ChevronRight size={13} /><strong>Overview</strong></div><div className="topbar-right"><span className="local-pill"><span /> LOCAL & PRIVATE</span><span className="profile-avatar" aria-label="Personal workspace"><UsersRound size={17} /></span></div></header>

      <main id="overview" className="main-content">
        <div className="page-heading"><div><div className="eyebrow"><span /> A HOME FOR YOUR SHARED STORY</div><h1>Your moments. <em>Beautifully together.</em></h1><p>Bring two collections of memories into one place. The story starts here.</p></div><span className="phase-badge">PHASE 06 <span>·</span> AUTOMATIC PRODUCTION</span></div>

        {error && <div role="alert" className="feedback error-feedback"><CircleHelp size={18} /><div className="feedback-message"><p>{error}</p>{errorDiagnostic?.forMessage===error && <details className="request-diagnostic"><summary>Google request details</summary><dl><div><dt>Operation</dt><dd>{errorDiagnostic.details.operation}</dd></div><div><dt>HTTP status</dt><dd>{errorDiagnostic.details.httpStatus}</dd></div>{errorDiagnostic.details.googleStatus && <div><dt>Google status</dt><dd>{errorDiagnostic.details.googleStatus}</dd></div>}{errorDiagnostic.details.googleCode!==undefined && <div><dt>Google code</dt><dd>{errorDiagnostic.details.googleCode}</dd></div>}{errorDiagnostic.details.reason && <div><dt>Reason</dt><dd>{errorDiagnostic.details.reason}</dd></div>}{errorDiagnostic.details.consumerProject && <div><dt>Google consumer</dt><dd>{errorDiagnostic.details.consumerProject}</dd></div>}</dl><p>{errorDiagnostic.details.message}</p></details>}</div><Button variant="ghost" size="sm" onClick={() => { setError(''); if (!session) void initialize(); }} aria-label={session ? 'Dismiss error' : 'Retry connection'}>{session ? <X size={16} /> : 'Retry'}</Button></div>}
        {notice && <div role="status" className="feedback success-feedback"><Check size={18} /><p>{notice}</p><Button variant="ghost" size="icon" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={16} /></Button></div>}
        {session && !session.configured && <div role="status" className="setup-banner"><LockKeyhole size={18} /><div><strong>Your studio is ready for its Google connection.</strong><p>Add your Google OAuth credentials to the local environment file and restart the API. The README walks you through setup.</p></div><span>SETUP REQUIRED</span></div>}

        <section className="story-card" aria-labelledby="story-title">
          <div className="story-copy"><span className="story-kicker"><FolderHeart size={15} /> YOUR FIRST STORY</span><h2 id="story-title">Every great story<br />starts with <em>you two.</em></h2><p>Favorite places. Familiar faces. The moments you almost forgot. Gather the photos that make your story yours.</p><a className="story-link" href="#connect">Let’s bring them together <ArrowRight size={16} /></a></div>
          <div className="story-art" aria-hidden="true"><div className="art-orbit orbit-one" /><div className="art-orbit orbit-two" /><span className="art-star star-one">✦</span><span className="art-star star-two">✧</span><div className="polaroid polaroid-back"><div className="abstract-landscape"><div className="landscape-sun" /><div className="landscape-hill hill-one" /><div className="landscape-hill hill-two" /></div><span>the places we go</span></div><div className="polaroid polaroid-front"><div className="abstract-memory"><span className="memory-arch arch-one" /><span className="memory-arch arch-two" /><Heart size={25} strokeWidth={1.3} /></div><span>the little things</span></div><div className="art-seal"><Heart size={18} fill="currentColor" /></div><span className="art-caption">a collection of us</span></div>
          <div className="story-footer"><span><LockKeyhole size={13} /> Only the photos you choose.</span><span><ShieldCheck size={13} /> Always in your control.</span></div>
        </section>

        <div className="content-grid">
          <div className="primary-column">
            <section id="connect" className="connect-section" aria-labelledby="connect-title"><div className="section-heading"><div><span className="step-label">01 / BRING YOUR MEMORIES</span><h2 id="connect-title">Two collections. One beginning.</h2></div><span className="section-meta">{connectedCount} of 2 connected</span></div><p className="section-description">Connect each person’s Google Photos, then pick the photos you want to keep.</p>
              <div className="contributor-grid">{(['person1', 'person2'] as const).map((id, index) => {
                const person = session?.contributors.find(contributor => contributor.id === id) as ContributorConnection | undefined;
                const needsReconnect = Boolean(person?.requiresReauthorization);
                const isConnected = Boolean(person?.connected && !needsReconnect);
                const count = assets.filter(asset => asset.contributorId === id).length;
                return <article className={`contributor-card person-${index}`} key={id}><div className="contributor-top"><span className="person-avatar">{index === 0 ? <Heart size={21} strokeWidth={1.5} /> : <UsersRound size={22} strokeWidth={1.5} />}</span><span className={`connection-state ${isConnected ? 'connected' : needsReconnect ? 'needs-reconnect' : ''}`}><span />{isConnected ? 'Connected' : needsReconnect ? 'Needs reconnect' : 'Not connected'}</span></div><h3>{index === 0 ? 'Your memories' : 'Their memories'}</h3><p>{count ? `${count} ${count === 1 ? 'photo' : 'photos'} in your studio` : index === 0 ? 'Your favorite moments, from your side.' : 'A different perspective. The same story.'}</p><Button variant="outline" className="connect-button" disabled={loading || !session?.configured || connectionBusy} onClick={() => isConnected ? void startPicker(id) : needsReconnect ? reconnect(id) : window.location.assign(`/auth/google?person=${id}`)}>{creating === id ? <LoaderCircle size={17} className="animate-spin" /> : <GooglePhotosMark />}{isConnected ? 'Choose photos' : needsReconnect ? 'Reconnect Google Photos' : 'Connect Google Photos'}{isConnected ? <Plus size={14} /> : <ArrowRight size={14} />}</Button>{needsReconnect && <p className="connection-warning">{connectionIssueMessage(person?.reauthorizationReason)}</p>}{(isConnected || needsReconnect) && <Button className="check-connection" variant="ghost" size="sm" disabled={loading || !session?.configured || connectionBusy} onClick={()=>void checkConnection(id)}>{checkingConnection===id && <LoaderCircle size={13} className="animate-spin" />}{checkingConnection===id?'Checking connection…':'Check connection'}</Button>}{isConnected && <a className="switch-account" href={`/auth/google?person=${id}&reconnect=1`} aria-disabled={connectionBusy} onClick={event => { if (connectionBusy) event.preventDefault(); }}>Reconnect Google Photos <ExternalLink size={10} /></a>}</article>;
              })}</div>
              <p className="privacy-caption"><LockKeyhole size={12} /> You choose what to share in Google’s photo picker. Your full library stays private.</p>
            </section>

            {!!project?.jobs?.length && <div className="import-history"><label htmlFor="import-history-job"><Clock3 size={14} /> Import history</label><select id="import-history-job" aria-label="View import job" value={selectedImportId ?? picker?.id ?? project.jobs[0]?.id ?? ''} disabled={historyPending || cancelling || jobActionPending} onChange={event => void chooseImportJob(event.target.value)}>{project.jobs.map((job, index) => {
              const createdAt = (job as PickerState & { createdAt?: number }).createdAt;
              const date = createdAt ? new Date(createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : `Import ${project.jobs!.length - index}`;
              return <option key={job.id} value={job.id}>{date} · {job.contributorId === 'person1' ? 'Yours' : 'Theirs'} · {job.status} · {job.total.toLocaleString()} photos</option>;
            })}</select>{historyPending && <LoaderCircle size={14} className="animate-spin" />}</div>}
            {picker && <ImportProgress picker={picker} cancelling={cancelling} actionPending={jobActionPending} connectionBlocked={connectionBusy} onCancel={() => void cancelPicker()} onResume={() => void runJobAction('resume')} onRetry={() => void runJobAction('retry')} onReconnect={reconnect} onReselect={chooseAgain} />}

            <section id="library" className="library-section" aria-labelledby="library-title"><div className="section-heading"><div><span className="step-label">02 / MAKE IT YOURS</span><h2 id="library-title">Your memory library <span className="heading-count">{assets.length}</span></h2></div><span className="section-meta">{selectedCount} selected</span></div><p className="section-description">Search and organize your collection, a few photos or a few thousand. Open the AI Director below to find your story.</p>
              <div className="gallery-search"><Search size={16} /><input type="search" aria-label="Search imported photos" placeholder="Search filenames or dates…" value={search} onChange={event => setSearch(event.target.value)} />{search && <Button size="icon" variant="ghost" aria-label="Clear photo search" onClick={() => setSearch('')}><X size={15} /></Button>}</div>
              <div className="library-toolbar"><div className="filter-group" aria-label="Filter photos">{([{ id: 'all', label: 'All memories' }, { id: 'person1', label: 'Yours' }, { id: 'person2', label: 'Theirs' }] as const).map(item => <button key={item.id} className={filter === item.id ? 'filter active-filter' : 'filter'} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div><span className="library-count">{visibleAssets.length.toLocaleString()} {visibleAssets.length === 1 ? 'photo' : 'photos'}</span></div>
              <div className="gallery-controls"><label>Selection<select aria-label="Filter by selection" value={selectionFilter} onChange={event => setSelectionFilter(event.target.value as typeof selectionFilter)}><option value="all">All photos</option><option value="selected">Selected</option><option value="unselected">Not selected</option></select></label><label>Format<select aria-label="Filter by format" value={mimeType} onChange={event => setMimeType(event.target.value)}><option value="">All formats</option><option value="image/jpeg">JPEG</option><option value="image/png">PNG</option><option value="image/webp">WebP</option><option value="image/gif">GIF</option></select></label></div>
              <div className="bulk-selection"><span>{visibleAssets.length.toLocaleString()} matching · {selectedCount.toLocaleString()} selected in project</span><div><Button size="sm" variant="outline" disabled={!visibleAssets.length || bulkPending || searchPending || !!mutating.size} onClick={() => void bulkSelect(true)}>{bulkPending && <LoaderCircle size={13} className="animate-spin" />} Select all matching</Button><Button size="sm" variant="ghost" disabled={!visibleAssets.length || bulkPending || searchPending || !!mutating.size} onClick={() => void bulkSelect(false)}>Deselect all matching</Button></div></div>
              {loading ? <div className="gallery-empty"><LoaderCircle size={25} className="animate-spin" /><p>Opening your studio…</p></div> : visibleAssets.length === 0 ? <div className="gallery-empty"><div className="empty-illustration"><span className="empty-frame frame-back" /><span className="empty-frame frame-front"><ImagePlus size={29} strokeWidth={1.2} /></span><span className="empty-spark">✧</span></div><h3>{assets.length ? 'No photos match these filters' : 'Your memories belong here'}</h3><p>{assets.length ? 'Try a different filename, date, collection, selection, or format.' : 'Connect Google Photos above and choose your favorites. Imports are saved in batches, so you can bring a whole collection.'}</p><span className="empty-file-types">JPG, PNG, WEBP & GIF · PRIVATE LOCAL STORAGE</span></div> : <VirtualPhotoGallery assets={visibleAssets} mutating={mutating} disabled={bulkPending} resetKey={JSON.stringify(galleryQuery)} onSelect={asset => void updateAsset(asset)} onDelete={asset => void updateAsset(asset, true)} />}

              <div className="library-footer"><span><ShieldCheck size={13} /> Saved locally. Visible only in your private studio.</span><span><CheckCheck size={13} /> Originals stay in Google Photos</span></div>
            </section>
          </div>

          <aside className="secondary-column" aria-label="Story guide"><section className="journey-card"><span className="rail-eyebrow">THE BIG PICTURE</span><h2>From moments<br />to movie magic.</h2><p>A little collecting now.<br />Something beautiful later.</p><ol className="journey-list"><li className="current-step"><span className="journey-step"><Images size={15} /></span><div><span className="journey-step-meta">YOU ARE HERE</span><h3>Gather your memories</h3><p>Connect, choose, and collect your favorite photos.</p></div></li><li><span className="journey-step"><Sparkles size={15} /></span><div><h3>Find your story</h3><p>Analyze quality, confirm your protagonists, and shape a cinematic storyboard.</p><a className="future-tag" href="#director">OPEN THE AI DIRECTOR</a></div></li><li><span className="journey-step"><Clapperboard size={15} /></span><div><h3>Bring it to life</h3><p>Generate and review individual clips with an approved cost for each scene.</p><a className="future-tag" href="#video-generation">OPEN SCENE CLIPS</a></div></li></ol></section><section className="tip-card"><span className="tip-icon"><Heart size={18} strokeWidth={1.4} /></span><span className="rail-eyebrow">A LITTLE INSPIRATION</span><h3>Start with the<br />moments that feel like you.</h3><p>The blurry laughs. The everyday adventures. A place you both call home. The best stories live in the little things.</p></section><div className="local-note"><LockKeyhole size={16} /><p><strong>Your memories stay yours.</strong><br />Originals stay on this device. AI analysis shares resized copies with Gemini only when you choose Analyze.</p></div></aside>
        </div>

        <DirectorStudio projectId={project?.project.id} assets={assets} csrfToken={session?.csrfToken} />
        <StorytellingStudio projectId={project?.project.id} assets={assets} csrfToken={session?.csrfToken} />
        <ProductionStudio projectId={project?.project.id} csrfToken={session?.csrfToken} />

        <section id="whats-next" className="future-project" aria-labelledby="future-title"><div className="future-project-icon"><Film size={26} strokeWidth={1.25} /></div><div><span className="step-label">THE NEXT CHAPTER</span><h2 id="future-title">A home for all the stories you’ll tell.</h2><p>Your finished movies stay private in Movie Studio. More ways to organize and revisit future projects will come later.</p></div><span className="future-project-badge"><Clock3 size={13} /> COMING LATER</span></section>
        <footer className="main-footer"><span>AI Memories Studio <span>·</span> Made for the moments that matter.</span><span><LockKeyhole size={11} /> Your private creative space</span></footer>
      </main>
    </div>
  </div>;
}
