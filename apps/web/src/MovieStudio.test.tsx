// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { movieSettingsSchema,textOverlaySchema, type Asset, type MovieRenderAsset, type MovieRenderJob, type MovieStudioState, type MovieSoundtrack, type Storyboard } from '@memories/shared';
import { MovieStudio } from './MovieStudio';

const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const photo: Asset = { id: id(1), projectId: id(9), contributorId: 'person1', filename: 'A private memory.jpg', mimeType: 'image/jpeg', bytes: 100, importedAt: '2026-11-14T10:00:00Z', selected: true, url: `/api/projects/${id(9)}/assets/${id(1)}/content` };
const board: Storyboard = { schemaVersion: '1.0', id: id(20), projectId: id(9), version: 2, title: 'Our story', synopsis: 'Our approved movie plan.', targetDurationSeconds: 150, scenes: [{ id: id(101), sequenceNumber: 1, type: 'ORIGINAL_ANIMATION', title: 'The beginning', description: 'A faithful memory.', durationSeconds: 8, sourcePhotoIds: [photo.id], protagonistIds: ['person1'], visualStyle: 'Natural light', cameraDirection: 'Slow drift', motionPrompt: 'Subtle movement', emotionalTone: 'Warm', continuityNotes: '', generationInstructions: 'Preserve the composition.', isFictional: false, requiresUserConfirmation: true, userConfirmed: true }], createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:00:00Z', status: 'validated', readyForVideoGeneration: true, validationIssues: [] };
function studio(overrides: Partial<MovieStudioState> = {}): MovieStudioState {
  return { settings: movieSettingsSchema.parse({}), timeline: { storyboardId: board.id, targetDurationSeconds: 150, durationSeconds: 150, totalSourceDurationSeconds: 151.5, transitionOverlapSeconds: 1.5, segments: [{ id: 'segment-1', sceneId: id(101), sceneType: 'ORIGINAL_ANIMATION', type: 'video', durationSeconds: 8, startSeconds: 0, generatedAssetId: id(25), thumbnailUrl: '/api/video/assets/private/thumbnail', isFictional: false, transition: { type: 'cut', durationSeconds: 0 } }], issues: [], warnings: [], ready: true, beatAlignedCuts: 0 }, readiness: { ready: true, issues: [], warnings: [] }, jobs: [], assets: [], soundtracks: [], tools: { available: true }, ...overrides };
}
function storytellingTimeline(){const initial=studio(),overlay=textOverlaySchema.parse({id:id(90),type:'MOMENT_CAPTION',text:'Our shared afternoon',userProvided:true});return {...initial.timeline,storytelling:{applied:true,source:'saved-moments' as const,revision:'saved-plan-v2',sequences:1,collages:1,montages:1,representedPhotos:3,textOverlays:1,referenceOnlyCount:4,warnings:[],reusedClipCount:1,multiImageAnimations:0},segments:[initial.timeline.segments[0],{id:'local-collage',sceneId:id(102),sceneType:'PHOTO_MONTAGE' as const,type:'composition' as const,durationSeconds:8,startSeconds:8,sourcePhotoIds:[photo.id,id(2)],presentationType:'ANIMATED_PHOTO_COLLAGE' as const,collageLayout:'SPLIT_SCREEN' as const,textOverlays:[overlay],isFictional:false,transition:{type:'cut' as const,durationSeconds:0}},{id:'local-montage',sceneId:id(103),sceneType:'PHOTO_MONTAGE' as const,type:'photo' as const,durationSeconds:8,startSeconds:16,sourceAssetId:id(3),presentationType:'CINEMATIC_PHOTO_MONTAGE' as const,isFictional:false,transition:{type:'cut' as const,durationSeconds:0}}]};}
const job = (overrides: Partial<MovieRenderJob> = {}): MovieRenderJob => ({ id: id(40), projectId: id(9), storyboardId: board.id, version: 1, state: 'PENDING', progress: 0, createdAt: '2026-11-14T10:00:00Z', updatedAt: '2026-11-14T10:00:00Z', ...overrides });
const asset = (version = 1): MovieRenderAsset => ({ id: id(50 + version), jobId: id(40), projectId: id(9), storyboardId: board.id, version, url: `/api/movie/assets/${id(50 + version)}/content`, downloadUrl: `/api/movie/assets/${id(50 + version)}/content?download=1`, thumbnailUrl: `/api/movie/assets/${id(50 + version)}/thumbnail`, durationSeconds: 150, width: 1920, height: 1080, fps: 30, videoCodec: 'h264', audioCodec: 'aac', hasAudio: true, bytes: 1048576, sha256: 'private-file-hash', isFictional: true, fictionalSceneIds: [id(102)], createdAt: '2026-11-14T10:00:00Z' });
const soundtrack=(patch:Partial<MovieSoundtrack>={}):MovieSoundtrack=>({id:id(70),projectId:id(9),name:'Synthetic licensed.wav',mimeType:'audio/wav',bytes:1024,durationSeconds:190,instrumental:true,licensed:true,createdAt:'2026-11-14T10:00:00Z',url:`/api/movie/soundtracks/${id(70)}/content`,...patch});
const response = (body: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;
function setup(initial = studio(), handler?: (path: string, options?: RequestInit) => Response | Promise<Response> | undefined, dirty = false) {
  const fetch = vi.fn(async (path: string, options?: RequestInit) => handler?.(path, options) ?? response(path.startsWith('/api/movie?') ? initial : path==='/api/movie/soundtracks'?soundtrack():job()));
  vi.stubGlobal('fetch', fetch);
  render(<MovieStudio storyboard={board} assets={[photo]} csrfToken="private-csrf" hasUnsavedChanges={dirty}/>);
  return fetch;
}
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('private local movie assembly', () => {
  it('only reads local metadata on mount and shows duration, approved clips and the absence of music honestly', async () => {
    const fetch = setup();
    await screen.findByRole('button', { name: 'Create Movie' });
    expect(fetch.mock.calls).toHaveLength(1); expect(fetch.mock.calls[0][0]).toBe(`/api/movie?storyboardId=${board.id}`); expect(fetch.mock.calls[0][1]?.method).toBeUndefined();
    expect(screen.getByText('150s after 1.5s of transition overlap')).toBeInTheDocument();
    expect(screen.getByText('No music will be added. Only enabled source audio will be retained.')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: 'Automatic movie timeline' })).getByText('Approved')).toBeInTheDocument();
    expect(screen.queryByLabelText('Final assembled movie')).not.toBeInTheDocument();
  });
  it('blocks missing clips with exact scene IDs and never substitutes an unapproved clip', async () => {
    const fetch = setup(studio({ readiness: { ready: false, issues: [{ code: 'APPROVED_CLIP_REQUIRED', sceneId: id(101), message: 'Approve a completed clip for The beginning.' }], warnings: ['Add enough approved media to fill 150 seconds.'] } }));
    expect(await screen.findByText(`Scene ID: ${id(101)}`)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create Movie' })).toBeDisabled(); expect(fetch.mock.calls.every(([, options]) => !options?.method)).toBe(true);
  });
  it('keeps rendering blocked for unavailable tools and unsaved storyboard edits', async () => {
    setup(studio({ tools: { available: false, message: 'FFmpeg is unavailable.' } }));
    expect(await screen.findByText('FFmpeg is unavailable.')).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Create Movie' })).toBeDisabled(); cleanup();
    setup(studio(), undefined, true);
    expect(await screen.findByText(/Save your storyboard edits before creating a movie/)).toBeInTheDocument(); expect(screen.getByRole('button', { name: 'Create Movie' })).toBeDisabled();
  });
  it('saves Unicode titles, audio and output settings with CSRF before allowing a render', async () => {
    let state = studio(), saved: { settings: typeof state.settings } | undefined;
    const fetch = setup(state, (path, options) => {
      if (path === '/api/movie/settings') { saved = JSON.parse(String(options?.body)); state = { ...state, settings: saved!.settings }; return response(state.settings); }
      if (path.startsWith('/api/movie?')) return response(state);
    });
    fireEvent.change(await screen.findByRole('textbox', { name: 'Opening movie title' }), { target: { value: 'הסיפור שלנו · わたしたち' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Movie output resolution' }), { target: { value: '720p' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Movie aspect ratio' }), { target: { value: '9:16' } });
    fireEvent.change(screen.getByRole('slider', { name: /music volume/i }), { target: { value: '0.35' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Retain scene audio/ }));
    expect(screen.getByRole('button', { name: 'Create Movie' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save movie settings' }));
    await screen.findByText('Movie settings saved. The timeline and readiness checks are updated.');
    expect(saved?.settings).toMatchObject({ resolution: '720p', aspectRatio: '9:16', musicVolume: 0.35, retainSceneAudio: false, titles: { openingTitle: 'הסיפור שלנו · わたしたち' } });
    expect(fetch.mock.calls.find(([path]) => path === '/api/movie/settings')?.[1]).toMatchObject({ method: 'PATCH', headers: { 'X-CSRF-Token': 'private-csrf' } });
    expect(screen.getByRole('button', { name: 'Create Movie' })).toBeEnabled(); expect(fetch.mock.calls.some(([path]) => path === '/api/movie/jobs')).toBe(false);
  });
  it('creates one explicitly requested local job without contacting any generation endpoint', async () => {
    let created: unknown;
    const fetch = setup(studio(), (path, options) => path === '/api/movie/jobs' ? (created = JSON.parse(String(options?.body)), response(job())) : undefined);
    fireEvent.click(await screen.findByRole('button', { name: 'Create Movie' }));
    await waitFor(() => expect(created).toMatchObject({ storyboardId: board.id, idempotencyKey: expect.any(String) }));
    expect(fetch.mock.calls.find(([path]) => path === '/api/movie/jobs')?.[1]).toMatchObject({ method: 'POST', headers: { 'X-CSRF-Token': 'private-csrf' } });
    expect(fetch.mock.calls.every(([path]) => path.startsWith('/api/movie'))).toBe(true);
  });
  it('reuses the render idempotency key after a lost response instead of automatically reposting', async () => {
    const attempts: { idempotencyKey: string }[] = [];
    setup(studio(), (path, options) => { if (path === '/api/movie/jobs') { attempts.push(JSON.parse(String(options?.body))); if (attempts.length === 1) throw new Error('Connection interrupted'); return response(job()); } });
    fireEvent.click(await screen.findByRole('button', { name: 'Create Movie' })); await screen.findByRole('alert');
    expect(attempts).toHaveLength(1); fireEvent.click(screen.getByRole('button', { name: 'Create Movie' }));
    await waitFor(() => expect(attempts).toHaveLength(2)); expect(attempts[0].idempotencyKey).toBe(attempts[1].idempotencyKey);
  });
  it('reports actual render progress and cancels the local job', async () => {
    const running = job({ state: 'RENDERING', progress: 46, message: 'Encoding frame 2070 of 4500.' });
    const fetch = setup(studio({ jobs: [running] }), path => path.endsWith('/cancel') ? response({ ...running, state: 'CANCELLED', message: 'Render cancelled.' }) : undefined);
    const progress = await screen.findByRole('progressbar', { name: 'Movie render progress' }); expect(progress).toHaveAttribute('value', '46');
    expect(screen.getAllByText('Encoding frame 2070 of 4500.')).toHaveLength(2); expect(screen.getByRole('button', { name: 'Create Movie' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel render' })); await screen.findByText('Render cancelled.');
    expect(fetch.mock.calls.find(([path]) => path.endsWith('/cancel'))?.[1]).toMatchObject({ method: 'POST', body: '{}' });
  });
  it('retries a failed local render while preserving source clips', async () => {
    const failed = job({ state: 'FAILED', progress: 42, errorMessage: 'Disk space is low.' });
    const fetch = setup(studio({ jobs: [failed] }), path => path.endsWith('/retry') ? response({ ...failed, state: 'PENDING' }) : undefined);
    await screen.findByText('Disk space is low.'); fireEvent.click(screen.getByRole('button', { name: 'Retry render' }));
    await screen.findByText('The render will retry from safe local checkpoints. Source clips are preserved.');
    expect(fetch.mock.calls.find(([path]) => path.endsWith('/retry'))?.[1]).toMatchObject({ method: 'POST', body: '{}' }); expect(fetch.mock.calls.some(([path]) => path.startsWith('/api/video'))).toBe(false);
  });
  it('requires a license affirmation before privately uploading raw soundtrack bytes', async () => {
    const fetch = setup(); await screen.findByRole('button', { name: 'Create Movie' });
    const file = new File(['synthetic test audio'], 'שיר licensed.wav', { type: 'audio/x-wav' });
    fireEvent.change(screen.getByLabelText('Upload licensed soundtrack file'), { target: { files: [file] } });
    const upload = screen.getByRole('button', { name: 'Save licensed soundtrack' }); expect(upload).toBeDisabled(); expect(fetch.mock.calls).toHaveLength(1);
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission or a license/ })); fireEvent.click(upload);
    await screen.findByText('Licensed soundtrack saved privately and selected in your draft. Your other movie settings are unchanged; save them when ready.');
    const submitted = fetch.mock.calls.find(([path]) => path === '/api/movie/soundtracks');
    expect(submitted?.[1]).toMatchObject({ method: 'POST', body: file, headers: { 'Content-Type': 'audio/wav', 'X-CSRF-Token': 'private-csrf', 'X-License-Confirmed': 'true', 'X-Instrumental': 'true', 'X-Upload-Name': encodeURIComponent(file.name) } });
  });
  it('rejects unsupported soundtrack types before sending bytes', async () => {
    const fetch = setup(); await screen.findByRole('button', { name: 'Create Movie' });
    fireEvent.change(screen.getByLabelText('Upload licensed soundtrack file'), { target: { files: [new File(['test'], 'track.exe')] } });
    fireEvent.click(screen.getByRole('checkbox', { name: /I have permission or a license/ })); fireEvent.click(screen.getByRole('button', { name: 'Save licensed soundtrack' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a licensed MP3, WAV, or M4A soundtrack.'); expect(fetch.mock.calls).toHaveLength(1);
  });
  it('previews and downloads private movie versions and keeps fictional provenance visible', async () => {
    const old = asset(1), latest = asset(2); setup(studio({ assets: [latest, old] }));
    const player = await screen.findByLabelText('Final assembled movie'); expect(player).toHaveAttribute('src', latest.url); expect(player).toHaveAttribute('poster', latest.thumbnailUrl);
    expect(screen.getByRole('link', { name: 'Download MP4' })).toHaveAttribute('href', latest.downloadUrl); expect(screen.getByText(/Includes fictional AI-created scenes/)).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Movie render version' }), { target: { value: old.id } });
    expect(player).toHaveAttribute('src', old.url); expect(screen.getByRole('link', { name: 'Download MP4' })).toHaveAttribute('href', old.downloadUrl);
  });
  it('pages a large automatic timeline without discarding later segments', async () => {
    const initial = studio(); initial.timeline.segments = Array.from({ length: 45 }, (_, index) => ({ ...initial.timeline.segments[0], id: `segment-${index}`, startSeconds: index * 3 }));
    setup(initial); await screen.findByRole('list', { name: 'Automatic movie timeline' });
    expect(screen.getAllByRole('listitem', { name: /Movie segment/ })).toHaveLength(30); expect(screen.queryByRole('listitem', { name: 'Movie segment 45' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next segments' })); expect(screen.getByRole('listitem', { name: 'Movie segment 45' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem', { name: /Movie segment/ })).toHaveLength(15);
  });
  it.each([true,false])('uploads and selects licensed music with unsaved duration/titles and instrumental=%s without silently saving settings',async instrumental=>{
    const track=soundtrack({instrumental});const fetch=setup(studio(),path=>path==='/api/movie/soundtracks'?response(track,201):undefined,true);
    fireEvent.change(await screen.findByRole('spinbutton',{name:'Movie duration in seconds'}),{target:{value:'391'}});fireEvent.change(screen.getByRole('textbox',{name:'Opening movie title'}),{target:{value:'Feliz Aniversario'}});fireEvent.change(screen.getByRole('textbox',{name:'Movie protagonist names'}),{target:{value:'Elias y Lian'}});fireEvent.change(screen.getByRole('slider',{name:'Movie music volume'}),{target:{value:'0.5'}});
    const file=new File(['synthetic licensed audio'],'test track.wav',{type:'audio/wav'});fireEvent.change(screen.getByLabelText('Upload licensed soundtrack file'),{target:{files:[file]}});expect(screen.getByText(/File selected, save to add it/)).toHaveTextContent(file.name);fireEvent.click(screen.getByRole('checkbox',{name:/I have permission or a license/}));if(!instrumental)fireEvent.click(screen.getByRole('checkbox',{name:'This is an instrumental track'}));expect(screen.getByRole('button',{name:'Save licensed soundtrack'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'Save licensed soundtrack'}));
    await screen.findByText('Licensed soundtrack saved privately and selected in your draft. Your other movie settings are unchanged; save them when ready.');
    expect(screen.getByRole('spinbutton',{name:'Movie duration in seconds'})).toHaveValue(391);expect(screen.getByRole('textbox',{name:'Opening movie title'})).toHaveValue('Feliz Aniversario');expect(screen.getByRole('textbox',{name:'Movie protagonist names'})).toHaveValue('Elias y Lian');expect(screen.getByRole('slider',{name:'Movie music volume'})).toHaveValue('0.5');expect(screen.getByRole('combobox',{name:'Movie soundtrack'})).toHaveValue(track.id);expect(screen.getByRole('list',{name:'Private soundtrack library'})).toHaveTextContent(track.name);expect(screen.queryByText(/File selected, save to add it/)).not.toBeInTheDocument();expect(screen.getByLabelText('Upload licensed soundtrack file')).toHaveValue('');
    const mutations=fetch.mock.calls.filter(([,options])=>options?.method);expect(mutations).toHaveLength(1);expect(mutations[0][0]).toBe('/api/movie/soundtracks');expect(mutations[0][1]).toMatchObject({method:'POST',body:file,headers:{'X-Instrumental':String(instrumental)}});expect(screen.getByRole('button',{name:'Create Movie'})).toBeDisabled();
  });
  it('keeps a failed upload file and license available for an explicit retry',async()=>{
    let attempts=0;const fetch=setup(studio(),path=>path==='/api/movie/soundtracks'?(++attempts===1?response({error:{code:'SOUNDTRACK_INVALID',message:'The local soundtrack could not be validated. Try again.'}},422):response(soundtrack(),201)):undefined);await screen.findByRole('button',{name:'Create Movie'});const file=new File(['synthetic audio'],'retry.wav',{type:'audio/wav'});fireEvent.change(screen.getByLabelText('Upload licensed soundtrack file'),{target:{files:[file]}});fireEvent.click(screen.getByRole('checkbox',{name:/I have permission or a license/}));fireEvent.click(screen.getByRole('button',{name:'Save licensed soundtrack'}));expect(await screen.findByRole('alert')).toHaveTextContent('The local soundtrack could not be validated. Try again.');expect(screen.getByText(/File selected, save to add it/)).toHaveTextContent('retry.wav');expect(screen.getByRole('checkbox',{name:/I have permission or a license/})).toBeChecked();expect(attempts).toBe(1);fireEvent.click(screen.getByRole('button',{name:'Save licensed soundtrack'}));await screen.findByText(/Licensed soundtrack saved privately and selected in your draft/);expect(attempts).toBe(2);expect(fetch.mock.calls.filter(([path])=>path==='/api/movie/soundtracks').every(([,options])=>options?.body===file)).toBe(true);
  });
  it('visibly clears a pending soundtrack file without uploading it',async()=>{const fetch=setup();await screen.findByRole('button',{name:'Create Movie'});const input=screen.getByLabelText('Upload licensed soundtrack file');fireEvent.change(input,{target:{files:[new File(['synthetic'],'pending.mp3',{type:'audio/mpeg'})]}});fireEvent.click(screen.getByRole('checkbox',{name:/I have permission or a license/}));fireEvent.click(screen.getByRole('button',{name:'Clear selected soundtrack file'}));expect(input).toHaveValue('');expect(screen.queryByText(/File selected, save to add it/)).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'Save licensed soundtrack'})).toBeDisabled();expect(fetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);});
  it('reports indeterminate local upload/validation progress without starting a render',async()=>{let finish:((value:Response)=>void)|undefined;const fetch=setup(studio(),path=>path==='/api/movie/soundtracks'?new Promise<Response>(resolve=>{finish=resolve;}):undefined);await screen.findByRole('button',{name:'Create Movie'});fireEvent.change(screen.getByLabelText('Upload licensed soundtrack file'),{target:{files:[new File(['synthetic'],'progress.wav',{type:'audio/wav'})]}});fireEvent.click(screen.getByRole('checkbox',{name:/I have permission or a license/}));fireEvent.click(screen.getByRole('button',{name:'Save licensed soundtrack'}));expect(await screen.findByRole('progressbar',{name:'Soundtrack upload progress'})).not.toHaveAttribute('value');expect(screen.getByText(/Saving and validating your licensed soundtrack locally/)).toBeInTheDocument();finish!(response(soundtrack(),201));await screen.findByText(/Licensed soundtrack saved privately and selected in your draft/);expect(fetch.mock.calls.some(([path])=>path==='/api/movie/jobs'||path==='/api/movie/settings')).toBe(false);});
  it.each([true,false])('removes library music with invalid draft settings and clears only a deleted selected track (%s)',async selected=>{const one=soundtrack(),two=soundtrack({id:id(71),name:'Second licensed track.mp3'}),remove=selected?one:two;const fetch=setup(studio({settings:movieSettingsSchema.parse({soundtrackId:one.id}),soundtracks:[one,two]}),path=>path===`/api/movie/soundtracks/${remove.id}`?response(undefined,204):undefined);fireEvent.change(await screen.findByRole('spinbutton',{name:'Movie duration in seconds'}),{target:{value:'901'}});fireEvent.change(screen.getByRole('textbox',{name:'Opening movie title'}),{target:{value:'Keep this unsaved title'}});const button=screen.getByRole('button',{name:`Remove soundtrack ${remove.name}`});expect(button).toBeEnabled();fireEvent.click(button);await screen.findByText('Soundtrack removed from this private library. Your other draft settings and existing rendered movies are preserved.');expect(screen.getByRole('spinbutton',{name:'Movie duration in seconds'})).toHaveValue(901);expect(screen.getByRole('textbox',{name:'Opening movie title'})).toHaveValue('Keep this unsaved title');expect(screen.getByRole('combobox',{name:'Movie soundtrack'})).toHaveValue(selected?'':one.id);expect(screen.getByRole('list',{name:'Private soundtrack library'})).not.toHaveTextContent(remove.name);const mutations=fetch.mock.calls.filter(([,options])=>options?.method);expect(mutations).toHaveLength(1);expect(mutations[0][1]?.method).toBe('DELETE');});
  it('accepts a 391-second movie and clearly blocks settings beyond the shared 15-minute bound',async()=>{let saved:unknown;const fetch=setup(studio(),(path,options)=>path==='/api/movie/settings'?(saved=JSON.parse(String(options?.body)),response(studio().settings)):undefined);const field=await screen.findByRole('spinbutton',{name:'Movie duration in seconds'});expect(field).toHaveAttribute('max','900');fireEvent.change(field,{target:{value:'391'}});expect(screen.getByRole('button',{name:'Save movie settings'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'Save movie settings'}));await waitFor(()=>expect(saved).toMatchObject({settings:{targetDurationSeconds:391}}));fireEvent.change(field,{target:{value:'901'}});expect(screen.getByRole('button',{name:'Save movie settings'})).toBeDisabled();expect(screen.getByRole('alert')).toHaveTextContent('Choose a whole-number duration between 120 and 900 seconds (2–15 minutes).');expect(fetch.mock.calls.some(([path])=>path==='/api/movie/jobs')).toBe(false);});

  it('shows the actual compiled collage/montage/photo/text counts for a legacy storyboard without calling a one-image clip multi-image',async()=>{const initial=studio({timeline:storytellingTimeline()});const morePhotos=[photo,{...photo,id:id(2),filename:'Second original.jpg'},{...photo,id:id(3),filename:'Third original.jpg'}];const fetch=vi.fn(async()=>response(initial));vi.stubGlobal('fetch',fetch);render(<MovieStudio storyboard={board} assets={morePhotos} csrfToken="private-csrf"/>);const summary=await screen.findByRole('region',{name:'Actual compiled movie composition'});expect(within(summary).getByText('Animated collages').parentElement).toHaveTextContent('1');expect(within(summary).getByText('Original photographs represented').parentElement).toHaveTextContent('3');expect(within(summary).getByText('Text overlays').parentElement).toHaveTextContent('1');expect(within(summary).getByText('Reference-only photographs').parentElement).toHaveTextContent('4');expect(within(summary).getByText('Multi-image AI clips').parentElement).toHaveTextContent('0');expect(within(summary).getByText(/Existing approved clips retain their original inputs/)).toBeInTheDocument();const row=screen.getByRole('listitem',{name:'Movie segment 2'});expect(row).toHaveTextContent('ANIMATED PHOTO COLLAGE · SPLIT SCREEN');expect(row).toHaveTextContent('2 original photographs · 1 text overlay');const preview=within(row).getByRole('img',{name:'Collage timeline preview with 2 original photographs'});expect(preview.querySelectorAll('img')).toHaveLength(2);expect([...preview.querySelectorAll('img')].every(image=>image.getAttribute('src')?.endsWith('/thumbnail'))).toBe(true);expect(screen.getByRole('listitem',{name:'Movie segment 3'})).toHaveTextContent('ORIGINAL PHOTO MONTAGE');expect(fetch.mock.calls).toHaveLength(1);});
  it('refreshes saved moment changes into the compiled timeline while preserving unsaved movie settings and pending music',async()=>{let snapshot=studio();const fetch=setup(snapshot,path=>path.startsWith('/api/movie?')?response(snapshot):undefined);fireEvent.change(await screen.findByRole('spinbutton',{name:'Movie duration in seconds'}),{target:{value:'391'}});fireEvent.change(screen.getByRole('textbox',{name:'Opening movie title'}),{target:{value:'Keep my title'}});fireEvent.change(screen.getByRole('textbox',{name:'Movie protagonist names'}),{target:{value:'Elias y Lian'}});fireEvent.change(screen.getByRole('slider',{name:'Movie music volume'}),{target:{value:'0.5'}});fireEvent.change(screen.getByLabelText('Upload licensed soundtrack file'),{target:{files:[new File(['synthetic'],'pending music.wav',{type:'audio/wav'})]}});fireEvent.click(screen.getByRole('checkbox',{name:/I have permission or a license/}));snapshot=studio({timeline:storytellingTimeline()});window.dispatchEvent(new Event('cinematic-updated'));await screen.findByRole('img',{name:'Collage timeline preview with 2 original photographs'});expect(screen.getByRole('spinbutton',{name:'Movie duration in seconds'})).toHaveValue(391);expect(screen.getByRole('textbox',{name:'Opening movie title'})).toHaveValue('Keep my title');expect(screen.getByRole('textbox',{name:'Movie protagonist names'})).toHaveValue('Elias y Lian');expect(screen.getByRole('slider',{name:'Movie music volume'})).toHaveValue('0.5');expect(screen.getByText(/File selected, save to add it/)).toHaveTextContent('pending music.wav');expect(screen.getByRole('checkbox',{name:/I have permission or a license/})).toBeChecked();expect(screen.getByText(/Saved moments and storytelling choices are updated in the compiled timeline/)).toBeInTheDocument();expect(fetch.mock.calls).toHaveLength(2);expect(fetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);});
  it('marks an old export as unchanged until a new local movie uses the compiled storytelling revision',async()=>{const timeline=storytellingTimeline();setup(studio({timeline,assets:[asset()]}));expect(await screen.findByText(/This export uses an earlier movie plan/)).toHaveTextContent('Create a new local movie');cleanup();setup(studio({timeline,assets:[{...asset(),storytellingRevision:timeline.storytelling.revision}]}));await screen.findByLabelText('Final assembled movie');expect(screen.queryByText(/This export uses an earlier movie plan/)).not.toBeInTheDocument();});
  it('makes mixing saved moments an optional explicit movie setting without creating a render',async()=>{let saved:unknown;const fetch=setup(studio(),(path,options)=>path==='/api/movie/settings'?(saved=JSON.parse(String(options?.body)),response(studio().settings)):undefined);const mixing=await screen.findByRole('checkbox',{name:'Mix saved moments and collages into this movie'});expect(mixing).toBeChecked();fireEvent.click(mixing);expect(fetch.mock.calls.every(([,options])=>!options?.method)).toBe(true);fireEvent.click(screen.getByRole('button',{name:'Save movie settings'}));await waitFor(()=>expect(saved).toMatchObject({settings:{storytellingEnabled:false}}));expect(fetch.mock.calls.filter(([,options])=>options?.method).map(([path])=>path)).toEqual(['/api/movie/settings']);});

});
