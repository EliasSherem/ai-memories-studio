import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { LocalPhotoFeatures, PhotoAnalysis, Protagonist, ProtagonistId } from '@memories/shared';
import { curatePhotos, evidencedPhotoDate, perceptualDistance, type CurationStore, type DirectorPhotoRow } from '../src/curation.js';

const analysis: PhotoAnalysis = { schemaVersion: '1.0', sharpness: 80, exposure: 80, composition: 80, animationSuitability: 80, storytellingPotential: 80, suitability: 'ANIMATED_ORIGINAL', description: 'People standing beside a tree.', sceneType: 'outdoors', visibleLocations: [], activities: ['standing'], objects: ['tree'], emotionalTone: 'warm', diversityTags: ['nature'], uncertaintyNotes: [] };
function row(index: number, people: ProtagonistId[] = []): DirectorPhotoRow {
  const id = `${index.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return { asset: { id, projectId: '11111111-1111-4111-8111-111111111111', contributorId: 'person1', filename: `${index}.jpg`, mimeType: 'image/jpeg', bytes: 10, importedAt: '2026-11-14T00:00:00Z', selected: true, url: '/private' }, analysis: structuredClone(analysis), features: null, curation: { assetId: id, pinned: false, excluded: false, protagonistIds: people, associationsConfirmed: true } };
}
function fixture(rows: DirectorPhotoRow[], profiles: Protagonist[] = []) {
  rows.sort((a, b) => a.asset.id.localeCompare(b.asset.id));
  const calls: { limit: number; after?: string }[] = [];
  const store: CurationStore = { ensure: async () => {}, protagonists: () => profiles, rows: (_owner, limit = 100, after) => {
    calls.push({ limit, after }); return rows.filter(value => !after || value.asset.id > after).slice(0, limit);
  } };
  return { store, calls };
}
function features(hash: string): LocalPhotoFeatures {
  return { sha256: randomUUID(), perceptualHash: hash, width: 100, height: 100, exif: { dateTimeOriginal: null, dateSource: 'NONE', latitude: null, longitude: null, locationSource: 'NONE', cameraMake: null, cameraModel: null } };
}

describe('bounded, evidence-based automatic photo curation', () => {
  it.each([100, 500, 1000])('paginates %i analyzed photos without an application import-selection limit', async count => {
    const rows = Array.from({ length: count }, (_, index) => row(index + 1));
    rows[count - 1].curation.pinned = true;
    rows[count - 1].analysis!.storytellingPotential = 0;
    const { store, calls } = fixture(rows);
    const result = await curatePhotos(store, 'owner', 150);
    expect(result.selection.assetIds).toHaveLength(25);
    expect(result.selection.assetIds).toContain(rows[count - 1].asset.id);
    expect(calls).toHaveLength(count / 100 + 1);
    expect(calls.every(call => call.limit === 100)).toBe(true);
    expect(new Set(calls.slice(1).map(call => call.after)).size).toBe(count / 100);
  });

  it('keeps confirmed solo and shared moments even outside the highest-score pool', async () => {
    const rows = Array.from({ length: 600 }, (_, index) => row(index + 1, ['person1']));
    const solo = row(700, ['person2']), shared = row(701, ['person1', 'person2']);
    solo.analysis!.storytellingPotential = 60; shared.analysis!.storytellingPotential = 60;
    const { store } = fixture([...rows, solo, shared]);
    const result = await curatePhotos(store, 'owner');
    expect(result.selection.assetIds).toContain(solo.asset.id);
    expect(result.selection.assetIds).toContain(shared.asset.id);
  });

  it('excludes blocked photos and avoids near duplicates unless the user pins both', async () => {
    const first = row(1), duplicate = row(2), excluded = row(3);
    first.features = features('0000000000000000'); duplicate.features = features('0000000000000001');
    excluded.curation.excluded = true; excluded.analysis!.storytellingPotential = 100;
    const { store } = fixture([first, duplicate, excluded]);
    expect((await curatePhotos(store, 'owner')).selection.assetIds).toEqual([first.asset.id]);
    first.curation.pinned = true; duplicate.curation.pinned = true;
    const result = await curatePhotos(store, 'owner');
    expect(result.selection.assetIds).toEqual([first.asset.id, duplicate.asset.id]);
    expect(result.selection.warnings.join(' ')).toContain('pins take precedence');
  });

  it('does not infer identity from an unconfirmed association or an import date', async () => {
    const unknown = row(1, ['person1', 'person2']); unknown.curation.associationsConfirmed = false;
    const { store } = fixture([unknown]);
    const result = await curatePhotos(store, 'owner');
    expect(result.selection.ranked[0].protagonistIds).toEqual([]);
    expect(evidencedPhotoDate(unknown)).toBeUndefined();
    expect(result.selection.warnings.join(' ')).toContain('thematic');
  });

  it('uses real EXIF/Google metadata chronologically and whole-image Hamming distance only', async () => {
    const later = row(1), earlier = row(2);
    later.asset.createdAt = '2022-02-01T00:00:00Z';
    earlier.features = features('ffffffffffffffff');
    earlier.features.exif = { ...earlier.features.exif, dateSource: 'EXIF', dateTimeOriginal: '2019:06:15 12:00:00' };
    expect((await curatePhotos(fixture([later, earlier]).store, 'owner')).selection.assetIds).toEqual([earlier.asset.id, later.asset.id]);
    expect(perceptualDistance('0000000000000000', '000000000000001f')).toBe(5);
    expect(perceptualDistance('not-a-hash', 'not-a-hash')).toBe(64);
  });

  it('requires analysis for every pinned original and validates target duration', async () => {
    const pinned = row(1); pinned.curation.pinned = true; pinned.analysis = null;
    await expect(curatePhotos(fixture([pinned]).store, 'owner')).rejects.toMatchObject({ code: 'PINNED_PHOTO_NOT_ANALYZED' });
    await expect(curatePhotos(fixture([]).store, 'owner', 901)).rejects.toMatchObject({ code: 'INVALID_MOVIE_DURATION' });
  });
});
