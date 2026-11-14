import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonGenerationRequest, JsonGenerator, PhotoAnalysis, Protagonist, Storyboard, StoryboardContent, StoryboardScene } from '@memories/shared';
import type { Config } from '../src/config.js';
import type { DirectorPhotoRow } from '../src/curation.js';
import { StoryboardDirector, storyboardContent, validateStoryboard, type StoryboardStore } from '../src/storyboard.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const photoAnalysis: PhotoAnalysis = { schemaVersion: '1.0', sharpness: 80, exposure: 80, composition: 80, animationSuitability: 80, storytellingPotential: 80, suitability: 'ANIMATED_ORIGINAL', description: 'A person sitting beside a window.', sceneType: 'interior', visibleLocations: [], activities: ['sitting'], objects: ['window'], emotionalTone: 'reflective', diversityTags: ['quiet'], uncertaintyNotes: [] };

async function fixture() {
  const owner = randomUUID(), root = await mkdtemp(join(tmpdir(), 'memories-director-')); roots.push(root);
  const file = join(root, 'reference.jpg');
  await sharp({ create: { width: 16, height: 16, channels: 3, background: '#b3a6a4' } }).jpeg().toFile(file);
  const rows: DirectorPhotoRow[] = Array.from({ length: 14 }, (_, index) => {
    const id = `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    return { asset: { id, projectId: owner, contributorId: 'person1', filename: `${index}.jpg`, mimeType: 'image/jpeg', bytes: 100, selected: true, importedAt: '2026-11-14T00:00:00Z', url: '/private' }, analysis: structuredClone(photoAnalysis), features: null, curation: { assetId: id, pinned: false, excluded: false, protagonistIds: index < 5 ? ['person1'] : index < 10 ? ['person2'] : ['person1', 'person2'], associationsConfirmed: true } };
  });
  const profiles: Protagonist[] = [{ id: 'person1', name: 'Alex', referencePhotoIds: rows.slice(0, 5).map(row => row.asset.id), likenessPermissionConfirmed: true, ready: true, updatedAt: '2026-11-14' }, { id: 'person2', name: 'Sam', referencePhotoIds: rows.slice(5, 10).map(row => row.asset.id), likenessPermissionConfirmed: true, ready: true, updatedAt: '2026-11-14' }];
  const makeScene = (type: StoryboardScene['type'], duration: number, sourceIds: string[], people: StoryboardScene['protagonistIds']): StoryboardScene => ({ id: randomUUID(), sequenceNumber: 1, type, title: type === 'NEW_CINEMATIC_SCENE' ? 'Fictional AI-created moment' : 'A quiet memory', description: type === 'NEW_CINEMATIC_SCENE' ? 'A fictional, imagined scene inspired by the supplied memories.' : 'Original source summary.', durationSeconds: duration, sourcePhotoIds: sourceIds, protagonistIds: people, visualStyle: 'Natural light with subtle film grain.', cameraDirection: 'Slow camera drift.', motionPrompt: 'Subtle parallax and gentle ambient motion.', emotionalTone: 'Warm and reflective.', continuityNotes: 'Thematic transition; no date is assumed.', generationInstructions: 'Future video planning instructions only; preserve supplied references.', isFictional: type === 'NEW_CINEMATIC_SCENE', requiresUserConfirmation: type === 'NEW_CINEMATIC_SCENE', userConfirmed: false });
  const content: StoryboardContent = { schemaVersion: '1.0', title: 'Two lives, shared light', synopsis: 'A thematic film using original images and clearly fictional cinematic transitions.', targetDurationSeconds: 150, scenes: [makeScene('TITLE_SEQUENCE', 10, [], []), makeScene('ORIGINAL_ANIMATION', 30, [rows[0].asset.id], ['person1']), makeScene('NEW_CINEMATIC_SCENE', 30, [rows[0].asset.id, rows[5].asset.id], ['person1', 'person2']), makeScene('PHOTO_MONTAGE', 20, [rows[10].asset.id], ['person1', 'person2']), makeScene('NEW_CINEMATIC_SCENE', 40, [rows[0].asset.id, rows[5].asset.id], ['person1', 'person2']), makeScene('ORIGINAL_ANIMATION', 20, [rows[5].asset.id], ['person2'])] };
  content.scenes.forEach((scene, index) => { scene.sequenceNumber = index + 1; });
  const saved: Storyboard[] = [], requests: JsonGenerationRequest[] = [];
  const store: StoryboardStore = {
    ensure: async () => {}, protagonists: current => current === owner ? profiles : [],
    rows: (current, limit = 100, after) => current === owner ? rows.filter(row => !after || row.asset.id > after).slice(0, limit) : [],
    asset: async (current, id) => { const row = rows.find(row => current === owner && row.asset.id === id); if (!row) throw new Error('not owned'); return { asset: row.asset, file, originalMetadata: [] }; },
    saveStoryboard: (current, data, issues) => { const now = new Date().toISOString(); const board: Storyboard = { ...structuredClone(data), id: randomUUID(), projectId: current, version: saved.length + 1, createdAt: now, updatedAt: now, validationIssues: [...issues], status: issues.length ? 'draft' : 'validated', readyForVideoGeneration: !issues.length }; saved.push(board); return structuredClone(board); },
    getStoryboard: (current, id) => { const board = id ? saved.find(board => board.id === id && board.projectId === current) : saved.filter(board => board.projectId === current).at(-1); return board ? structuredClone(board) : undefined; },
  };
  const generator: JsonGenerator = { generateJson: async request => { requests.push(request); return { json: structuredClone(content), usage: { inputTokens: 500, outputTokens: 1000 } }; } };
  const director = new StoryboardDirector(store, generator, { geminiTimeoutMs: 1000 } as Config);
  return { owner, rows, profiles, content, saved, requests, director, store, generator };
}

describe('AI Director storyboard safety and versioned editing', () => {
  it('supplies server-owned scene IDs, sequence and review state before validating model placeholders',async()=>{
    const f=await fixture();
    f.generator.generateJson=async()=>({json:{...f.content,schemaVersion:'a-model-invented-version',targetDurationSeconds:170,scenes:f.content.scenes.map(scene=>({...scene,id:'scene-placeholder',sequenceNumber:'first',userConfirmed:true,isFictional:scene.type!=='NEW_CINEMATIC_SCENE',requiresUserConfirmation:false,...(scene.type==='NEW_CINEMATIC_SCENE'?{title:'A moonlit walk',description:'A cinematic walk beside the sea.'}:{})}))},usage:{inputTokens:500,outputTokens:1000}});
    const board=await f.director.generate(f.owner);
    expect(board.scenes.every(scene=>/^[a-f0-9-]{36}$/.test(scene.id)&&scene.userConfirmed===false)).toBe(true);
    expect(new Set(board.scenes.map(scene=>scene.id)).size).toBe(6);
    expect(board.scenes.map(scene=>scene.sequenceNumber)).toEqual([1,2,3,4,5,6]);
    expect(board.readyForVideoGeneration).toBe(false);
    expect(board.schemaVersion).toBe('1.0');
    expect(board.targetDurationSeconds).toBe(150);
    expect(board.scenes.filter(scene=>scene.type==='NEW_CINEMATIC_SCENE').every(scene=>scene.isFictional&&scene.requiresUserConfirmation&&scene.title.startsWith('Fictional:'))).toBe(true);
  });
  it('reports invalid AI field paths safely without copying response values',async()=>{
    const f=await fixture();
    f.generator.generateJson=async()=>({json:{...f.content,scenes:f.content.scenes.map(scene=>({...scene,durationSeconds:'private-invalid-value'}))},usage:{inputTokens:500,outputTokens:1000}});
    await expect(f.director.generate(f.owner)).rejects.toThrow('scenes.0.durationSeconds');
    await expect(f.director.generate(f.owner)).rejects.not.toThrow('private-invalid-value');
    expect(f.saved).toHaveLength(0);
  });
  it('removes unsupported model identity labels from original photos without assigning people in the library',async()=>{
    const f=await fixture();
    f.rows[11].curation.associationsConfirmed=false;
    f.content.scenes[1].sourcePhotoIds=[f.rows[11].asset.id];
    f.content.scenes[1].protagonistIds=['person1','person2'];
    f.content.scenes[1].title='Alex and Sam in the original';
    const originalCuration=structuredClone(f.rows[11].curation);
    const board=await f.director.generate(f.owner);
    expect(board.scenes[1]).toMatchObject({sourcePhotoIds:[f.rows[11].asset.id],protagonistIds:[],requiresUserConfirmation:true,userConfirmed:false,title:'Original photograph'});
    expect(JSON.stringify(board.scenes[1])).not.toMatch(/Alex|Sam/);
    expect(f.rows[11].curation).toEqual(originalCuration);
    expect(board.scenes.filter(scene=>scene.type==='NEW_CINEMATIC_SCENE').every(scene=>scene.protagonistIds.includes('person1')&&scene.protagonistIds.includes('person2'))).toBe(true);
    expect(board.readyForVideoGeneration).toBe(false);
  });
  it('directs an exact 150-second storyboard using only confirmed reference images, without approving fictional scenes', async () => {
    const f = await fixture();
    f.content.scenes.forEach(scene => { scene.userConfirmed = true; }); // An AI response must not approve itself.
    const board = await f.director.generate(f.owner, { durationSeconds: 150, brief: 'A warm, cinematic shared journey.' });
    expect(board.scenes.reduce((sum, scene) => sum + scene.durationSeconds, 0)).toBe(150);
    expect(new Set(board.scenes.map(scene => scene.id)).size).toBe(6);
    expect(board.readyForVideoGeneration).toBe(false);
    expect(board.scenes.filter(scene => scene.isFictional).every(scene => !scene.userConfirmed && scene.requiresUserConfirmation)).toBe(true);
    expect(board.scenes[1].description).toBe(photoAnalysis.description);
    expect(board.scenes[1].continuityNotes).toContain('No photo date metadata');
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].operation).toBe('storyboard');
    expect(f.requests[0].images).toHaveLength(10);
    expect(f.requests[0].prompt).toContain('only these may ground protagonist likeness');
    expect(f.requests[0].prompt).toContain('Never invent real dates, cities');
    expect(f.requests[0].maxOutputTokens).toBe(12000);
  });

  it('saves independently editable versions and exports schema 1.0 plus readiness metadata', async () => {
    const f = await fixture();
    const first = await f.director.save(f.owner, f.content);
    f.content.scenes.forEach(scene => { if (scene.requiresUserConfirmation) scene.userConfirmed = true; });
    const second = await f.director.save(f.owner, f.content);
    expect(first.version).toBe(1); expect(first.readyForVideoGeneration).toBe(false);
    expect(second.version).toBe(2); expect(second.id).not.toBe(first.id); expect(second.readyForVideoGeneration).toBe(true);
    expect(f.director.get(f.owner, first.id)?.readyForVideoGeneration).toBe(false);
    const exported = f.director.export(f.owner, second.id);
    expect(JSON.parse(JSON.stringify(exported))).toMatchObject({ schemaVersion: '1.0', version: 2, readyForVideoGeneration: true });
    expect(storyboardContent(exported)).not.toHaveProperty('projectId');
    expect(f.director.get(randomUUID(), second.id)).toBeUndefined();
  });

  it('keeps duration and balance edits as drafts until corrected', async () => {
    const f = await fixture();
    f.content.scenes.forEach(scene => { scene.userConfirmed = true; });
    f.content.scenes[1].durationSeconds = 29;
    const board = await f.director.save(f.owner, f.content);
    expect(board.readyForVideoGeneration).toBe(false);
    expect(board.validationIssues.join(' ')).toContain('149 seconds');
    expect(board.status).toBe('draft');
    f.content.scenes[1].durationSeconds = 50; f.content.scenes[4].durationSeconds = 20;
    expect((await f.director.save(f.owner, f.content)).validationIssues.join(' ')).toContain('40–60%');
  });

  it('rejects missing, excluded, foreign, and unconfirmed identity references', async () => {
    const f = await fixture();
    const missing = structuredClone(f.content); missing.scenes[1].sourcePhotoIds = [randomUUID()];
    await expect(f.director.save(f.owner, missing)).rejects.toMatchObject({ code: 'INVALID_STORYBOARD_REFERENCES' });
    f.rows[10].curation.excluded = true;
    await expect(f.director.save(f.owner, f.content)).rejects.toThrow('excluded photo');
    f.rows[10].curation.excluded = false;
    const noReference = structuredClone(f.content); noReference.scenes[2].sourcePhotoIds = [f.rows[10].asset.id];
    await expect(f.director.save(f.owner, noReference)).rejects.toThrow('user-confirmed reference');
    const unconfirmed = structuredClone(f.content); unconfirmed.scenes[1].sourcePhotoIds = [f.rows[11].asset.id];
    f.rows[11].curation.associationsConfirmed = false;
    await expect(f.director.save(f.owner, unconfirmed)).rejects.toThrow('without a user-confirmed association');
  });

  it('requires explicit fiction labels, unique scene IDs, sequential numbering, and every pinned photo', async () => {
    const f = await fixture();
    const unlabeled = structuredClone(f.content); unlabeled.scenes[2].isFictional = false;
    await expect(f.director.save(f.owner, unlabeled)).rejects.toThrow('fictional');
    const duplicate = structuredClone(f.content); duplicate.scenes[2].id = duplicate.scenes[1].id;
    await expect(f.director.save(f.owner, duplicate)).rejects.toThrow('duplicate scene identifier');
    const order = structuredClone(f.content); order.scenes[2].sequenceNumber = 5;
    await expect(f.director.save(f.owner, order)).rejects.toThrow('sequence number 3');
    f.rows[13].curation.pinned = true;
    await expect(f.director.save(f.owner, f.content)).rejects.toThrow('pinned photo is missing');
  });

  it('does not call Gemini before both people have two references and likeness permission', async () => {
    const f = await fixture();
    f.profiles[1].referencePhotoIds = [f.rows[5].asset.id];
    await expect(f.director.generate(f.owner)).rejects.toMatchObject({ code: 'PROTAGONIST_SETUP_REQUIRED' });
    expect(f.requests).toHaveLength(0);
    f.profiles[1].referencePhotoIds.push(f.rows[6].asset.id); f.profiles[1].likenessPermissionConfirmed = false;
    await expect(f.director.generate(f.owner)).rejects.toThrow('permission');
    expect(f.requests).toHaveLength(0);
  });

  it('directs and validates a storyboard with exactly two references per protagonist', async () => {
    const f = await fixture();
    for (const profile of f.profiles) profile.referencePhotoIds = profile.referencePhotoIds.slice(0, 2);
    const draft = await f.director.generate(f.owner);
    expect(f.requests[0].images).toHaveLength(4);
    expect(draft.validationIssues.every(issue => issue.startsWith('Review and confirm scene '))).toBe(true);
    draft.scenes.forEach(scene => { scene.userConfirmed = true; });
    expect((await f.director.save(f.owner, storyboardContent(draft))).readyForVideoGeneration).toBe(true);
  });

  it('rechecks readiness after consent withdrawal, source deletion, reference exclusion, and pin changes', async () => {
    const f = await fixture();
    f.content.scenes.forEach(scene => { scene.userConfirmed = true; });
    const saved = await f.director.save(f.owner, f.content); expect(saved.readyForVideoGeneration).toBe(true);
    f.profiles[1].likenessPermissionConfirmed = false;
    expect(f.director.get(f.owner, saved.id)?.readyForVideoGeneration).toBe(false);
    f.profiles[1].likenessPermissionConfirmed = true; f.rows[0].curation.excluded = true;
    expect(f.director.get(f.owner, saved.id)?.validationIssues.join(' ')).toContain('excluded');
    f.rows[0].curation.excluded = false; f.rows.splice(10, 1);
    expect(f.director.get(f.owner, saved.id)?.validationIssues.join(' ')).toContain('unavailable');
  });

  it('normalizes estimated AI timings to the requested duration and balance before strict validation', async () => {
    const f = await fixture(); f.content.scenes[1].durationSeconds = 29;
    const board=await f.director.generate(f.owner);
    expect(board.scenes.reduce((sum,scene)=>sum+scene.durationSeconds,0)).toBe(150);
    expect(board.validationIssues.every(issue=>issue.startsWith('Review and confirm scene '))).toBe(true);
    expect(f.saved).toHaveLength(1);
    expect(validateStoryboard(f.content, { protagonists: f.profiles, photos: new Map(f.rows.map(row => [row.asset.id, row])), pinnedPhotoIds: [] }).issues.join(' ')).toContain('149 seconds');
  });
  it('retains pinned photos omitted from the generated draft without trusting model identity assignments',async()=>{
    const f=await fixture();f.rows[13].curation.pinned=true;
    const board=await f.director.generate(f.owner);
    expect(board.scenes.some(scene=>scene.sourcePhotoIds.includes(f.rows[13].asset.id))).toBe(true);
    expect(board.scenes.reduce((sum,scene)=>sum+scene.durationSeconds,0)).toBe(150);
  });

  it('preserves durable stale/missing-file validation until a new version is saved', async () => {
    const f = await fixture();
    f.content.scenes.forEach(scene => { scene.userConfirmed = true; });
    const saved = await f.director.save(f.owner, f.content);
    f.saved[0].status = 'draft';
    f.saved[0].validationIssues = ['Protagonist references or likeness permission changed. Validate a new storyboard version.', 'A source photo file is missing. Restore it or replace its references.'];
    expect(f.director.get(f.owner, saved.id)?.validationIssues).toEqual(f.saved[0].validationIssues);
    expect(f.director.get(f.owner, saved.id)?.readyForVideoGeneration).toBe(false);
    expect((await f.director.save(f.owner, f.content)).readyForVideoGeneration).toBe(true);
  });

  it('rejects a stale in-flight generation if identity references or names change', async () => {
    const f = await fixture();
    const originalGenerate = f.generator.generateJson;
    f.generator.generateJson = async (request, signal) => {
      const response = await originalGenerate(request, signal);
      f.profiles[0].name = 'Changed after request';
      return response;
    };
    await expect(f.director.generate(f.owner)).rejects.toMatchObject({ code: 'PROTAGONIST_SETUP_CHANGED' });
    expect(f.saved).toHaveLength(0);
  });

  it('keeps a film without declared protagonists in draft without silently assigning identities', async () => {
    const f = await fixture();
    f.content.scenes.forEach(scene => { scene.protagonistIds = []; scene.userConfirmed = true; });
    const board = await f.director.save(f.owner, f.content);
    expect(board.readyForVideoGeneration).toBe(false);
    expect(board.status).toBe('draft');
    expect(board.validationIssues.join(' ')).toContain('Include Alex as a confirmed protagonist');
    expect(board.validationIssues.join(' ')).toContain('Include Sam as a confirmed protagonist');
    expect(board.scenes.every(scene => scene.protagonistIds.length === 0)).toBe(true);
    await expect(f.director.generate(f.owner)).rejects.toMatchObject({ code: 'INVALID_AI_STORYBOARD' });
    expect(f.saved).toHaveLength(1);
  });

  it('requires both protagonists to participate in fictional cinematic footage while allowing anonymous b-roll', async () => {
    const f = await fixture();
    f.content.scenes.forEach(scene => {
      scene.userConfirmed = true;
      if (scene.type === 'NEW_CINEMATIC_SCENE') scene.protagonistIds = ['person1'];
    });
    const board = await f.director.save(f.owner, f.content);
    expect(board.readyForVideoGeneration).toBe(false);
    expect(board.validationIssues.join(' ')).toContain('Include Sam in at least one fictional');
    f.content.scenes[2].protagonistIds = ['person1', 'person2'];
    f.content.scenes[4].protagonistIds = [];
    expect((await f.director.save(f.owner, f.content)).readyForVideoGeneration).toBe(true);
  });
});
