// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import '@testing-library/jest-dom/vitest';
import App from './App';
import {cinematicPreferencesSchema} from '@memories/shared';
import type { Asset, PickerState, ProjectState, SessionInfo } from '@memories/shared';

const disconnected: SessionInfo = { authenticated: false, configured: false, csrfToken: 'csrf-test', contributors: [{ id: 'person1', label: 'Your memories', connected: false }, { id: 'person2', label: 'Their memories', connected: false }] };
const connected: SessionInfo = { ...disconnected, authenticated: true, configured: true, contributors: [{ id: 'person1', label: 'Your memories', connected: true }, disconnected.contributors[1]] };
const asset: Asset = { id: '790b60dd-aec7-4cc4-826e-c70ca3f103c3', projectId: '6f234f6e-b244-4810-91c8-a015c29e351d', contributorId: 'person1', filename: 'Our trip.jpg', mimeType: 'image/jpeg', bytes: 1000, importedAt: '2026-11-14T10:00:00Z', selected: true, url: '/api/projects/p/assets/a/content' };
const project: ProjectState = { project: { id: asset.projectId, name: 'Our story', createdAt: asset.importedAt }, assets: [asset] };
const emptyStorytelling={sequences:[],preferences:cinematicPreferencesSchema.parse({}),importedCount:1,analyzedCount:0,analysisVersion:'test',warnings:[]};
function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }

beforeEach(() => { window.history.replaceState(null, '', '/'); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the private studio dashboard', () => {
  it('shows missing-scope credentials as needing reconnect and preserves the local gallery', async () => {
    const needsReconnect={...connected,contributors:connected.contributors.map(person=>person.id==='person1'?{...person,connected:false,requiresReauthorization:true,reauthorizationReason:'MISSING_PHOTOS_SCOPE'}:person)};
    vi.stubGlobal('fetch',vi.fn(async(path:string)=>response(path==='/api/cinematic'?emptyStorytelling:path==='/api/session'?needsReconnect:project)));
    render(<App />);
    expect(await screen.findByText('Needs reconnect')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Reconnect Google Photos'})).toBeEnabled();
    expect(screen.queryByRole('button',{name:'Choose photos'})).not.toBeInTheDocument();
    expect(screen.getByText('The Photos Picker permission is missing. Reconnect and approve access to the photos you select.')).toBeInTheDocument();
    expect(await screen.findByRole('img',{name:asset.filename})).toBeInTheDocument();
  });

  it('offers explicit reauthorization for a connected contributor without switching the other slot', async () => {
    vi.stubGlobal('fetch',vi.fn(async(path:string)=>response(path==='/api/cinematic'?emptyStorytelling:path==='/api/session'?connected:project)));
    render(<App />);
    const reconnect=await screen.findByRole('link',{name:'Reconnect Google Photos'});
    expect(reconnect).toHaveAttribute('href','/auth/google?person=person1&reconnect=1');
    expect(screen.getByRole('button',{name:'Choose photos'})).toBeEnabled();
    expect(screen.getByRole('button',{name:'Connect Google Photos'})).toBeEnabled();
  });

  it('checks the chosen connection with CSRF and refreshes its authorization status without starting a Picker', async () => {
    const calls:{path:string;options?:RequestInit}[]=[];
    vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>{
      calls.push({path,options});
      if(path==='/api/cinematic')return response(emptyStorytelling);
      if(path==='/api/session')return response(connected);
      if(path==='/api/connections/person1/verify')return response({clientPairVerified:true,connection:{connected:true,requiresReauthorization:false}});
      return response(project);
    }));
    render(<App />);fireEvent.click(await screen.findByRole('button',{name:'Check connection'}));
    expect(await screen.findByText('Google connection verified. Choose photos to open Picker.')).toBeInTheDocument();
    expect(calls.find(call=>call.path==='/api/connections/person1/verify')?.options).toMatchObject({method:'POST',credentials:'include',headers:{'X-CSRF-Token':connected.csrfToken}});
    expect(calls.filter(call=>call.path==='/api/session')).toHaveLength(2);
    expect(calls.some(call=>call.path.includes('person2/verify')||call.path==='/api/picker/sessions')).toBe(false);
    expect(screen.getByRole('button',{name:'Choose photos'})).toBeEnabled();
  });

  it('keeps a failed connection check specific to its contributor and exposes its safe diagnostic', async () => {
    let checked=false;
    const bothConnected={...connected,contributors:connected.contributors.map(person=>({...person,connected:true}))};
    const needsReconnect={...bothConnected,contributors:bothConnected.contributors.map(person=>person.id==='person1'?{...person,connected:false,requiresReauthorization:true,reauthorizationReason:'WRONG_OAUTH_CLIENT'}:person)};
    const calls:{path:string;options?:RequestInit}[]=[];
    vi.stubGlobal('fetch',vi.fn(async(path:string,options?:RequestInit)=>{
      calls.push({path,options});
      if(path==='/api/cinematic')return response(emptyStorytelling);
      if(path==='/api/session')return response(checked?needsReconnect:bothConnected);
      if(path==='/api/connections/person1/verify'){
        checked=true;
        return response({error:{code:'WRONG_OAUTH_CLIENT',message:'The saved authorization belongs to another OAuth client. Reconnect Google Photos.',diagnostic:{operation:'oauth.tokenInfo',httpStatus:200,reason:'OAUTH_CLIENT_MISMATCH',message:'The OAuth client does not match this grant.'}}},403);
      }
      return response(project);
    }));
    render(<App />);fireEvent.click((await screen.findAllByRole('button',{name:'Check connection'}))[0]);
    expect(await screen.findByText('Needs reconnect')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Reconnect Google Photos'})).toBeEnabled();
    expect(screen.getAllByRole('button',{name:'Choose photos'})).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('The saved authorization belongs to another OAuth client.');
    fireEvent.click(screen.getByText('Google request details'));expect(screen.getByRole('alert')).toHaveTextContent('OAUTH_CLIENT_MISMATCH');
    expect(calls.filter(call=>call.path.endsWith('/verify'))).toHaveLength(1);
    expect(calls.some(call=>call.path.includes('person2/verify'))).toBe(false);
    expect(screen.getByRole('img',{name:asset.filename})).toBeInTheDocument();
  });

  it('explains Google OAuth test-user restrictions without assuming every denial has that cause', async () => {
    window.history.replaceState(null,'','/?auth=oauth_testing_required');
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(disconnected)));
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Google Auth Platform → Audience → Test users');
    expect(screen.getByRole('alert')).toHaveTextContent('Google blocked access to this testing app.');
  });

  it('refreshes contributor authorization after a Picker missing-scope response instead of retaining Connected', async () => {
    let reads=0;
    const needsReconnect={...connected,contributors:connected.contributors.map(person=>person.id==='person1'?{...person,connected:false,requiresReauthorization:true,reauthorizationReason:'MISSING_PHOTOS_SCOPE'}:person)};
    vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
      if(path==='/api/cinematic')return response(emptyStorytelling);
      if(path==='/api/session')return response(++reads===1?connected:needsReconnect);
      if(path==='/api/picker/sessions')return response({error:{code:'MISSING_PHOTOS_SCOPE',message:'The saved token does not grant Google Photos Picker access. Reconnect Google Photos.'}},403);
      return response(project);
    }));
    const pickerWindow={opener:window,closed:false,location:{replace:vi.fn()},close:vi.fn()};
    vi.spyOn(window,'open').mockReturnValue(pickerWindow as unknown as Window);
    render(<App />);fireEvent.click(await screen.findByRole('button',{name:'Choose photos'}));
    expect(await screen.findByText('Needs reconnect')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Reconnect Google Photos'})).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('The saved token does not grant Google Photos Picker access.');
    expect(screen.getByRole('img',{name:asset.filename})).toBeInTheDocument();expect(pickerWindow.close).toHaveBeenCalled();
  });

  it('shows sanitized Google operation and reason details without treating every 403 as a missing scope', async () => {
    vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
      if(path==='/api/cinematic')return response(emptyStorytelling);
      if(path==='/api/session')return response(connected);
      if(path==='/api/picker/sessions')return response({error:{code:'GOOGLE_API_DISABLED',message:'Google reports that Photos Picker is disabled for the OAuth client’s consumer project.',diagnostic:{operation:'picker.sessions.create',httpStatus:403,googleCode:403,googleStatus:'PERMISSION_DENIED',reason:'SERVICE_DISABLED',consumerProject:'projects/123456',message:'The Photos Picker service is disabled for this consumer project.'}}},403);
      return response(project);
    }));
    vi.spyOn(window,'open').mockReturnValue({opener:window,closed:false,location:{replace:vi.fn()},close:vi.fn()} as unknown as Window);
    render(<App />);fireEvent.click(await screen.findByRole('button',{name:'Choose photos'}));
    const alert=await screen.findByRole('alert');expect(alert).toHaveTextContent('Google reports that Photos Picker is disabled');
    fireEvent.click(screen.getByText('Google request details'));
    expect(alert).toHaveTextContent('picker.sessions.create');expect(alert).toHaveTextContent('403');
    expect(alert).toHaveTextContent('SERVICE_DISABLED');expect(alert).toHaveTextContent('projects/123456');
    expect(screen.getByRole('button',{name:'Choose photos'})).toBeEnabled();
    expect(screen.queryByText('Needs reconnect')).not.toBeInTheDocument();
  });

  it('explains missing setup without making unavailable connections clickable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(disconnected)));
    render(<App />);
    expect(await screen.findByText('Your studio is ready for its Google connection.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Connect Google Photos/ })).toHaveLength(2);
    screen.getAllByRole('button', { name: /Connect Google Photos/ }).forEach(button => expect(button).toBeDisabled());
    expect(screen.getByRole('heading', { name: 'Your memories belong here' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /generate|create movie/i })).not.toBeInTheDocument();
  });

  it('never creates a Google session when a browser blocks the picker window', async () => {
    const fetchMock = vi.fn(async (path: string) => response(path === '/api/cinematic' ? emptyStorytelling : path === '/api/session' ? connected : project));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Choose photos/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your browser blocked the photo picker');
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/picker/sessions')).toBe(false);
  });

  it('opens a reserved tab and navigates to the real Picker URI, then offers cancellation', async () => {
    const picker: PickerState = { id: 'local-picker-id', contributorId: 'person1', status: 'waiting', pickerUri: 'https://photos.google.com/picker/session', pollIntervalMs: 60000, nextPollAt: Date.now() + 60000, deadline: Date.now() + 120000, total: 0, processed: 0, imported: 0, skipped: 0, failed: 0, issues: [] };
    const calls: { path: string; options?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      calls.push({ path, options });
      return response(path === '/api/cinematic' ? emptyStorytelling : path === '/api/session' ? connected : path === '/api/picker/sessions' ? picker : project);
    }));
    const locationReplace = vi.fn();
    const pickerWindow = { opener: window, closed: false, location: { replace: locationReplace }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(pickerWindow as unknown as Window);
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /Choose photos/ }));
    await waitFor(() => expect(locationReplace).toHaveBeenCalledWith(picker.pickerUri));
    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(pickerWindow.opener).toBeNull();
    const create = calls.find(call => call.path === '/api/picker/sessions');
    expect(create?.options).toMatchObject({ method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': 'csrf-test' }, body: JSON.stringify({ contributorId: 'person1' }) });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByText('Finish your selection with Done in the other tab. This studio will update automatically.')).toBeInTheDocument();
  });

  it('updates selected photos through the authenticated API and supports local deletion', async () => {
    const calls: { path: string; options?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      calls.push({ path, options });
      if (options?.method === 'PATCH') return response({ ...asset, selected: false });
      if (options?.method === 'DELETE') return response(undefined, 204);
      return response(path === '/api/cinematic' ? emptyStorytelling : path === '/api/session' ? connected : project);
    }));
    render(<App />);
    const checkbox = await screen.findByRole('checkbox', { name: 'Select Our trip.jpg' });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox).not.toBeChecked());
    expect(screen.getByText('0 selected')).toBeInTheDocument();
    const patch = calls.find(call => call.options?.method === 'PATCH');
    expect(patch?.options).toMatchObject({ credentials: 'include', headers: { 'X-CSRF-Token': 'csrf-test' }, body: JSON.stringify({ selected: false }) });
    fireEvent.click(screen.getByRole('button', { name: 'Delete Our trip.jpg' }));
    expect(await screen.findByText('Photo deleted from the local studio. The original in Google Photos is unchanged.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Our trip.jpg' })).not.toBeInTheDocument();
  });

  it('imports a ready selection once and polls local import progress without waiting for the previous Google interval', async () => {
    const ready: PickerState = { id: 'ready-picker', contributorId: 'person1', status: 'ready', pollIntervalMs: 60000, nextPollAt: Date.now() + 60000, deadline: Date.now() + 120000, total: 0, processed: 0, imported: 0, skipped: 0, failed: 0, issues: [] };
    const completed = { ...ready, status: 'complete', total: 1, processed: 1, imported: 1 } as const;
    let imported = false;
    const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/api/session') return response(connected);
      if (path === '/api/project') return response({ ...project, assets: imported ? [asset] : [], picker: imported ? completed : ready });
      if (options?.method === 'POST') return response({ ...ready, status: 'importing', total: 1 });
      imported = true;
      return response(completed);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByText('1 photo is safely in your studio.', {}, { timeout: 2500 })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Our trip.jpg' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter(([path, options]) => path.endsWith('/import') && options?.method === 'POST')).toHaveLength(1);
  });

  it('retains an expired selection message and enables choosing a fresh session', async () => {
    const expired: PickerState = { id: 'expired-picker', contributorId: 'person1', status: 'expired', pollIntervalMs: 1000, nextPollAt: 0, deadline: 0, total: 0, processed: 0, imported: 0, skipped: 0, failed: 0, issues: [], message: 'Your Google Photos selection expired. Choose photos again to start a new session.' };
    vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path === '/api/cinematic' ? emptyStorytelling : path === '/api/session' ? connected : { ...project, picker: expired })));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Photo selection expired' })).toBeInTheDocument();
    expect(screen.getByText(expired.message!)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose photos' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Choose photos again' })).toBeEnabled();
  });

  it('clears protected gallery data and offers reconnecting when credentials are revoked during selection', async () => {
    const waiting: PickerState = { id: 'revoked-picker', contributorId: 'person1', status: 'waiting', pollIntervalMs: 1000, nextPollAt: 0, deadline: Date.now() + 60000, total: 0, processed: 0, imported: 0, skipped: 0, failed: 0, issues: [] };
    let sessionReads = 0;
    let projectReads = 0;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => {
      if (path === '/api/session') return response(++sessionReads === 1 ? connected : { ...disconnected, configured: true });
      if (path === '/api/project') return ++projectReads === 1 ? response({ ...project, picker: waiting }) : response({ error: { code: 'RECONNECT_REQUIRED', message: 'Reconnect Google Photos to continue.' } }, 401);
      return response({ ...waiting, status: 'error', cleanupPending: false, message: 'Google Photos permissions were revoked. Reconnect to continue.' });
    }));
    render(<App />);
    expect(await screen.findByRole('img', { name: asset.filename })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Connect Google Photos/ })).toHaveLength(2));
    expect(screen.queryByRole('img', { name: asset.filename })).not.toBeInTheDocument();
    screen.getAllByRole('button', { name: /Connect Google Photos/ }).forEach(button => expect(button).toBeEnabled());
    expect(screen.getByRole('alert')).toHaveTextContent('Reconnect Google Photos to continue.');
  });
});

describe('large photo collections', () => {
  function collection(count = 1000): ProjectState {
    return { ...project, assets: Array.from({ length: count }, (_, index) => ({
      ...asset,
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      filename: `Photo ${String(index).padStart(4, '0')}.jpg`,
      contributorId: index % 2 ? 'person2' as const : 'person1' as const,
      selected: false,
      mimeType: index % 5 ? 'image/jpeg' : 'image/png',
      createdAt: index === 987 ? '2024-02-03T12:00:00Z' : '2020-01-01T00:00:00Z',
    })) };
  }

  it('mounts a bounded number of photos and replaces rows while scrolling through 1,000 items', async () => {
    const photos = collection();
    vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path === '/api/cinematic' ? emptyStorytelling : path === '/api/session' ? connected : photos)));
    render(<App />);
    const gallery = await screen.findByRole('list', { name: 'Imported photo gallery' });
    expect(screen.getAllByRole('img').length).toBeLessThan(30);
    expect(screen.getByRole('img', { name: 'Photo 0000.jpg' })).toBeInTheDocument();
    expect(gallery.querySelector('[aria-setsize="1000"]')).toBeInTheDocument();
    fireEvent.scroll(gallery, { target: { scrollTop: 8500 } });
    await waitFor(() => expect(screen.queryByRole('img', { name: 'Photo 0000.jpg' })).not.toBeInTheDocument());
    expect(screen.getAllByRole('img').length).toBeLessThan(30);
    expect(screen.getByText('1,000 photos')).toBeInTheDocument();
  });

  it('searches offscreen metadata and combines contributor, selection, and format filters', async () => {
    const photos = collection();
    vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path === '/api/cinematic' ? emptyStorytelling : path === '/api/session' ? connected : photos)));
    render(<App />);
    const search = await screen.findByRole('searchbox', { name: 'Search imported photos' });
    await screen.findByRole('list', { name: 'Imported photo gallery' });
    fireEvent.change(search, { target: { value: '2024-02' } });
    expect(await screen.findByRole('img', { name: 'Photo 0987.jpg' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Yours' }));
    expect(await screen.findByRole('heading', { name: 'No photos match these filters' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Theirs' }));
    expect(await screen.findByRole('img', { name: 'Photo 0987.jpg' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by format' }), { target: { value: 'image/png' } });
    expect(await screen.findByRole('heading', { name: 'No photos match these filters' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by format' }), { target: { value: 'image/jpeg' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by selection' }), { target: { value: 'selected' } });
    expect(await screen.findByRole('heading', { name: 'No photos match these filters' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter by selection' }), { target: { value: 'unselected' } });
    expect(await screen.findByRole('img', { name: 'Photo 0987.jpg' })).toBeInTheDocument();
  });

  it('selects all 1,000 matching photos by server query instead of only mounted rows', async () => {
    const photos = collection();
    const calls: { path: string; options?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      calls.push({ path, options });
      if (options?.method === 'PATCH') return response({ updated: 1000 });
      return response(path === '/api/cinematic' ? emptyStorytelling : path === '/api/session' ? connected : photos);
    }));
    render(<App />);
    await screen.findByRole('list', { name: 'Imported photo gallery' });
    expect(screen.getAllByRole('img').length).toBeLessThan(30);
    fireEvent.click(screen.getByRole('button', { name: 'Select all matching' }));
    expect(await screen.findByText('Selected 1,000 matching photos.')).toBeInTheDocument();
    expect(screen.getByText('1,000 selected in project', { exact: false })).toBeInTheDocument();
    const bulk = calls.find(call => call.path.endsWith('/assets/selection'));
    expect(bulk?.options).toMatchObject({ method: 'PATCH', credentials: 'include', headers: { 'X-CSRF-Token': connected.csrfToken }, body: JSON.stringify({ query: {}, selected: true }) });
    screen.getAllByRole('checkbox').forEach(checkbox => expect(checkbox).toBeChecked());
  });

  it('reports all queue counts and offers retry and checkpoint resume actions', async () => {
    const paused = { id: 'durable-job', contributorId: 'person1', status: 'paused', pollIntervalMs: 1000, nextPollAt: 0, deadline: Date.now() + 3600000, total: 500, processed: 115, completed: 100, imported: 100, skipped: 10, failed: 5, remaining: 385, issues: [], resumable: true, message: 'Storage was temporarily unavailable. Your completed photos are saved.' } as unknown as PickerState;
    const calls: { path: string; options?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      calls.push({ path, options });
      if (path === '/api/session') return response(connected);
      if (options?.method === 'POST') return response({ ...paused, status: 'importing' });
      return response({ ...project, picker: paused });
    }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Your import is paused' })).toBeInTheDocument();
    expect(screen.getByLabelText('Import item counts')).toHaveTextContent('Total500Completed100Failed5Skipped10Remaining385');
    expect(screen.getByRole('button', { name: 'Resume import' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry failed items' }));
    expect(await screen.findByText('Failed items have been queued to retry.')).toBeInTheDocument();
    expect(calls.find(call => call.path.endsWith('/durable-job/retry'))?.options).toMatchObject({ method: 'POST', headers: { 'X-CSRF-Token': connected.csrfToken } });
  });

  it('keeps already imported photos available while requesting renewed Google authorization', async () => {
    const paused = { id: 'authorization-paused', contributorId: 'person1', status: 'paused', pollIntervalMs: 1000, nextPollAt: 0, deadline: Date.now() + 3600000, total: 1000, processed: 400, imported: 400, completed: 400, skipped: 0, failed: 0, remaining: 600, issues: [], requiresAuthorization: true, resumable: true } as unknown as PickerState;
    vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path === '/api/cinematic' ? emptyStorytelling : path === '/api/session' ? { ...connected, contributors: disconnected.contributors } : { ...project, picker: paused })));
    render(<App />);
    expect(await screen.findByRole('img', { name: asset.filename })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reconnect Google Photos' })).toBeEnabled();
    expect(screen.getByText('Reconnect the same Google account to continue. If Google can no longer provide this selection, choose the remaining photos again.')).toBeInTheDocument();
  });
});

describe('persistent import history', () => {
  it('resumes an older job and preserves that selection when a newer job is the project default', async () => {
    const base: PickerState = { id: 'older-job', contributorId: 'person1', status: 'paused', pollIntervalMs: 1000, nextPollAt: 0, deadline: Date.now() + 3600000, total: 3, processed: 1, imported: 1, completed: 1, skipped: 0, failed: 0, remaining: 2, resumable: true, issues: [], message: 'Older import paused at its saved checkpoint.' };
    const newer: PickerState = { ...base, id: 'newer-job', status: 'complete', total: 500, processed: 500, imported: 500, completed: 500, remaining: 0, message: 'The most recent import is complete.' };
    const completed: PickerState = { ...base, status: 'complete', processed: 3, imported: 3, completed: 3, remaining: 0, message: 'Older import completed.' };
    let resumed = false;
    const calls: { path: string; options?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, options?: RequestInit) => {
      calls.push({ path, options });
      if (path === '/api/session') return response(connected);
      if (path === '/api/project') return response({ ...project, picker: newer, jobs: [newer, resumed ? completed : base] });
      if (path === '/api/picker/sessions/older-job/resume') { resumed = true; return response({ ...base, status: 'importing' }); }
      if (path === '/api/picker/sessions/older-job') return response(resumed ? completed : base);
      return response(newer);
    }));
    render(<App />);
    const history = await screen.findByRole('combobox', { name: 'View import job' });
    expect(history).toHaveValue('newer-job');
    fireEvent.change(history, { target: { value: 'older-job' } });
    expect(await screen.findByText('Older import paused at its saved checkpoint.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume import' }));
    expect(await screen.findByText('Older import completed.', {}, { timeout: 2500 })).toBeInTheDocument();
    expect(history).toHaveValue('older-job');
    expect(screen.queryByText('The most recent import is complete.')).not.toBeInTheDocument();
    expect(calls.find(call => call.path.endsWith('/older-job/resume'))?.options).toMatchObject({ method: 'POST', headers: { 'X-CSRF-Token': connected.csrfToken } });
  });
});

describe('import account safety', () => {
  it('keeps account changes blocked when an older paused job is selected while another import is active', async () => {
    const older: PickerState = { id: 'older-auth', contributorId: 'person1', status: 'paused', pollIntervalMs: 1000, nextPollAt: 0, deadline: Date.now() + 3600000, total: 100, processed: 50, imported: 50, completed: 50, skipped: 0, failed: 0, remaining: 50, issues: [], resumable: true, requiresAuthorization: true };
    const newer: PickerState = { ...older, id: 'newer-running', status: 'importing', requiresAuthorization: false };
    vi.stubGlobal('fetch', vi.fn(async (path: string) => response(path === '/api/cinematic' ? emptyStorytelling : path === '/api/session' ? connected : path === '/api/picker/sessions/older-auth' ? older : { ...project, picker: newer, jobs: [newer, older] })));
    render(<App />);
    const history = await screen.findByRole('combobox', { name: 'View import job' });
    fireEvent.change(history, { target: { value: older.id } });
    expect(await screen.findByRole('button', { name: 'Reconnect Google Photos' })).toBeDisabled();
    expect(screen.getByText('Finish or cancel any active import, and wait for Google cleanup before reconnecting or choosing more photos.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose photos' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connect Google Photos' })).toBeDisabled();
  });
});
