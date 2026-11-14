// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AnalysisRun, Asset, DirectorState, PhotoAnalysis, PhotoCuration, Protagonist, Storyboard, StoryboardScene } from '@memories/shared';
import { DirectorStudio } from './DirectorStudio';

const uuid = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const asset = (number = 1): Asset => ({ id: uuid(number), projectId: uuid(9000), contributorId: 'person1', filename: `Memory ${number}.jpg`, mimeType: 'image/jpeg', bytes: 1000, importedAt: '2026-11-14T10:00:00Z', selected: true, url: `/api/projects/${uuid(9000)}/assets/${uuid(number)}/content` });
const assets = Array.from({ length: 12 }, (_, index) => asset(index + 1));
const person = (id: 'person1' | 'person2', ready = false): Protagonist => ({ id, name: ready ? id === 'person1' ? 'Maya' : 'Noam' : '', referencePhotoIds: ready ? assets.slice(id === 'person1' ? 0 : 5, id === 'person1' ? 5 : 10).map(item => item.id) : [], likenessPermissionConfirmed: ready, ready, updatedAt: '2026-11-14T10:00:00Z' });
const baseState = (overrides: Partial<DirectorState> = {}): DirectorState => ({ configured: true, model: 'gemini-test', pipelineVersion: '1.0', totalImported: 12, analyzed: 0, pending: 12, duplicateCandidates: 2, usage: { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, reservedUsd: 0, maximumSpendUsd: 10, currency: 'USD', estimatesOnly: true }, protagonists: [person('person1'), person('person2')], ...overrides });
const analysis: PhotoAnalysis = { schemaVersion: '1.0', sharpness: 88, exposure: 81, composition: 82, animationSuitability: 91, storytellingPotential: 89, suitability: 'ANIMATED_ORIGINAL', description: 'A quiet walk in a leafy park.', sceneType: 'Outdoor walk', visibleLocations: ['park'], activities: ['walking'], objects: ['trees'], emotionalTone: 'warm', diversityTags: ['outdoors'], uncertaintyNotes: ['The people have not been identified.'] };
const curation = (assetId: string): PhotoCuration => ({ assetId, pinned: false, excluded: false, protagonistIds: [], associationsConfirmed: false });
const run = (overrides: Partial<AnalysisRun> = {}): AnalysisRun => ({ id: uuid(7000), status: 'running', total: 12, completed: 2, pending: 10, failed: 0, skipped: 0, active: 2, createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:00:00Z', ...overrides });
const scene = (number: number): StoryboardScene => ({ id: uuid(100 + number), sequenceNumber: number, type: number === 3 ? 'NEW_CINEMATIC_SCENE' : 'ORIGINAL_ANIMATION', title: `A moment ${number}`, description: number === 3 ? 'An imagined moonlit walk inspired by the references.' : 'Animate the original photograph gently.', durationSeconds: 25, sourcePhotoIds: [assets[0].id], protagonistIds: ['person1'], visualStyle: 'Natural warm light', cameraDirection: 'Slow push in', motionPrompt: 'Subtle movement', emotionalTone: 'Hopeful', continuityNotes: 'Keep the same clothing.', generationInstructions: 'Use the confirmed references.', isFictional: number === 3, requiresUserConfirmation: number === 3, userConfirmed: false });
const storyboard = (): Storyboard => ({ schemaVersion: '1.0', id: uuid(5000), projectId: uuid(9000), version: 1, title: 'A collection of us', synopsis: 'Two lives, shared moments, imagined possibilities.', targetDurationSeconds: 150, scenes: Array.from({ length: 6 }, (_, index) => scene(index + 1)), createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:00:00Z', status: 'draft', readyForVideoGeneration: false, validationIssues: ['Confirm the fictional cinematic scene.'] });
function response(body: unknown, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => body } as Response; }
function setup(state: DirectorState, handler?: (path: string, options?: RequestInit) => Response | Promise<Response> | undefined) {
  const fetch = vi.fn(async (path: string, options?: RequestInit) => handler?.(path, options) ?? (path.includes('analyzedOnly=true') ? response({photos:[]}) : response(state)));
  vi.stubGlobal('fetch', fetch);
  render(<DirectorStudio projectId={uuid(9000)} assets={assets} csrfToken="private-csrf" />);
  return fetch;
}
let restoreScroll=()=>{};
function mockSectionScroll(){
  const previous=Object.getOwnPropertyDescriptor(HTMLElement.prototype,'scrollIntoView'),scroll=vi.fn();
  Object.defineProperty(HTMLElement.prototype,'scrollIntoView',{configurable:true,value:scroll});
  restoreScroll=()=>{if(previous)Object.defineProperty(HTMLElement.prototype,'scrollIntoView',previous);else Reflect.deleteProperty(HTMLElement.prototype,'scrollIntoView');};
  return scroll;
}
beforeEach(()=>{window.history.replaceState(null,'','/');});
afterEach(() => { cleanup(); restoreScroll(); restoreScroll=()=>{};vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the private AI Director', () => {
  it.each([{hash:'#video-generation',label:'Scene clips P4',heading:'Bring a scene to life.',section:'video-generation'},{hash:'#movie-studio',label:'Movie Studio P5',heading:'A story, ready to keep.',section:'movie-studio'}])('opens $label from analysis, including a repeated unchanged-hash click',async({hash,label,heading,section})=>{
    const scroll=mockSectionScroll(),state=baseState({storyboard:storyboard()});
    const fetch=vi.fn(async(path:string,_options?:RequestInit)=>response(path==='/api/director'?state:{photos:[]}));vi.stubGlobal('fetch',fetch);
    render(<><a href={hash}>{label}</a><DirectorStudio projectId={uuid(9000)} assets={assets} csrfToken="csrf"/></>);
    expect(await screen.findByRole('tab',{name:'AI analysis'})).toHaveAttribute('aria-selected','true');
    fireEvent.click(screen.getByRole('link',{name:label}));
    expect(await screen.findByRole('heading',{name:heading})).toBeInTheDocument();
    expect(screen.getByRole('tab',{name:'Storyboard'})).toHaveAttribute('aria-selected','true');
    await waitFor(()=>expect(scroll.mock.contexts.some(target=>target instanceof HTMLElement&&target.id===section)).toBe(true));
    expect(window.location.hash).toBe(hash);
    fireEvent.click(screen.getByRole('tab',{name:'AI analysis'}));
    expect(screen.queryByRole('heading',{name:heading})).not.toBeInTheDocument();
    scroll.mockClear();fireEvent.click(screen.getByRole('link',{name:label}));
    await screen.findByRole('heading',{name:heading});
    await waitFor(()=>expect(scroll.mock.contexts.some(target=>target instanceof HTMLElement&&target.id===section)).toBe(true));
    expect(fetch.mock.calls.some(([,options])=>options&&'method' in options)).toBe(false);
  });
  it.each([{hash:'#video-generation',heading:'Bring a scene to life.',section:'video-generation'},{hash:'#movie-studio',heading:'A story, ready to keep.',section:'movie-studio'}])('honors $hash after asynchronous storyboard metadata loads',async({hash,heading,section})=>{
    const scroll=mockSectionScroll();window.history.replaceState(null,'',`/${hash}`);
    let resolveDirector!:(value:Response)=>void;
    const pending=new Promise<Response>(resolve=>{resolveDirector=resolve;});
    const fetch=vi.fn(async(path:string)=>path==='/api/director'?pending:response({photos:[]}));vi.stubGlobal('fetch',fetch);
    const view=render(<DirectorStudio assets={assets} csrfToken="csrf"/>);
    expect(document.getElementById(section)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    view.rerender(<DirectorStudio projectId={uuid(9000)} assets={assets} csrfToken="csrf"/>);
    resolveDirector(response(baseState({storyboard:storyboard()})));
    await screen.findByRole('heading',{name:heading});
    expect(screen.getByRole('tab',{name:'Storyboard'})).toHaveAttribute('aria-selected','true');
    await waitFor(()=>expect(scroll.mock.contexts.some(target=>target instanceof HTMLElement&&target.id===section)).toBe(true));
    expect(fetch.mock.calls.every(([path])=>path==='/api/director'||path.startsWith('/api/video?')||path.startsWith('/api/movie?'))).toBe(true);
  });
  it('shows saved Gemini output on the overview without reanalyzing and explains photos outside the finished batch', async () => {
    const records=assets.slice(0,3).map((item,index)=>({assetId:item.id,asset:item,analysis:index<2?analysis:null,features:null,curation:curation(item.id)}));
    const fetch=setup(baseState({totalImported:31,analyzed:29,pending:2,run:run({status:'complete',total:29,completed:29,pending:0,active:0})}),path=>path.startsWith('/api/director/photos?')?response({photos:path.includes('analyzedOnly=true')?records.slice(0,2):records}):undefined);
    const results=await screen.findByRole('region',{name:'Saved analysis results'});
    expect(await within(results).findAllByText(analysis.description)).toHaveLength(2);
    expect(within(results).getAllByRole('img')).toHaveLength(2);
    expect(within(results).getAllByText(/Story 89\/100/)).toHaveLength(2);
    expect(screen.getByText('This batch is complete. 2 photos still need analysis.')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Analyze remaining photos'})).toBeEnabled();
    expect(fetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);
    fireEvent.click(within(results).getByRole('button',{name:'View all analyzed photos'}));
    expect(await screen.findByText('2 matching photos')).toBeInTheDocument();
    expect(screen.getByRole('combobox',{name:'Filter director collection'})).toHaveValue('analyzed');
  });

  it('clearly marks a one-reference save as a draft with one more photo needed', async () => {
    setup(baseState(),(path,options)=>path.endsWith('/protagonists/person1')?response({...person('person1'),...JSON.parse(String(options?.body)),ready:false}):undefined);
    fireEvent.click(await screen.findByRole('tab',{name:'Two protagonists'}));
    const first=screen.getByRole('article',{name:'First protagonist'});
    fireEvent.change(within(first).getByLabelText('First protagonist name'),{target:{value:'Maya'}});
    fireEvent.click(within(first).getByRole('button',{name:/Choose reference photos/}));
    const picker=screen.getByRole('dialog');
    fireEvent.click(within(picker).getByRole('checkbox',{name:`Use ${assets[0].filename} as reference`}));
    fireEvent.click(within(picker).getByRole('button',{name:'Use 1 references'}));
    fireEvent.click(within(first).getByRole('checkbox',{name:"Permission to use first protagonist's likeness"}));
    fireEvent.click(within(first).getByRole('button',{name:'Save protagonist'}));
    expect(await screen.findByText(/Protagonist draft saved\. Add 1 more reference photo\./)).toBeInTheDocument();
    expect(within(first).getByText('1 more reference photo is needed before storyboard generation.')).toBeInTheDocument();
    expect(within(first).queryByText('Ready for your story')).not.toBeInTheDocument();
  });
  it('requires an explicit action and explains the missing server key without sending any photos', async () => {
    const fetch = setup(baseState({ configured: false }));
    expect(await screen.findByText('Gemini setup required')).toBeInTheDocument();
    expect(screen.getByText(/Choosing Analyze sends resized copies of your photos to Google Gemini/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyze photos' })).toBeDisabled();
    expect(screen.getByText(/Set GEMINI_API_KEY/)).toBeInTheDocument();
    expect(fetch.mock.calls.every(([path, options]) => path === '/api/director' && !options?.method)).toBe(true);
    fireEvent.click(screen.getByRole('tab', { name: 'Storyboard' }));
    expect(screen.getByRole('button', { name: 'Create storyboard' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /generate video/i })).not.toBeInTheDocument();
  });

  it('keeps the director private until a project exists', () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    render(<DirectorStudio assets={[]} />);
    expect(screen.getByText('A private story starts with your photos.')).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('saves user-confirmed names, two references and likeness permission with CSRF', async () => {
    let savedInput: Record<string, unknown> | undefined;
    const fetch = setup(baseState(), (path, options) => {
      if (path.endsWith('/protagonists/person1')) {
        savedInput = JSON.parse(String(options?.body));
        return response({ ...person('person1'), ...savedInput, ready: true, updatedAt: '2026-11-14T11:00:00Z' });
      }
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Two protagonists' }));
    const first = screen.getByRole('article', { name: 'First protagonist' });
    fireEvent.change(within(first).getByLabelText('First protagonist name'), { target: { value: 'Maya' } });
    fireEvent.click(within(first).getByRole('button', { name: /Choose reference photos/ }));
    const picker = screen.getByRole('dialog', { name: 'Reference photos for first protagonist' });
    for (const item of assets.slice(0, 2)) fireEvent.click(within(picker).getByRole('checkbox', { name: `Use ${item.filename} as reference` }));
    fireEvent.click(within(picker).getByRole('button', { name: 'Use 2 references' }));
    expect(within(first).getByText('Setup in progress')).toBeInTheDocument();
    fireEvent.click(within(first).getByRole('checkbox', { name: "Permission to use first protagonist's likeness" }));
    fireEvent.click(within(first).getByRole('button', { name: 'Save protagonist' }));
    expect(await within(first).findByText('Ready for your story')).toBeInTheDocument();
    expect(savedInput).toEqual({ name: 'Maya', referencePhotoIds: assets.slice(0, 2).map(item => item.id), likenessPermissionConfirmed: true });
    expect(screen.getByText('Protagonist saved and ready with 2 reference photos. 2 are enough for your storyboard.')).toBeInTheDocument();
    expect(fetch.mock.calls.find(([path]) => path.endsWith('/protagonists/person1'))?.[1]).toMatchObject({ method: 'PUT', credentials: 'include', headers: { 'X-CSRF-Token': 'private-csrf' } });
    expect(screen.getByRole('article', { name: 'Second protagonist' })).toHaveTextContent('Setup in progress');
  });

  it('virtualizes 1,000 reference photos and keeps optional extra references bounded at ten', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(baseState({ totalImported: 1000 }))));
    render(<DirectorStudio projectId={uuid(9000)} assets={Array.from({ length: 1000 }, (_, index) => asset(index + 1))} csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Two protagonists' }));
    fireEvent.click(within(screen.getByRole('article', { name: 'First protagonist' })).getByRole('button', { name: /Choose reference photos/ }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('img').length).toBeLessThan(30);
    for (let index = 1; index <= 11; index++) fireEvent.click(within(dialog).getByRole('checkbox', { name: `Use Memory ${index}.jpg as reference` }));
    expect(within(dialog).getByText('Choose no more than 10 reference photos for each protagonist.')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'Use Memory 11.jpg as reference' })).not.toBeChecked();
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Search reference photos' }), { target: { value: 'Memory 1000.jpg' } });
    expect(within(dialog).getByRole('img', { name: 'Memory 1000.jpg' })).toBeInTheDocument();
    expect(within(dialog).getAllByRole('img')).toHaveLength(1);
  });

  it('starts analysis only on click and can cancel persisted work without dropping results', async () => {
    let current = baseState();
    const fetch = setup(current, (path) => {
      if (path === '/api/director') return response(current);
      if (path === '/api/director/analysis') { current = { ...current, analyzed: 2, pending: 10, run: run() }; return response(current.run); }
      if (path.endsWith('/cancel')) { current = { ...current, run: run({ status: 'cancelled', active: 0 }) }; return response(current.run); }
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Analyze photos' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel analysis' }));
    expect(await screen.findByText('Analysis stopped. Completed results are saved.')).toBeInTheDocument();
    expect(screen.getByText('2 of 12 analyzed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume analysis' })).toBeEnabled();
    expect(fetch.mock.calls.find(([path]) => path.endsWith('/cancel'))?.[1]).toMatchObject({ method: 'POST', headers: { 'X-CSRF-Token': 'private-csrf' } });
  });

  it.each(['resume', 'retry'] as const)('can %s a persisted analysis job', async action => {
    const initial = baseState({ run: run({ status: 'paused', failed: 2, active: 0 }) });
    const fetch = setup(initial, path => path.endsWith(`/${action}`) ? response(run()) : undefined);
    fireEvent.click(await screen.findByRole('button', { name: action === 'resume' ? 'Resume analysis' : 'Retry failed images' }));
    await waitFor(() => expect(fetch.mock.calls.some(([path]) => path === `/api/director/analysis/${initial.run!.id}/${action}`)).toBe(true));
  });

  it('loads all metadata pages while keeping the curation gallery bounded, searchable and manually associated', async () => {
    const all = Array.from({ length: 1000 }, (_, index) => asset(index + 1));
    const records = all.map(item => ({ asset: item, assetId: item.id, analysis, features: null, curation: curation(item.id) }));
    let edited: PhotoCuration = records[0].curation;
    const fetch = vi.fn(async (path: string, options?: RequestInit) => {
      if (path.startsWith('/api/director/photos?')) {
        const after = new URL(path, 'http://localhost').searchParams.get('afterId');
        const start = after ? records.findIndex(item => item.assetId === after) + 1 : 0;
        return response({ photos: records.slice(start, start + 100), nextCursor: start + 100 < records.length ? records[start + 99].assetId : undefined });
      }
      if (path === `/api/director/photos/${records[0].assetId}`) { edited = { ...edited, ...JSON.parse(String(options?.body)), associationsConfirmed: true }; return response(edited); }
      return response(baseState({ totalImported: 1000, analyzed: 1000, pending: 0, protagonists: [person('person1', true), person('person2', true)] }));
    });
    vi.stubGlobal('fetch', fetch);
    render(<DirectorStudio projectId={uuid(9000)} assets={all} csrfToken="csrf" />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Photo curation' }));
    expect(await screen.findByText('1,000 matching photos')).toBeInTheDocument();
    const gallery = screen.getByRole('list', { name: 'Photo curation gallery' });
    expect(within(gallery).getAllByRole('img').length).toBeLessThan(30);
    expect(fetch.mock.calls.filter(([path]) => path.startsWith('/api/director/photos?') && !path.includes('analyzedOnly=true'))).toHaveLength(10);
    fireEvent.click(within(gallery).getByRole('button', { name: 'Review Memory 1.jpg' }));
    const review = screen.getByRole('dialog', { name: 'Review Memory 1.jpg' });
    const association = within(review).getByRole('checkbox', { name: 'Confirm Maya appears in Memory 1.jpg' });
    expect(association).not.toBeChecked();
    expect(within(review).getByText('Identity is not inferred. Leave a person unchecked if you are unsure.')).toBeInTheDocument();
    fireEvent.click(association);
    await waitFor(() => expect(association).toBeChecked());
    expect(edited.protagonistIds).toEqual(['person1']);
    fireEvent.click(within(review).getByRole('button', { name: 'Pin photo' }));
    await waitFor(() => expect(edited.pinned).toBe(true));
    fireEvent.click(within(review).getByRole('button', { name: 'Exclude from story' }));
    await waitFor(() => expect(edited.excluded).toBe(true));
    expect(edited.pinned).toBe(false);
    fireEvent.click(within(review).getByRole('button', { name: 'Close photo review' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search analyzed photos' }), { target: { value: 'walking' } });
    expect(screen.getByText('1,000 matching photos')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search analyzed photos' }), { target: { value: 'Memory 1000.jpg' } });
    expect(within(gallery).getByRole('img', { name: 'Memory 1000.jpg' })).toBeInTheDocument();
  });

  it('edits scene descriptions, prompts and duration, confirms fiction, and only trusts server readiness after saving', async () => {
    let saved = storyboard(); let savedBody: Record<string, unknown> | undefined;
    const fetch = setup(baseState({ analyzed: 12, pending: 0, protagonists: [person('person1', true), person('person2', true)], storyboard: saved }), (path, options) => {
      if (options?.method === 'PUT') { savedBody = JSON.parse(String(options.body)); saved = { ...saved, ...savedBody, version: 2, readyForVideoGeneration: true, status: 'validated', validationIssues: [] } as Storyboard; return response(saved); }
    });
    fireEvent.click(await screen.findByRole('tab', { name: 'Storyboard' }));
    expect(screen.getByText('Draft · review required')).toBeInTheDocument();
    expect(screen.getByText('AI-created · Fictional')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Scene 1 duration' }), { target: { value: '26' } });
    expect(screen.getByText('Scene durations must add up to exactly 150 seconds. Current total: 151 seconds.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Scene 1 duration' }), { target: { value: '25' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Scene 1 description' }), { target: { value: 'A slow, gentle reveal of the real photograph.' } });
    fireEvent.change(screen.getByLabelText('Scene 1 motion prompt'), { target: { value: 'Only a little movement in the leaves.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Confirm fictional scene 3' }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    expect(screen.queryByText('Ready for video generation')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Download saved draft JSON' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save storyboard version' }));
    expect(await screen.findByText('Ready for video generation')).toBeInTheDocument();
    expect((savedBody?.scenes as StoryboardScene[])[0]).toMatchObject({ durationSeconds: 25, description: 'A slow, gentle reveal of the real photograph.', motionPrompt: 'Only a little movement in the leaves.' });
    expect((savedBody?.scenes as StoryboardScene[])[2].userConfirmed).toBe(true);
    expect(screen.getByRole('link', { name: 'Download P4 storyboard' })).toHaveAttribute('href', `/api/director/storyboards/${saved.id}/export`);
    expect(fetch.mock.calls.find(([, options]) => options?.method === 'PUT')?.[1]).toMatchObject({ credentials: 'include', headers: { 'X-CSRF-Token': 'private-csrf' } });
    expect(screen.queryByRole('button', { name: /generate video/i })).not.toBeInTheDocument();
  });
  it('shows two approved reference-only photos per protagonist as ready without asking for more pictures',async()=>{
    const profiles=[{...person('person1',true),referencePhotoIds:assets.slice(0,2).map(item=>item.id),readinessIssues:[]},{...person('person2',true),referencePhotoIds:assets.slice(2,4).map(item=>item.id),readinessIssues:[]}];
    const fetch=vi.fn(async(_path:string,_options?:RequestInit)=>response(baseState({protagonists:profiles})));vi.stubGlobal('fetch',fetch);
    render(<DirectorStudio projectId={uuid(9000)} assets={assets.map(item=>({...item,selected:false}))} csrfToken="private-csrf"/>);
    expect(await screen.findByText('Both protagonists are ready with confirmed references and permission.')).toBeInTheDocument();fireEvent.click(screen.getByRole('tab',{name:'Two protagonists'}));
    expect(screen.getAllByText('Ready for your story')).toHaveLength(2);expect(screen.queryByText('Setup in progress')).not.toBeInTheDocument();
    expect(screen.getAllByText(/2 reference photos selected. 2 are enough/)).toHaveLength(2);expect(screen.getAllByText(/A photo excluded from the movie can still be an explicitly approved protagonist reference/)).toHaveLength(2);
    expect(fetch.mock.calls.every(([,options])=>!(options as RequestInit|undefined)?.method)).toBe(true);
  });
  it.each([{issue:'A selected reference photo file is missing. Restore it or choose a replacement.',consent:true},{issue:'Confirm permission to use this person’s likeness.',consent:false}])('shows the actual profile requirement with two references: $issue',async({issue,consent})=>{
    const firstProfile={...person('person1',true),referencePhotoIds:assets.slice(0,2).map(item=>item.id),ready:false,likenessPermissionConfirmed:consent,readinessIssues:[issue]};
    setup(baseState({protagonists:[firstProfile,person('person2',true)]}),(path,options)=>path.endsWith('/protagonists/person1')?response({...firstProfile,...JSON.parse(String(options?.body)),readinessIssues:[issue],ready:false}):undefined);
    fireEvent.click(await screen.findByRole('tab',{name:'Two protagonists'}));const first=screen.getByRole('article',{name:'First protagonist'});expect(within(first).getByRole('list',{name:'First protagonist remaining requirements'})).toHaveTextContent(issue);expect(within(first).queryByText(/more reference.*needed/)).not.toBeInTheDocument();
    fireEvent.change(within(first).getByLabelText('First protagonist name'),{target:{value:'Maya updated'}});fireEvent.click(within(first).getByRole('button',{name:'Save protagonist'}));expect(await screen.findByText(`Protagonist draft saved. ${issue} Complete this profile before creating a storyboard.`)).toBeInTheDocument();
    expect(screen.queryByText(/Protagonist draft saved. Add .*more reference/)).not.toBeInTheDocument();
  });

  it('allows a 391-second storyboard and clearly rejects durations above the shared 15-minute bound',async()=>{const fetch=setup(baseState({analyzed:12,pending:0,protagonists:[person('person1',true),person('person2',true)]}));fireEvent.click(await screen.findByRole('tab',{name:'Storyboard'}));const field=screen.getByRole('spinbutton',{name:'Movie duration in seconds'});expect(field).toHaveAttribute('max','900');fireEvent.change(field,{target:{value:'391'}});expect(screen.getByRole('button',{name:'Create storyboard'})).toBeEnabled();fireEvent.change(field,{target:{value:'901'}});expect(screen.getByRole('button',{name:'Create storyboard'})).toBeDisabled();expect(screen.getByText('Choose a whole-number duration between 120 and 900 seconds (2–15 minutes).')).toBeInTheDocument();expect(fetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);});

});
