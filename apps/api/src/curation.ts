import {MIN_MOVIE_DURATION_SECONDS,MAX_MOVIE_DURATION_SECONDS} from '@memories/shared';
import type { Asset, CuratedSelection, LocalPhotoFeatures, PhotoAnalysis, PhotoCuration, Protagonist, ProtagonistId } from '@memories/shared';
import { ApiError } from './errors.js';

export interface DirectorPhotoRow {
  asset: Asset;
  analysis: PhotoAnalysis | null;
  features: LocalPhotoFeatures | null;
  curation: PhotoCuration;
}
export interface CurationStore {
  ensure(ownerId: string): Promise<void>;
  rows(ownerId: string, limit?: number, afterId?: string): DirectorPhotoRow[];
  protagonists(ownerId: string): Protagonist[];
}
export const CURATION_PAGE_SIZE = 100;
const CANDIDATE_POOL_SIZE = 256;

/** A whole-image luminance hash, never a face descriptor or identity embedding. */
export function perceptualDistance(first: string, second: string): number {
  if (!/^[a-f0-9]{16}$/i.test(first) || !/^[a-f0-9]{16}$/i.test(second)) return 64;
  let bits = BigInt(`0x${first}`) ^ BigInt(`0x${second}`), count = 0;
  while (bits) { bits &= bits - 1n; count++; }
  return count;
}

/** Preserve metadata's calendar ordering without inventing a timezone for EXIF dates. */
export function evidencedPhotoDate(row: DirectorPhotoRow): string | undefined {
  const date = row.features?.exif.dateSource !== 'NONE' ? row.features?.exif.dateTimeOriginal ?? row.asset.createdAt : row.asset.createdAt;
  if (!date || !/^\d{4}[-:]\d{2}[-:]\d{2}/.test(date)) return undefined;
  return date.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
}

type Candidate = { row: DirectorPhotoRow; score: number; reasons: string[]; protagonistIds: ProtagonistId[] };
function confirmedPeople(row: DirectorPhotoRow, profiles: Protagonist[]): ProtagonistId[] {
  const ids = new Set<ProtagonistId>(row.curation.associationsConfirmed ? row.curation.protagonistIds : []);
  for (const profile of profiles) if (profile.referencePhotoIds.includes(row.asset.id)) ids.add(profile.id);
  return [...ids].sort();
}
function candidate(row: DirectorPhotoRow, profiles: Protagonist[]): Candidate | undefined {
  if (row.curation.excluded) return undefined;
  const analysis = row.analysis;
  if (!analysis && !row.curation.pinned) return undefined;
  if (!analysis) throw new ApiError(409, 'PINNED_PHOTO_NOT_ANALYZED', 'Analyze pinned photos before creating a storyboard, or unpin those photos.');
  const protagonistIds = confirmedPeople(row, profiles);
  const technical = (analysis.sharpness + analysis.exposure + analysis.composition) / 3;
  const score = technical * 0.3 + analysis.storytellingPotential * 0.35 + analysis.animationSuitability * 0.2 + (protagonistIds.length ? 10 : 0) + (evidencedPhotoDate(row) ? 5 : 0);
  const reasons = [`Technical quality ${Math.round(technical)}/100`, `Storytelling ${Math.round(analysis.storytellingPotential)}/100`, `Animation suitability ${Math.round(analysis.animationSuitability)}/100`];
  if (protagonistIds.length) reasons.push(protagonistIds.length === 2 ? 'User-confirmed shared moment' : 'User-confirmed solo moment');
  if (evidencedPhotoDate(row)) reasons.push('Existing date metadata supports chronological placement');
  if (row.curation.pinned) reasons.unshift('Pinned by you');
  return { row, score, reasons, protagonistIds };
}
function tags(value: Candidate): Set<string> {
  return new Set([value.row.analysis!.sceneType, ...value.row.analysis!.diversityTags, ...value.row.analysis!.activities].map(tag => tag.toLocaleLowerCase()));
}
function similarity(first: Candidate, second: Candidate): number {
  const one = tags(first), two = tags(second);
  let shared = 0;
  for (const tag of one) if (two.has(tag)) shared++;
  return shared / Math.max(1, one.size + two.size - shared);
}
function nearDuplicate(first: Candidate, second: Candidate, distance: number): boolean {
  if (first.row.asset.sha256 && first.row.asset.sha256 === second.row.asset.sha256) return true;
  const one = first.row.features?.perceptualHash, two = second.row.features?.perceptualHash;
  return Boolean(one && two && perceptualDistance(one, two) <= distance);
}

/** Stream collection metadata in pages, retaining a bounded automatic candidate pool. */
export async function curatePhotos(store: CurationStore, ownerId: string, durationSeconds = 150, duplicateDistance = 5): Promise<{ selection: CuratedSelection; rows: DirectorPhotoRow[] }> {
  if (!Number.isInteger(durationSeconds) || durationSeconds < MIN_MOVIE_DURATION_SECONDS || durationSeconds > MAX_MOVIE_DURATION_SECONDS) throw new ApiError(400, 'INVALID_MOVIE_DURATION', `Choose a whole-number movie duration between ${MIN_MOVIE_DURATION_SECONDS} and ${MAX_MOVIE_DURATION_SECONDS} seconds.`);
  await store.ensure(ownerId);
  const profiles = store.protagonists(ownerId);
  const pool: Candidate[] = [], pinned: Candidate[] = [];
  // Protect strong solo/shared material even when a large collection's top scores
  // are dominated by one person or one repeated setting.
  const associationPools = new Map<string, Candidate[]>();
  let afterId: string | undefined;
  while (true) {
    const page = store.rows(ownerId, CURATION_PAGE_SIZE, afterId);
    if (!page.length) break;
    for (const row of page) {
      const current = candidate(row, profiles);
      if (!current) continue;
      if (row.curation.pinned) pinned.push(current);
      else {
        pool.push(current);
        if (pool.length > CANDIDATE_POOL_SIZE) {
          pool.sort((a, b) => b.score - a.score || a.row.asset.id.localeCompare(b.row.asset.id));
          pool.length = CANDIDATE_POOL_SIZE;
        }
        if (current.protagonistIds.length) {
          const key = current.protagonistIds.join(',');
          const group = associationPools.get(key) ?? [];
          group.push(current);
          group.sort((a, b) => b.score - a.score || a.row.asset.id.localeCompare(b.row.asset.id));
          if (group.length > 32) group.length = 32;
          associationPools.set(key, group);
        }
      }
    }
    const next = page[page.length - 1].asset.id;
    if (next === afterId) throw new ApiError(500, 'CURATION_PAGINATION_ERROR', 'Photo curation could not advance through this project.');
    afterId = next;
  }
  // Forty scenes with thirty source references is the JSON storyboard's representational capacity.
  if (pinned.length > 1200) throw new ApiError(409, 'STORYBOARD_REFERENCE_CAPACITY', 'The pinned photos exceed this storyboard format’s source-reference capacity. Unpin some photos or plan separate storyboards.');
  pinned.sort((a, b) => a.row.asset.id.localeCompare(b.row.asset.id));
  for (const group of associationPools.values()) for (const value of group) {
    if (!pool.some(item => item.row.asset.id === value.row.asset.id)) pool.push(value);
  }
  pool.sort((a, b) => b.score - a.score || a.row.asset.id.localeCompare(b.row.asset.id));
  const selected = [...pinned], warnings: string[] = [];
  const desired = Math.max(pinned.length, Math.round(durationSeconds / 6));
  const pick = (condition: (value: Candidate) => boolean): boolean => {
    const available = pool.filter(value => condition(value) && !selected.some(chosen => chosen.row.asset.id === value.row.asset.id || nearDuplicate(chosen, value, duplicateDistance)));
    available.sort((a, b) => {
      const diversity = (item: Candidate) => item.score - Math.max(0, ...selected.map(previous => similarity(item, previous))) * 24;
      return diversity(b) - diversity(a) || a.row.asset.id.localeCompare(b.row.asset.id);
    });
    if (!available.length) return false;
    selected.push(available[0]); return true;
  };
  // Keep strong solo and shared material, rather than selecting only couple photographs.
  for (const ids of [['person1'], ['person2'], ['person1', 'person2']] as ProtagonistId[][]) {
    if (!selected.some(value => value.protagonistIds.length === ids.length && ids.every(id => value.protagonistIds.includes(id)))) {
      pick(value => value.protagonistIds.length === ids.length && ids.every(id => value.protagonistIds.includes(id)));
    }
  }
  while (selected.length < desired && pick(() => true)) { /* Greedy diverse selection over the bounded pool. */ }
  if (!selected.length) warnings.push('Analyze imported photos before creating a cinematic selection.');
  if (selected.some(value => !evidencedPhotoDate(value.row))) warnings.push('Some selected photos have no date metadata. Their placement is thematic, not an invented chronology.');
  if (!selected.some(value => value.protagonistIds.length === 2)) warnings.push('No selected photograph has both protagonists confirmed. Associate shared moments in the gallery if available.');
  if (pinned.some((value, index) => pinned.slice(0, index).some(previous => nearDuplicate(value, previous, duplicateDistance)))) warnings.push('Your pins include duplicate candidates; pins take precedence over automatic repetition avoidance.');
  selected.sort((a, b) => {
    const first = evidencedPhotoDate(a.row), second = evidencedPhotoDate(b.row);
    if (first && second) return first.localeCompare(second) || b.score - a.score;
    if (first) return -1; if (second) return 1;
    return b.score - a.score || a.row.asset.id.localeCompare(b.row.asset.id);
  });
  const selection: CuratedSelection = {
    assetIds: selected.map(value => value.row.asset.id),
    ranked: selected.map(value => ({ assetId: value.row.asset.id, score: Math.round(value.score * 100) / 100, reasons: value.reasons, pinned: value.row.curation.pinned, protagonistIds: value.protagonistIds })),
    warnings,
  };
  return { selection, rows: selected.map(value => value.row) };
}
