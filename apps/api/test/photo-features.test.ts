import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { extractPhotoFeatures, hammingDistance, metadataEvidence, prepareAnalysisImage } from '../src/photo-features.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function image() {
  const dir = await mkdtemp(join(tmpdir(), 'director-features-')); directories.push(dir);
  const file = join(dir, 'original.jpg');
  await sharp({ create: { width: 1200, height: 800, channels: 3, background: '#387e69' } }).jpeg().toFile(file);
  return file;
}
describe('local image evidence', () => {
  it('hashes locally, detects exact visual duplicates, and creates a bounded metadata-free preview', async () => {
    const file = await image();
    const a = await extractPhotoFeatures(file, 'a'.repeat(64));
    const b = await extractPhotoFeatures(file, 'b'.repeat(64));
    expect(a.perceptualHash).toMatch(/^[a-f0-9]{16}$/);
    expect(hammingDistance(a.perceptualHash, b.perceptualHash)).toBe(0);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(a.exif).toMatchObject({ dateSource: 'NONE', dateTimeOriginal: null, latitude: null, longitude: null });
    const preview = await prepareAnalysisImage(file, 768);
    const metadata = await sharp(preview.data).metadata();
    expect(metadata.width).toBe(768); expect(metadata.height).toBe(512); expect(metadata.exif).toBeUndefined();
    expect(preview.data.byteLength).toBeLessThan(8 * 1024 * 1024);
  });
  it('preserves timezone-unknown EXIF strings and only uses evidenced date/GPS metadata', () => {
    expect(metadataEvidence({ DateTimeOriginal: '2024:04:03 12:34:56', Make: 'Camera' })).toMatchObject({ dateTimeOriginal: '2024:04:03 12:34:56', dateSource: 'EXIF', cameraMake: 'Camera', locationSource: 'NONE' });
    expect(metadataEvidence({ DateTimeOriginal: '2024:04:03 12:34:56', OffsetTimeOriginal: '+03:00', latitude: 32.1, longitude: 34.8 })).toMatchObject({ dateTimeOriginal: '2024:04:03 12:34:56 +03:00', latitude: 32.1, longitude: 34.8, locationSource: 'EXIF' });
    expect(metadataEvidence(undefined, [{ createTime: '2020-02-03T04:05:06Z' }])).toMatchObject({ dateTimeOriginal: '2020-02-03T04:05:06Z', dateSource: 'GOOGLE_METADATA', latitude: null });
  });
  it('extracts real EXIF without assigning the computer timezone to its original date', async () => {
    const file = await image();
    await sharp({ create: { width: 24, height: 16, channels: 3, background: '#4488aa' } }).withExif({ IFD0: { Make: 'Test camera' }, IFD2: { DateTimeOriginal: '2024:04:03 12:34:56', OffsetTimeOriginal: '+03:00' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '32/1 6/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '34/1 48/1 0/1' } }).jpeg().toFile(file);
    const result = await extractPhotoFeatures(file, 'c'.repeat(64));
    expect(result.exif.dateTimeOriginal).toBe('2024:04:03 12:34:56 +03:00');
    expect(result.exif.dateSource).toBe('EXIF');
    expect(result.exif).toMatchObject({ latitude: 32.1, longitude: 34.8, locationSource: 'EXIF' });
  });
  it('rejects undecodable files with a safe message', async () => {
    const file = await image(); await writeFile(file, 'invalid image containing a private filename');
    await expect(extractPhotoFeatures(file, 'd'.repeat(64))).rejects.toMatchObject({ code: 'UNSUPPORTED_ANALYSIS_IMAGE', message: 'This local image could not be decoded safely for analysis.' });
  });
});
